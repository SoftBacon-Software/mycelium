// The decoded-vector cache behind searchVector (2026-09-11, F-mycelium/194).
//
// Why: searchVector was JSON.parsing EVERY candidate row's ~15 KB embedding
// text (768 floats) on every query, on the event loop — measured 2.4-4.3 s per
// query at 5,852 rows on jetson01, and it blocked the loop hard enough under
// concurrent callers to wedge the platform twice on 09-10/09-11 (accept queue
// full, node in R, pingable but dead). The fix decodes each row's vector ONCE
// into an in-memory Float32 cache, invalidated on the write paths, and never
// parses on the query path.
//
// What this file pins:
//   identity   — cached results are IDENTICAL to the JSON path (the original
//                algorithm, kept verbatim as searchVectorJsonPath as the
//                oracle): same ranking, same scores to 1e-6, same row shape,
//                across filters, bench opt-ins, limits, chunk collapse, and
//                degenerate inputs (zero vectors, dim mismatch).
//   invalid.   — index / updateEmbedding / remove / removeChunksFrom /
//                purge / bulkIndex all keep the cache exact, and an
//                OUT-OF-BAND raw SQL delete (what auto-memory's unindexFacts
//                does — a writer this module does not hook) self-heals on the
//                next search through the freshness signature.
//   pre-cosine — the bench exclusion (F-mycelium/165) and the
//                namespace/source_type filters are applied BEFORE the cosine
//                loop: a bench row is never scored for a plain query, proven
//                via the candidate count the cache reports.
//   cap        — the 5,000-row recency cap (DoS bound, preserved semantics)
//                selects the NEWEST candidates among the FILTERED set, as the
//                old SQL's ORDER BY updated_at DESC LIMIT 5000 did.
//
// Models on test/unit/memory-bench-namespace-invisibility.test.js: vitest +
// better-sqlite3 ':memory:' seeded from schema.sql — hermetic, no network.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'server', 'plugins', 'semantic-memory');

function unitVec(rng, dim) {
  const v = new Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) { v[i] = rng() * 2 - 1; norm += v[i] * v[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


const DIM = 8;

// Fixture: mixed types/namespaces (incl. both bench shapes), one multi-chunk
// doc, one zero-vector row. updated_at is set EXPLICITLY per row afterwards —
// datetime('now') has 1-second granularity, and both search paths order by it,
// so ties would make the identity assertion order-sensitive for the wrong
// reason. Deterministic vectors via mulberry32.
const SEED = [];
(function buildSeed() {
  const rng = mulberry32(194);
  let n = 0;
  const add = (source_type, source_id, namespace, chunk_index = 0) =>
    SEED.push({ source_type, source_id, namespace, chunk_index, vec: unitVec(rng, DIM), n: n++ });
  for (let i = 0; i < 8; i++) add('note', 'note-' + i, null);
  for (let i = 0; i < 4; i++) add('preference', 'pref-' + i, 'proj-a');
  for (let i = 0; i < 2; i++) add('note', 'proja-note-' + i, 'proj-a');
  for (let i = 0; i < 2; i++) add('bench_longmemeval', 'bm-' + i, 'bench-p194'); // bench TYPE
  for (let i = 0; i < 2; i++) add('note', 'bmns-' + i, 'bench-p194-ns');          // bench NAMESPACE
  add('doc', 'big-doc', null, 0);                                                  // multi-chunk
  add('doc', 'big-doc', null, 1);
  SEED.push({ source_type: 'note', source_id: 'zero-row', namespace: null, chunk_index: 0, vec: [0, 0, 0, 0, 0, 0, 0, 0], n: n++ });
  for (let i = 0; i < 3; i++) add('lesson', 'lesson-' + i, null);
})();

async function makeCtx() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));
  const { default: createMemoryDB } = await import(join(PLUGIN_DIR, 'db.js'));
  const mem = createMemoryDB(db);
  const rngVec = mulberry32(7);
  for (const r of SEED) {
    mem.index(r.source_type, r.source_id, 'content for ' + r.source_id + ' chunk ' + r.chunk_index, {
      namespace: r.namespace, chunk_index: r.chunk_index,
    });
    mem.updateEmbedding(r.source_type, r.source_id, r.chunk_index, r.vec, 'test-model');
  }
  // Distinct updated_at per seed order — both paths ORDER BY updated_at DESC.
  const setUpdated = db.prepare("UPDATE sm_embeddings SET updated_at = ? WHERE source_type = ? AND source_id = ? AND chunk_index = ?");
  const base = Date.UTC(2026, 8, 11, 12, 0, 0);
  SEED.forEach((r, i) => {
    const d = new Date(base + i * 60000);
    setUpdated.run(d.toISOString().replace('T', ' ').slice(0, 19), r.source_type, r.source_id, r.chunk_index);
  });
  const queries = {
    self: SEED[0].vec,
    mid: SEED[10].vec,
    random: unitVec(rngVec, DIM),
    zero: [0, 0, 0, 0, 0, 0, 0, 0],
    wrongDim: [1, 2, 3, 4],
  };
  return { db, mem, queries };
}

