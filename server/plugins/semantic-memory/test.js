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
import { chunkText } from './chunking.js';

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

// Redaction guard: PUT /memory/config must not echo the embedding API key
// back in its response body — mirrors the GET handler's redaction.
test('routes: PUT /memory/config response does NOT leak embedding_api_key', async function () {
  // Set a fake API key in config
  mem.setConfig('embedding_api_key', 'sk-fake-test-key-12345');
  assert.strictEqual(mem.getConfig('embedding_api_key'), 'sk-fake-test-key-12345', 'key is stored');

  // PUT config — update another field. NOTE: we restore embedding_provider
  // below; leaving it as 'openai' would re-route downstream embedding tests
  // off the hermetic Ollama fetch-patch and break them (shared in-memory DB).
  var prevProvider = mem.getConfig('embedding_provider');
  var r = await call('PUT', '/memory/config', { embedding_provider: 'openai' });
  assert.equal(r.status, 200);
  assert.ok(r.body.config, 'response contains config object');

  // The critical assertion: API key must NOT be in the response
  assert.strictEqual(r.body.config.embedding_api_key, undefined, 'embedding_api_key redacted from PUT response');

  // Verify the key is still persisted (we only redact the response, not the stored value)
  assert.strictEqual(mem.getConfig('embedding_api_key'), 'sk-fake-test-key-12345', 'key still persisted');

  // Also verify GET still redacts (regression guard)
  var g = await call('GET', '/memory/config');
  assert.strictEqual(g.body.embedding_api_key, undefined, 'embedding_api_key redacted from GET response');

  // Teardown: restore the provider so we don't pollute the shared DB for
  // later embedding tests.
  mem.setConfig('embedding_provider', prevProvider);
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

// ---- chunked embedding (#228): docs past the model's window split into
// chunk rows that embed independently ----

// Build paragraph-y text where every paragraph carries a marker token
function makeBigText(token, paras) {
  var out = [];
  for (var i = 0; i < paras; i++) {
    out.push(token + ' section ' + i + ': ' + 'the squad loop is the work and the substrate is identity. '.repeat(4).trim());
  }
  return out.join('\n\n');
}

function getChunkRows(sourceType, sourceId) {
  return db.prepare(
    'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? ORDER BY chunk_index'
  ).all(sourceType, String(sourceId));
}

test('chunker: lossless boundary-preferring split, hard fallback, small untouched', function () {
  var text = makeBigText('chunkertest', 14);
  var chunks = chunkText(text, 600);
  assert.ok(chunks.length > 1, 'oversized text split');
  assert.equal(chunks.join(''), text, 'lossless partition');
  for (var c of chunks) assert.ok(c.length <= 600, 'chunk within limit');
  for (var j = 0; j < chunks.length - 1; j++) {
    assert.match(chunks[j], /\n$/, 'cuts land on clean line boundaries');
  }
  // hard split fallback: no separators anywhere
  var blob = 'x'.repeat(1500);
  var hard = chunkText(blob, 600);
  assert.deepEqual(hard.map(function (h) { return h.length; }), [600, 600, 300]);
  assert.equal(hard.join(''), blob);
  // small text untouched
  assert.deepEqual(chunkText('small doc', 600), ['small doc']);
});

test('routes: oversized doc auto-chunks on index, every chunk embeds', async function () {
  mem.setConfig('chunk_size', '600'); // sm_config wins — deterministic for the chunk tests
  var big = makeBigText('oversizeindex', 8);
  assert.ok(big.length > 1200, 'doc spans multiple chunks');

  var r = await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'big-doc-1', content_text: big,
    namespace: 'memories', metadata: { topic: 'chunking' }
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.chunks > 1, 'reported multiple chunks');

  var rows = getChunkRows('m5max_memory', 'big-doc-1');
  assert.equal(rows.length, r.body.chunks);
  assert.deepEqual(
    rows.map(function (x) { return x.chunk_index; }),
    rows.map(function (_, i) { return i; }),
    'contiguous chunk_index 0..N'
  );
  assert.equal(rows.map(function (x) { return x.content_text; }).join(''), big, 'chunks reassemble the doc');
  for (var row of rows) {
    assert.ok(row.content_text.length <= 600, 'each chunk fits the window');
    assert.equal(row.namespace, 'memories', 'namespace carried to every chunk');
    assert.match(row.metadata, /chunking/, 'metadata carried to every chunk');
  }

  var ok = await waitFor(function () {
    var rs = getChunkRows('m5max_memory', 'big-doc-1');
    return rs.length > 1 && rs.every(function (x) { return x.embedding; });
  });
  assert.ok(ok, 'every chunk embedded');
});

test('routes: small doc stays a single row at chunk_index 0', async function () {
  var r = await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'small-doc-1',
    content_text: 'a small doc stays one row'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.chunks, 1);
  var rows = getChunkRows('m5max_memory', 'small-doc-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chunk_index, 0);
  assert.equal(rows[0].content_text, 'a small doc stays one row');
});

test('routes: re-index replaces chunk rows — no orphans either direction', async function () {
  var big = makeBigText('reindexorphan', 10);
  await call('POST', '/memory/index', { source_type: 'm5max_memory', source_id: 'reindex-1', content_text: big });
  var n1 = getChunkRows('m5max_memory', 'reindex-1').length;
  assert.ok(n1 > 2, 'first index produced several chunks');

  // shrink to fewer (but still multiple) chunks — extra rows must go
  var smallerBig = makeBigText('reindexorphan', 5);
  await call('POST', '/memory/index', { source_type: 'm5max_memory', source_id: 'reindex-1', content_text: smallerBig });
  var rows2 = getChunkRows('m5max_memory', 'reindex-1');
  assert.ok(rows2.length < n1, 'fewer chunks after shrinking');
  assert.equal(rows2.map(function (x) { return x.content_text; }).join(''), smallerBig, 'no stale chunk content');

  // shrink to a small doc — exactly one row left
  await call('POST', '/memory/index', { source_type: 'm5max_memory', source_id: 'reindex-1', content_text: 'now a small doc again' });
  var rows3 = getChunkRows('m5max_memory', 'reindex-1');
  assert.equal(rows3.length, 1, 'single row after small re-index — no orphans');
  assert.equal(rows3[0].chunk_index, 0);
  assert.equal(rows3[0].content_text, 'now a small doc again');
});

test('routes: bulk index chunks oversized items, small items single-row', async function () {
  var big = makeBigText('bulkoversize', 8);
  var r = await call('POST', '/memory/index/bulk', { items: [
    { source_type: 'm5max_memory', source_id: 'bulk-big-1', content_text: big },
    { source_type: 'm5max_memory', source_id: 'bulk-small-1', content_text: 'small bulk item rides along' }
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.indexed, 2, 'indexed counts docs');
  assert.ok(r.body.rows > 3, 'rows counts post-chunking rows');

  var bigRows = getChunkRows('m5max_memory', 'bulk-big-1');
  assert.ok(bigRows.length > 1, 'oversized bulk item chunked');
  assert.equal(bigRows.map(function (x) { return x.content_text; }).join(''), big);
  assert.equal(getChunkRows('m5max_memory', 'bulk-small-1').length, 1);

  var ok = await waitFor(function () {
    var rs = getChunkRows('m5max_memory', 'bulk-big-1');
    var small = getChunkRows('m5max_memory', 'bulk-small-1');
    return rs.every(function (x) { return x.embedding; }) && small[0] && small[0].embedding;
  });
  assert.ok(ok, 'every bulk chunk embedded');
});

test('handler: oversized content chunks via indexAndEmbed, unchanged skip still holds', async function () {
  var big = makeBigText('handleroversize', 8);
  fire('context_key_updated', { agent: 'tester', data: { namespace: 'ops', key: 'bigkey', value: big } });

  var rows = getChunkRows('context_key', 'ops:bigkey');
  assert.ok(rows.length > 1, 'handler-indexed doc chunked');
  assert.equal(rows.map(function (x) { return x.content_text; }).join(''), big, 'chunks reassemble the doc');

  var ok = await waitFor(function () {
    var rs = getChunkRows('context_key', 'ops:bigkey');
    return rs.length > 1 && rs.every(function (x) { return x.embedding; });
  });
  assert.ok(ok, 'all handler chunks embedded');

  // Re-fire with identical content — must not re-index or re-embed
  var callsBefore = embedCalls;
  var rowCountBefore = getChunkRows('context_key', 'ops:bigkey').length;
  fire('context_key_updated', { agent: 'tester', data: { namespace: 'ops', key: 'bigkey', value: big } });
  await new Promise(function (r) { setTimeout(r, 50); });
  assert.equal(embedCalls, callsBefore, 'unchanged chunked doc not re-embedded');
  assert.equal(getChunkRows('context_key', 'ops:bigkey').length, rowCountBefore, 'row count unchanged');
});

test('backfill: oversized NULL row is chunked and embedded instead of failing', async function () {
  // Seed the way the live backlog looks: one un-chunked oversized row,
  // NULL embedding (indexed before chunking existed)
  var big = makeBigText('legacybacklog', 8);
  mem.index('m5max_memory', 'legacy-big-1', big, { namespace: 'memories', metadata: { legacy: true } });
  var seeded = getChunkRows('m5max_memory', 'legacy-big-1');
  assert.equal(seeded.length, 1);
  assert.ok(seeded[0].content_text.length > 600, 'seeded row is oversized');
  assert.equal(seeded[0].embedding, null);

  // Let in-flight fire-and-forget embeds from earlier tests land first
  await waitFor(function () { return mem.countUnembedded() === 1; });

  var r = await call('POST', '/memory/backfill-embeddings?limit=50');
  assert.equal(r.status, 200);
  assert.equal(r.body.failed, 0, 'no failures — oversized doc chunked instead');
  assert.ok(r.body.embedded > 1, 'embedded one vector per chunk');
  assert.equal(r.body.remaining, 0);

  var rows = getChunkRows('m5max_memory', 'legacy-big-1');
  assert.ok(rows.length > 1, 'row replaced by chunk rows');
  assert.equal(rows.map(function (x) { return x.content_text; }).join(''), big, 'chunks reassemble the doc');
  for (var row of rows) {
    assert.ok(row.embedding, 'every chunk embedded');
    assert.equal(row.namespace, 'memories', 'namespace preserved through backfill chunking');
    assert.match(row.metadata, /legacy/, 'metadata preserved through backfill chunking');
  }
});

test('backfill: already-chunked doc with an oversized chunk re-chunks from the FULL doc', async function () {
  // Live failure shape (2026-06-09): a chunk cut at an older, larger
  // threshold still exceeds the model's window. Re-chunk must rebuild from
  // ALL chunk rows — re-chunking one chunk's slice would drop the rest.
  mem.setConfig('chunk_size', '600');
  var big = makeBigText('thresholdshift', 8);
  await call('POST', '/memory/index', { source_type: 'm5max_memory', source_id: 'shift-1', content_text: big });
  await waitFor(function () {
    var rs = getChunkRows('m5max_memory', 'shift-1');
    return rs.length > 1 && rs.every(function (x) { return x.embedding; });
  });
  var before = getChunkRows('m5max_memory', 'shift-1');

  // Threshold drops; one existing chunk is now oversized and unembedded
  mem.setConfig('chunk_size', '300');
  db.prepare(
    "UPDATE sm_embeddings SET embedding = NULL WHERE source_type='m5max_memory' AND source_id='shift-1' AND chunk_index = 0"
  ).run();

  var r = await call('POST', '/memory/backfill-embeddings?limit=50');
  assert.equal(r.status, 200);
  assert.equal(r.body.failed, 0);
  assert.equal(r.body.remaining, 0);

  var after = getChunkRows('m5max_memory', 'shift-1');
  assert.ok(after.length > before.length, 're-chunked at the smaller threshold');
  assert.equal(after.map(function (x) { return x.content_text; }).join(''), big, 'no content lost in re-chunk');
  for (var row of after) {
    assert.ok(row.content_text.length <= 300, 'chunks fit the new threshold');
    assert.ok(row.embedding, 'every re-chunked chunk embedded');
  }
  mem.setConfig('chunk_size', '600'); // restore for later tests
});

test('search: multi-chunk doc collapses to its best chunk', async function () {
  var big = makeBigText('zebrafish', 8); // every chunk carries the marker token
  await call('POST', '/memory/index', { source_type: 'm5max_memory', source_id: 'collapse-big', content_text: big });
  await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'collapse-small',
    content_text: 'zebrafish appears once in this small doc'
  });
  await waitFor(function () { return mem.countUnembedded() === 0; });

  for (var mode of ['keyword', 'hybrid']) {
    var r = await call('POST', '/memory/search', { query: 'zebrafish', mode: mode, limit: 10 });
    assert.equal(r.status, 200);
    var bigHits = r.body.results.filter(function (x) { return x.source_id === 'collapse-big'; });
    var smallHits = r.body.results.filter(function (x) { return x.source_id === 'collapse-small'; });
    assert.equal(bigHits.length, 1, mode + ': multi-chunk doc collapsed to one result');
    assert.equal(smallHits.length, 1, mode + ': other matching docs still surface');
    assert.equal(bigHits[0].embedding, undefined, mode + ': raw vectors stripped');
  }
});

// ---- 3 bounded correctness fixes: per-instance _vecAvailable, chunk_index:0,
// and null-embedding stringification ----

// Fix (a): _vecAvailable is per-instance, not a module-level singleton.
// Each createMemoryDB() independently determines whether ITS db can load
// sqlite-vec — the first instance no longer poisons every later one.
test('db: vecAvailable is per-instance, not a module-level singleton', function () {
  var db1 = new Database(':memory:');
  db1.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  var mem1 = createMemoryDB(db1);

  var db2 = new Database(':memory:');
  db2.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  var mem2 = createMemoryDB(db2);

  // Both instances independently settle to a boolean (ran their own check,
  // not a cached module-level value left at null).
  assert.strictEqual(typeof mem1.vecAvailable(), 'boolean');
  assert.strictEqual(typeof mem2.vecAvailable(), 'boolean');

  // stats() reads the SAME per-instance flag, not a shared module var.
  assert.strictEqual(mem1.stats().vec_available, mem1.vecAvailable());
  assert.strictEqual(mem2.stats().vec_available, mem2.vecAvailable());

  db1.close();
  db2.close();
});

// Fix (b): bulkIndex honors an explicit chunk_index of 0. Pre-fix,
// `if (item.chunk_index)` treated 0 as falsy and fell through to indexDoc,
// which re-chunked oversized content and discarded the caller's assignment.
// NOTE: this only manifests with OVERSIZED content — small content produces
// a single chunk either way, so the test must use oversized text to catch it.
test('db: bulkIndex respects explicit chunk_index 0 — oversized content stays one row', function () {
  mem.setConfig('chunk_size', '600');
  var big = makeBigText('chunkzero', 8); // oversized — would auto-chunk without the fix
  assert.ok(big.length > 600, 'content is oversized');

  var rows = mem.bulkIndex([
    { source_type: 'test', source_id: 'chunk-zero', content_text: big, chunk_index: 0 }
  ]);
  // Explicit chunk_index: 0 => stored as a SINGLE row, NOT auto-chunked.
  assert.strictEqual(rows.length, 1, 'one row — caller chunk_index honored');
  assert.strictEqual(rows[0].chunk_index, 0);
  assert.strictEqual(rows[0].content_text, big, 'full content, not a fragment');

  assert.strictEqual(getChunkRows('test', 'chunk-zero').length, 1, 'exactly one DB row');
  var doc = mem.getDoc('test', 'chunk-zero', 0);
  assert.ok(doc);
  assert.strictEqual(doc.content_text, big);
});

// Fix (c): updateEmbedding(null) must keep the column as SQL NULL, not the
// string "null". The string would escape `embedding IS NULL` and permanently
// hide the row from backfill — silent data loss. Scoped to this one row so
// it is immune to other tests' in-flight async embeds.
test('db: updateEmbedding(null) keeps row as SQL NULL, not the string "null"', function () {
  mem.index('test', 'null-embed-test', 'content for null embedding test', {});
  var row0 = db.prepare(
    'SELECT embedding FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = ?'
  ).get('test', 'null-embed-test', 0);
  assert.strictEqual(row0.embedding, null, 'freshly indexed row has NULL embedding');

  mem.updateEmbedding('test', 'null-embed-test', 0, null, 'some-model');

  // The null must NOT have been stringified to "null" — column stays SQL NULL.
  var row = db.prepare(
    'SELECT embedding FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = ?'
  ).get('test', 'null-embed-test', 0);
  assert.strictEqual(row.embedding, null, 'embedding column is SQL NULL');
  assert.notStrictEqual(row.embedding, 'null', 'not the string "null"');

  // Still matches `embedding IS NULL` => remains backfill-visible.
  var unembedded = db.prepare(
    'SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND embedding IS NULL'
  ).get('test', 'null-embed-test').c;
  assert.strictEqual(unembedded, 1, 'row still backfill-visible (embedding IS NULL)');
});

// ---- 3 P1 correctness fixes: searchVector chunk-collapse, task_completed
// content preservation, and the getChunkSize N+1 hoist ----

// P1 fix 1: searchVector collapses chunked docs to their best chunk BEFORE
// slicing to the page limit (mirrors searchKeyword). Pre-fix a single
// multi-chunk doc could occupy every slot on the result page.
test('db: searchVector collapses multi-chunk docs to one result per document', function () {
  mem.setConfig('chunk_size', '600');
  var big = makeBigText('vcollapse', 10);
  var chunks = mem.indexDoc('test', 'vec-multi', big);
  assert.ok(chunks.length > 1, 'doc split into multiple chunks');
  // A distinct embedding vector makes this doc the unique top match; every
  // other doc in the shared DB carries FAKE_VECTOR (lower cosine sim).
  var V = [1, 0, 0];
  for (var i = 0; i < chunks.length; i++) {
    mem.updateEmbedding('test', 'vec-multi', i, V, 'test-model');
  }
  var results = mem.searchVector(V, { limit: 3 });
  var hits = results.filter(function (r) { return r.source_id === 'vec-multi'; });
  assert.equal(hits.length, 1, 'multi-chunk doc collapsed to a single vector result');
  var ids = results.map(function (r) { return r.source_type + ':' + r.source_id; });
  assert.equal(ids.length, new Set(ids).size, 'no duplicate docs across the vector page');
});

// P1 fix 2: task_completed re-indexes with COMPLETED: + summary but PRESERVES
// the task's original title + description. indexAndEmbed upserts (replacing
// the doc), so pre-fix a completed task became unfindable by its own title.
test('handler: task_completed preserves original task title + description', function () {
  fire('task_created', {
    agent: 'tester',
    data: { task_id: 501, title: 'Refactor the embedding pipeline', description: 'Split generate and batch paths for clarity', project_id: 'mycelium' }
  });
  var before = getDoc('task', '501');
  assert.ok(before, 'task indexed on creation');
  assert.match(before.content_text, /Refactor the embedding pipeline/);
  assert.match(before.content_text, /Split generate and batch paths/);

  fire('task_completed', { agent: 'lucy', summary: 'shipped the refactor', data: { task_id: 501 }, project_id: 'mycelium' });
  var after = getDoc('task', '501');
  assert.ok(after, 'task still indexed after completion');
  assert.match(after.content_text, /^COMPLETED: shipped the refactor/, 'completion marker + summary prepended');
  assert.match(after.content_text, /Refactor the embedding pipeline/, 'original title preserved');
  assert.match(after.content_text, /Split generate and batch paths/, 'original description preserved');
});

// P1 fix 3: expandOversizedRows hoists getChunkSize() above the loop (one
// call per request, not one per row). A Proxy over the isolated db counts
// getConfig('chunk_size') SELECTs — the only such caller during backfill is
// getChunkSize (embeddings.js calls neither). indexDoc also calls it once
// per re-chunked doc, so the post-hoist total is 1 + N; pre-hoist it was N + N.
test('routes: expandOversizedRows calls getChunkSize once per request, not per row', async function () {
  var iso = new Database(':memory:');
  iso.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  iso.exec(PLATFORM_TABLES);

  var chunkSizeCalls = 0;
  var countingDb = new Proxy(iso, {
    get: function (target, prop) {
      var val = target[prop];
      if (prop === 'prepare') {
        return function (sql) {
          if (sql === 'SELECT value FROM sm_config WHERE key = ?') chunkSizeCalls++;
          return target.prepare(sql);
        };
      }
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });

  var isoMem = createMemoryDB(iso);
  isoMem.setConfig('embedding_provider', 'ollama');
  isoMem.setConfig('embedding_url', 'http://localhost:11434');
  isoMem.setConfig('embedding_model', 'nomic-embed-text');
  isoMem.setConfig('chunk_size', '600');

  var N = 4;
  var big = makeBigText('nplusone', 8);
  for (var i = 0; i < N; i++) {
    isoMem.index('m5max_memory', 'nq-' + i, big, { metadata: { t: i } });
  }
  assert.equal(isoMem.countUnembedded(), N, 'seeded N oversized NULL rows');

  var isoCore = makeCore(countingDb);
  var isoApp = express();
  isoApp.use(express.json({ limit: '10mb' }));
  isoApp.use('/memory', createRoutes(isoCore));
  var isoServer = http.createServer(isoApp);
  await new Promise(function (r) { isoServer.listen(0, '127.0.0.1', r); });
  var isoBase = 'http://127.0.0.1:' + isoServer.address().port;

  var res = await realFetch(isoBase + '/memory/backfill-embeddings?limit=50', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }
  });
  var rj = await res.json();
  isoServer.close();
  iso.close();

  assert.equal(res.status, 200);
  assert.equal(rj.failed, 0, 'all oversized docs chunked + embedded');
  // Post-hoist: 1 (loop) + N (indexDoc re-chunks). Pre-hoist: N (loop) + N.
  assert.equal(chunkSizeCalls, 1 + N, 'getChunkSize hoisted above the loop (1 + N), not called per row (2N)');
});
