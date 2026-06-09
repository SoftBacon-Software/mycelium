// Semantic-memory plugin tests — on-ramp handlers + embedding backfill.
// Run from server/:  node --test plugins/semantic-memory/test.js
// Real schema.sql + real routes/handlers on an in-memory better-sqlite3 DB;
// core helpers faked faithfully (same shapes as routes/mycelium.js). The
// embedding provider is hermetic: global fetch is patched to answer Ollama
// embed calls with a fixed vector — no live Ollama needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import express from 'express';
import Database from 'better-sqlite3';

import createRoutes from './routes.js';
import createMemoryDB from './db.js';
import { registerHooks } from './handlers.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- hermetic embedding provider: patch fetch for localhost:11434 only ----
var realFetch = global.fetch;
var embedCalls = 0;
var FAKE_VECTOR = [0.1, 0.2, 0.3];

// ---- faithful fakes of the pluginCore helpers ----
function apiError(res, status, message, extra) {
  return res.status(status).json(Object.assign({ error: message }, extra || {}));
}
function parseIntParam(val) {
  var n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}
var hooks = {};
function fire(type, eventData) {
  var fns = hooks[type] || [];
  for (var fn of fns) fn(Object.assign({ type: type }, eventData));
}
function makeCore(db) {
  return {
    db: db,
    auth: {
      checkAgentOrAdmin: function (req, res) {
        if (req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return req.headers['x-acting-as'] || 'tester';
      },
      checkAdmin: function (req, res) {
        if (req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return 'tester';
      },
      getAdminDisplayName: function () { return 'tester'; }
    },
    apiError: apiError,
    parseIntParam: parseIntParam,
    validateEnum: function () { return true; },
    emitEvent: function () {},
    onEvent: function (type, fn) {
      (hooks[type] = hooks[type] || []).push(fn);
    },
    gatedActions: [],
    inbox: {}
  };
}

var server, base, db, mem;

// Minimal platform tables the handlers read (same columns as server/schema.sql
// and the workflows plugin schema — only what the handlers touch).
var PLATFORM_TABLES = `
CREATE TABLE concepts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  description TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE agent_savepoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  working_on TEXT NOT NULL DEFAULT '',
  notes TEXT
);
CREATE TABLE workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  shape TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'pending',
  project_id TEXT
);
CREATE TABLE workflow_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT ''
);
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE plan_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  linked_task_id INTEGER
);
CREATE TABLE plugin_config (
  plugin_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_name, key)
);
`;

before(function () {
  global.fetch = function (url, opts) {
    if (String(url).indexOf('11434') !== -1) {
      embedCalls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ embeddings: [FAKE_VECTOR] }); }
      });
    }
    return realFetch(url, opts);
  };

  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.exec(PLATFORM_TABLES);

  var core = makeCore(db);
  registerHooks(core);
  mem = createMemoryDB(db);
  mem.setConfig('embedding_provider', 'ollama');
  mem.setConfig('embedding_url', 'http://localhost:11434');
  mem.setConfig('embedding_model', 'nomic-embed-text');

  var app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/memory', createRoutes(core));
  server = http.createServer(app);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(function () {
  server.close();
  global.fetch = realFetch;
});

