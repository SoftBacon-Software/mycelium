// GET /memory/coverage — per-namespace embedding coverage (task 214).
//
// THE PROBLEM: the bench's embedding wait polls GLOBAL coverage (through
// /memory/stats) because that was the only number the index would say. But the
// wait is about ONE run's rows: the lab writes lessons and Aria writes facts
// all day, so the global number can sit at ~40% for ~25 min after a burst
// while the run's own namespaces have been at 100% for ages — the bench burns
// its cap waiting on rows it will never read (measured, bench r2). The index
// already computes the per-namespace truth (indexHealth's definitions); it
// just refused to say it for one namespace.
//
// THE CONTRACT here (brief task 214):
//   GET /memory/coverage?namespace=<ns> → {namespace, rows, embedded,
//   coverage_pct} — agent- OR admin-key readable (the lab's recall paths read
//   it with agent keys); the same definitions as indexHealth() scoped to the
//   namespace (superseded am_fact index rows count — they are searchable by
//   design). GET /memory/coverage with no namespace → the global indexHealth()
//   shape, byte-compatible with today's /memory/stats embedding block.
//   An empty or whitespace namespace is a 400 (the nonEmptyQuery convention).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');

async function makeApp() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));

  const core = {
    db,
    auth: {
      checkAdmin: (req, res) => {
        if (req.headers['x-admin-key'] === 'admin-key') return true;
        res.status(401).json({ error: 'Authentication required' });
        return false;
      },
      // mirror the real gate's contract: an agent key OR the admin key reads
      checkAgentOrAdmin: (req, res) => {
        if (req.headers['x-agent-key'] === 'agent-key' || req.headers['x-admin-key'] === 'admin-key') return 'tester';
        res.status(401).json({ error: 'Authentication required' });
        return false;
      },
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

const NS_A = 'bench-214-a';
const NS_B = 'bench-214-b';
const NS_EMPTY = 'bench-214-empty';

describe('task 214 — GET /memory/coverage says a namespace\'s own coverage', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    // ns A: 3 rows, 1 embedded — and one of the unembedded rows is a
    // SUPERSEDED am_fact index row, which counts (it stays searchable by
    // design — task 206). ns B: 1 row, embedded → 100%. Two legacy rows with
    // namespace NULL (one embedded) keep the global number honest.
    ctx.mem.index('lesson', 'a-1', 'lease renewal notice period is thirty days', { namespace: NS_A });
    ctx.mem.updateEmbedding('lesson', 'a-1', 0, [1, 0.5], 'test-model');
    ctx.mem.index('lesson', 'a-2', 'parking permit renewal happens quarterly', { namespace: NS_A });
    ctx.mem.index('am_fact', 'a-3', 'the team lead was Dana', {
      namespace: NS_A,
      metadata: { superseded_by: 'a-9', valid_to: '2026-09-01' },
    });
    ctx.mem.index('lesson', 'b-1', 'the vault code changes monthly', { namespace: NS_B });
    ctx.mem.updateEmbedding('lesson', 'b-1', 0, [0.5, 1], 'test-model');
    ctx.mem.index('lesson', 'legacy-1', 'legacy unembedded row', {});
    ctx.mem.index('lesson', 'legacy-2', 'legacy embedded row', {});
    ctx.mem.updateEmbedding('lesson', 'legacy-2', 0, [0.25, 0.75], 'test-model');
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('namespace route: 3 rows / 1 embedded → coverage 33 (indexHealth\'s own rounding), agent-key readable', async () => {
    const res = await request(ctx.app)
      .get(`/memory/coverage?namespace=${NS_A}`)
      .set('X-Agent-Key', 'agent-key');
    expect(res.status).toBe(200);
    // the exact route contract — these four keys, this shape, nothing else
    expect(Object.keys(res.body).sort()).toEqual(['coverage_pct', 'embedded', 'namespace', 'rows']);
    expect(res.body).toEqual({ namespace: NS_A, rows: 3, embedded: 1, coverage_pct: 33 });
  });

  it('a fully embedded namespace reads 100, and the superseded am_fact row is IN the count', async () => {
    const res = await request(ctx.app)
      .get(`/memory/coverage?namespace=${NS_B}`)
      .set('X-Agent-Key', 'agent-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ namespace: NS_B, rows: 1, embedded: 1, coverage_pct: 100 });
    // the a-3 row above is superseded (superseded_by set) and still counted in
    // ns A's rows=3 — searchable-by-design rows are coverage's business too
  });

  it('admin key reads it too', async () => {
    const res = await request(ctx.app)
      .get(`/memory/coverage?namespace=${NS_B}`)
      .set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(200);
    expect(res.body.coverage_pct).toBe(100);
  });

  it('no key → 401 (the route is agent/admin readable, not open)', async () => {
    const res = await request(ctx.app).get(`/memory/coverage?namespace=${NS_B}`);
    expect(res.status).toBe(401);
  });

  it('no namespace → the global indexHealth shape, byte-identical to db.indexHealth()', async () => {
    const res = await request(ctx.app).get('/memory/coverage').set('X-Admin-Key', 'admin-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ctx.mem.indexHealth());
    // and the numbers themselves: 6 rows, 3 embedded — the legacy NULL rows
    // count globally, the per-namespace math never touched them
    expect(res.body).toEqual({ total: 6, embedded: 3, coverage_pct: 50, vector_scan_capped: false });
  });

  it('empty and whitespace namespaces are a 400 (the nonEmptyQuery convention)', async () => {
    for (const q of ['namespace=', 'namespace=%20%20']) {
      const res = await request(ctx.app).get(`/memory/coverage?${q}`).set('X-Agent-Key', 'agent-key');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/namespace/i);
    }
  });

  it('a namespace with zero rows reads 0/0/0 — an honest zero, not an error', async () => {
    const res = await request(ctx.app)
      .get(`/memory/coverage?namespace=${NS_EMPTY}`)
      .set('X-Agent-Key', 'agent-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ namespace: NS_EMPTY, rows: 0, embedded: 0, coverage_pct: 0 });
  });
});
