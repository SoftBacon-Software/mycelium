#!/usr/bin/env node
// bench-search-latency.mjs — the BEFORE/AFTER latency receipt for the
// semantic-memory search path (F-mycelium/194).
//
// Why this exists: on jetson01 (2026-09-10/09-11) the platform's event loop
// BLOCKED under concurrent /memory/search callers — accept queue full, node in
// R at 40% CPU, pingable but dead, twice in one night, and the 09-10 bench run
// r2 died of the same. Cause by reading: db.js searchVector loads up to 5000
// candidate rows per query and JSON.parses EVERY row's ~15 KB embedding text
// (768 floats) on the query path, then cosines in JS — O(capped_rows x 768)
// parse work on the loop, per query, per caller.
//
// What it measures — the query layer itself (server/plugins/semantic-memory/db.js
// called directly; NOT an HTTP bench — the wedge lived under the route). Against
// a temp SQLite DB seeded with N synthetic rows written THE WAY THE PLATFORM
// WRITES THEM (mem.index for the text + FTS trigger, mem.updateEmbedding for a
// JSON.stringify'd 768-d unit vector), for N in {1k, 5k, 25k}:
//
//   searchKeyword(text)             — the non-vector arm (baseline)
//   searchVector(vec)               — the arm that parses per query today
//   searchHybrid(text, opts, vec)   — what /memory/search actually runs
//
// For each arm: p50 / p95 latency over Q queries (default 30, after 3 warmup)
// and the event-loop BLOCKED span per query — measured with a recursive
// setImmediate gap monitor (worst single loop turn while the arm runs; its
// drift IS the blocking the Jetson died of). The first measured query is
// also printed on its own: after the 194 fix it carries the one-time decode
// of the whole corpus into the cache, and that number belongs to the receipt,
// not averaged away.
//
// 196 adds the drift scenario the brief names: prune 200 rows OUT-OF-BAND
// (raw SQL DELETE, the auto-memory unindexFacts worst case), then run 30
// searches. On the pre-196 shape the first of those searches met the full
// corpus rebuild synchronously on the loop; after 196 it carries an
// incremental reconcile that yields per decode batch. Reported as the worst
// loop stall across the whole window (target < 50 ms at 25k).
//
// Usage:
//   node tools/bench-search-latency.mjs [--sizes 1000,5000,25000] [--queries 30] [--dim 768]
//                                       [--seed 194] [--prune-rows 200] [--prune-queries 30]
//                                       [--keep] [--selftest] [--quiet]
//
//   --selftest  tiny N (12 rows), asserts the plumbing: rows are searchable on
//               all three arms, the self-vector query returns itself at ~1.0,
//               the probe registers positive blocking. Exit 1 on any failure.
//               Wired into the vitest suite (search-vector-decode-cache.test.js).
//
// Memory note for the fix this bench arbitrates: the decoded cache holds every
// embedded row's vector as Float32 — 25k rows x 768 dims x 4 B = 77 MB
// (today's live store: 4,030 embedded rows ≈ 12 MB). The bench does not
// measure that footprint; it is stated in vector-cache.js's header.

import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import Database from 'better-sqlite3';

const PLUGIN_DIR = new URL('../server/plugins/semantic-memory/', import.meta.url).pathname;
const SCHEMA_SQL = readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8');
const { default: createMemoryDB } = await import(join(PLUGIN_DIR, 'db.js'));

// ---------- deterministic RNG (mulberry32) — BEFORE/AFTER runs must seed identical data
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeUnitVec(rng, dim) {
  var v = new Array(dim);
  var norm = 0;
  for (var i = 0; i < dim; i++) { v[i] = rng() * 2 - 1; norm += v[i] * v[i]; }
  norm = Math.sqrt(norm) || 1;
  for (var j = 0; j < dim; j++) v[j] = v[j] / norm;
  return v;
}