async function call(method, p, body, headers) {
  var res = await realFetch(base + p, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

function getDoc(sourceType, sourceId) {
  return db.prepare('SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ?').get(sourceType, String(sourceId));
}

// Fire-and-forget embeds land a few ticks after the handler returns.
async function waitFor(fn, ms) {
  var deadline = Date.now() + (ms || 1000);
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(function (r) { setTimeout(r, 10); });
  }
  return fn();
}

// Config: the platform plugin_config store is honored as a fallback;
// the plugin's own sm_config wins on conflict.
test('config: plugin_config fallback merges under sm_config', function () {
  db.prepare("INSERT INTO plugin_config (plugin_name, key, value) VALUES ('semantic-memory', 'chunk_size', '512')").run();
  db.prepare("INSERT INTO plugin_config (plugin_name, key, value) VALUES ('semantic-memory', 'embedding_model', 'platform-model')").run();
  var config = mem.getAllConfig();
  assert.equal(config.chunk_size, '512', 'plugin_config-only key visible');
  assert.equal(config.embedding_model, 'nomic-embed-text', 'sm_config wins on conflict');
  assert.equal(mem.getConfig('chunk_size'), '512');
  assert.equal(mem.getConfig('embedding_model'), 'nomic-embed-text');
});

// #191: concept_created carries no data payload — the handler resolves the
// concept from the summary + concepts table, indexes it, and embeds it.
test('handler: concept_created indexes + embeds the concept', async function () {
  var conceptId = db.prepare(
    "INSERT INTO concepts (name, type, description, data) VALUES ('Vector Memory', 'custom', 'Hybrid keyword and vector search for the platform', '{\"status\":\"live\"}') RETURNING id"
  ).get().id;
  fire('concept_created', { agent: 'tester', summary: 'Created concept: Vector Memory (custom)', data: null });

  var doc = getDoc('concept', conceptId);
  assert.ok(doc, 'concept indexed');
  assert.match(doc.content_text, /Vector Memory: Hybrid keyword and vector search/);
  assert.match(doc.content_text, /"status":"live"/);

  var ok = await waitFor(function () { var d = getDoc('concept', conceptId); return d && d.embedding; });
  assert.ok(ok, 'embedding generated for handler-indexed concept');
  assert.deepEqual(JSON.parse(getDoc('concept', conceptId).embedding.toString()), FAKE_VECTOR);
});

test('handler: concept_updated re-indexes changed content', async function () {
  var conceptId = db.prepare(
    "INSERT INTO concepts (name, description) VALUES ('Sidecar', 'Reusable UI primitive with three states') RETURNING id"
  ).get().id;
  fire('concept_updated', { agent: 'tester', summary: 'Updated concept: Sidecar', data: null });
  var doc = getDoc('concept', conceptId);
  assert.ok(doc, 'updated concept indexed');
  assert.match(doc.content_text, /Sidecar: Reusable UI primitive/);
});

test('handler: agent_heartbeat indexes latest savepoint, skips unchanged', async function () {
  db.prepare(
    "INSERT INTO agent_savepoints (agent_id, working_on, notes) VALUES ('m5max', 'fixing the semantic-memory on-ramp', 'backfill route next')"
  ).run();
  fire('agent_heartbeat', { agent: 'm5max', summary: 'm5max is online' });

  var doc = getDoc('savepoint', 'm5max');
  assert.ok(doc, 'savepoint indexed');
  assert.match(doc.content_text, /fixing the semantic-memory on-ramp\nbackfill route next/);

  var ok = await waitFor(function () { var d = getDoc('savepoint', 'm5max'); return d && d.embedding; });
  assert.ok(ok, 'savepoint embedded');

  // Same savepoint re-fires every heartbeat — must not re-embed
  var callsBefore = embedCalls;
  fire('agent_heartbeat', { agent: 'm5max', summary: 'm5max is online' });
  await new Promise(function (r) { setTimeout(r, 50); });
  assert.equal(embedCalls, callsBefore, 'unchanged savepoint not re-embedded');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sm_embeddings WHERE source_type = 'savepoint'").get().n, 1, 'one doc per agent');
});

test('handler: savepoint_notes re-indexes via summary-parsed agent id', async function () {
  db.prepare(
    "INSERT INTO agent_savepoints (agent_id, working_on, notes) VALUES ('m5max', 'fixing the semantic-memory on-ramp', 'handoff: gate output pasted')"
  ).run();
  fire('savepoint_notes', { agent: '__admin__', summary: 'Admin left notes for m5max: handoff: gate output pasted' });
  var doc = getDoc('savepoint', 'm5max');
  assert.match(doc.content_text, /handoff: gate output pasted/, 'latest savepoint content indexed');
});

test('handler: workflow_created + workflow_completed index name and briefs', async function () {
  var wfId = db.prepare(
    "INSERT INTO workflows (name, shape, project_id) VALUES ('research: embedding providers', 'fanout', 'mycelium') RETURNING id"
  ).get().id;
  db.prepare("INSERT INTO workflow_invocations (workflow_id, agent_id, brief) VALUES (?, 'scout', 'survey ollama embed endpoints')").run(wfId);
  db.prepare("INSERT INTO workflow_invocations (workflow_id, agent_id, brief) VALUES (?, 'echo', 'verify dimensions match config')").run(wfId);

  fire('workflow_created', { agent: 'tester', summary: 'fired workflow', data: { workflow_id: wfId } });
  var doc = getDoc('workflow', wfId);
  assert.ok(doc, 'workflow indexed');
  assert.match(doc.content_text, /research: embedding providers \[fanout\]/);
  assert.match(doc.content_text, /scout: survey ollama embed endpoints/);
  assert.match(doc.content_text, /echo: verify dimensions match config/);

  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(wfId);
  fire('workflow_completed', { agent: 'tester', summary: 'workflow completed', data: { workflow_id: wfId } });
  doc = getDoc('workflow', wfId);
  assert.match(doc.content_text, /^COMPLETED: research: embedding providers/);
});

test('handler: plan_created + plan_step_completed', async function () {
  var planId = db.prepare(
    "INSERT INTO plans (title, description, project_id) VALUES ('Memory on-ramp', 'Index all platform-native content', 'mycelium') RETURNING id"
  ).get().id;
  fire('plan_created', { agent: 'tester', summary: 'created plan', data: { plan_id: planId } });
  var doc = getDoc('plan', planId);
  assert.ok(doc, 'plan indexed');
  assert.match(doc.content_text, /Memory on-ramp\nIndex all platform-native content/);

  var stepId = db.prepare(
    "INSERT INTO plan_steps (plan_id, title, description, status, linked_task_id) VALUES (?, 'Add concept handler', 'Hook concept_created', 'completed', 77) RETURNING id"
  ).get(planId).id;
  fire('plan_step_completed', { agent: 'lucy', summary: '1 plan step(s) auto-completed by task #77', data: { task_id: 77, steps: 1 } });
  var stepDoc = getDoc('plan_step', stepId);
  assert.ok(stepDoc, 'plan step indexed');
  assert.match(stepDoc.content_text, /^COMPLETED: Add concept handler/);
});

// Second root cause of the unembedded backlog: POST /index stored NULL
// embeddings forever. It must now fire embedding generation.
test('routes: POST /index and /index/bulk auto-embed', async function () {
  var r = await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'route-embed-1',
    content_text: 'route-level indexing must embed when a provider is configured'
  });
  assert.equal(r.status, 200);
  var ok = await waitFor(function () { var d = getDoc('m5max_memory', 'route-embed-1'); return d && d.embedding; });
  assert.ok(ok, 'POST /index embedded');

  var rb = await call('POST', '/memory/index/bulk', { items: [
    { source_type: 'm5max_memory', source_id: 'route-bulk-1', content_text: 'first bulk item gets a vector too' },
    { source_type: 'm5max_memory', source_id: 'route-bulk-2', content_text: 'second bulk item gets a vector too' }
  ] });
  assert.equal(rb.status, 200);
  assert.equal(rb.body.indexed, 2);
  var okBulk = await waitFor(function () {
    var a = getDoc('m5max_memory', 'route-bulk-1');
    var b = getDoc('m5max_memory', 'route-bulk-2');
    return a && a.embedding && b && b.embedding;
  });
  assert.ok(okBulk, 'bulk items embedded');
});

