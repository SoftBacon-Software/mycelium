// Semantic Memory DB helpers

import { cosineSimilarity, embedQueueDepth } from './embeddings.js';
import { chunkText, DEFAULT_CHUNK_SIZE } from './chunking.js';
import { createVectorCache } from './vector-cache.js';

// -- Bench rows are invisible to plain recall (2026-09-08) ---------------------
// Benchmark harnesses write into the ONE index live recall reads from (task
// 163's Mycelium arm left 3,104 rows with source_type bench_longmemeval /
// namespace bench-p1-2026-09-08-*; they outranked real agent memories on every
// unfiltered search). Rule: a bench row — source_type starting 'bench_' OR
// namespace starting 'bench-' — is returned by the search functions ONLY when
// the request itself names a bench source_type in source_types or a bench
// namespace in namespace. Those are exact-match filters, so naming one bench
// type/namespace cannot leak another; a request that names no bench filter at
// all sees no bench rows. Enforced in the query layer (not post-filter) so the
// caller's `limit` is spent on visible rows instead of being burned on hidden
// ones before the slice.
export var BENCH_TYPE_PREFIX = 'bench_';
export var BENCH_NS_PREFIX = 'bench-';

export function benchOptIn(opts) {
  opts = opts || {};
  if (Array.isArray(opts.source_types) &&
      opts.source_types.some(function (t) {
        return typeof t === 'string' && t.indexOf(BENCH_TYPE_PREFIX) === 0;
      })) return true;
  if (typeof opts.namespace === 'string' && opts.namespace.indexOf(BENCH_NS_PREFIX) === 0) return true;
  return false;
}

// Static SQL for the exclusion — no parameters, the prefixes are the constants
// above and nothing user-supplied is interpolated. substr() instead of LIKE so
// the '_' in the type prefix is a literal, not a single-char wildcard.
// COALESCE guards NULL namespace: NULL LIKE/substr = NULL, and a bare NOT(...)
// would silently drop every NULL-namespace row with it.
var BENCH_HIDDEN_SQL =
  "NOT (substr(COALESCE(source_type,''),1," + BENCH_TYPE_PREFIX.length + ") = '" + BENCH_TYPE_PREFIX + "'" +
  " OR substr(COALESCE(namespace,''),1," + BENCH_NS_PREFIX.length + ") = '" + BENCH_NS_PREFIX + "')";

// DoS bound shared by BOTH vector arms: only the newest N candidate rows
// among the filtered set are scored — what the old per-query SQL expressed as
// `ORDER BY updated_at DESC LIMIT <cap>`, and what the decoded-vector cache
// (vector-cache.js) expresses as an early break in its recency order.
// Exported for the cache default and the tests.
export var VECTOR_SCAN_CAP = 5000;

