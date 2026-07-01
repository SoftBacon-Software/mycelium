import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import fs from 'fs';
import path from 'path';

import createResidencyDB from '../../server/plugins/residency/db.js';
import { decideResidency, estimateRss, modelRssLookup } from '../../server/plugins/residency/src/policy.js';
import { createResidencyPlugin } from '../../server/plugins/residency/src/index.js';

// ---------------------------------------------------------------------------
// 1. Schema creation + insert/query of nodes, models, routes
// ---------------------------------------------------------------------------
describe('residency db — schema + CRUD', () => {
  let db, store;
  beforeEach(() => {
    db = new Database(':memory:');
    store = createResidencyDB(db);
  });
  afterEach(() => db.close());

  test('creates the three tables and round-trips a node', () => {
    const node = store.upsertNode({
      node_id: 'mac',
      ram_total_gb: 128,
      ram_budget_gb: 120,
      actuator_kind: 'omlx',
      actuator_url: 'http://localhost:8080'
    });
    expect(node.node_id).toBe('mac');
    const nodes = store.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120 });
    expect(nodes[0].updated_at).toBeTruthy();
  });

  test('upsertNode updates an existing node in place', () => {
    store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120 });
    store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 96 });
    expect(store.getNode('mac').ram_budget_gb).toBe(96);
    expect(store.listNodes()).toHaveLength(1);
  });

  test('inserts/queries resident models for a node', () => {
    store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120 });
    store.upsertModel({
      node_id: 'mac', model_id: 'ds4', backend: 'omlx',
      kind: 'local', state: 'resident', rss_gb: 80
    });
    store.upsertModel({
      node_id: 'mac', model_id: 'gpt-4o', backend: 'openai',
      kind: 'api', state: 'resident', rss_gb: 0
    });
    const models = store.listModelsForNode('mac');
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.model_id).sort()).toEqual(['ds4', 'gpt-4o']);
    // CHECK constraints reject bad enum values.
    expect(() =>
      store.upsertModel({ node_id: 'mac', model_id: 'x', backend: 'b', kind: 'bogus', state: 'resident' })
    ).toThrow();
    expect(() =>
      store.upsertModel({ node_id: 'mac', model_id: 'x', backend: 'b', kind: 'local', state: 'bogus' })
    ).toThrow();
  });

  test('inserts/queries seat routes and getMap aggregates everything', () => {
    store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120 });
    store.upsertModel({
      node_id: 'mac', model_id: 'ds4', backend: 'omlx',
      kind: 'local', state: 'resident', rss_gb: 80
    });
    store.upsertRoute({ seat: 'lucy', backend: 'omlx', kind: 'local', mode_pref: 'local-first' });

    const map = store.getMap();
    expect(map.nodes).toHaveLength(1);
    expect(map.nodes[0].resident_set).toHaveLength(1);
    expect(map.nodes[0].resident_set[0].model_id).toBe('ds4');
    expect(map.seat_routes).toHaveLength(1);
    expect(map.seat_routes[0]).toMatchObject({ seat: 'lucy', backend: 'omlx', kind: 'local' });
  });

  test('removeNode cascades its resident models', () => {
    store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120 });
    store.upsertModel({ node_id: 'mac', model_id: 'ds4', backend: 'omlx', kind: 'local', state: 'resident', rss_gb: 80 });
    expect(store.removeNode('mac')).toBe(1);
    expect(store.listModelsForNode('mac')).toHaveLength(0);
    expect(store.getNode('mac')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/mycelium/residency returns the correct JSON shape
// ---------------------------------------------------------------------------
describe('residency plugin — GET map handler', () => {
  let plugin, tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'residency-'));
    plugin = createResidencyPlugin(path.join(tmpDir, 'residency.db'));
    plugin.init();
    const store = plugin.getStore();
    store.upsertNode({
      node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120,
      actuator_kind: 'omlx', actuator_url: 'http://localhost:8080'
    });
    store.upsertModel({
      node_id: 'mac', model_id: 'ds4', backend: 'omlx',
      kind: 'local', state: 'resident', rss_gb: 80
    });
    store.upsertRoute({ seat: 'lucy', backend: 'omlx', kind: 'local', mode_pref: 'local-first' });
  });

  afterEach(() => {
    plugin.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('factory exposes a single GET route at the spec path', () => {
    expect(plugin.name).toBe('residency');
    expect(plugin.version).toBe('0.1.0');
    const gets = plugin.routes.filter((r) => r.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(gets[0].path).toBe('/api/mycelium/residency');
  });

  test('handler returns the live map in the documented shape', () => {
    const route = plugin.routes.find((r) => r.method === 'GET');
    const body = route.handler({});

    expect(body.ok).toBe(true);
    expect(body.residency.nodes).toHaveLength(1);

    const node = body.residency.nodes[0];
    expect(node).toMatchObject({
      node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120,
      actuator_kind: 'omlx', actuator_url: 'http://localhost:8080'
    });
    expect(node.updated_at).toBeTruthy();
    expect(node.resident_set).toHaveLength(1);
    expect(node.resident_set[0]).toMatchObject({
      model_id: 'ds4', backend: 'omlx', kind: 'local', state: 'resident', rss_gb: 80
    });

    expect(body.residency.seat_routes[0]).toMatchObject({
      seat: 'lucy', backend: 'omlx', kind: 'local', mode_pref: 'local-first'
    });
  });

  test('handler throws cleanly before init()', () => {
    const uninit = createResidencyPlugin(path.join(tmpDir, 'x.db'));
    const route = uninit.routes.find((r) => r.method === 'GET');
    expect(() => route.handler({})).toThrow(/not initialised/);
  });
});

// ---------------------------------------------------------------------------
// 3. Policy: co-reside vs swap
// ---------------------------------------------------------------------------
describe('residency policy — decideResidency', () => {
  test('co-reside when ds4 + squad fits a 120GB budget', () => {
    // node currently has ds4 resident (80GB); squad-glm (27GB) requested.
    const d = decideResidency(
      [{ model_id: 'ds4', kind: 'local' }],
      { model_id: 'squad-glm', kind: 'local' },
      120
    );
    expect(d.action).toBe('co-reside');
    expect(d.total_gb).toBe(107); // 80 + 27
    expect(d.reason).toMatch(/co-reside/);
  });

  test('swap when ds4 + squad + Lucy exceeds a 120GB budget', () => {
    // resident set is ds4 (80) + squad-glm (27) = 107; Lucy-30B (30) requested.
    const d = decideResidency(
      [{ model_id: 'ds4', kind: 'local' }, { model_id: 'squad-glm', kind: 'local' }],
      { model_id: 'oMLX-Lucy-30B', kind: 'local' },
      120
    );
    expect(d.action).toBe('swap');
    expect(d.total_gb).toBe(137); // 80 + 27 + 30
    expect(d.reason).toMatch(/evict/);
  });

  test('api models cost 0 RAM and co-reside freely', () => {
    expect(estimateRss({ model_id: 'gpt-4o', kind: 'api' })).toBe(0);
    const d = decideResidency(
      [{ model_id: 'ds4', kind: 'local' }],
      { model_id: 'gpt-4o', kind: 'api' },
      80
    );
    expect(d.action).toBe('co-reside');
    expect(d.total_gb).toBe(80); // 80 + 0, fits exactly
  });

  test('unknown local model falls back to default-local (8GB)', () => {
    expect(estimateRss({ model_id: 'mystery-7b', kind: 'local' })).toBe(8);
  });

  test('explicit rss_gb overrides the lookup table', () => {
    expect(estimateRss({ model_id: 'ds4', kind: 'local', rss_gb: 42 })).toBe(42);
  });

  test('invalid budget is fail-closed to swap', () => {
    const d = decideResidency([], { model_id: 'ds4', kind: 'local' }, NaN);
    expect(d.action).toBe('swap');
  });

  test('modelRssLookup has the spec defaults', () => {
    expect(modelRssLookup).toMatchObject({
      ds4: 80, 'squad-glm': 27, 'oMLX-Lucy-30B': 30, 'default-local': 8, 'default-api': 0
    });
  });
});

// ---------------------------------------------------------------------------
// Mounted routes (supertest) — the regression class for the auth-hang bug.
//
// routes.js is the Express adapter the platform loader mounts at
// /api/mycelium/residency. It used core.auth.checkAgentOrAdmin as Express
// MIDDLEWARE, but that helper is imperative (sends 401/403 itself, returns the
// principal, never calls next()) — so every AUTHENTICATED request hung. These
// tests exercise the real mounted adapter with the shared mycelium core
// (auth + db) and prove: unauth → 401 (responds, no hang), auth → 200 + map,
// POST /decide runs the policy engine. Harness mirrors auth-roles.test.js.
// ---------------------------------------------------------------------------
describe('residency mounted routes (supertest)', () => {
  let app;
  let request;
  let tmpDir;
  const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef';
  const AGENT_KEY = 'dvk_' + 'a'.repeat(48);

  beforeAll(async () => {
    const crypto = await import('node:crypto');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'residency-mount-'));
    process.env.DATA_DIR = tmpDir;
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = 'test-jwt-secret';

    // Shared mycelium DB connection (initDB opens it from DATA_DIR).
    const db = await import('../../server/db.js');
    db.initDB();

    // Seed an agent whose key authenticates via the X-Agent-Key header.
    const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex');
    db.createAgent('residency-agent', 'Residency Agent', 'residency-proj', hash, '["code"]');

    // Seed residency data on the SAME connection the mounted route reads.
    const store = createResidencyDB(db.getDB());
    store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 96 });
    store.upsertRoute({ seat: 'seat-1', backend: 'mac', kind: 'local', mode_pref: 'ollama' });

    // Import the mycelium router AFTER env is set, mount it, then initPlugins()
    // so the platform loader mounts residency at /residency on that router.
    const express = (await import('express')).default;
    const mycelium = await import('../../server/routes/mycelium.js');
    app = express();
    app.use(express.json());
    app.use('/api/mycelium', mycelium.default);
    await mycelium.initPlugins();

    request = (await import('supertest')).default;
  });

  afterAll(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  });

  test('GET /residency without auth → 401 (responds, does not hang)', async () => {
    const res = await request(app).get('/api/mycelium/residency');
    expect(res.status).toBe(401);
  });

  test('GET /residency with agent key → 200 + residency map shape', async () => {
    const res = await request(app)
      .get('/api/mycelium/residency')
      .set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.residency.nodes)).toBe(true);
    expect(Array.isArray(res.body.residency.seat_routes)).toBe(true);
    expect(res.body.residency.nodes.length).toBeGreaterThan(0);
  });

  test('GET /residency with admin key → 200', async () => {
    const res = await request(app)
      .get('/api/mycelium/residency')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('POST /residency/decide with valid body → 200 + decision shape', async () => {
    const res = await request(app)
      .post('/api/mycelium/residency/decide')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ resident_set: ['default-api'], candidate: 'default-local', ram_budget_gb: 64 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(['co-reside', 'swap']).toContain(res.body.decision.action);
    expect(typeof res.body.decision.total_gb).toBe('number');
    expect(typeof res.body.decision.reason).toBe('string');
  });

  test('POST /residency/decide with missing fields → 400', async () => {
    const res = await request(app)
      .post('/api/mycelium/residency/decide')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ resident_set: ['default-api'] }); // missing candidate + ram_budget_gb
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