const FILTER_CASES = [
  {},
  { source_types: ['note'] },
  { namespace: 'proj-a' },
  { source_types: ['bench_longmemeval'] },       // bench opt-in via type
  { namespace: 'bench-p194-ns' },                // bench opt-in via namespace
  { limit: 3 },
  { limit: 100 },
  { source_types: ['note', 'preference'], namespace: 'proj-a', limit: 4 },
];

describe('searchVector cached results are identical to the JSON path', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeCtx(); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('same ranking and scores to 1e-6 across queries x filters (incl. zero-vector and dim-mismatch)', () => {
    let cases = 0;
    for (const qname of Object.keys(ctx.queries)) {
      for (const filter of FILTER_CASES) {
        cases++;
        const ctxLine = JSON.stringify({ qname, filter });
        const viaJson = ctx.mem.searchVectorJsonPath(ctx.queries[qname], { ...filter });
        const viaCache = ctx.mem.searchVector(ctx.queries[qname], { ...filter });
        expect(viaCache.length, ctxLine).toBe(viaJson.length);
        // Ranking identical: same rows, same order.
        expect(viaCache.map((r) => r.source_type + ':' + r.source_id + ':' + r.chunk_index), ctxLine)
          .toEqual(viaJson.map((r) => r.source_type + ':' + r.source_id + ':' + r.chunk_index));
        // Scores to 1e-6 (the cache rounds to Float32; agreement is ~1e-7 —
        // do NOT compare rounded scores for exact equality, that demands 1e-9).
        for (let i = 0; i < viaJson.length; i++) {
          expect(Math.abs(viaCache[i].score - viaJson[i].score), ctxLine).toBeLessThanOrEqual(1e-6);
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(40);
  });

  it('identical row SHAPE: the cache path returns the same full rows the JSON path did', () => {
    const a = ctx.mem.searchVectorJsonPath(ctx.queries.self, { limit: 2 });
    const b = ctx.mem.searchVector(ctx.queries.self, { limit: 2 });
    expect(Object.keys(b[0]).sort()).toEqual(Object.keys(a[0]).sort());
    expect(b[0].content_text).toBe(a[0].content_text);
    expect(b[0].metadata).toEqual(a[0].metadata);
    expect(b[0].embedding_model).toBe(a[0].embedding_model);
  });

  it('hybrid stays consistent too (RRF over the cached vector arm vs the JSON arm)', () => {
    const hybrid = ctx.mem.searchHybrid('content for note-0', { limit: 5 }, ctx.queries.self);
    expect(hybrid.length).toBeGreaterThanOrEqual(1);
    // The cached arm must contribute the same vector scores to the fusion as
    // the JSON arm would: recompute the fusion manually over the JSON path.
    const kw = ctx.mem.searchKeyword('content for note-0', { limit: 10 });
    const vec = ctx.mem.searchVectorJsonPath(ctx.queries.self, { limit: 10 });
    const K = 60;
    const scores = {};
    kw.forEach((r, i) => {
      const k = r.source_type + ':' + r.source_id + ':' + (r.chunk_index || 0);
      scores[k] = (scores[k] || 0) + 1 / (K + i + 1);
    });
    vec.forEach((r, i) => {
      const k = r.source_type + ':' + r.source_id + ':' + (r.chunk_index || 0);
      scores[k] = (scores[k] || 0) + 1 / (K + i + 1);
    });
    expect(hybrid.length).toBeLessThanOrEqual(Object.keys(scores).length);
    for (const r of hybrid) {
      const k = r.source_type + ':' + r.source_id + ':' + (r.chunk_index || 0);
      expect(scores[k]).toBeDefined();
    }
  });
});

describe('cache invalidation on every write path', () => {
  it('updateEmbedding: the new vector is the one that scores (row jumps to top-1)', async () => {
    const ctx = await makeCtx();
    const q = unitVec(mulberry32(99), DIM);
    ctx.mem.index('note', 'fresh', 'freshly embedded', {});
    ctx.mem.updateEmbedding('note', 'fresh', 0, q, 'test-model');
    let rows = ctx.mem.searchVector(q, { limit: 3 });
    expect(rows[0].source_id).toBe('fresh');
    expect(rows[0].score).toBeCloseTo(1, 6);
    // Rotate the vector: the cached entry must follow the row, not the decode.
    const q2 = unitVec(mulberry32(100), DIM);
    ctx.mem.updateEmbedding('note', 'fresh', 0, q2, 'test-model');
    rows = ctx.mem.searchVector(q2, { limit: 3 });
    expect(rows[0].source_id).toBe('fresh');
    expect(ctx.mem.searchVector(q, { limit: 50 }).some((r) => r.source_id === 'fresh' && r.score > 0.99)).toBe(false);
    ctx.db.close();
  });

  it('index() re-upsert WITHOUT an embedding drops the row from vector results (embedding went NULL)', async () => {
    const ctx = await makeCtx();
    const q = SEED[0].vec;
    expect(ctx.mem.searchVector(q, { limit: 50 }).some((r) => r.source_id === 'note-0')).toBe(true);
    ctx.mem.index('note', 'note-0', 'content rewritten, no embedding yet', {});
    const rows = ctx.mem.searchVector(q, { limit: 50 });
    expect(rows.some((r) => r.source_id === 'note-0')).toBe(false);
    // ...and it comes back once the embed lands (the scheduler's callback path).
    ctx.mem.updateEmbedding('note', 'note-0', 0, q, 'test-model');
    expect(ctx.mem.searchVector(q, { limit: 50 }).some((r) => r.source_id === 'note-0')).toBe(true);
    ctx.db.close();
  });

  it('remove(): the pair disappears, both chunks', async () => {
    const ctx = await makeCtx();
    ctx.mem.remove('doc', 'big-doc');
    for (const q of [ctx.queries.self, ctx.queries.random]) {
      expect(ctx.mem.searchVector(q, { limit: 50 }).some((r) => r.source_id === 'big-doc')).toBe(false);
    }
    ctx.db.close();
  });

  it('indexDoc shrink (removeChunksFrom): stale chunks leave the cache on re-index', async () => {
    const ctx = await makeCtx();
    // chunkText cuts ~4000-char windows at paragraph boundaries — three
    // ~2500-char paragraphs split into 3 chunks; a one-word doc stays 1.
    const para = 'word '.repeat(500); // ~2500 chars
    const longText = para + '\n\n' + para + '\n\n' + para;
    ctx.mem.indexDoc('doc', 'shrinking', longText, {});          // first pass: 3 chunks
    const q = unitVec(mulberry32(11), DIM);
    const chunksBefore = ctx.mem.getDocChunks('doc', 'shrinking');
    expect(chunksBefore.length).toBe(3);
    chunksBefore.forEach((c, i) => ctx.mem.updateEmbedding('doc', 'shrinking', c.chunk_index, unitVec(mulberry32(200 + i), DIM), 'test-model'));
    expect(ctx.mem.searchVector(ctx.queries.random, { limit: 100 }).some((r) => r.source_id === 'shrinking')).toBe(true);

    ctx.mem.indexDoc('doc', 'shrinking', 'short now', {});       // second pass: 1 chunk
    expect(ctx.mem.getDocChunks('doc', 'shrinking').length).toBe(1);
    ctx.mem.updateEmbedding('doc', 'shrinking', 0, q, 'test-model');
    const rows = ctx.mem.searchVector(q, { limit: 100 });
    const shr = rows.filter((r) => r.source_id === 'shrinking');
    expect(shr.length).toBe(1);
    expect(shr[0].chunk_index).toBe(0);
    ctx.db.close();
  });

  it('purge(): by source_type and by namespace, the cache empties with the table', async () => {
    const ctx = await makeCtx();
    expect(ctx.mem.purge({ source_type: 'bench_longmemeval' })).toBe(2);
    expect(ctx.mem.searchVector(ctx.queries.random, { limit: 100, source_types: ['bench_longmemeval'] }).length).toBe(0);
    expect(ctx.mem.purge({ namespace: 'bench-p194-ns' })).toBe(2);
    const benchQuery = ctx.mem.searchVector(ctx.queries.random, { limit: 100, namespace: 'bench-p194-ns' });
    expect(benchQuery.length).toBe(0);
    // Real rows untouched.
    expect(ctx.mem.searchVector(ctx.queries.random, { limit: 100 }).length).toBeGreaterThan(10);
    ctx.db.close();
  });

  it('bulkIndex(): rows land in the cache and are searchable immediately', async () => {
    const ctx = await makeCtx();
    const q = unitVec(mulberry32(123), DIM);
    ctx.mem.bulkIndex([
      { source_type: 'note', source_id: 'bulk-a', content_text: 'bulk a', namespace: null, embedding: null },
      { source_type: 'note', source_id: 'bulk-b', content_text: 'bulk b', namespace: null, embedding: null },
    ]);
    ctx.mem.updateEmbedding('note', 'bulk-a', 0, q, 'test-model');
    ctx.mem.updateEmbedding('note', 'bulk-b', 0, unitVec(mulberry32(124), DIM), 'test-model');
    const rows = ctx.mem.searchVector(q, { limit: 5 });
    expect(rows[0].source_id).toBe('bulk-a');
    ctx.db.close();
  });

  it('OUT-OF-BAND raw SQL delete (auto-memory unindexFacts shape) self-heals on the next search', async () => {
    const ctx = await makeCtx();
    expect(ctx.mem.searchVector(ctx.queries.random, { limit: 50 }).some((r) => r.source_id === 'lesson-0')).toBe(true);
    const buildsBefore = ctx.mem.vectorCacheInfo().rebuilds; // after priming: the build counted
    // No hook runs here — the exact shape of plugins/auto-memory/db.js unindexFacts.
    ctx.db.prepare("DELETE FROM sm_embeddings WHERE source_type = 'lesson' AND source_id = 'lesson-0'").run();
    expect(ctx.mem.searchVector(ctx.queries.random, { limit: 50 }).some((r) => r.source_id === 'lesson-0')).toBe(false);
    expect(ctx.mem.vectorCacheInfo().rebuilds).toBe(buildsBefore + 1); // the signature caught it
    ctx.db.close();
  });
});

describe('filters apply BEFORE the cosine (bench rows are never scored for plain queries)', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeCtx(); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('a plain query scans only the visible rows — no bench row enters the candidate set', () => {
    ctx.mem.searchVector(ctx.queries.random, { limit: 10 }); // prime the cache
    const info = ctx.mem.vectorCacheInfo();
    // 20 of the 24 SEED rows are visible to a plain query: minus the 2
    // bench-typed rows and the 2 notes sitting in a bench namespace; the
    // multi-chunk doc counts both its chunks.
    expect(info.last_scan_candidates).toBe(SEED.length - 4);
    // Opt-in scans them again.
    ctx.mem.searchVector(ctx.queries.random, { limit: 10, source_types: ['bench_longmemeval'] });
    expect(ctx.mem.vectorCacheInfo().last_scan_candidates).toBe(2);
    ctx.mem.searchVector(ctx.queries.random, { limit: 10, namespace: 'bench-p194-ns' });
    expect(ctx.mem.vectorCacheInfo().last_scan_candidates).toBe(2);
    // ...and the results are the bench rows only.
    const benchRows = ctx.mem.searchVector(ctx.queries.random, { limit: 10, namespace: 'bench-p194-ns' });
    for (const r of benchRows) expect(r.namespace).toBe('bench-p194-ns');
  });

  it('the cache reports its shape honestly (built, rows, one-time build cost)', () => {
    const info = ctx.mem.vectorCacheInfo();
    expect(info.built).toBe(true);
    expect(info.rows).toBe(SEED.length);
    expect(info.last_build_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('the recency cap selects the newest candidates AFTER filters', () => {
  // The cap folds into the cache's accumulation loop (rows are kept globally
  // recency-sorted, so the cap is an early break — the same newest-N-after-
  // WHERE the old SQL's `ORDER BY updated_at DESC LIMIT 5000` produced).
  // Exercised here against a real cache with a small injected cap.
  it('accumulation stops at the cap, keeping the newest N among the FILTERED set', async () => {
    const { createVectorCache } = await import(join(PLUGIN_DIR, 'vector-cache.js'));
    const { benchOptIn, BENCH_TYPE_PREFIX, BENCH_NS_PREFIX, VECTOR_SCAN_CAP } = await import(join(PLUGIN_DIR, 'db.js'));
    expect(VECTOR_SCAN_CAP).toBe(5000);
    const ctx = await makeCtx();
    const cache = createVectorCache(ctx.db, { benchOptIn, BENCH_TYPE_PREFIX, BENCH_NS_PREFIX, scanCap: 5 });
    // scored() returns SCORE-sorted output; the cap decides which rows are
    // CANDIDATES (the newest N among the filtered set). Assert the sets.
    const idOf = (s) => ctx.db.prepare('SELECT source_id FROM sm_embeddings WHERE id = ?').get(s.id).source_id;

    // Unfiltered: 20 visible candidates, capped to the 5 NEWEST
    // (lesson-2/1/0, zero-row, big-doc chunk 1 — the tail of the seed order).
    const top5 = cache.scored(ctx.queries.random, {});
    expect(top5.length).toBe(5);
    expect(top5.map(idOf).sort()).toEqual(['big-doc', 'lesson-0', 'lesson-1', 'lesson-2', 'zero-row']);

    // Filtered to notes: the cap spends itself on the FILTERED set — the two
    // NEWEST 'note' rows are zero-row (seed index 20) and proja-note-1
    // (index 13), never any of the nine older notes.
    const cache3 = createVectorCache(ctx.db, { benchOptIn, BENCH_TYPE_PREFIX, BENCH_NS_PREFIX, scanCap: 2 });
    const notes = cache3.scored(ctx.queries.random, { source_types: ['note'] });
    expect(notes.length).toBe(2);
    expect(notes.map(idOf).sort()).toEqual(['proja-note-1', 'zero-row']);

    // Bench namespace opt-in under a tiny cap: the newest bench-ns row wins.
    const cache2 = createVectorCache(ctx.db, { benchOptIn, BENCH_TYPE_PREFIX, BENCH_NS_PREFIX, scanCap: 1 });
    const benchNs = cache2.scored(ctx.queries.random, { namespace: 'bench-p194-ns' });
    expect(benchNs.length).toBe(1);
    expect(idOf(benchNs[0])).toBe('bmns-1');
    ctx.db.close();
  });
});

describe('the latency bench selftest passes on this tree', () => {
  it('node tools/bench-search-latency.mjs --selftest exits 0', () => {
    let out;
    try {
      out = execFileSync('node', ['tools/bench-search-latency.mjs', '--selftest'], {
        cwd: REPO_ROOT, timeout: 120000, encoding: 'utf8',
      });
    } catch (e) {
      throw new Error('bench selftest failed:\n' + (e.stdout || '') + (e.stderr || e.message), { cause: e });
    }
    expect(out).toMatch(/selftest PASS/);
  }, 180000);
});
