// Bench namespaces are invisible to plain recall (2026-09-08, F-mycelium/165).
//
// Task 163's Mycelium benchmark arm wrote 3,104 rows (source_type
// bench_longmemeval, namespace bench-p1-2026-09-08-*) into the ONE
// semantic-memory index live recall reads from. They outranked real agent
// memories on every unfiltered POST /memory/search — the director's
// SessionStart recall hook and Kira's wake both answered from benchmark text.
//
// The fix (db.js): a bench row — source_type starting 'bench_' OR namespace
// starting 'bench-' — is excluded from searchKeyword (FTS arm AND LIKE
// fallback arm) and searchVector unless the request itself names a bench
// source_type in `source_types` or a bench namespace in `namespace`. Plus an
// admin bulk purge (DELETE /memory/index?source_type=&namespace=) so a
// finished benchmark run can actually leave.
//
// Models on test/unit/reindex-crash-regression.test.js: vitest + supertest +
// express, the plugin's own createRoutes() with a faked core and an in-memory
// better-sqlite3 DB seeded from schema.sql — hermetic, no network (the embed
// provider is unset, so autoEmbed is a no-op).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');

// Builds a fresh app + memory DB per call so each describe seeds and asserts
// against its own store (the LIKE-fallback describe drops the FTS table and
// must not poison the route-level describes).
async function makeApp() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));

  const core = {
    db,
    // checkAdmin mirrors the real gate's contract: admin key present -> true,
    // absent -> 401 response + false. The purge route must be admin-only, so
    // the fake has to be able to refuse.
    auth: {
      checkAdmin: (req, res) => {
        if (req.headers['x-admin-key'] === 'admin-key') return true;
        res.status(401).json({ error: 'Authentication required' });
        return false;
      },
      checkAgentOrAdmin: () => 'tester-agent',
      getAdminDisplayName: (req) => req.headers['x-acting-as'] || 'admin-test',
    },
    apiError: (res, code, msg) => res.status(code).json({ error: msg }),
    parseIntParam: (v, d) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? d : n;
    },
    asyncHandler: (fn) => function (req, res, next) {
      return Promise.resolve(fn(req, res, next)).catch(next);
    },
  };

  const { default: createRoutes } = await import(join(PLUGIN_DIR, 'routes.js'));
  const { default: createMemoryDB } = await import(join(PLUGIN_DIR, 'db.js'));

  const app = express();
  app.use(express.json());
  app.use('/memory', createRoutes(core));

  return { db, app, mem: createMemoryDB(db) };
}

// Task-163-shaped seed: real agent memories alongside benchmark rows in the
// same index, bench text lexically identical to the real text (that overlap is
// exactly why the unfiltered pollution outranked real memories). 'note:polluted'
// covers the rule's other half — a REAL source_type written into a bench
// namespace is still a bench row, hidden until that namespace is named.
const SEED = [
  { source_type: 'preference', source_id: 'pref-1', namespace: null, text: 'moving truck parking rules for the house' },
  { source_type: 'note', source_id: 'polluted', namespace: 'bench-p1-2026-09-08-run1', text: 'note parked in a bench namespace moving truck parking' },
  { source_type: 'bench_longmemeval', source_id: 'bm-1', namespace: 'bench-p1-2026-09-08-run1', text: 'moving truck parking rules benchmark passage one' },
  { source_type: 'bench_longmemeval', source_id: 'bm-2', namespace: 'bench-p1-2026-09-08-run1', text: 'moving truck parking rules benchmark passage two' },
  { source_type: 'bench_other_suite', source_id: 'bo-1', namespace: null, text: 'moving truck parking rules other bench suite passage' },
];

async function seedRows(mem, rows) {
  for (const r of rows) mem.index(r.source_type, r.source_id, r.text, { namespace: r.namespace });
}

function ids(res) {
  return res.body.results.map((r) => r.source_type + ':' + r.source_id);
}