// ---------- event-loop blocking probe ---------------------------------------
// A RECURSIVE setImmediate monitor spanning fn's whole run: every loop turn
// records the gap since the previous turn; `loop_blocked_ms` is the WORST
// gap. For a synchronous fn (better-sqlite3, the pre-196 query path) that is
// fn's entire runtime — the same number the old one-shot probe reported. For
// an async fn that yields (the 196 build/reconcile), it is the worst SINGLE
// tick, which is exactly the quantity the fix bounds (~500 rows/tick) — wall
// time is reported separately. Since 196 searchVector may await an in-flight
// build, fn is awaited.
async function withLoopProbe(fn) {
  var last = performance.now();
  var maxGap = 0;
  var running = true;
  function tick() {
    // Record FIRST, then decide whether to continue: fn can finish before the
    // first scheduled tick fires (a short synchronous query), and that first
    // gap IS fn's runtime — bailing before recording would report 0.
    var now = performance.now();
    if (now - last > maxGap) maxGap = now - last;
    last = now;
    if (running) setImmediate(tick);
  }
  setImmediate(tick);
  var t0 = performance.now();
  var result = await fn();
  var syncMs = performance.now() - t0;
  // Drain one loop turn before reading maxGap: the await continuation runs as
  // a microtask, which beats the check phase — the tick that covers fn's span
  // has not fired yet when fn resolves. One setImmediate turn lets it land.
  await new Promise(function (res) { setImmediate(res); });
  running = false;
  return {
    result: result,
    sync_ms: syncMs,
    loop_blocked_ms: maxGap
  };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  var idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function stats(samples) {
  var lat = samples.map(function (s) { return s.ms; }).sort(function (a, b) { return a - b; });
  var blk = samples.map(function (s) { return s.blocked; }).sort(function (a, b) { return a - b; });
  return {
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    blocked_p50: percentile(blk, 50),
    blocked_p95: percentile(blk, 95),
    blocked_max: blk[blk.length - 1]
  };
}

// ---------- seeding ----------------------------------------------------------
const VOCAB_SIZE = 200;
function makeVocab(rng) {
  var words = [];
  for (var i = 0; i < VOCAB_SIZE; i++) {
    var w = 'w';
    for (var c = 0; c < 6; c++) w += String.fromCharCode(97 + Math.floor(rng() * 26));
    words.push(w);
  }
  return words;
}

function seedDb(dbPath, nRows, dim, rng) {
  var db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  var mem = createMemoryDB(db);
  var vocab = makeVocab(rng);

  var vectors = new Array(nRows);
  var texts = new Array(nRows);
  for (var i = 0; i < nRows; i++) {
    vectors[i] = makeUnitVec(rng, dim);
    var words = [];
    for (var w = 0; w < 10; w++) words.push(vocab[Math.floor(rng() * VOCAB_SIZE)]);
    texts[i] = words.join(' ');
  }

  var seedTxn = db.transaction(function () {
    for (var r = 0; r < nRows; r++) {
      var id = 'bench-row-' + r;
      // Namespace must NOT start with 'bench-' — the F-mycelium/165 exclusion
      // would hide every row from plain queries and the arms would time empty
      // scans (this bench did exactly that on its first run: 13 ms "vector"
      // at 25k rows because all rows were bench-hidden).
      mem.index('doc', id, texts[r], { namespace: 'latency-lab' });
      mem.updateEmbedding('doc', id, 0, vectors[r], 'bench-model');
    }
  });
  var tSeed0 = performance.now();
  seedTxn();
  var seedMs = performance.now() - tSeed0;

  return {
    db: db,
    mem: mem,
    vectors: vectors,
    texts: texts,
    vocab: vocab,
    seedMs: seedMs
  };
}

function pickQueryText(rng, vocab) {
  return vocab[Math.floor(rng() * vocab.length)] + ' ' +
         vocab[Math.floor(rng() * vocab.length)] + ' ' +
         vocab[Math.floor(rng() * vocab.length)];
}

// ---------- the 196 scenario: prune out-of-band, then search -----------------
// Production trigger: auto-memory's unindexFacts raw-DELETEs embedded rows
// (a 6-hour prune timer, or any extraction past max_facts_per_agent), the
// freshness signature moves, and the NEXT search met a full synchronous
// corpus rebuild — the 194 shape's remaining loop-blocker. This scenario
// deletes rows with RAW SQL (the maintenance-script worst case; the
// unindexFacts hook path is pinned in the unit tests), then runs searches,
// and reports the worst event-loop stall across the whole window. Target
// after the 196 fix: < 50 ms at 25k rows.
async function pruneScenario(ctx, pruneRows, nQueries, log) {
  var targets = [];
  for (var i = 0; i < pruneRows; i++) targets.push('bench-row-' + i);
  // Mirror the production pruner's predicate shape: unindexFacts deletes
  // WHERE source_type = ? AND source_id = ? so idx_sm_source serves it
  // (21 ms per 200 rows at 25k, measured). Deleting by source_id ALONE
  // cannot use that index and degrades to a full table scan (~16 ms/row at
  // 25k) — that measures a missing-index bug in the pruner, not the
  // freshness heal, and it drowned this scenario's number on its first run.
  var del = ctx.db.prepare("DELETE FROM sm_embeddings WHERE source_type = 'doc' AND source_id = ?");
  var mon = null;
  var maxSpan = 0;
  // Phase attribution: the monitor names the phase that owned the worst stall
  // (the prune DELETE stretch, the heal search, or a steady-state search), so
  // a bad number points at the right code rather than at the scenario.
  var phase = 'prune-deletes';
  var maxPhase = 'prune-deletes';
  var t0 = performance.now();
  mon = (function () {
    var last = performance.now();
    var max = 0;
    var running = true;
    (function tick() {
      // Record FIRST (see withLoopProbe): the synchronous prune DELETEs can
      // finish before the first tick fires, and that gap must count.
      var now = performance.now();
      if (now - last > max) { max = now - last; maxPhase = phase; }
      last = now;
      if (running) setImmediate(tick);
    })();
    return { stop: function () { running = false; return { max: max, maxPhase: maxPhase }; } };
  })();
  for (var t of targets) del.run(t); // out-of-band by construction — no hook sees these
  var gone = new Set(targets);
  for (var q = 0; q < nQueries; q++) {
    phase = 'search-' + q + (q === 0 ? ' (carries the heal)' : '');
    var v = ctx.vectors[q % ctx.vectors.length];
    var rows = await ctx.mem.searchVector(v, { limit: 10 });
    // Force a real loop turn between operations: a cache-hit search is fully
    // synchronous inside a microtask chain (yields exist only in the decode
    // path), so without this the monitor would collapse the delete loop, the
    // heal and all 30 searches into one giant "gap" instead of attributing
    // the worst SINGLE stall. Production searches arrive as separate
    // macrotasks (HTTP requests); this restores that boundary.
    await new Promise(function (res) { setImmediate(res); });
    if (q === 0) {
      for (var r of rows) {
        if (gone.has(r.source_id)) throw new Error('prune scenario: deleted row ' + r.source_id + ' still in results — the freshness machinery failed');
      }
      if (rows.length === 0) throw new Error('prune scenario: zero results after prune — refusing to report a number off an empty scan');
    }
  }
  var wallMs = performance.now() - t0;
  // Same drain rule as withLoopProbe: let the in-flight tick record the final
  // gap (the last search's tail) before stopping the monitor.
  await new Promise(function (res) { setImmediate(res); });
  var worst = mon.stop();
  maxSpan = worst.max;
  log('  prune-' + pruneRows + ' scenario: worst loop stall ' + maxSpan.toFixed(1) + ' ms (' + worst.maxPhase + ') across the prune + ' + nQueries + ' searches (wall ' + (wallMs / 1000).toFixed(2) + ' s) — target < 50 ms');
  return { max_span_ms: maxSpan, max_span_phase: worst.maxPhase, wall_ms: wallMs, pruned: pruneRows, queries: nQueries };
}

// ---------- one size tier ----------------------------------------------------
async function benchSize(nRows, opts, log) {
  var dim = opts.dim;
  var rng = mulberry32(opts.seed + nRows); // per-size stream, reproducible
  var tmp = mkdtempSync(join(tmpdir(), 'sm-bench-194-'));
  var dbPath = join(tmp, 'sm-bench.db');

  var ctx = seedDb(dbPath, nRows, dim, rng);
  var mem = ctx.mem;

  log('# N=' + nRows + ' rows, dim=' + dim + ' — seeded in ' + (ctx.seedMs / 1000).toFixed(1) + 's at ' + dbPath);

  // Sanity gate BEFORE any timing: an arm that returns zero rows means the
  // seed or the filters hid the data and every number below is meaningless.
  // (Refuses to print a table rather than print a lie.)
  var sanityV = await mem.searchVector(ctx.vectors[0], { limit: 10 });
  var sanityK = mem.searchKeyword(ctx.texts[3].split(' ').slice(0, 3).join(' '), { limit: 10 });
  var sanityH = await mem.searchHybrid(ctx.texts[5].split(' ').slice(0, 3).join(' '), { limit: 10 }, ctx.vectors[1]);
  if (sanityV.length === 0 || sanityK.length === 0 || sanityH.length === 0) {
    ctx.db.close();
    rmSync(tmp, { recursive: true, force: true });
    throw new Error('N=' + nRows + ': sanity FAILED (vector=' + sanityV.length +
      ' keyword=' + sanityK.length + ' hybrid=' + sanityH.length +
      ' rows expected visible) — arms would time empty scans; refusing to measure');
  }
  log('  sanity: vector=' + sanityV.length + ' keyword=' + sanityK.length + ' hybrid=' + sanityH.length + ' rows returned');

  var arms = [
    {
      name: 'keyword',
      run: function () { return mem.searchKeyword(pickQueryText(rng, ctx.vocab), { limit: 10 }); }
    },
    {
      name: 'vector',
      run: (function () {
        var qi = 0;
        return function () {
          var v = ctx.vectors[qi % ctx.vectors.length]; qi++;
          return mem.searchVector(v, { limit: 10 });
        };
      })()
    },
    {
      name: 'hybrid',
      run: (function () {
        var qi = 0;
        return function () {
          var v = ctx.vectors[qi % ctx.vectors.length]; qi++;
          return mem.searchHybrid(pickQueryText(rng, ctx.vocab), { limit: 10 }, v);
        };
      })()
    }
  ];

  // Warmup (3 per arm): absorbs JIT + page cache — and, after the 194 fix,
  // the one-time corpus decode. That first-query cost is printed separately
  // below instead of being averaged into the p50/p95.
  for (var a of arms) {
    var tFirst = performance.now();
    await a.run();
    var firstMs = performance.now() - tFirst;
    a.firstMs = firstMs;
    for (var w = 0; w < 2; w++) await a.run();
  }

  var results = {};
  for (var arm of arms) {
    var samples = [];
    for (var q = 0; q < opts.queries; q++) {
      var t0 = performance.now();
      var r = await withLoopProbe(arm.run);
      var t1 = performance.now();
      samples.push({ ms: t1 - t0, blocked: r.loop_blocked_ms });
    }
    results[arm.name] = { stats: stats(samples), firstMs: arm.firstMs };
  }

  log('');
  log('  arm        first-ms    p50-ms    p95-ms   blocked-p50   blocked-p95   blocked-max');
  for (var name of ['keyword', 'vector', 'hybrid']) {
    var s = results[name].stats;
    log('  ' + name.padEnd(10) +
        String((results[name].firstMs / 1).toFixed(1)).padStart(9) +
        String(s.p50.toFixed(1)).padStart(10) +
        String(s.p95.toFixed(1)).padStart(10) +
        String(s.blocked_p50.toFixed(1)).padStart(14) +
        String(s.blocked_p95.toFixed(1)).padStart(14) +
        String(s.blocked_max.toFixed(1)).padStart(14));
  }
  log('');

  var prune = await pruneScenario(ctx, opts.pruneRows, opts.pruneQueries, log);
  results.prune_scenario = prune;

  ctx.db.close();
  if (!opts.keep) rmSync(tmp, { recursive: true, force: true });
  return results;
}

// ---------- selftest ---------------------------------------------------------
async function selftest(log) {
  var failures = [];
  function check(name, cond) {
    if (cond) log('  ok  ' + name);
    else { log('  FAIL ' + name); failures.push(name); }
  }

  var dim = 64;
  var rng = mulberry32(1);
  var tmp = mkdtempSync(join(tmpdir(), 'sm-bench-selftest-'));
  var dbPath = join(tmp, 'selftest.db');
  var db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  var mem = createMemoryDB(db);

  // 12 rows; row 0 has a distinct marker word + a known vector.
  var target = makeUnitVec(rng, dim);
  mem.index('doc', 'target', 'zebra marker token here', {});
  mem.updateEmbedding('doc', 'target', 0, target, 'selftest');
  for (var i = 1; i < 12; i++) {
    mem.index('doc', 'row-' + i, 'plain filler words ' + i, {});
    mem.updateEmbedding('doc', 'row-' + i, 0, makeUnitVec(rng, dim), 'selftest');
  }

  var kw = mem.searchKeyword('zebra marker', { limit: 10 });
  check('keyword arm finds the marker row', kw.length >= 1 && kw[0].source_id === 'target');

  var vec = await mem.searchVector(target, { limit: 12 });
  check('vector arm returns the self vector as top-1', vec.length >= 1 && vec[0].source_id === 'target');
  check('self-vector score is ~1.0 (got ' + (vec[0] ? vec[0].score.toFixed(6) : 'none') + ')',
        vec.length >= 1 && Math.abs(vec[0].score - 1) < 1e-5);

  var hyb = await mem.searchHybrid('zebra marker', { limit: 10 }, target);
  check('hybrid arm returns results', hyb.length >= 1);

  var probe = await withLoopProbe(function () {
    var s = 0;
    for (var i = 0; i < 1e6; i++) s += i;
    return s;
  });
  check('loop probe registers positive blocking (' + probe.loop_blocked_ms.toFixed(3) + ' ms)',
        probe.loop_blocked_ms > 0 && probe.sync_ms > 0);

  // 196 correctness-only mini prune scenario: raw-DELETE two embedded rows
  // out-of-band (no hook runs), then search — the freshness machinery must
  // reconcile before serving, never return a ghost. Timing is NOT asserted
  // here (12 rows); the number at production scale comes from the main run.
  db.prepare("DELETE FROM sm_embeddings WHERE source_id IN ('row-1', 'row-2')").run();
  var afterPrune = await mem.searchVector(target, { limit: 12 });
  var prunedIds = afterPrune.map(function (r) { return r.source_id; });
  check('prune scenario: raw-deleted rows never come back from a search',
        prunedIds.indexOf('row-1') === -1 && prunedIds.indexOf('row-2') === -1 && afterPrune.length >= 1);

  db.close();
  rmSync(tmp, { recursive: true, force: true });

  if (failures.length) {
    log('selftest FAILED: ' + failures.join('; '));
    process.exitCode = 1;
  } else {
    log('selftest PASS');
  }
  return failures.length === 0;
}

// ---------- main -------------------------------------------------------------
function parseArgs(argv) {
  var opts = { sizes: [1000, 5000, 25000], queries: 30, dim: 768, seed: 194, pruneRows: 200, pruneQueries: 30, keep: false, selftest: false, quiet: false };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--sizes') opts.sizes = argv[++i].split(',').map(Number);
    else if (a === '--queries') opts.queries = parseInt(argv[++i], 10);
    else if (a === '--dim') opts.dim = parseInt(argv[++i], 10);
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--prune-rows') opts.pruneRows = parseInt(argv[++i], 10);
    else if (a === '--prune-queries') opts.pruneQueries = parseInt(argv[++i], 10);
    else if (a === '--keep') opts.keep = true;
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

var opts = parseArgs(process.argv.slice(2));
var log = function (line) { if (!opts.quiet) console.log(line); };

if (opts.help) {
  console.log('usage: node tools/bench-search-latency.mjs [--sizes 1000,5000,25000] [--queries 30] [--dim 768] [--seed 194] [--prune-rows 200] [--prune-queries 30] [--keep] [--selftest]');
} else if (opts.selftest) {
  await selftest(log);
} else {
  log('semantic-memory search latency bench (F-mycelium/194+196) — ' + new Date().toISOString());
  log('queries per arm: ' + opts.queries + ' (after 3 warmup); worst loop-turn gap via setImmediate monitor');
  log('prune scenario: ' + opts.pruneRows + ' rows raw-DELETEd out-of-band, then ' + opts.pruneQueries + ' searches');
  log('');
  var all = {};
  for (var s of opts.sizes) all[s] = await benchSize(s, opts, log);
  log('done.');
}
