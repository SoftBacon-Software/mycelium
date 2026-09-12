// Decoded-vector cache behind searchVector (2026-09-11, F-mycelium/194).
//
// THE PROBLEM IT EXISTS FOR: searchVector used to JSON.parse EVERY candidate
// row's ~15 KB embedding text (768 floats) on every query — O(capped_rows x
// 768) parse work ON THE EVENT LOOP, per query, per caller. Measured on
// jetson01 (2026-09-10/09-11): 2.4-4.3 s per hybrid query at 5,852 rows, and
// under concurrent callers the loop blocked hard enough to wedge the platform
// (accept queue full, node in R, pingable but dead — twice in one night, plus
// the 09-10 bench run r2 died of the same). Mac numbers for the same shape:
// 205 ms p50 at 5k rows, 376 ms at 25k — tools/bench-search-latency.mjs.
//
// THE SHAPE: each row's vector is decoded ONCE (at build, or on the write
// that touched it) into a Float32Array with its norm precomputed. Search is
// then a filter + a tight dot-product loop — no JSON.parse on the query path,
// ever. Rows are kept globally sorted by updated_at DESC, so the vector scan
// cap is an early break in that order: the same newest-N-after-WHERE the old
// SQL's `ORDER BY updated_at DESC LIMIT <cap>` produced, minus the per-query
// sort.
//
// MEMORY BOUND: every embedded row's vector, Float32 —
//   25,000 rows x 768 dims x 4 B = 77 MB (the benchmark's worst modeled case)
//   today's live jetson01 store: 4,030 embedded rows ≈ 12 MB.
// Acceptable on the Jetson (8 GB); state the number whenever this is debated.
//
// FRESHNESS (the part that must never silently rot):
//   - every write path in db.js calls a hook here (index, updateEmbedding,
//     remove, removeChunksFrom, purge) and the cache mutates incrementally;
//   - a 2-aggregate signature — embedded-row count (via a partial index) and
//     MAX(id) — is checked per search, so OUT-OF-BAND writers this module
//     cannot hook (auto-memory's unindexFacts deletes rows directly;
//     standalone maintenance scripts) self-heal on the next search via a
//     rebuild. A rolled-back transaction self-heals the same way: hooks run
//     optimistically inside the transaction, the signature is read back from
//     SQL truth after it.
//   - documented gap: an out-of-band writer that changes an embedding VALUE
//     without changing any row count or id leaves the cached scores stale
//     until some other write moves the signature. No product path does this
//     (the embed scheduler lands vectors through updateEmbedding's hook);
//     the final top-N rows are still fetched live from the table, so only
//     the ranking could be stale, never the returned row content.
//
// SCORE IDENTITY with the JSON path (cosineSimilarity): the query vector and
// each row vector are rounded to Float32, dot and norms accumulate in the
// same ascending-index order, and the score is dot / (sqrt(magA) * precomputed
// sqrt(magB)) — the same IEEE operations as the reference, so scores agree to
// ~1e-7 (asserted to 1e-6 in test/unit/search-vector-decode-cache.test.js
// against searchVectorJsonPath, the original algorithm kept verbatim as the
// oracle). Two documented divergences, both in the direction of "skip a row
// the JSON path would have scored NaN": a row whose embedding parses but
// holds a non-finite number is treated as unparseable (the old path already
// skipped unparseable JSON; such a row has never produced a usable score),
// and equal-score ties order by recency deterministically instead of by
// SQLite's sorter whim.

