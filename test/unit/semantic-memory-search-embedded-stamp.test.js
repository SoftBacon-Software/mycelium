// /memory/search results carry `embedded` per row (task 213 — the reconcile
// fastpath guard's platform half).
//
// THE PROBLEM: rows are embedded asynchronously after indexing, and a reconcile
// search seconds later ranks the newest rows keyword-only — inside a HYBRID
// result, where their scores look like every other score. The search response
// already carried mode + degraded; it did not say, per row, whether that row's
// OWN vector existed. The bench timeline arm's fastpath (task 205) reads the
// best current hit's score and skips a decision call below the threshold — on
// a keyword-only score that skip decides blind. (BRIEF task 213: "the
// reconcile decision must not depend on embedder timing.")
//
// THE CONTRACT here: every /memory/search result row states `embedded:
// true|false` — a keyword-found row with a NULL embedding is false, a
// vector-scan hit is true — in ALL modes (keyword, keyword-fallback, hybrid
// RRF, vector). A row that cannot know stamps null, never a guessed true
// (stampEmbedded's contract, tested directly below). Additive field only: no
// existing field moves.

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

const NS = 'bench-guard-213';
const QUERY = 'lease renewal notice period';

async function searchMode(app, mode) {
  const body = { query: QUERY, namespace: NS, limit: 10 };
  if (mode) body.mode = mode;
  const res = await request(app).post('/memory/search').send(body);
  expect(res.status).toBe(200);
  return res.body;
}

describe('task 213 — /memory/search results state their own embeddedness', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    // one row indexed WITHOUT an embedding (the just-written reconcile window
    // shape) and one WITH (the settled shape) — same text family so both rank
    ctx.mem.index('bench_longmemeval', 'unembedded-1', `${QUERY} — thirty days written notice`, { namespace: NS });
    ctx.mem.index('bench_longmemeval', 'embedded-1', `${QUERY} was sixty days last year`, { namespace: NS });
    ctx.mem.updateEmbedding('bench_longmemeval', 'embedded-1', 0, [1, 0.5], 'test-model');
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('mode keyword: the unembedded row stamps embedded:false, the embedded row true', async () => {
    const body = await searchMode(ctx.app, 'keyword');
    const byId = Object.fromEntries(body.results.map((r) => [r.source_id, r]));
    expect(byId['unembedded-1']).toBeTruthy();
    expect(byId['unembedded-1'].embedded).toBe(false);
    expect(byId['embedded-1'].embedded).toBe(true);
    // the raw vector never leaves the server, stamped or not
    for (const r of body.results) expect(r).not.toHaveProperty('embedding');
  });

  it('mode hybrid with no provider (keyword-fallback): both rows stamp it', async () => {
    const body = await searchMode(ctx.app, null); // no provider configured → keyword-fallback
    expect(body.mode).toBe('keyword-fallback');
    const byId = Object.fromEntries(body.results.map((r) => [r.source_id, r]));
    expect(byId['unembedded-1'].embedded).toBe(false);
    expect(byId['embedded-1'].embedded).toBe(true);
  });

  it('the true hybrid arm (RRF over keyword+vector) stamps it, and the field is ALWAYS present', async () => {
    const body = await searchMode(ctx.app, 'keyword'); // route-level shape check
    for (const r of body.results) expect(Object.hasOwn(r, 'embedded')).toBe(true);

    // db-level: the RRF merge path — keyword row and vector row for the same
    // key collapse to ONE row object; its stamp must reflect that row's vector
    const rows = await ctx.mem.searchHybrid(QUERY, { namespace: NS, limit: 10 }, [1, 0.5]);
    const byId = Object.fromEntries(rows.map((r) => [r.source_id, r]));
    expect(byId['embedded-1'].embedded).toBe(true);
    for (const r of rows) expect(Object.hasOwn(r, 'embedded')).toBe(true);
  });

  it('a vector-scan hit stamps embedded:true (finishScored path, cache and json arms share it)', async () => {
    const rows = await ctx.mem.searchVector([1, 0.5], { namespace: NS, limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.embedded).toBe(true);
  });

  it('after the unembedded row\'s embedding lands, the SAME search stamps embedded:true', async () => {
    ctx.mem.updateEmbedding('bench_longmemeval', 'unembedded-1', 0, [0.9, 0.4], 'test-model');
    for (const mode of ['keyword', null]) {
      const body = await searchMode(ctx.app, mode);
      const byId = Object.fromEntries(body.results.map((r) => [r.source_id, r]));
      expect(byId['unembedded-1'].embedded).toBe(true);
    }
  });

  it('every result row carries the field — null when a producer could not know, never a guessed true', async () => {
    // the boundary contract, directly: a producer row that predates the stamp
    // (no embedded property at all — the legacy shape) must leave /memory/search
    // stamped null, not silently true
    const { stampEmbedded } = await import(join(PLUGIN_DIR, 'db.js'));
    expect([
      { source_id: 'a', embedding: null },
      { source_id: 'b', embedding: [1] },
      { source_id: 'c' },
    ].map(stampEmbedded))
      .toEqual([
        { source_id: 'a', embedding: null, embedded: false },
        { source_id: 'b', embedding: [1], embedded: true },
        { source_id: 'c', embedded: null }, // cannot know — stamped null, never true
      ]);
    // and it does not resurrect dropped vectors: stripping still happens route-side
    const body = await searchMode(ctx.app, 'keyword');
    for (const r of body.results) expect(r).not.toHaveProperty('embedding');
  });
});