describe('bench rows are invisible to plain recall (route level)', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); await seedRows(ctx.mem, SEED); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('a plain search returns no bench rows even when the text matches exactly', async () => {
    const res = await request(ctx.app).post('/memory/search').send({ query: 'moving truck parking', limit: 50 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1); // the real memory is still there
    for (const r of res.body.results) {
      expect(r.source_type.startsWith('bench_')).toBe(false);
      expect(String(r.namespace || '').startsWith('bench-')).toBe(false);
    }
    expect(ids(res)).toContain('preference:pref-1');
    expect(ids(res)).not.toContain('note:polluted'); // real type, bench namespace — still hidden
  });

  it('a bench row becomes visible when the request names its source_type in source_types', async () => {
    const res = await request(ctx.app).post('/memory/search')
      .send({ query: 'moving truck parking', source_types: ['bench_longmemeval'], limit: 50 });
    expect(res.status).toBe(200);
    expect(ids(res)).toContain('bench_longmemeval:bm-1');
    // Naming one bench type must not leak another: exact-match filter.
    for (const r of res.body.results) expect(r.source_type).toBe('bench_longmemeval');
  });

  it('a bench row becomes visible when the request names its namespace', async () => {
    const res = await request(ctx.app).post('/memory/search')
      .send({ query: 'moving truck parking', namespace: 'bench-p1-2026-09-08-run1', limit: 50 });
    expect(res.status).toBe(200);
    expect(ids(res)).toContain('bench_longmemeval:bm-1');
    for (const r of res.body.results) expect(r.namespace).toBe('bench-p1-2026-09-08-run1');
  });

  it('naming a NON-bench type keeps bench rows hidden (opt-in needs a bench filter)', async () => {
    const res = await request(ctx.app).post('/memory/search')
      .send({ query: 'moving truck parking', source_types: ['preference'], limit: 50 });
    expect(res.status).toBe(200);
    for (const r of res.body.results) expect(r.source_type.startsWith('bench_')).toBe(false);
    // The namespace half bites here too: 'note:polluted' matches the named
    // source_type but sits in a bench namespace the request did not name.
    expect(ids(res)).not.toContain('note:polluted');
  });

  it('the vector arm hides bench rows too (searchVector, not just the FTS arm)', async () => {
    // Give every row an embedding and search by one of them — searchVector is
    // the arm a configured provider uses; a forgotten exclusion here would put
    // bench rows right back into hybrid results.
    const V = [1, 0.5, 0.25, 0.125];
    for (const r of SEED) {
      ctx.mem.updateEmbedding(r.source_type, r.source_id, 0, V, 'test-model');
    }
    // Route-level hybrid without a provider never reaches searchVector, so the
    // vector arm is asserted directly against the same db the route uses.
    const rows = ctx.mem.searchVector(V, { limit: 50 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.source_type + ':' + r.source_id)).toContain('preference:pref-1');
    for (const r of rows) {
      expect(r.source_type.startsWith('bench_')).toBe(false);
      expect(String(r.namespace || '').startsWith('bench-')).toBe(false);
    }
  });
});

describe('bench rows are invisible in the LIKE fallback arm too', () => {
  it('with the FTS table unavailable, the LIKE fallback still excludes bench rows', async () => {
    const ctx = await makeApp();
    await seedRows(ctx.mem, SEED);
    // Force searchKeyword's catch path: no FTS table -> MATCH throws -> LIKE.
    ctx.db.exec('DROP TABLE sm_embeddings_fts');
    try {
      const rows = ctx.mem.searchKeyword('moving truck parking', { limit: 50 });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) expect(r.source_type.startsWith('bench_')).toBe(false);
      expect(rows.map((r) => r.source_type + ':' + r.source_id)).toContain('preference:pref-1');

      // Opt-in works on the fallback arm as well.
      const opted = ctx.mem.searchKeyword('moving truck parking', {
        limit: 50, source_types: ['bench_longmemeval'],
      });
      expect(opted.map((r) => r.source_id).sort()).toEqual(['bm-1', 'bm-2']);
    } finally {
      // Restore the FTS table so this DB is whole again (trigger targets).
      ctx.db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));
      ctx.db.close();
    }
  });
});