export default function createMemoryDB(db) {
  // Decoded-vector cache behind searchVector (F-mycelium/194): each embedded
  // row's vector is JSON.parse'd ONCE, not on every query. Write paths below
  // keep it exact through hooks; the 2-aggregate freshness signature in
  // vector-cache.js self-heals writers that bypass this module (auto-memory
  // deletes rows directly). Memory bound: 25k rows x 768 dims x 4 B = 77 MB.
  var vectorCache = createVectorCache(db, {
    benchOptIn: benchOptIn,
    benchTypePrefix: BENCH_TYPE_PREFIX,
    benchNsPrefix: BENCH_NS_PREFIX,
    scanCap: VECTOR_SCAN_CAP
  });

  return {

    // -- Config --
    // Two stores: sm_config (PUT /memory/config) is canonical; the platform's
    // plugin_config table (PUT /plugins/semantic-memory/config) is the fallback
    // so config set through the platform plugin surface is honored too.
    // Reads happen per-call, so either route applies live — no restart needed.
    getConfig(key) {
      var row = db.prepare('SELECT value FROM sm_config WHERE key = ?').get(key);
      if (row) return row.value;
      try {
        var prow = db.prepare("SELECT value FROM plugin_config WHERE plugin_name = 'semantic-memory' AND key = ?").get(key);
        return prow ? prow.value : null;
      } catch (e) {
        return null; // plugin_config may not exist (plugin-only DBs, tests)
      }
    },

    setConfig(key, value) {
      db.prepare('INSERT OR REPLACE INTO sm_config (key, value) VALUES (?, ?)').run(key, value);
    },

    getAllConfig() {
      var config = {};
      try {
        var prows = db.prepare("SELECT key, value FROM plugin_config WHERE plugin_name = 'semantic-memory'").all();
        for (var p of prows) config[p.key] = p.value;
      } catch (e) { /* plugin_config may not exist (plugin-only DBs, tests) */ }
      var rows = db.prepare('SELECT key, value FROM sm_config').all();
      for (var r of rows) config[r.key] = r.value;
      return config;
    },

    // -- Chunking --
    // Threshold for splitting docs into chunk rows. Tunable via the
    // chunk_size config key; floor of 200 so a stray tiny value can't
    // shred every doc.
    getChunkSize() {
      var v = parseInt(this.getConfig('chunk_size'), 10);
      return (isNaN(v) || v < 200) ? DEFAULT_CHUNK_SIZE : v;
    },

    // Chunk-aware indexing: oversized content is split into chunk rows
    // (chunk_index 0..N), each holding its slice — replacing the doc's
    // previous rows. Stale chunks beyond the new count are removed in the
    // same transaction, so re-index never orphans old chunks. Returns the
    // chunk texts written (length 1 for docs under the threshold).
    indexDoc(sourceType, sourceId, contentText, opts) {
      opts = opts || {};
      var chunks = chunkText(contentText, this.getChunkSize());
      var self = this;
      var txn = db.transaction(function () {
        for (var i = 0; i < chunks.length; i++) {
          var chunkOpts = Object.assign({}, opts, { chunk_index: i });
          if (chunks.length > 1) {
            // caller-supplied embeddings cover the whole doc — invalid per-chunk
            delete chunkOpts.embedding;
            delete chunkOpts.embedding_model;
          }
          self.index(sourceType, sourceId, chunks[i], chunkOpts);
        }
        self.removeChunksFrom(sourceType, sourceId, chunks.length);
      });
      txn();
      return chunks;
    },

    removeChunksFrom(sourceType, sourceId, fromIndex) {
      db.prepare(
        'DELETE FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index >= ?'
      ).run(sourceType, sourceId, fromIndex);
      vectorCache.onRemovePair(sourceType, sourceId, fromIndex);
    },

    getDocChunks(sourceType, sourceId) {
      return db.prepare(
        'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? ORDER BY chunk_index'
      ).all(sourceType, sourceId);
    },

    // -- Index --
    index(sourceType, sourceId, contentText, opts) {
      opts = opts || {};
      var namespace = opts.namespace || null;
      var chunkIndex = opts.chunk_index || 0;
      var metadata = opts.metadata ? JSON.stringify(opts.metadata) : '{}';
      var embedding = opts.embedding || null;
      var embeddingModel = opts.embedding_model || null;

      db.prepare(`
        INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id, chunk_index)
        DO UPDATE SET content_text = excluded.content_text, namespace = excluded.namespace,
          metadata = excluded.metadata, embedding = excluded.embedding,
          embedding_model = excluded.embedding_model, updated_at = datetime('now')
      `).run(sourceType, sourceId, contentText, namespace, chunkIndex, metadata, embedding, embeddingModel);
      vectorCache.onUpsert(sourceType, sourceId, chunkIndex);
    },

    // Chunk-aware bulk index. Items carrying an explicit chunk_index are
    // stored as single rows (caller-managed chunking); everything else goes
    // through indexDoc so oversized content splits and stale chunks are
    // cleaned up. Returns the rows actually written (post-chunking) so the
    // caller can embed each one.
    bulkIndex(items) {
      var self = this;
      var rows = [];
      var txn = db.transaction(function (items) {
        for (var item of items) {
          if (item.chunk_index !== undefined && item.chunk_index !== null) {
            self.index(item.source_type, item.source_id, item.content_text, {
              namespace: item.namespace, chunk_index: item.chunk_index,
              metadata: item.metadata, embedding: item.embedding,
              embedding_model: item.embedding_model
            });
            rows.push({
              source_type: item.source_type, source_id: item.source_id,
              chunk_index: item.chunk_index, content_text: item.content_text,
              embedding: item.embedding || null
            });
            continue;
          }
          var chunks = self.indexDoc(item.source_type, item.source_id, item.content_text, {
            namespace: item.namespace, metadata: item.metadata,
            embedding: item.embedding, embedding_model: item.embedding_model
          });
          for (var i = 0; i < chunks.length; i++) {
            rows.push({
              source_type: item.source_type, source_id: item.source_id,
              chunk_index: i, content_text: chunks[i],
              embedding: chunks.length === 1 ? (item.embedding || null) : null
            });
          }
        }
      });
      txn(items);
      return rows;
    },

    getDoc(sourceType, sourceId, chunkIndex) {
      return db.prepare(
        'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = ?'
      ).get(sourceType, sourceId, chunkIndex || 0);
    },

    remove(sourceType, sourceId) {
      db.prepare('DELETE FROM sm_embeddings WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
      vectorCache.onRemovePair(sourceType, sourceId, null);
    },

    // Admin bulk purge by exact filter — how a finished benchmark run cleans up
    // after itself (task 163's 3,104 bench rows were only reachable one
    // (source_type, source_id) pair at a time before this). At least one filter
    // is required: the route refuses a bare purge, and this returns null rather
    // than guess. FTS stays in sync through the sm_fts_delete trigger. Returns
    // the number of rows deleted.
    purge(filters) {
      filters = filters || {};
      var where = [];
      var params = [];
      if (filters.source_type) { where.push('source_type = ?'); params.push(filters.source_type); }
      if (filters.namespace) { where.push('namespace = ?'); params.push(filters.namespace); }
      if (where.length === 0) return null; // never delete unfiltered
      var info = db.prepare('DELETE FROM sm_embeddings WHERE ' + where.join(' AND ')).run(...params);
      vectorCache.onPurge(filters);
      return info.changes;
    },

    // -- Search --
    // Collapse chunked docs to their best-scoring chunk so one big doc
    // can't flood a result page. Input must be sorted best-first; keeps
    // the first row seen per (source_type, source_id).
    collapseChunks(results) {
      var seen = {};
      var out = [];
      for (var r of results) {
        var key = r.source_type + ':' + r.source_id;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(r);
      }
      return out;
    },

    searchKeyword(query, opts) {
      opts = opts || {};
      var limit = Math.min(opts.limit || 10, 100);
      // Overfetch so collapsing a multi-chunk doc doesn't starve the page
      var fetchLimit = Math.min(limit * 2, 200);
      var where = [];
      var params = [];

      // FTS5 match
      where.push("sm_embeddings_fts MATCH ?");
      // Escape special FTS5 chars and convert to prefix search
      var ftsQuery = query.replace(/['"*()]/g, '').split(/\s+/).filter(Boolean).map(function (w) { return '"' + w + '"'; }).join(' OR ');
      params.push(ftsQuery);

      if (opts.source_types && opts.source_types.length > 0) {
        where.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
        params = params.concat(opts.source_types);
      }
      if (opts.namespace) {
        where.push('namespace = ?');
        params.push(opts.namespace);
      }
      if (!benchOptIn(opts)) where.push(BENCH_HIDDEN_SQL);

      params.push(fetchLimit);

      try {
        var rows = db.prepare(
          'SELECT rowid, content_text, source_type, namespace, rank FROM sm_embeddings_fts WHERE ' + where.join(' AND ') + ' ORDER BY rank LIMIT ?'
        ).all(...params);

        // Enrich with full row data
        var enriched = rows.map(function (r) {
          var full = db.prepare('SELECT * FROM sm_embeddings WHERE id = ?').get(r.rowid);
          if (!full) return null;
          try { full.metadata = JSON.parse(full.metadata); } catch (e) { full.metadata = {}; }
          full.score = -r.rank; // FTS5 rank is negative (lower = better)
          return full;
        }).filter(Boolean);
        return this.collapseChunks(enriched).slice(0, limit);
      } catch (e) {
        // FTS5 query syntax error — fall back to LIKE search
        var likeParams = [];
        var likeWhere = ['content_text LIKE ?'];
        likeParams.push('%' + query + '%');
        if (opts.source_types && opts.source_types.length > 0) {
          likeWhere.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
          likeParams = likeParams.concat(opts.source_types);
        }
        if (opts.namespace) {
          likeWhere.push('namespace = ?');
          likeParams.push(opts.namespace);
        }
        if (!benchOptIn(opts)) likeWhere.push(BENCH_HIDDEN_SQL);
        likeParams.push(fetchLimit);
        var likeRows = db.prepare(
          'SELECT * FROM sm_embeddings WHERE ' + likeWhere.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ?'
        ).all(...likeParams);
        return this.collapseChunks(likeRows.map(function (r) {
          try { r.metadata = JSON.parse(r.metadata); } catch (e) { r.metadata = {}; }
          r.score = 1.0; // no ranking for LIKE fallback
          return r;
        })).slice(0, limit);
      }
    },

    // -- Vector Search --
    // The query path NEVER JSON.parses an embedding: vectors are decoded once
    // into the cache (vector-cache.js) and search is a filter + tight dot
    // loop. Per-query parse of up to 5,000 vectors was 2.4-4.3 s on jetson01
    // and blocked the event loop hard enough to wedge the platform
    // (F-mycelium/194). The original algorithm lives on verbatim as
    // searchVectorJsonPath — the oracle the tests hold the cache to, and the
    // fallback if the cache ever throws (never worse than before the cache).
    searchVector(queryEmbedding, opts) {
      opts = opts || {};
      try {
        var scored = vectorCache.scored(queryEmbedding, opts);
        return this.finishScored(scored, Math.min(opts.limit || 10, 100));
      } catch (e) {
        console.error('[semantic-memory] vector cache failed, falling back to JSON path:', e.message);
        return this.searchVectorJsonPath(queryEmbedding, opts);
      }
    },

    // Shared tail for both vector arms: collapse chunked docs to their best
    // chunk BEFORE slicing to the page limit (mirrors searchKeyword), then
    // fetch full rows only for the top results.
    finishScored(scored, limit) {
      var topIds = this.collapseChunks(scored).slice(0, limit);
      return topIds.map(function (s) {
        var full = db.prepare('SELECT * FROM sm_embeddings WHERE id = ?').get(s.id);
        if (!full) return null;
        try { full.metadata = JSON.parse(full.metadata); } catch (e) { full.metadata = {}; }
        full.score = s.score;
        return full;
      }).filter(Boolean);
    },

    // The pre-194 algorithm, kept verbatim as the correctness oracle for the
    // cache (test/unit/search-vector-decode-cache.test.js asserts identical
    // ranking and scores to 1e-6) and as the emergency fallback above. Not
    // called on the hot path; do not optimize or "clean up" this method —
    // its value is being exactly what shipped before the cache.
    searchVectorJsonPath(queryEmbedding, opts) {
      opts = opts || {};
      var limit = Math.min(opts.limit || 10, 100);
      var where = ['embedding IS NOT NULL'];
      var params = [];

      if (opts.source_types && opts.source_types.length > 0) {
        where.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
        params = params.concat(opts.source_types);
      }
      if (opts.namespace) {
        where.push('namespace = ?');
        params.push(opts.namespace);
      }
      if (!benchOptIn(opts)) where.push(BENCH_HIDDEN_SQL);

      // Cap rows loaded for JS-side cosine sim to prevent DoS on large tables
      params.push(VECTOR_SCAN_CAP);
      var rows = db.prepare(
        'SELECT id, source_type, source_id, chunk_index, embedding FROM sm_embeddings WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ?'
      ).all(...params);

      // Compute cosine similarity in JS
      var scored = [];
      for (var row of rows) {
        var embedding = null;
        try {
          if (typeof row.embedding === 'string') {
            embedding = JSON.parse(row.embedding);
          } else if (Buffer.isBuffer(row.embedding)) {
            embedding = JSON.parse(row.embedding.toString());
          }
        } catch (e) { continue; }
        if (!embedding) continue;

        var sim = cosineSimilarity(queryEmbedding, embedding);
        scored.push({ id: row.id, source_type: row.source_type, source_id: row.source_id, chunk_index: row.chunk_index, score: sim });
      }

      scored.sort(function (a, b) { return b.score - a.score; });
      return this.finishScored(scored, limit);
    },

    // Cache observability for tests and ops (additive, read-only).
    vectorCacheInfo() {
      return vectorCache.info();
    },

    updateEmbedding(sourceType, sourceId, chunkIndex, embedding, model) {
      // A null embedding must NOT be stored as the string "null" — that
      // escapes `embedding IS NULL` and orphans the row from backfill.
      if (embedding == null) return;
      var embeddingStr = embedding == null ? null : JSON.stringify(embedding);
      db.prepare(
        "UPDATE sm_embeddings SET embedding = ?, embedding_model = ?, updated_at = datetime('now') WHERE source_type = ? AND source_id = ? AND chunk_index = ?"
      ).run(embeddingStr, model, sourceType, sourceId, chunkIndex || 0);
      vectorCache.onUpsert(sourceType, sourceId, chunkIndex || 0);
    },

    getUnembedded(limit) {
      return db.prepare(
        'SELECT id, source_type, source_id, chunk_index, content_text FROM sm_embeddings WHERE embedding IS NULL ORDER BY updated_at DESC LIMIT ?'
      ).all(limit || 50);
    },

    countUnembedded() {
      return db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NULL').get().c;
    },

    searchHybrid(query, opts, queryEmbedding) {
      opts = opts || {};
      var limit = opts.limit || 10;

      // Always do keyword search
      var keywordResults = this.searchKeyword(query, Object.assign({}, opts, { limit: limit * 2 }));

      // If no query embedding, return keyword only
      if (!queryEmbedding) {
        return keywordResults.slice(0, limit);
      }

      // Vector search
      var vectorResults = this.searchVector(queryEmbedding, Object.assign({}, opts, { limit: limit * 2 }));

      // Reciprocal Rank Fusion (RRF)
      var K = 60; // standard RRF constant
      var scores = {}; // key: source_type:source_id:chunk_index -> { score, row }

      for (var ki = 0; ki < keywordResults.length; ki++) {
        var kr = keywordResults[ki];
        var key = kr.source_type + ':' + kr.source_id + ':' + (kr.chunk_index || 0);
        if (!scores[key]) scores[key] = { score: 0, row: kr };
        scores[key].score += 1 / (K + ki + 1);
      }

      for (var vi = 0; vi < vectorResults.length; vi++) {
        var vr = vectorResults[vi];
        var key2 = vr.source_type + ':' + vr.source_id + ':' + (vr.chunk_index || 0);
        if (!scores[key2]) scores[key2] = { score: 0, row: vr };
        scores[key2].score += 1 / (K + vi + 1);
        scores[key2].row.vector_score = vr.score; // attach vector similarity for debugging
      }

      // Sort by combined RRF score, then collapse chunked docs to their
      // best chunk before applying the page limit
      var merged = Object.values(scores).sort(function (a, b) { return b.score - a.score; });
      var rows = merged.map(function (m) {
        m.row.rrf_score = m.score;
        return m.row;
      });
      return this.collapseChunks(rows).slice(0, limit);
    },

    // -- Stats --
    // List rows of a given source_type, newest first — query-free retrieval for
    // always-on content (e.g. standing preferences injected every turn
    // regardless of the current query). Added 2026-08-18.
    listByType(sourceType, opts) {
      opts = opts || {};
      var namespace = opts.namespace || null;
      var limit = Math.min(parseInt(opts.limit, 10) || 20, 100);
      var sql = 'SELECT source_type, source_id, content_text, namespace, metadata, created_at '
              + 'FROM sm_embeddings WHERE source_type = ? AND chunk_index = 0';
      var args = [sourceType];
      if (namespace) { sql += ' AND namespace = ?'; args.push(namespace); }
      sql += ' ORDER BY created_at DESC LIMIT ?'; args.push(limit);
      return db.prepare(sql).all(...args);
    },

    // -- Lessons & history (2026-09-10, F-mycelium/186) ---------------------------
    // A LESSON is a memory row like everything else: source_type 'lesson', one
    // row per lesson (chunk_index 0), provenance in metadata (actor, learned_at,
    // evidence — enforced at the route, not here). Recall orders by the lesson's
    // OWN date ("last Tuesday this exact shape failed because…"), falling back
    // to created_at for rows that somehow lack learned_at — NOT by insertion
    // order, which disagrees with reality the moment a batch migrates in.
    // History is the sibling view over source_type 'verdict' (prior workflow/
    // lane verdicts for a repo/class). Same provenance gate, same ordering.
    listProvenanceRows(sourceType, opts) {
      opts = opts || {};
      var limit = Math.min(parseInt(opts.limit, 10) || 20, 100);
      var where = ['source_type = ?', 'chunk_index = 0'];
      var args = [sourceType];
      if (opts.task_class) { where.push("json_extract(metadata, '$.task_class') = ?"); args.push(opts.task_class); }
      if (opts.repo) { where.push("json_extract(metadata, '$.repo') = ?"); args.push(opts.repo); }
      if (opts.since) {
        // ISO date/datetime strings compare correctly as text (fixed-width,
        // zero-padded) — a date-only since= covers the whole named day.
        where.push("COALESCE(json_extract(metadata, '$.learned_at'), created_at) >= ?");
        args.push(opts.since);
      }
      var sql = 'SELECT source_type, source_id, content_text, namespace, metadata, created_at, updated_at '
              + 'FROM sm_embeddings WHERE ' + where.join(' AND ')
              + " ORDER BY COALESCE(json_extract(metadata, '$.learned_at'), created_at) DESC, created_at DESC LIMIT ?";
      args.push(limit);
      var rows = db.prepare(sql).all(...args);
      for (var r of rows) {
        try { r.metadata = JSON.parse(r.metadata); } catch (e) { r.metadata = {}; }
      }
      return rows;
    },

    listLessons(opts) {
      return this.listProvenanceRows('lesson', opts);
    },

    listHistory(opts) {
      return this.listProvenanceRows('verdict', opts);
    },

    // The provenance gate the route enforces for lesson/verdict rows — lives
    // beside the query layer so /index and /index/bulk share ONE definition.
    // actor/learned_at/evidence are the brief's provenance trio (BRIEF-lab-
    // alive-memory-program: "a lesson row without provenance is refused at
    // the route"); the rest of the §1 shape (symptom, fix_or_rule, task_class,
    // repo, origin, outcome) is the documented contract but is not the gate.
    LESSON_SOURCE_TYPES: { lesson: true, verdict: true },
    REQUIRED_PROVENANCE: ['actor', 'learned_at', 'evidence'],
    missingProvenanceFields(metadata) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return this.REQUIRED_PROVENANCE.slice();
      }
      return this.REQUIRED_PROVENANCE.filter(function (f) {
        var v = metadata[f];
        return typeof v !== 'string' || v.trim().length === 0;
      });
    },

    // Lightweight health snapshot for the search response — the four numbers a
    // caller needs to judge whether a result set is complete + healthy (total,
    // embedded, coverage %, vector-scan cap), WITHOUT the two GROUP BYs stats()
    // runs. Search is a hotter path than GET /stats, so this stays cheap.
    // Surfaced on every /memory/search response — see MEMORY-FAILURE-STATES.md §F3.
    indexHealth() {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings').get().c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
      return {
        total: total,
        embedded: withEmbedding,
        coverage_pct: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        vector_scan_capped: withEmbedding > VECTOR_SCAN_CAP // mirrors the cap in searchVector()
      };
    },

    stats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings').get().c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
      var byType = db.prepare('SELECT source_type, COUNT(*) as count FROM sm_embeddings GROUP BY source_type ORDER BY count DESC').all();
      var byNamespace = db.prepare('SELECT namespace, COUNT(*) as count FROM sm_embeddings WHERE namespace IS NOT NULL GROUP BY namespace ORDER BY count DESC LIMIT 20').all();
      return {
        total_indexed: total,
        with_embeddings: withEmbedding,
        embedding_coverage: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        // Rows awaiting embedding (the row-level backlog) + the in-process
        // scheduler depth (what's in flight / queued per lane). A client
        // watching a bulk index can see the embed pipeline drain here
        // instead of diagnosing it from search timeouts. (2026-09-09)
        embed_backlog: this.countUnembedded(),
        embed_queue: embedQueueDepth(),
        by_source_type: byType,
        by_namespace: byNamespace,
        vector_scan_capped: withEmbedding > VECTOR_SCAN_CAP
      };
    }
  };
}
