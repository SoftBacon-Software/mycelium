// auto-memory plugin load+mount smoke — closes the plugin-test blind spot
// (CI's `node --test server/plugins/*/test.js` glob skipped any plugin without
// a test.js, so a broken plugin shipped green). Mirrors the
// workflows/semantic-memory node:test suites: real schema.sql on an in-memory
// better-sqlite3 DB, a faithful pluginCore fake, and the plugin's own
// routes/handlers loaded the same way server/plugins.js loads them. The bar is
// "the plugin loads and its contract holds" — routes register and hooks
// register without throwing — not exhaustive endpoint coverage.
//
// Run from repo root:  node --test server/plugins/auto-memory/test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import createRoutes from './routes.js';
import { registerHooks } from './handlers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeCore(db) {
  var subscriptions = [];
  return {
    db: db,
    _subscriptions: subscriptions,
    auth: {
      checkAgentOrAdmin(req, res) {
        if (req.headers && req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return (req.headers && req.headers['x-acting-as']) || 'tester';
      },
      checkAdmin() { return 'tester'; },
      getAdminDisplayName() { return 'tester'; }
    },
    apiError(res, status, message, extra) { return res.status(status).json(Object.assign({ error: message }, extra || {})); },
    parseIntParam(val) { var n = parseInt(val, 10); return isNaN(n) ? null : n; },
    validateEnum() { return true; },
    emitEvent() {},
    onEvent(type) { subscriptions.push(type); },
    gatedActions: [],
    inbox: {}
  };
}

function freshDB() {
  var db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

test('auto-memory: routes load against a fresh schema and register without throwing', () => {
  var router = createRoutes(makeCore(freshDB()));
  assert.ok(router, 'createRoutes returned a value');
  assert.equal(typeof router.use, 'function', 'createRoutes returned an express Router');
  assert.ok(router.stack.length > 0, 'auto-memory registered at least one route');
});

test('auto-memory: event hooks register without throwing and subscribe to ≥1 event', () => {
  var core = makeCore(freshDB());
  registerHooks(core);
  assert.ok(core._subscriptions.length > 0, 'auto-memory subscribed to at least one platform event');
});

// -- Namespace scoping regressions (task 206): absent namespace = today's
// behavior, byte for byte; namespaced rows never leak into the unscoped views.
// These dispatch through a real express app so the guards run as mounted.
import express from 'express';

// Both plugin schemas: the semantic index (sm_embeddings) is part of the fact
// routes' contract — indexFactInMemory's fail-soft 'indexed:false' is what a
// semantic-memory-less deployment honestly reports, and this regression pins
// the deploy-with-both case.
function freshDBBoth() {
  var db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(here, '../semantic-memory/schema.sql'), 'utf8'));
  return db;
}

async function listenApp(core) {
  var app = express();
  app.use(express.json());
  app.use('/api/mycelium/auto-memory', createRoutes(core));
  var server = app.listen(0, '127.0.0.1');
  await new Promise(function (r) { server.on('listening', r); });
  return { base: 'http://127.0.0.1:' + server.address().port + '/api/mycelium/auto-memory', close: function () { server.close(); } };
}

test('auto-memory: no-namespace fact routes behave exactly as before namespaces (create → list → supersede)', async () => {
  var core = makeCore(freshDBBoth());
  var svc = await listenApp(core);
  try {
    var res = await fetch(svc.base + '/facts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fact_text: 'A legacy fact from the internal writer' }) });
    var body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['fact', 'id', 'memory_index', 'ok']);
    assert.equal(body.memory_index.indexed, true);
    assert.equal(body.fact.namespace, null);

    var list = await (await fetch(svc.base + '/facts')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, body.id);

    var neu = await (await fetch(svc.base + '/facts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fact_text: 'The replacement legacy fact, restated' }) })).json();
    var sup = await fetch(svc.base + '/facts/' + body.id + '/supersede', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_id: neu.id }) });
    assert.equal(sup.status, 200);
    assert.deepEqual(await sup.json(), { ok: true }); // legacy supersede response, unchanged

    var after = await (await fetch(svc.base + '/facts')).json();
    assert.deepEqual(after.map(function (f) { return f.id; }), [neu.id]); // superseded row hidden
  } finally { svc.close(); }
});

test('auto-memory: namespaced facts are invisible to every unscoped read', async () => {
  var core = makeCore(freshDBBoth());
  var svc = await listenApp(core);
  try {
    var ns = 'bench-p1-regression';
    await fetch(svc.base + '/facts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fact_text: 'A bench run fact for question one', namespace: ns }) });
    var unscoped = await (await fetch(svc.base + '/facts')).json();
    assert.equal(unscoped.length, 0, 'unscoped GET /facts must not surface namespaced rows');
    var due = await (await fetch(svc.base + '/facts/due-reverification')).json();
    assert.equal(due.length, 0, 'unscoped re-verify queue must not surface namespaced rows');
    var scoped = await (await fetch(svc.base + '/facts?namespace=' + encodeURIComponent(ns))).json();
    assert.equal(scoped.length, 1);
  } finally { svc.close(); }
});
