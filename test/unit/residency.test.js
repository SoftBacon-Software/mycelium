import { describe, test, expect, beforeEach, afterEach } from 'vitest';
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
