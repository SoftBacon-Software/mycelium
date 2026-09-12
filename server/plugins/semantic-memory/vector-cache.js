// Decoded-vector cache behind searchVector (2026-09-11, F-mycelium/194;
// rebuild discipline 2026-09-11, F-mycelium/196).
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
//     auto-memory's unindexFacts — the one known out-of-band writer — is
//     hooked too since 196, via a per-db side-channel (see onRemoveMany),
//     so the in-process path never needs the signature at all.
//   - a 2-aggregate signature — embedded-row count (via a partial index) and
//     MAX(id) — is checked per search, so writers nothing hooks (standalone
//     maintenance scripts) self-heal on the next search. A rolled-back
//     transaction self-heals the same way: hooks run optimistically inside
//     the transaction, the signature is read back from SQL truth after it.
//   - documented gap: an out-of-band writer that changes an embedding VALUE,
//     namespace or source_type on an EXISTING row (a raw UPDATE) moves
//     neither COUNT nor MAX(id) — invisible to the signature, and the cached
//     scores stay stale until some other write moves the signature. No
//     product path does this (the embed scheduler lands vectors through
//     updateEmbedding's hook; the only raw UPDATE in product code is that
//     hook's own site — pinned by the delete-only tripwire in
//     test/unit/vector-cache-rebuild-resilience.test.js). The final top-N
//     rows are still fetched live from the table, so only the RANKING could
//     be stale, never the returned row content.
//
// REBUILD DISCIPLINE (F-mycelium/196 — 194 could still block the loop):
//   194 kept the build unbounded and synchronous, and production re-triggers
//   it: every signature drift re-decoded the WHOLE corpus on the event loop
//   (~390 ms at 25k rows, 2-4x on the Jetson). Three changes:
//   1. INCREMENTAL — a drift reconciles by id: the light id-scan is diffed
//      against the cache; rows SQL lost are dropped, rows SQL gained are
//      decoded. A 200-row prune costs an id scan + 200 drops, not 25k
//      JSON.parses (test/unit/vector-cache-rebuild-resilience.test.js).
//   2. YIELDING — decodes run in batches of decodeBatchRows (500) with
//      setImmediate between batches, so no single tick carries more than
//      ~500 x 15 KB of JSON.parse (~20 ms — inside the loop budget the
//      wedge investigation set). Searches arriving mid-build await the ONE
//      in-flight build promise; two builds never run concurrently.
//   3. BREAKER — a build that throws opens a JSON-fallback window (30 s
//      doubling to 10 min): inside a window searches skip the cache
//      entirely and serve the pre-194 JSON path, with ONE log line per
//      window. Before this, a persistently failing build made every search
//      pay the full build attempt AND the fallback — strictly more work
//      than before the cache existed, forever, silently. State is exposed
//      through info() → db.stats().vector_cache.
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
  // Rows decoded per event-loop tick during a build/reconcile. 500 x ~15 KB
  // of JSON.parse stays inside the ~20 ms/tick budget; injectable so tests
  // can force a multi-tick build on a tiny corpus.
  var decodeBatchRows = opts.decodeBatchRows || 500;
  // Breaker windows: 30 s after the first failure, doubling, capped at
  // 10 min. Injectable so the breaker test runs in milliseconds.
  var backoffBaseMs = opts.buildBackoffBaseMs || 30000;
  var backoffMaxMs = opts.buildBackoffMaxMs || 600000;

  // rowid -> entry; `order` holds the same entries sorted updated_at DESC.
  var byId = new Map();
  var order = [];
  var built = false;
  var building = false;
  var buildPromise = null;    // the ONE in-flight build/reconcile, or null
  var baseline = null;        // last signature the SQL truth confirmed
  var baselineStale = false;  // a hook mutated state inside a live transaction
  var maxId = 0;

  var builds = 0;
  var reconciles = 0;
  var lastBuildMs = 0;
  var lastScanCandidates = 0;
  var lastScanMs = 0;

  // Breaker state (see header, point 3).
  var buildFailures = 0;
  var fallbackUntil = 0;      // epoch ms while a fallback window is open
  var fallbackQueries = 0;    // searches that went JSON because of the breaker
  var lastBuildError = null;

  // SQL signature — 2 aggregates, both index-only (idx_sm_embedded is the
  // partial index on embedding IS NOT NULL; MAX(rowid) is O(1)). This is what
  // catches writers that bypass db.js AND the unindexFacts hook.
  function aggregates() {
    return {
      embedded: db.prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c,
      maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sm_embeddings').get().m
    };
  }

  // The light opener every build/reconcile shares: the embedded id set in
  // recency order. The MARKER comment is a test seam — the breaker test
  // proxies the db and throws on exactly this statement.
  var ID_SCAN = '/* vector-cache:scan-ids */ SELECT id FROM sm_embeddings ' +
    'WHERE embedding IS NOT NULL ORDER BY updated_at DESC';

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

  // SQLite's TEXT ORDER BY is BINARY collation — plain `<` on the ISO-ish
  // timestamps mirrors it, NULLs last, same as `ORDER BY updated_at DESC`.
  function byRecencyDesc(a, b) {
    if (a.updated_at === b.updated_at) return 0;
    return a.updated_at < b.updated_at ? 1 : -1;
  }

  function yieldTick() {
    return new Promise(function (res) { setImmediate(res); });
  }

  // Decode the given ids in batches, yielding the loop between batches so no
  // single tick blocks longer than ~decodeBatchRows x JSON.parse (header,
  // point 2). Returns flat decoded entries (unparseable rows skipped).
  async function decodeIds(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i += decodeBatchRows) {
      var chunk = ids.slice(i, i + decodeBatchRows);
      var stmt = db.prepare(
        'SELECT id, source_type, source_id, chunk_index, namespace, updated_at, embedding ' +
        'FROM sm_embeddings WHERE id IN (' + chunk.map(function () { return '?'; }).join(',') + ')'
      );
      var rows = stmt.all.apply(stmt, chunk);
      for (var r of rows) {
        var entry = decodeRow(r.source_type, r.source_id, r.chunk_index, r.namespace, r.updated_at, r.embedding);
        if (!entry) continue;
        entry.id = r.id;
        out.push(entry);
      }
      if (i + decodeBatchRows < ids.length) await yieldTick();
    }
    return out;
  }

  // Build ('rebuild': cold cache) and reconcile ('reconcile': drift) share
  // one batched, yield-shaped path. Both converge the cache to SQL truth;
  // they differ only in what they do with what they already hold.
  async function runBuild(kind) {
    building = true;
    var t0 = Date.now();
    try {
      if (kind === 'rebuild') {
        byId = new Map();
        order = [];
      }
      var idRows = db.prepare(ID_SCAN).all();
      var sqlIds = new Set();
      var missing = [];
      for (var r of idRows) {
        sqlIds.add(r.id);
        if (!byId.has(r.id)) missing.push(r.id);
      }
      if (kind === 'reconcile') {
        // Drop what SQL lost in one pass (no per-entry splice).
        var kept = [];
        for (var i = 0; i < order.length; i++) {
          if (sqlIds.has(order[i].id)) kept.push(order[i]);
          else byId.delete(order[i].id);
        }
        order = kept;
      }
      var decoded = await decodeIds(missing);
      for (var d of decoded) {
        order.push(d);
        byId.set(d.id, d);
      }
      // The id scan ordered ids by recency but the IN-fetches return rows in
      // arbitrary order — one sort restores the global updated_at DESC order
      // `order` must hold (the scan cap's early break depends on it).
      if (decoded.length > 0) order.sort(byRecencyDesc);

      var aggr = aggregates();
      maxId = aggr.maxId;
      baseline = aggr;
      baselineStale = false;
      built = true;
      if (kind === 'rebuild') builds++; else reconciles++;
      lastBuildMs = Date.now() - t0;
    } catch (err) {
      // Cache state is now unknown relative to SQL — refuse to serve from it
      // and open the fallback window (searches skip to the JSON path until
      // the window expires and a build retries).
      built = false;
      recordBuildFailure(err);
    } finally {
      building = false;
      // buildPromise is cleared by startBuild() AFTER the assignment lands —
      // a failed build's synchronous catch must not null the var before the
      // caller stores it (that would strand every later search on a
      // permanently-resolved promise and the breaker would never retry).
    }
  }

  // Registers a build as the ONE in-flight build and returns its promise.
  // runBuild's body runs synchronously up to its first yield (and a failed
  // build fails synchronously), so the clear must happen in a microtask
  // AFTER the assignment below — never inside runBuild itself.
  function startBuild(kind) {
    var p = runBuild(kind);
    buildPromise = p;
    p.then(function () { if (buildPromise === p) buildPromise = null; });
    return p;
  }

  function recordBuildFailure(err) {
    buildFailures++;
    lastBuildError = err && err.message ? err.message : String(err);
    var windowMs = Math.min(backoffBaseMs * Math.pow(2, buildFailures - 1), backoffMaxMs);
    fallbackUntil = Date.now() + windowMs;
    // ONE distinct line per window — a search inside an open window logs
    // nothing (it never attempts a build), so the log rate is the failure
    // rate, not the query rate.
    console.error('[semantic-memory] vector cache build failed: ' + lastBuildError +
      '; JSON fallback for ' + Math.round(windowMs / 1000) + 's');
  }

  // Reconcile against SQL truth before serving from the cache. Resolves when
  // the cache is either fresh or (breaker open) known-unavailable — callers
  // check available() after awaiting. Searches arriving mid-build join the
  // in-flight build's promise; two builds never run concurrently.
  function ensureFresh() {
    if (buildPromise) return buildPromise;
    if (!built) {
      // Inside a window: no build attempt at all. The fallback search is
      // counted once, by the caller (fallbackServed), not here.
      if (Date.now() < fallbackUntil) { return Promise.resolve(); }
      return startBuild('rebuild');
    }
    var aggr;
    try { aggr = aggregates(); }
    catch (e) {
      built = false;
      recordBuildFailure(e);
      return Promise.resolve();
    }
    if (baselineStale) {
      // Hooks mutated optimistic state inside what may have been a live
      // transaction. If SQL truth matches the bookkeeping, the writes
      // committed — adopt the new baseline. If not (rollback, or a writer we
      // do not hook), reconcile to the table — incremental since 196.
      if (aggr.embedded === byId.size && aggr.maxId === maxId) {
        baseline = aggr;
        baselineStale = false;
        return Promise.resolve();
      }
      return startBuild('reconcile');
    }
    if (aggr.embedded !== baseline.embedded || aggr.maxId !== baseline.maxId) {
      return startBuild('reconcile'); // out-of-band write — incremental self-heal
    }
    return Promise.resolve();
  }

  function available() { return built; }
  function fallbackServed() { fallbackQueries++; }

  // The query path. Mirrors searchVectorJsonPath's semantics: filters and the
  // bench exclusion apply BEFORE any cosine; the scan cap keeps the newest N
  // candidates among the filtered set; scores sort best-first with ties in
  // recency order. REQUIRES an awaited ensureFresh() first (db.js's search
  // path awaits it; direct callers must too) — this throws rather than
  // silently serving an empty cache.
  function scored(queryEmbedding, scanOpts) {
    if (!built) {
      throw new Error('vector cache not ready — await ensureFresh() before scored()');
    }
    scanOpts = scanOpts || {};

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

  // F-mycelium/196: the unindexFacts batch shape (auto-memory deletes N
  // facts' rows in one call). One pass for N ids — the per-pair hook would
  // rescan the recency order per id. Wired from auto-memory/db.js through a
  // per-db side-channel (db.__myceliumVectorCache, set by createMemoryDB —
  // both plugins receive the same core.db instance), so neither plugin
  // imports the other and auto-memory stays loadable when this plugin is
  // not deployed. Fail-soft like every hook.
  function onRemoveMany(sourceType, sourceIds) {
    if (!built) return;
    try {
      var doomed = new Set();
      var list = sourceIds || [];
      for (var s of list) doomed.add(String(s));
      if (doomed.size === 0) return;
      baselineStale = true;
      var removed = dropWhere(function (e) {
        return e.source_type === sourceType && doomed.has(e.source_id);
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
  // Surfaced on GET /stats as stats().vector_cache (db.js stats()).
  function info() {
    return {
      built: built,
      building: building,
      rows: byId.size,
      rebuilds: builds,
      reconciles: reconciles,
      last_build_ms: lastBuildMs,
      last_scan_candidates: lastScanCandidates,
      last_scan_ms: lastScanMs,
      baseline_stale: baselineStale,
      decode_batch_rows: decodeBatchRows,
      build_failures: buildFailures,
      fallback_until_ms: fallbackUntil,
      fallback_queries: fallbackQueries,
      last_build_error: lastBuildError
    };
  }

  return {
    ensureFresh: ensureFresh,
    available: available,
    fallbackServed: fallbackServed,
    scored: scored,
    onUpsert: onUpsert,
    onRemovePair: onRemovePair,
    onRemoveMany: onRemoveMany,
    onPurge: onPurge,
    info: info
  };
}
