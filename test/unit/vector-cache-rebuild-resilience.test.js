// The 196 fast-follow to the 194 decoded-vector cache: REBUILDS MUST NOT
// BLOCK THE LOOP.
//
// Why this file exists: 194 made the QUERY path parse-free, but kept the
// one-time cache build unbounded and synchronous, and production re-triggers
// it — auto-memory's unindexFacts deletes sm_embeddings rows directly (no
// hook), the freshness signature moves, and the next search pays a FULL
// corpus decode on the event loop (~390 ms at 25k rows on the Mac, 2-4x on
// the Jetson, growing with the corpus). And if build() throws for a
// persistent reason, every search re-attempts the full build AND falls back
// to the JSON path — strictly more work per query than before 194, forever,
// silently.
//
// What this file pins:
//   reconcile  — a signature drift self-heals INCREMENTALLY: ids are diffed
//                against SQL truth; rows SQL lost are dropped, rows SQL
//                gained are decoded — the corpus is NOT re-decoded (rebuilds
//                stays put, reconciles ticks).
//   one-build  — searches arriving mid-build wait on the ONE in-flight build
//                (never two concurrent builds), then serve correct results.
//   breaker    — a failing build opens a JSON-fallback window (30 s doubling
//                to 10 min in prod; injected short here) with ONE log line
//                per window: inside a window no rebuild is attempted at all,
//                so a broken cache costs no more per query than pre-194.
//   hook       — auto-memory's unindexFacts now lands in the cache in the
//                same tick (per-db side-channel, fail-soft when the other
//                plugin is absent), so the in-process path never needs the
//                signature; the negative control proves the test can tell.
//   delete-only— tripwire: no raw UPDATE of sm_embeddings exists in product
//                code outside the hooked db.js. A raw UPDATE of
//                namespace/source_type/embedding on an existing row moves
//                neither count nor MAX(id) — invisible to the signature,
//                documented gap — so if this fires, a writer appeared that
//                the freshness machinery cannot see.
//   contract   — scored() requires an awaited ensureFresh() (loud, not
//                silent-empty), and the stats surface carries the breaker
//                state.
//
// Models test/unit/search-vector-decode-cache.test.js (194): vitest +
// better-sqlite3 ':memory:' seeded from schema.sql — hermetic, no network.

import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SM_DIR = join(REPO_ROOT, 'server', 'plugins', 'semantic-memory');
const AM_DIR = join(REPO_ROOT, 'server', 'plugins', 'auto-memory');

// Must match the SQL comment marker vector-cache.js puts on its id-scan —
// the one query every build/reconcile opens with, and therefore the exact
// place the breaker test forces failures.
const MARKER = 'vector-cache:scan-ids';

const DIM = 8;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = [];
(function buildSeed() {
  const rng = mulberry32(196);
  for (let i = 0; i < 6; i++) SEED.push({ source_type: 'note', source_id: 'note-' + i, vec: unitVec(rng, DIM) });
  for (let i = 0; i < 3; i++) SEED.push({ source_type: 'lesson', source_id: 'lesson-' + i, vec: unitVec(rng, DIM) });
  for (let i = 0; i < 3; i++) SEED.push({ source_type: 'preference', source_id: 'pref-' + i, vec: unitVec(rng, DIM) });
})();

function keyOf(r) { return r.source_type + ':' + r.source_id + ':' + r.chunk_index; }
function embeddedCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
}

async function makeMem(vectorCacheOpts) {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(SM_DIR, 'schema.sql'), 'utf8'));
  const { default: createMemoryDB } = await import(join(SM_DIR, 'db.js'));
  const mem = vectorCacheOpts
    ? createMemoryDB(db, { vectorCache: vectorCacheOpts })
    : createMemoryDB(db);
  const stamp = db.prepare("UPDATE sm_embeddings SET updated_at = ? WHERE source_type = ? AND source_id = ?");
  const base = Date.UTC(2026, 8, 11, 12, 0, 0);
  SEED.forEach((r, i) => {
    mem.index(r.source_type, r.source_id, 'content for ' + r.source_id, {});
    mem.updateEmbedding(r.source_type, r.source_id, 0, r.vec, 'test-model');
    stamp.run(new Date(base + i * 60000).toISOString().replace('T', ' ').slice(0, 19), r.source_type, r.source_id);
  });
  return { db, mem, queries: SEED.map((r) => r.vec) };
}