test('backfill: embeds NULL rows, bounded by ?limit=, idempotent', async function () {
  // Seed rows the way the backlog was created: indexed without embeddings
  for (var i = 0; i < 5; i++) {
    mem.index('m5max_memory', 'backlog-' + i, 'unembedded backlog row number ' + i + ' for the backfill route');
  }
  var pre = mem.countUnembedded();
  assert.ok(pre >= 5, 'seeded NULL-embedding rows');

  var first = await call('POST', '/memory/backfill-embeddings?limit=2');
  assert.equal(first.status, 200);
  assert.equal(first.body.processed, 2);
  assert.equal(first.body.embedded, 2);
  assert.equal(first.body.failed, 0);
  assert.equal(first.body.remaining, pre - 2, 'remaining reports total docs still lacking embeddings');

  var second = await call('POST', '/memory/backfill-embeddings');
  assert.equal(second.status, 200);
  assert.equal(second.body.embedded, pre - 2);
  assert.equal(second.body.remaining, 0);

  // Re-runnable: nothing left to touch
  var third = await call('POST', '/memory/backfill-embeddings');
  assert.equal(third.status, 200);
  assert.equal(third.body.processed, 0);
  assert.equal(third.body.embedded, 0);
  assert.equal(third.body.remaining, 0);

  var doc = getDoc('m5max_memory', 'backlog-0');
  assert.deepEqual(JSON.parse(doc.embedding.toString()), FAKE_VECTOR);
});

test('backfill: 400 when no provider configured', async function () {
  // Temporarily clear both config stores
  var saved = db.prepare('SELECT key, value FROM sm_config').all();
  db.prepare('DELETE FROM sm_config').run();
  var savedPlugin = db.prepare("SELECT key, value FROM plugin_config WHERE plugin_name = 'semantic-memory'").all();
  db.prepare("DELETE FROM plugin_config WHERE plugin_name = 'semantic-memory'").run();
  try {
    var r = await call('POST', '/memory/backfill-embeddings');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /No embedding provider configured/);
  } finally {
    for (var row of saved) mem.setConfig(row.key, row.value);
    for (var prow of savedPlugin) {
      db.prepare("INSERT INTO plugin_config (plugin_name, key, value) VALUES ('semantic-memory', ?, ?)").run(prow.key, prow.value);
    }
  }
});

test('auth: unauthenticated backfill and index get 401, nothing written', async function () {
  var beforeCount = db.prepare('SELECT COUNT(*) AS n FROM sm_embeddings').get().n;
  var r = await call('POST', '/memory/backfill-embeddings', undefined, { 'x-test-deny': '1' });
  assert.equal(r.status, 401);
  var r2 = await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'nope', content_text: 'should never land'
  }, { 'x-test-deny': '1' });
  assert.equal(r2.status, 401);
  var afterCount = db.prepare('SELECT COUNT(*) AS n FROM sm_embeddings').get().n;
  assert.equal(afterCount, beforeCount);
});
