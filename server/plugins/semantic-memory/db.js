// Semantic Memory DB helpers

import { cosineSimilarity } from './embeddings.js';
import { chunkText, DEFAULT_CHUNK_SIZE } from './chunking.js';
export default function createMemoryDB(db) {
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
        likeParams.push(fetchLimit);
        var rows = db.prepare(
          'SELECT * FROM sm_embeddings WHERE ' + likeWhere.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ?'
        ).all(...likeParams);
        return this.collapseChunks(rows.map(function (r) {
          try { r.metadata = JSON.parse(r.metadata); } catch (e) { r.metadata = {}; }
          r.score = 1.0; // no ranking for LIKE fallback
          return r;
        })).slice(0, limit);
      }
    },

    // -- Vector Search --
    searchVector(queryEmbedding, opts) {
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

      // Cap rows loaded for JS-side cosine sim to prevent DoS on large tables
      var vectorCap = 5000;
      params.push(vectorCap);
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
      // Collapse chunked docs to their best chunk BEFORE slicing to the page
      // limit — otherwise one multi-chunk doc floods the results. Mirrors
      // searchKeyword (collapse then slice). scored rows carry source_type +
      // source_id, so collapseChunks keys them directly.
      var topIds = this.collapseChunks(scored).slice(0, limit);

      // Fetch full rows only for top results
      return topIds.map(function (s) {
        var full = db.prepare('SELECT * FROM sm_embeddings WHERE id = ?').get(s.id);
        if (!full) return null;
        try { full.metadata = JSON.parse(full.metadata); } catch (e) { full.metadata = {}; }
        full.score = s.score;
        return full;
      }).filter(Boolean);
    },

    updateEmbedding(sourceType, sourceId, chunkIndex, embedding, model) {
      // A null embedding must NOT be stored as the string "null" — that
      // escapes `embedding IS NULL` and orphans the row from backfill.
      if (embedding == null) return;
      var embeddingStr = embedding == null ? null : JSON.stringify(embedding);
      db.prepare(
        "UPDATE sm_embeddings SET embedding = ?, embedding_model = ?, updated_at = datetime('now') WHERE source_type = ? AND source_id = ? AND chunk_index = ?"
      ).run(embeddingStr, model, sourceType, sourceId, chunkIndex || 0);
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
    stats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings').get().c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
      var byType = db.prepare('SELECT source_type, COUNT(*) as count FROM sm_embeddings GROUP BY source_type ORDER BY count DESC').all();
      var byNamespace = db.prepare('SELECT namespace, COUNT(*) as count FROM sm_embeddings WHERE namespace IS NOT NULL GROUP BY namespace ORDER BY count DESC LIMIT 20').all();
      return {
        total_indexed: total,
        with_embeddings: withEmbedding,
        embedding_coverage: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        by_source_type: byType,
        by_namespace: byNamespace,
        vector_scan_capped: withEmbedding > 5000
      };
    }
  };
}