// Both plugins over ONE db — the production wiring (both get core.db).
async function makeBothCtx() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(SM_DIR, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(AM_DIR, 'schema.sql'), 'utf8'));
  const { default: createMemoryDB } = await import(join(SM_DIR, 'db.js'));
  const { default: createAutoMemoryDB } = await import(join(AM_DIR, 'db.js'));
  const mem = createMemoryDB(db);
  const autoDb = createAutoMemoryDB(db);
  const factIds = [];
  for (let i = 0; i < 4; i++) {
    const fid = autoDb.createFact('agent-1', null, 'general', 'fact body ' + i, 0.9, 'test', 'ext-' + i);
    factIds.push(fid);
    mem.index('memory', String(fid), 'fact body ' + i, {});
    mem.updateEmbedding('memory', String(fid), 0, unitVec(mulberry32(500 + i), DIM), 'test-model');
  }
  return { db, mem, autoDb, factIds };
}

// A Database proxy that throws on the first `failTimes` prepares of the
// cache's id-scan (the build/reconcile opener), then heals. Counts marker
// calls so the test can prove NO attempt happened, not just that none failed.
function failThenHeal(real, failTimes) {
  const state = { markerCalls: 0, failTimes };
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return function (sql, ...rest) {
          if (String(sql).indexOf(MARKER) !== -1) {
            state.markerCalls++;
            if (state.markerCalls <= state.failTimes) {
              throw new Error('simulated build failure #' + state.markerCalls);
            }
          }
          return target.prepare(sql, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  return { proxy, state };
}

function captureErrors() {
  const lines = [];
  const spy = vi.spyOn(console, 'error').mockImplementation(function (...args) {
    lines.push(args.map(String).join(' '));
  });
  return { lines, spy };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('signature drift self-heals by INCREMENTAL reconcile, not a corpus rebuild', () => {
  it('out-of-band DELETE: rebuilds stays put, reconciles ticks, cache exact vs SQL + oracle', async () => {
    const ctx = await makeMem();
    await ctx.mem.searchVector(ctx.queries[0], { limit: 5 }); // prime: exactly one full build
    const before = ctx.mem.vectorCacheInfo();
    expect(before.rebuilds).toBe(1);

    // The pre-196 shape of auto-memory's unindexFacts: raw DELETE, no hook.
    ctx.db.prepare("DELETE FROM sm_embeddings WHERE source_type = 'lesson'").run();

    const rows = await ctx.mem.searchVector(ctx.queries[0], { limit: 50 });
    const after = ctx.mem.vectorCacheInfo();
    expect(after.reconciles).toBe(before.reconciles + 1);
    expect(after.rebuilds).toBe(before.rebuilds); // the 196 point: NO corpus re-decode
    expect(after.rows).toBe(embeddedCount(ctx.db));
    expect(rows.some((r) => r.source_type === 'lesson')).toBe(false);
    expect(rows.map(keyOf)).toEqual(ctx.mem.searchVectorJsonPath(ctx.queries[0], { limit: 50 }).map(keyOf));
    ctx.db.close();
  });

  it('out-of-band INSERT (raw embedded row): decoded by reconcile, searchable, no rebuild', async () => {
    const ctx = await makeMem();
    await ctx.mem.searchVector(ctx.queries[0], { limit: 5 });
    const before = ctx.mem.vectorCacheInfo();

    const v = unitVec(mulberry32(777), DIM);
    ctx.db.prepare(
      "INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model) " +
      "VALUES ('note', 'oob-1', 'raw insert', NULL, 0, '{}', ?, 'raw')"
    ).run(JSON.stringify(v));

    const rows = await ctx.mem.searchVector(v, { limit: 50 });
    const after = ctx.mem.vectorCacheInfo();
    expect(after.reconciles).toBe(before.reconciles + 1);
    expect(after.rebuilds).toBe(before.rebuilds);
    expect(after.rows).toBe(embeddedCount(ctx.db));
    expect(rows[0].source_id).toBe('oob-1');
    expect(rows[0].score).toBeCloseTo(1, 5);
    ctx.db.close();
  });

  it('repeated searches after a drift do NOT re-reconcile (baseline adopted)', async () => {
    const ctx = await makeMem();
    await ctx.mem.searchVector(ctx.queries[0], { limit: 5 });
    ctx.db.prepare("DELETE FROM sm_embeddings WHERE source_id = 'note-3'").run();
    await ctx.mem.searchVector(ctx.queries[0], { limit: 50 });
    const mid = ctx.mem.vectorCacheInfo();
    for (let i = 0; i < 5; i++) await ctx.mem.searchVector(ctx.queries[i % ctx.queries.length], { limit: 10 });
    const after = ctx.mem.vectorCacheInfo();
    expect(after.reconciles).toBe(mid.reconciles);
    expect(after.rebuilds).toBe(mid.rebuilds);
    ctx.db.close();
  });
});

describe('searches arriving mid-build wait on the ONE in-flight build', () => {
  it('concurrent first searches: one build, every waiter served correct results', async () => {
    // decodeBatchRows: 2 over 12 rows forces the build across several event-
    // loop turns, so the followers genuinely arrive MID-build.
    const ctx = await makeMem({ decodeBatchRows: 2 });
    const pending = [
      ctx.mem.searchVector(ctx.queries[0], { limit: 50 }),
      ctx.mem.searchVector(ctx.queries[1], { limit: 50 }),
      ctx.mem.searchVector(ctx.queries[5], { limit: 50 }),
      ctx.mem.searchVector(ctx.queries[9], { limit: 50 }),
      ctx.mem.searchHybrid('content for note-1', { limit: 5 }, ctx.queries[2]),
    ];
    const all = await Promise.all(pending);
    const info = ctx.mem.vectorCacheInfo();
    expect(info.rebuilds).toBe(1);
    expect(info.reconciles).toBe(0);
    expect(info.built).toBe(true);
    // Every waiter ranks identically to the oracle.
    const json = ctx.mem.searchVectorJsonPath(ctx.queries[0], { limit: 50 });
    expect(all[0].map(keyOf)).toEqual(json.map(keyOf));
    expect(all[3].map(keyOf)).toEqual(ctx.mem.searchVectorJsonPath(ctx.queries[9], { limit: 50 }).map(keyOf));
    expect(all[4].length).toBeGreaterThanOrEqual(1);
    ctx.db.close();
  });
});

describe('the circuit breaker: a failing build costs no more than pre-194', () => {
  it('throws twice then succeeds: two fallback searches inside the window, no rebuild attempts between them, rebuild after the window', async () => {
    const ctx0 = await makeMem({ buildBackoffBaseMs: 30, buildBackoffMaxMs: 120 });
    const { proxy, state } = failThenHeal(ctx0.db, 2);
    // Re-wire the plugin over the failing proxy (same db, same rows).
    const { default: createMemoryDB } = await import(join(SM_DIR, 'db.js'));
    const mem = createMemoryDB(proxy, { vectorCache: { buildBackoffBaseMs: 30, buildBackoffMaxMs: 120 } });
    const errors = captureErrors();
    const jsonCalls = { n: 0 };
    const origJson = mem.searchVectorJsonPath.bind(mem);
    mem.searchVectorJsonPath = function (...args) { jsonCalls.n++; return origJson(...args); };

    // Attempt 1 throws -> window 1 (30 ms) opens, ONE log line, JSON serves.
    const r1 = await mem.searchVector(ctx0.queries[0], { limit: 50 });
    let info = mem.vectorCacheInfo();
    expect(info.built).toBe(false);
    expect(info.build_failures).toBe(1);
    expect(info.fallback_until_ms).toBeGreaterThan(Date.now() - 1);
    expect(jsonCalls.n).toBe(1);
    expect(errors.lines.length).toBe(1);
    expect(errors.lines[0]).toMatch(/\[semantic-memory\] vector cache build failed: .*JSON fallback for/);

    // Inside the window: straight to JSON, NO rebuild attempt (marker count frozen).
    const r2 = await mem.searchVector(ctx0.queries[1], { limit: 50 });
    info = mem.vectorCacheInfo();
    expect(state.markerCalls).toBe(1); // no attempt between the two fallbacks
    expect(jsonCalls.n).toBe(2);
    expect(info.build_failures).toBe(1);

    // The fallback is the oracle: identical results, not a degradation.
    expect(r1.map(keyOf)).toEqual(origJson(ctx0.queries[0], { limit: 50 }).map(keyOf));
    expect(r2.map(keyOf)).toEqual(origJson(ctx0.queries[1], { limit: 50 }).map(keyOf));

    // Window expires -> attempt 2 -> throws again -> window 2 (60 ms), line 2.
    await sleep(45);
    const r3 = await mem.searchVector(ctx0.queries[2], { limit: 50 });
    info = mem.vectorCacheInfo();
    expect(state.markerCalls).toBe(2);
    expect(info.build_failures).toBe(2);
    expect(jsonCalls.n).toBe(3);
    expect(errors.lines.length).toBe(2);

    // Window 2 expires -> attempt 3 succeeds -> the cache serves, silently.
    await sleep(75);
    const r4 = await mem.searchVector(ctx0.queries[3], { limit: 50 });
    info = mem.vectorCacheInfo();
    expect(state.markerCalls).toBe(3);
    expect(info.built).toBe(true);
    expect(jsonCalls.n).toBe(3); // no further fallback
    expect(errors.lines.length).toBe(2); // still one line per window
    expect(r4.map(keyOf)).toEqual(origJson(ctx0.queries[3], { limit: 50 }).map(keyOf));

    // The stats surface carries the breaker state.
    const stats = mem.stats().vector_cache;
    expect(stats.build_failures).toBe(2);
    expect(stats.fallback_queries).toBe(3);
    expect(stats.last_build_error).toMatch(/simulated build failure #2/);
    errors.spy.mockRestore();
    ctx0.db.close();
  });
});

describe('auto-memory unindexFacts lands in the cache in the same tick', () => {
  it('deleteFact keeps the cache exact with NO signature drift and NO reconcile', async () => {
    const ctx = await makeBothCtx();
    const q = unitVec(mulberry32(501), DIM);
    await ctx.mem.searchVector(q, { limit: 5 }); // prime
    const before = ctx.mem.vectorCacheInfo();

    ctx.autoDb.deleteFact(ctx.factIds[0]); // -> unindexFacts -> raw DELETE + the 196 hook

    const rows = await ctx.mem.searchVector(q, { limit: 50 });
    const after = ctx.mem.vectorCacheInfo();
    expect(after.rebuilds).toBe(before.rebuilds);
    expect(after.reconciles).toBe(before.reconciles); // the hook, not the signature, did it
    expect(after.rows).toBe(embeddedCount(ctx.db));
    expect(rows.some((r) => r.source_id === String(ctx.factIds[0]))).toBe(false);
    expect(rows.map(keyOf)).toEqual(ctx.mem.searchVectorJsonPath(q, { limit: 50 }).map(keyOf));
    ctx.db.close();
  });

  it('negative control: with the side-channel severed, the same delete FORCES a reconcile', async () => {
    const ctx = await makeBothCtx();
    const q = unitVec(mulberry32(502), DIM);
    await ctx.mem.searchVector(q, { limit: 5 });
    const before = ctx.mem.vectorCacheInfo();
    delete ctx.db.__myceliumVectorCache; // simulate the pre-196 wiring / absent plugin
    ctx.autoDb.deleteFact(ctx.factIds[1]);
    await ctx.mem.searchVector(q, { limit: 50 });
    const after = ctx.mem.vectorCacheInfo();
    expect(after.reconciles).toBe(before.reconciles + 1); // the signature caught it — the net holds
    expect(after.rebuilds).toBe(before.rebuilds); // still incremental, still no corpus rebuild
    ctx.db.close();
  });
});

describe('the only out-of-band writer today is delete-only (signature-visible)', () => {
  it('no raw UPDATE of sm_embeddings in product code outside the hooked db.js', () => {
    const offenders = [];
    let sawKnownHookedSite = false;
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        if (name === 'test.js') continue; // plugin suites are fixtures, not product writers
        const text = readFileSync(p, 'utf8');
        if (/UPDATE\s+sm_embeddings/i.test(text)) {
          if (p === join(SM_DIR, 'db.js')) sawKnownHookedSite = true; // updateEmbedding: hooked via onUpsert
          else offenders.push(p);
        }
      }
    };
    walk(join(REPO_ROOT, 'server'));
    // A check that cannot fail is not a check: prove the scan sees the one
    // hooked writer, then assert no UNHOOKED one exists. A raw UPDATE of
    // namespace/source_type/embedding moves neither COUNT nor MAX(id) — the
    // signature is blind to it (documented gap in vector-cache.js's header).
    expect(sawKnownHookedSite).toBe(true);
    expect(offenders).toEqual([]);
  });
});

describe('the freshness contract is loud, and the stats route carries the state', () => {
  it('scored() before an awaited ensureFresh() throws instead of serving an empty cache', async () => {
    const { createVectorCache } = await import(join(SM_DIR, 'vector-cache.js'));
    const { benchOptIn, BENCH_TYPE_PREFIX, BENCH_NS_PREFIX } = await import(join(SM_DIR, 'db.js'));
    const db = new Database(':memory:');
    db.exec(readFileSync(join(SM_DIR, 'schema.sql'), 'utf8'));
    const cache = createVectorCache(db, { benchOptIn, benchTypePrefix: BENCH_TYPE_PREFIX, benchNsPrefix: BENCH_NS_PREFIX });
    expect(() => cache.scored([1, 0, 0], {})).toThrow(/ensureFresh/);
    await cache.ensureFresh(); // cold build over an empty table is legal
    expect(cache.scored([1, 0, 0], {})).toEqual([]);
    db.close();
  });

  it('stats() exposes the vector cache observability incl. breaker fields', async () => {
    const ctx = await makeMem();
    await ctx.mem.searchVector(ctx.queries[0], { limit: 5 });
    const vc = ctx.mem.stats().vector_cache;
    expect(vc.built).toBe(true);
    expect(vc.rebuilds).toBe(1);
    expect(vc.rows).toBe(SEED.length);
    expect(vc).toHaveProperty('reconciles');
    expect(vc).toHaveProperty('build_failures');
    expect(vc).toHaveProperty('fallback_until_ms');
    expect(vc).toHaveProperty('fallback_queries');
    expect(vc).toHaveProperty('decode_batch_rows');
    expect(vc.decode_batch_rows).toBe(500); // the prod default (the ~20 ms/tick bound)
    ctx.db.close();
  });
});