describe('admin bulk purge — DELETE /memory/index', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); await seedRows(ctx.mem, SEED); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  const countType = (t) => ctx.db.prepare('SELECT COUNT(*) c FROM sm_embeddings WHERE source_type = ?').get(t).c;
  const countNs = (n) => ctx.db.prepare('SELECT COUNT(*) c FROM sm_embeddings WHERE namespace = ?').get(n).c;
  const total = () => ctx.db.prepare('SELECT COUNT(*) c FROM sm_embeddings').get().c;

  it('purges exactly the filtered source_type and nothing else', async () => {
    const before = total();
    const res = await request(ctx.app)
      .delete('/memory/index?source_type=bench_longmemeval')
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(2); // bm-1 + bm-2, chunk rows included if any
    expect(countType('bench_longmemeval')).toBe(0);
    expect(countType('bench_other_suite')).toBe(1);   // a different bench type survives
    expect(countType('preference')).toBe(1);          // real memory untouched
    expect(total()).toBe(before - 2);
  });

  it('purges exactly the filtered namespace and nothing else', async () => {
    const res = await request(ctx.app)
      .delete('/memory/index?namespace=bench-p1-2026-09-08-run1')
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(200);
    // The type purge in the previous test removed bm-1/bm-2 but NOT
    // note:polluted (real source_type, bench namespace) — the namespace purge
    // is what catches it. deleted=1 proves the filters see different rows.
    expect(res.body.deleted).toBe(1);
    expect(countNs('bench-p1-2026-09-08-run1')).toBe(0);
  });

  it('purges by namespace when that is the only thing naming the rows', async () => {
    // Fresh namespace, mixed types under it: the namespace filter must take
    // both, and only both.
    ctx.mem.index('bench_a', 'ns-1', 'alpha text', { namespace: 'bench-p2-run9' });
    ctx.mem.index('bench_b', 'ns-2', 'beta text', { namespace: 'bench-p2-run9' });
    ctx.mem.index('note', 'keep-1', 'keeper', { namespace: 'bench-p2-run9' });
    const res = await request(ctx.app)
      .delete('/memory/index?namespace=bench-p2-run9')
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3); // bench_a + bench_b + the real type under that namespace
    expect(countNs('bench-p2-run9')).toBe(0);
    expect(countType('bench_other_suite')).toBe(1);
  });

  it('both filters together AND (source_type wins nothing outside the namespace)', async () => {
    ctx.mem.index('bench_a', 'and-1', 'alpha and', { namespace: 'bench-and-run' });
    ctx.mem.index('bench_a', 'and-2', 'alpha and other ns', { namespace: 'bench-other-run' });
    const res = await request(ctx.app)
      .delete('/memory/index?source_type=bench_a&namespace=bench-and-run')
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1); // only and-1: same type, other namespace survives
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM sm_embeddings WHERE source_id = 'and-2'").get().c).toBe(1);
  });

  it('refuses an unfiltered purge (no query params at all)', async () => {
    const before = total();
    const res = await request(ctx.app).delete('/memory/index').set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refusing unfiltered purge/i);
    expect(total()).toBe(before); // nothing was deleted by the refused call
  });

  it('refuses a present-but-empty filter value (it counts as no filter)', async () => {
    const res = await request(ctx.app)
      .delete('/memory/index?source_type=')
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(400);
  });

  it('refuses a malformed filter value instead of silently dropping it', async () => {
    // ?namespace=a&namespace=b arrives as an array — silently ignoring one of
    // the two values would purge rows the caller never named.
    const res = await request(ctx.app)
      .delete('/memory/index?namespace=bench-a&namespace=bench-b')
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty strings/);
  });

  it('is admin-only: an agent key gets 401 and nothing is deleted', async () => {
    const before = total();
    const res = await request(ctx.app).delete('/memory/index?source_type=bench_other_suite');
    expect(res.status).toBe(401);
    expect(total()).toBe(before);
  });
});