export function createVectorCache(db, opts) {
  opts = opts || {};
  var benchOptIn = opts.benchOptIn || function () { return false; };
  var benchTypePrefix = opts.benchTypePrefix || 'bench_';
  var benchNsPrefix = opts.benchNsPrefix || 'bench-';
  var scanCap = opts.scanCap || 5000;

  // rowid -> entry; `order` holds the same entries sorted updated_at DESC.
  var byId = new Map();
  var order = [];
  var built = false;
  var baseline = null;        // last signature the SQL truth confirmed
  var baselineStale = false;  // a hook mutated state inside a live transaction
  var maxId = 0;

  var builds = 0;
  var lastBuildMs = 0;
  var lastScanCandidates = 0;
  var lastScanMs = 0;

  // SQL signature — 2 aggregates, both index-only (idx_sm_embedded is the
  // partial index on embedding IS NOT NULL; MAX(rowid) is O(1)). This is what
  // catches writers that bypass db.js.
  function aggregates() {
    return {
      embedded: db.prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c,
      maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sm_embeddings').get().m
    };
  }

  // Decode one row's embedding text the way the platform stores it
  // (JSON.stringify of a float array). Returns null for anything the old
  // path would have skipped (parse failure) or scored NaN (non-finite).
  function decodeRow(sourceType, sourceId, chunkIndex, namespace, updatedAt, embedding) {
    var text = null;
    if (typeof embedding === 'string') text = embedding;
    else if (embedding && typeof embedding.toString === 'function' && typeof embedding !== 'number') text = embedding.toString();
    if (!text) return null;
    var arr;
    try { arr = JSON.parse(text); } catch (e) { return null; }
    if (!Array.isArray(arr) || arr.length === 0) return null;
    var vec = new Float32Array(arr.length);
    var mag = 0;
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i];
      if (typeof x !== 'number' || !isFinite(x)) return null;
      vec[i] = x;
      mag += x * x;
    }
    return {
      id: 0, // set by caller
      source_type: sourceType,
      source_id: sourceId,
      chunk_index: chunkIndex,
      namespace: namespace,
      updated_at: updatedAt,
      typeId: intern(typeIds, sourceType),
      nsId: namespace === null ? NS_NULL : intern(nsIds, namespace),
      isBench: (sourceType.indexOf(benchTypePrefix) === 0) ||
               (namespace !== null && namespace.indexOf(benchNsPrefix) === 0),
      dim: arr.length,
      vec: vec,
      norm: Math.sqrt(mag)
    };
  }

  // -- interning: filters compare small ints in the scan loop, not strings --
  var typeIds = new Map();
  var nsIds = new Map();
  var NS_NULL = -1;
  function intern(map, str) {
    var id = map.get(str);
    if (id === undefined) { id = map.size; map.set(str, id); }
    return id;
  }

  function insertFront(entry) {
    order.unshift(entry);
    byId.set(entry.id, entry);
  }

  function dropById(id) {
    if (!byId.has(id)) return;
    byId.delete(id);
    for (var i = 0; i < order.length; i++) {
      if (order[i].id === id) { order.splice(i, 1); return; }
    }
  }

  function dropWhere(predicate) {
    var removed = 0;
    for (var i = order.length - 1; i >= 0; i--) {
      if (predicate(order[i])) { byId.delete(order[i].id); order.splice(i, 1); removed++; }
    }
    return removed;
  }

  function build() {
    var t0 = Date.now();
    byId = new Map();
    order = [];
    var stmt = db.prepare(
      'SELECT id, source_type, source_id, chunk_index, namespace, updated_at, embedding ' +
      'FROM sm_embeddings WHERE embedding IS NOT NULL ORDER BY updated_at DESC'
    );
    // .iterate() streams — peak memory is one row's text + the decoded cache,
    // never the whole corpus a second time.
    for (var row of stmt.iterate()) {
      var entry = decodeRow(row.source_type, row.source_id, row.chunk_index, row.namespace, row.updated_at, row.embedding);
      if (!entry) continue;
      entry.id = row.id;
      // SQL walked them newest-first; appending keeps that order (unshift
      // would reverse it — caught by the cap test on 2026-09-11).
      order.push(entry);
      byId.set(entry.id, entry);
    }
    var aggr = aggregates();
    maxId = aggr.maxId;
    baseline = aggr;
    baselineStale = false;
    built = true;
    builds++;
    lastBuildMs = Date.now() - t0;
  }

  // Reconcile against SQL truth before serving from the cache.
  function ensureFresh() {
    if (!built) { build(); return; }
    var aggr = aggregates();
    if (baselineStale) {
      // Hooks mutated optimistic state inside what may have been a live
      // transaction. If SQL truth matches the bookkeeping, the writes
      // committed — adopt the new baseline. If not (rollback, or a writer we
      // do not hook), rebuild from the table.
      if (aggr.embedded === byId.size && aggr.maxId === maxId) {
        baseline = aggr;
        baselineStale = false;
      } else {
        build();
      }
    } else if (aggr.embedded !== baseline.embedded || aggr.maxId !== baseline.maxId) {
      build(); // out-of-band write — self-heal
    }
  }

  // The query path. Mirrors searchVectorJsonPath's semantics: filters and the
  // bench exclusion apply BEFORE any cosine; the scan cap keeps the newest N
  // candidates among the filtered set; scores sort best-first with ties in
  // recency order.
  function scored(queryEmbedding, scanOpts) {
    scanOpts = scanOpts || {};
    ensureFresh();

    var typeSet = null;
    if (scanOpts.source_types && scanOpts.source_types.length > 0) {
      typeSet = new Set();
      for (var t of scanOpts.source_types) {
        var tid = typeIds.get(t);
        if (tid !== undefined) typeSet.add(tid);
      }
    }
    var nsFilter; // undefined = unfiltered
    if (scanOpts.namespace !== undefined && scanOpts.namespace !== null) {
      var nid = nsIds.get(scanOpts.namespace);
      nsFilter = nid === undefined ? -2 : nid; // -2 matches nothing: an unknown namespace holds no cached rows
    }
    var benchIn = benchOptIn(scanOpts);

    // Filter + cap in ONE pass down the recency order — the cap is the break.
    var tScan = Date.now();
    var candidates = [];
    for (var i = 0; i < order.length; i++) {
      var e = order[i];
      if (typeSet !== null && !typeSet.has(e.typeId)) continue;
      if (nsFilter !== undefined && e.nsId !== nsFilter) continue;
      if (!benchIn && e.isBench) continue;
      candidates.push(e);
      if (candidates.length >= scanCap) break;
    }
    lastScanCandidates = candidates.length;

    // Query side: round once to Float32 like the row side, norm in the same
    // ascending order cosineSimilarity uses.
    var qv = null, qNorm = 0, qLen = 0;
    if (queryEmbedding && queryEmbedding.length > 0) {
      qv = Float32Array.from(queryEmbedding);
      qLen = qv.length;
      var magA = 0;
      for (var q = 0; q < qLen; q++) magA += qv[q] * qv[q];
      qNorm = Math.sqrt(magA);
    }

    var out = new Array(candidates.length);
    for (var c = 0; c < candidates.length; c++) {
      var row = candidates[c];
      var score = 0;
      // dim mismatch mirrors cosineSimilarity's length check -> 0; a zero
      // norm on either side mirrors its denom === 0 -> 0.
      if (qv !== null && row.dim === qLen) {
        var dot = 0;
        var vec = row.vec;
        for (var j = 0; j < qLen; j++) dot += qv[j] * vec[j];
        var denom = qNorm * row.norm;
        score = denom === 0 ? 0 : dot / denom;
      }
      out[c] = { id: row.id, source_type: row.source_type, source_id: row.source_id, chunk_index: row.chunk_index, score: score };
    }
    out.sort(function (a, b) { return b.score - a.score; });
    lastScanMs = Date.now() - tScan;
    return out;
  }

  // -- write-path hooks (called by db.js AFTER the SQL write succeeded) -----
  // Every hook is fail-soft: the cache must never break a write. On any
  // internal error the cache drops itself and the next search rebuilds.

  // index() upsert + updateEmbedding(): re-read the row's post-write state,
  // decode once, put it at the front of the recency order (both paths stamp
  // updated_at = now). An embedding that went NULL removes the row.
  function onUpsert(sourceType, sourceId, chunkIndex) {
    if (!built) return;
    try {
      var row = db.prepare(
        'SELECT id, namespace, updated_at, embedding FROM sm_embeddings ' +
        'WHERE source_type = ? AND source_id = ? AND chunk_index = ?'
      ).get(sourceType, sourceId, chunkIndex);
      if (!row) return;
      baselineStale = true;
      dropById(row.id);
      var entry = decodeRow(sourceType, sourceId, chunkIndex, row.namespace, row.updated_at, row.embedding);
      if (entry) {
        entry.id = row.id;
        insertFront(entry);
      }
      if (row.id > maxId) maxId = row.id;
    } catch (e) { built = false; }
  }

  // remove() (fromChunkIndex null) and removeChunksFrom() (chunks >= from).
  function onRemovePair(sourceType, sourceId, fromChunkIndex) {
    if (!built) return;
    try {
      baselineStale = true;
      var removed = dropWhere(function (e) {
        return e.source_type === sourceType && e.source_id === sourceId &&
               (fromChunkIndex === null || e.chunk_index >= fromChunkIndex);
      });
      if (removed > 0) maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sm_embeddings').get().m;
    } catch (e) { built = false; }
  }

  // purge(): the exact filters the SQL applied (at least one is enforced by
  // the caller).
  function onPurge(filters) {
    if (!built) return;
    try {
      baselineStale = true;
      var f = filters || {};
      var removed = dropWhere(function (e) {
        if (f.source_type && e.source_type !== f.source_type) return false;
        if (f.namespace && e.namespace !== f.namespace) return false;
        return true;
      });
      if (removed > 0) maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sm_embeddings').get().m;
    } catch (e) { built = false; }
  }

  // Observability for the tests and the ops story — additive, read-only.
  function info() {
    return {
      built: built,
      rows: byId.size,
      rebuilds: builds,
      last_build_ms: lastBuildMs,
      last_scan_candidates: lastScanCandidates,
      last_scan_ms: lastScanMs,
      baseline_stale: baselineStale
    };
  }

  return {
    scored: scored,
    onUpsert: onUpsert,
    onRemovePair: onRemovePair,
    onPurge: onPurge,
    info: info
  };
}
