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
import { generateEmbedding, generateEmbeddingBatch, EMBEDDING_OLLAMA_BATCH_MAX } from './embeddings.js';
import { startBootDrain, stopBootDrain, selfDrainTick, resolveSelfDrainIntervalS, lastDrainPromise } from './boot-drain.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- hermetic embedding provider: patch fetch for localhost:11434 only ----
var realFetch = global.fetch;
var embedCalls = 0;
var FAKE_VECTOR = [0.1, 0.2, 0.3];
// The fake models the resource a local embedder actually is: ONE model
// instance, requests served one at a time (FIFO) — that serialization is
// what made a single-string /memory/search wait behind a bulk backfill on
// jetson01 (2026-09-09, bench runs B2/B3/B4). With embedDelayMs = 0 the
// fake is instant-and-serial, which is what every test below assumes;
// setEmbedFakeDelay(ms) gives each embed a service time so the priority
// tests can measure queue wait. embedsPending counts in-flight + queued
// fake calls so a test can drain the line before finishing.
var embedDelayMs = 0;
var embedsPending = 0;
var embedChain = Promise.resolve();
function setEmbedFakeDelay(ms) { embedDelayMs = ms; }
function resetEmbedFake() { embedDelayMs = 0; }

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
        if (req.headers['x-test-admin']) req._authIsAdmin = true;
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
    // Mirrors the pluginCore contract: routes.js destructures asyncHandler
    // from core (routes/mycelium.js exports it via pluginCore since the
    // crash-isolation work). Same body as production.
    asyncHandler: function (fn) {
      return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
      };
    },
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
      embedsPending++;
      // Serialize through a promise tail: one embed at a time, like an
      // ollama serving a single model instance. The delay is the per-call
      // service time (0 → plain microtask hop, the pre-existing behavior).
      var job = embedChain.then(function () {
        if (embedDelayMs <= 0) return;
        return new Promise(function (done) { setTimeout(done, embedDelayMs); });
      });
      embedChain = job.then(function () { embedsPending--; }, function () { embedsPending--; });
      return job.then(function () {
        // Array input = the /api/embed batch contract (2026-09-18): one vector
        // per input row, in order. Answering a 64-row batch with one row would
        // be a server shape that cannot exist — the batch path correctly
        // treats the mismatch as a batch failure and falls back, which is the
        // SLOW path; model the real embedder instead.
        var inputs = [];
        try {
          var body = JSON.parse((opts && opts.body) || '{}');
          inputs = Array.isArray(body.input) ? body.input : [body.input];
        } catch (e) { inputs = ['']; }
        return {
          ok: true,
          status: 200,
          json: function () { return Promise.resolve({ embeddings: inputs.map(function () { return FAKE_VECTOR; }) }); }
        };
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
  // Task 219: registerHooks now starts the boot embed drain + a 60s self-check
  // ticker. The shared fixture must not have its NULL rows swept out from
  // under tests that seed them and assert they stay NULL — disable the
  // self-check here; the boot-drain tests below drive it explicitly on fresh
  // instances with their own interval config.
  mem.setConfig('embedding_self_drain_interval_s', '0');

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

test('routes: drone-key embed callback succeeds for the owning drone and is scoped', async function () {
  // drone_jobs isn't part of the plugin schema; create a minimal stand-in so
  // the scoping linkage is "available" for this test. drone-A has claimed an
  // embed job for note:scoped-note chunk 0.
  db.exec("CREATE TABLE IF NOT EXISTS drone_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, input_data TEXT, requires TEXT, requester TEXT, priority INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', drone_id TEXT, job_type TEXT)");
  db.prepare("INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text) VALUES ('note', 'scoped-note', 0, 'pre-embed')").run();
  db.prepare("INSERT INTO drone_jobs (title, input_data, requires, requester, job_type, status, drone_id) VALUES (?, ?, ?, ?, 'embed', 'claimed', 'drone-A')").run(
    'Embed: note:scoped-note',
    JSON.stringify({ source_type: 'note', source_id: 'scoped-note', chunk_index: 0, text: 'pre-embed', model: 'nomic-embed-text', callback_path: '/api/mycelium/memory/embeddings/note/scoped-note' }),
    JSON.stringify(['ollama']),
    'semantic-memory'
  );

  // Owning drone: 200 and the vector lands.
  var ok = await call('PUT', '/memory/embeddings/note/scoped-note', { embedding: [0.9, 0.8, 0.7], model: 'nomic-embed-text', chunk_index: 0 }, { 'x-acting-as': 'drone-A' });
  assert.equal(ok.status, 200, 'owning drone may store its embedding');
  var row = db.prepare("SELECT embedding FROM sm_embeddings WHERE source_type='note' AND source_id='scoped-note' AND chunk_index=0").get();
  assert.ok(row && row.embedding, 'embedding was written for the owning drone');

  // A different drone is scoped out (403) and must not overwrite the vector.
  var denied = await call('PUT', '/memory/embeddings/note/scoped-note', { embedding: [0.1, 0.1, 0.1], model: 'nomic-embed-text', chunk_index: 0 }, { 'x-acting-as': 'drone-B' });
  assert.equal(denied.status, 403, 'non-owning drone is scoped out');

  // An admin bypasses the scoping (no claimed job required).
  var admin = await call('PUT', '/memory/embeddings/note/scoped-note', { embedding: [0.5, 0.5, 0.5], model: 'admin-vec', chunk_index: 0 }, { 'x-acting-as': 'admin-1', 'x-test-admin': '1' });
  assert.equal(admin.status, 200, 'admin bypasses drone scoping');

  // cleanup so the shared db stays clean for the rest of the suite
  db.prepare("DELETE FROM drone_jobs WHERE job_type='embed' AND drone_id='drone-A'");
  db.prepare("DELETE FROM sm_embeddings WHERE source_type='note' AND source_id='scoped-note'");
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

// ---- stats() no longer reports the dead sqlite-vec flag; vector_scan_capped
// flags when the embedded row count exceeds the JS-cosine scan cap (5000) ----

test('db: stats() drops vec_available, reports vector_scan_capped past 5000 embedded', function () {
  var tdb = new Database(':memory:');
  tdb.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  var tmem = createMemoryDB(tdb);

  // The dead sqlite-vec flag no longer leaks into stats().
  assert.strictEqual(tmem.stats().vec_available, undefined, 'vec_available removed from stats()');

  // Below the cap: vector_scan_capped is false.
  assert.strictEqual(tmem.stats().vector_scan_capped, false);

  // >5000 embedded rows flips vector_scan_capped true. stats() counts rows
  // with a non-NULL embedding, so insert real vectors (no provider needed).
  tdb.transaction(function () {
    var ins = tdb.prepare("INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text, embedding, embedding_model) VALUES (?, ?, 0, ?, ?, 'test')");
    for (var i = 0; i < 5001; i++) ins.run('note', 'n' + i, 'x', '[0.1,0.2,0.3]');
  })();
  assert.strictEqual(tmem.stats().vector_scan_capped, true);
  assert.strictEqual(tmem.stats().with_embeddings, 5001);

  tdb.close();
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
test('db: searchVector collapses multi-chunk docs to one result per document', async function () {
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
  var results = await mem.searchVector(V, { limit: 3 });
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

// ---- Failure-state surfacing (MEMORY-FAILURE-STATES.md) ---------------------
// A search that silently degraded to keyword, or a project filter that produced
// a false-zero, used to look identical to a healthy result set. These pin the
// honest effective-mode + degraded + index-health + project-filter signals so a
// caller can tell "I got 3 mediocre hits because the embedding backend is down"
// from "I got 3 good hits from a healthy index." See MEMORY-FAILURE-STATES.md §F1–F3.

test('search: reports mode=keyword-fallback + degraded when the embedding provider is gone (was a silent mode:hybrid)', async function () {
  // Seed while provider is still ollama so the doc embeds AND is keyword-searchable.
  await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'deg-seed',
    content_text: 'kerbin orbital insertion burn profile'
  });
  await waitFor(function () { return mem.countUnembedded() === 0; });

  mem.setConfig('embedding_provider', 'none'); // simulate backend gone / unconfigured
  try {
    var r = await call('POST', '/memory/search', { query: 'kerbin orbital burn', mode: 'hybrid' });
    assert.equal(r.status, 200);
    // OLD behavior: echoed the REQUESTED mode ('hybrid') over keyword-only
    // results — the caller had no signal that vector search never ran.
    assert.equal(r.body.mode, 'keyword-fallback', 'effective mode is honest, not the requested hybrid');
    assert.equal(r.body.requested_mode, 'hybrid');
    assert.ok(r.body.degraded, 'degraded block present');
    assert.equal(r.body.degraded.fell_back_to, 'keyword');
    assert.ok(r.body.degraded.reason && r.body.degraded.reason.length > 0, 'reason populated');
    assert.ok(r.body.index, 'index health block present');
    assert.equal(typeof r.body.index.coverage_pct, 'number');
    // The result itself is unchanged — surfacing only, no retrieval weakening.
    var hit = r.body.results.filter(function (x) { return x.source_id === 'deg-seed'; });
    assert.ok(hit.length >= 1, 'keyword result still surfaces the doc');
  } finally {
    mem.setConfig('embedding_provider', 'ollama');
  }
});

test('search: happy-path hybrid reports mode=hybrid, no degraded, with index health', async function () {
  await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'happy-seed',
    content_text: 'duna transfer window opens roughly every 200 days'
  });
  await waitFor(function () { return mem.countUnembedded() === 0; });
  var r = await call('POST', '/memory/search', { query: 'duna transfer window', mode: 'hybrid' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'hybrid', 'a healthy hybrid search stays hybrid');
  assert.equal(r.body.degraded, undefined, 'no degraded block on a healthy search');
  assert.equal(r.body.requested_mode, undefined, 'requested_mode only present when it differed');
  assert.ok(r.body.index && r.body.index.coverage_pct >= 0, 'index health still surfaced');
});

test('search: a project_id filter that culls results surfaces project_filter (was a silent false-zero)', async function () {
  await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'pf-a',
    content_text: 'jool aerobraking depth at projtoken', metadata: { project_id: 'projAlpha' }
  });
  await call('POST', '/memory/index', {
    source_type: 'm5max_memory', source_id: 'pf-b',
    content_text: 'eve gravity assist via projtoken', metadata: { project_id: 'projBeta' }
  });
  await waitFor(function () { return mem.countUnembedded() === 0; });

  // projAlpha scope: pf-a matches, pf-b is culled by the post-filter.
  var rA = await call('POST', '/memory/search', { query: 'projtoken', project_id: 'projAlpha', limit: 10 });
  assert.equal(rA.status, 200);
  var aIds = rA.body.results.map(function (x) { return x.source_id; });
  assert.ok(aIds.indexOf('pf-a') !== -1, 'projAlpha doc present');
  assert.ok(aIds.indexOf('pf-b') === -1, 'projBeta doc filtered out');
  assert.ok(rA.body.project_filter, 'project_filter signal present when the filter culled something');
  assert.ok(rA.body.project_filter.results_before_filter >= 2, 'saw candidates before the filter ran');
  assert.equal(rA.body.project_filter.results_after_filter, aIds.length);

  // A scope with NO matching project: the false-zero case. Must be surfaced.
  var rZ = await call('POST', '/memory/search', { query: 'projtoken', project_id: 'projZeta', limit: 10 });
  assert.equal(rZ.body.count, 0, 'no projZeta results');
  assert.ok(rZ.body.project_filter, 'false-zero is signalled, not silent');
  assert.equal(rZ.body.project_filter.results_after_filter, 0);
  assert.ok(rZ.body.project_filter.results_before_filter >= 2, '...but candidates DID exist');
  assert.ok(/filtered out/.test(rZ.body.project_filter.hint), 'hint tells the caller memories exist');
});

// The optional rescue for the false-zero above: flagged, default OFF. With the
// flag on, the candidate pool is widened before the post-filter so a relevant
// memory ranked just below the default window still surfaces. Deterministic
// here because every doc carries the identical FAKE_VECTOR, so vector recall
// orders by updated_at DESC — we set those explicitly to control ranking.
test('search: search_project_overfetch=true rescues a project-filter false-zero (flagged, default OFF)', async function () {
  var odb = new Database(':memory:');
  odb.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  odb.exec(PLATFORM_TABLES);
  var omem = createMemoryDB(odb);
  omem.setConfig('embedding_provider', 'ollama');
  omem.setConfig('embedding_url', 'http://localhost:11434');
  omem.setConfig('embedding_model', 'nomic-embed-text');

  // 1 projAlpha doc (oldest) + 4 projBeta docs (newer). limit=2 => default
  // window = limit*2 = 4, exactly filled by projBeta, crowding projAlpha out.
  omem.index('m5max_memory', 'of-a', 'alpha content', { metadata: { project_id: 'ofAlpha' } });
  for (var i = 0; i < 4; i++) {
    omem.index('m5max_memory', 'of-b' + i, 'beta content ' + i, { metadata: { project_id: 'ofBeta' } });
  }
  for (var k = 0; k < 5; k++) {
    omem.updateEmbedding('m5max_memory', k === 0 ? 'of-a' : 'of-b' + (k - 1), 0, FAKE_VECTOR, 'test');
  }
  // Force deterministic recency (datetime('now') is whole-second → ties otherwise).
  odb.prepare("UPDATE sm_embeddings SET updated_at = '2026-01-01 00:00:00' WHERE source_id = 'of-a'").run();
  for (var m = 0; m < 4; m++) {
    odb.prepare("UPDATE sm_embeddings SET updated_at = ? WHERE source_id = ?").run('2026-01-02 00:00:0' + m, 'of-b' + m);
  }

  var oc = makeCore(odb);
  var oa = express(); oa.use(express.json({ limit: '10mb' })); oa.use('/memory', createRoutes(oc));
  var os = http.createServer(oa);
  await new Promise(function (r) { os.listen(0, '127.0.0.1', r); });
  var obase = 'http://127.0.0.1:' + os.address().port;

  async function searchScoped(overfetch) {
    omem.setConfig('search_project_overfetch', overfetch ? 'true' : 'false');
    var res = await realFetch(obase + '/memory/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acting-as': 'tester' },
      body: JSON.stringify({ query: 'zznomatch', project_id: 'ofAlpha', limit: 2, mode: 'hybrid' })
    });
    var body = await res.json();
    return body.results.map(function (x) { return x.source_id; });
  }
  // 'zznomatch' hits nothing by keyword, so results come purely from vector
  // recall (recency-ordered) — no FTS rank non-determinism.
  var plain = await searchScoped(false);
  var over = await searchScoped(true);
  os.close(); odb.close();

  // Deterministic: default window crowded projAlpha out entirely.
  assert.equal(plain.length, 0, 'default path: projAlpha crowded out → false-zero');
  assert.ok(over.indexOf('of-a') !== -1, 'overfetch surfaces the crowded-out projAlpha doc');
});

test('db: indexHealth() reports total/embedded/coverage/vector_scan_capped (lightweight, no GROUP BYs)', function () {
  var hdb = new Database(':memory:');
  hdb.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  var hmem = createMemoryDB(hdb);

  var e = hmem.indexHealth();
  assert.equal(e.total, 0);
  assert.equal(e.embedded, 0);
  assert.equal(e.coverage_pct, 0);
  assert.strictEqual(e.vector_scan_capped, false);

  hmem.index('note', 'a', 'first', {});
  hmem.index('note', 'b', 'second', {});
  hmem.updateEmbedding('note', 'a', 0, [0.1, 0.2, 0.3], 'test');

  var h = hmem.indexHealth();
  assert.equal(h.total, 2);
  assert.equal(h.embedded, 1);
  assert.equal(h.coverage_pct, 50);
  assert.strictEqual(h.vector_scan_capped, false);
  hdb.close();
});

// ---- Fresh-instance config + degrade contract ------------------------------
// The plugin ships enabled:true with NO embedding provider configured
// (generateEmbedding defaults `embedding_provider || 'none'`). These four
// tests pin what a stranger gets BEFORE any configuration, and the two
// half-behaviors they meet:
//
//   graceful half — POST /search still works, keyword-only, and says so
//                   (mode:'keyword-fallback' + degraded.reason). Pinned
//                   GREEN on master where written (the honest-mode fix
//                   predates this test; routes.js §F1 comment).
//   loud half     — POST /reindex and POST /backfill-embeddings answer 400
//                   naming `PUT /memory/config`, the only pointer to the
//                   on-switch. Also pinned GREEN on master where written.
//
// GREEN-on-arrival is expected and honest: these are PINS of the shipped
// contract (the file header says so), not reds manufactured against master.
// What keeps them from being vacuous is the bite matrix — each assertion
// below was proven RED by injecting the opposite behavior (default flipped
// to ollama / key-strip removed / auto-embed skipped / loud-400 silenced /
// unknown-provider throw), then restoring. See the branch, not this file,
// for that history.
//
// Every test here builds its OWN isolated DB + server: the shared fixture
// above boots with ollama pre-configured, which is exactly the state a
// fresh instance is NOT in.

// Spins up an isolated plugin app on a fresh in-memory DB (same shape as the
// expandOversizedRows N+1 test) and returns { db, mem, call } — call() has the
// same signature as the shared helper but is bound to this server.
async function freshInstance() {
  var iso = new Database(':memory:');
  iso.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  iso.exec(PLATFORM_TABLES);
  var core = makeCore(iso);
  var app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/memory', createRoutes(core));
  var srv = http.createServer(app);
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  var b = 'http://127.0.0.1:' + srv.address().port;
  async function isoCall(method, p, body, headers) {
    var res = await realFetch(b + p, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, body: json };
  }
  return {
    db: iso,
    mem: createMemoryDB(iso),
    call: isoCall,
    close: function () { srv.close(); iso.close(); }
  };
}

// THE PAIR on one fresh instance: config unset + search still answers +
// embed-requiring routes name the switch. The contract is the pair — a
// fresh install that either lost search or lost the pointer would strand
// the flagship feature in a different direction.
test('config: fresh instance has no provider — GET /config says nothing is set, search still answers keyword-only, embed routes name PUT /memory/config', async function () {
  var f = await freshInstance();
  try {
    // The fresh truth: no embedding_provider key AT ALL (getAllConfig is {}).
    // generateEmbedding's `|| 'none'` default is what makes this "off".
    var g = await f.call('GET', '/memory/config');
    assert.equal(g.status, 200);
    assert.equal('embedding_provider' in g.body, false, 'fresh config carries no embedding_provider — vector search is OFF');
    // The same truth at the unit level, through the same getter the routes
    // read: an unconfigured store yields no vector. (The route layer checks
    // the raw config itself, so this is the only pin on the DEFAULT — flip
    // `|| 'none'` in embeddings.js and THIS is the line that goes red.)
    assert.equal(await generateEmbedding(f.mem.getAllConfig(), 'probe text'), null, 'the unconfigured default produces no embedding');

    // Indexing works without a provider — the row just stores a NULL vector.
    var r = await f.call('POST', '/memory/index', {
      source_type: 'note', source_id: 'fresh-1',
      content_text: 'kerbin orbital insertion burn profile'
    });
    assert.equal(r.status, 200);
    var row = f.db.prepare("SELECT embedding FROM sm_embeddings WHERE source_id = 'fresh-1'").get();
    assert.equal(row.embedding, null, 'no provider → NULL embedding, index still succeeds');

    // Graceful half: search answers 200 with results, and says it fell back.
    var s = await f.call('POST', '/memory/search', { query: 'kerbin orbital burn' });
    assert.equal(s.status, 200);
    assert.equal(s.body.mode, 'keyword-fallback', 'search is honest about the missing vector half');
    assert.match(s.body.degraded.reason, /no embedding provider configured/, 'degraded.reason names the missing config');
    assert.ok(s.body.results.some(function (x) { return x.source_id === 'fresh-1'; }), 'keyword results still surface the doc');

    // Loud half: the embed-requiring routes refuse with the pointer, not silence.
    var rx = await f.call('POST', '/memory/reindex', {});
    assert.equal(rx.status, 400);
    assert.match(rx.body.error, /No embedding provider configured\. Set via PUT \/memory\/config/, 'reindex names the on-switch');

    var rb = await f.call('POST', '/memory/backfill-embeddings');
    assert.equal(rb.status, 400);
    assert.match(rb.body.error, /No embedding provider configured\. Set via PUT \/memory\/config/, 'backfill names the on-switch');
  } finally {
    f.close();
  }
});

// Round-trip: what PUT accepts, GET returns — with the api_key stripped on
// the read side but still persisted (redaction is response-only). Extends
// the PUT-leak test above by pinning the VALUE half of the round trip: GET
// must reflect the provider/model/url that were set, not just omit the key.
test('config: PUT /memory/config round-trips provider/model/url into GET and strips embedding_api_key', async function () {
  var f = await freshInstance();
  try {
    var put = await f.call('PUT', '/memory/config', {
      embedding_provider: 'ollama',
      embedding_model: 'mymodel',
      embedding_url: 'http://embed.internal:9999',
      embedding_api_key: 'sk-roundtrip-secret'
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.embedding_api_key, undefined, 'PUT response redacts the key');
    assert.equal(put.body.config.embedding_provider, 'ollama');

    var g = await f.call('GET', '/memory/config');
    assert.equal(g.status, 200);
    assert.equal(g.body.embedding_provider, 'ollama', 'GET reflects the configured provider');
    assert.equal(g.body.embedding_model, 'mymodel', 'GET reflects the configured model');
    assert.equal(g.body.embedding_url, 'http://embed.internal:9999', 'GET reflects the configured url');
    assert.equal(g.body.embedding_api_key, undefined, 'GET strips the api key');

    // Redaction is response-only: the key is still persisted for the provider.
    assert.equal(f.mem.getConfig('embedding_api_key'), 'sk-roundtrip-secret', 'key still persisted');
  } finally {
    f.close();
  }
});

// Provider fires: with a provider configured, an index write must reach the
// CONFIGURED url + model (not just any ollama) and the vector must land in
// search. The recorder replaces global.fetch wholesale — nothing here can
// touch a real localhost:11434 or api.openai.com.
test('provider fires: index embeds against the CONFIGURED url and model, and the vector round-trips into search', async function () {
  var f = await freshInstance();
  var seen = [];
  // Save what THIS test replaces and restore exactly that — restoring the
  // module-level realFetch here instead would wipe the file-level hermetic
  // patch installed in before(), silently un-faking ollama for every test
  // that runs after this one (found when the priority tests appended below
  // all hit a real ECONNREFUSED on localhost:11434 in full-file runs).
  var prevFetch = global.fetch;
  global.fetch = function (url, opts) {
    seen.push({ url: String(url), body: JSON.parse((opts && opts.body) || '{}') });
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ embeddings: [FAKE_VECTOR] }); }
    });
  };
  try {
    var cfg = await f.call('PUT', '/memory/config', {
      embedding_provider: 'ollama',
      embedding_model: 'my-embed-model',
      embedding_url: 'http://embed.test:9999'
    });
    assert.equal(cfg.status, 200);

    var r = await f.call('POST', '/memory/index', {
      source_type: 'note', source_id: 'fires-1',
      content_text: 'duna transfer window arithmetic'
    });
    assert.equal(r.status, 200);

    var ok = await waitFor(function () { return seen.length > 0; });
    assert.ok(ok, 'an embed call was made');
    var docCall = seen[0];
    assert.equal(docCall.url, 'http://embed.test:9999/api/embed', 'the CONFIGURED url is used, not a hard-coded default');
    assert.equal(docCall.body.model, 'my-embed-model', 'the CONFIGURED model is used');
    assert.equal(docCall.body.input, 'duna transfer window arithmetic', 'the indexed text is what gets embedded');

    // The stored vector round-trips into search as a real hybrid result.
    await waitFor(function () {
      var d = f.db.prepare("SELECT embedding FROM sm_embeddings WHERE source_id = 'fires-1'").get();
      return d && d.embedding;
    });
    var s = await f.call('POST', '/memory/search', { query: 'duna transfer window' });
    assert.equal(s.body.mode, 'hybrid', 'search reports the vector half running');
    assert.equal(s.body.degraded, undefined, 'no degraded block on a configured provider');
    assert.ok(s.body.results.some(function (x) { return x.source_id === 'fires-1'; }), 'the doc surfaces');
  } finally {
    global.fetch = prevFetch;
    f.close();
  }
});

// Unknown provider: the end of generateEmbedding's chain warns and returns
// null — no throw, no crash, and the index write still succeeds (with a NULL
// vector, which backfill can pick up later once the config is fixed).
test('unknown provider: generateEmbedding warns and returns null, index still succeeds, search degrades honestly', async function () {
  // Unit half: the end-of-chain contract, called directly.
  var warnings = [];
  var realWarn = console.warn;
  console.warn = function () { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
  var nullVector;
  try {
    nullVector = await generateEmbedding({ embedding_provider: 'bogus' }, 'some text');
  } finally {
    console.warn = realWarn;
  }
  assert.equal(nullVector, null, 'unknown provider resolves null — no throw');
  assert.ok(warnings.some(function (w) { return /Unknown embedding provider/.test(w) && /bogus/.test(w); }), 'the warn names the bogus provider — not a silent null');

  // Route half: with the bogus provider configured, indexing still succeeds
  // (row stored, NULL embedding) and search still answers with the honest
  // degrade rather than a 500.
  var f = await freshInstance();
  try {
    await f.mem.setConfig('embedding_provider', 'bogus');
    var r = await f.call('POST', '/memory/index', {
      source_type: 'note', source_id: 'bogus-1', content_text: 'laythe tides arithmetic'
    });
    assert.equal(r.status, 200, 'index succeeds under a bogus provider');
    var row = f.db.prepare("SELECT embedding FROM sm_embeddings WHERE source_id = 'bogus-1'").get();
    assert.equal(row.embedding, null, 'bogus provider stores a NULL vector, not a crash');

    var s = await f.call('POST', '/memory/search', { query: 'laythe tides' });
    assert.equal(s.status, 200);
    assert.equal(s.body.mode, 'keyword-fallback');
    assert.match(s.body.degraded.reason, /provider/, 'degraded.reason explains the vector half is unavailable');
  } finally {
    f.close();
  }
});

// -- Query-embedding priority over the bulk backfill (2026-09-09) ------------
//
// Measured on jetson01 during bench runs B2/B3/B4: right after a bulk index
// of thousands of rows, POST /memory/search took >30 s for minutes (five
// consecutive 30 s timeouts killed run B4 at answer 20/50) and even
// GET /memory/stats timed out. The plugin has no in-process queue — the
// waiting happens at the embedder endpoint, which serves one request at a
// time: every /index/bulk call starts its own unawaited sequential embed
// chain (routes.js POST /index/bulk -> generateEmbeddingBatch, ollama branch
// is an await-per-text loop), /backfill-embeddings and /reindex run theirs,
// and a search's single-string query embed joins the SAME tail (routes.js
// POST /search -> await generateEmbedding) with nothing marking it priority.
// At a 30 s wait the AbortSignal.timeout in embedOllama fires and the search
// degrades to keyword — after having burned the 30 s.
//
// The tests below model that embedder faithfully (serial, per-call service
// time) and pin the two properties the fix must hold:
//   1. a search under bulk load answers in ~2 embed service times, hybrid,
//      because its query embed jumps the queue;
//   2. backfill throughput stays at the embedder's serial service rate
//      (within 20%) — priority must not starve the bulk lane.

test('priority: a search under bulk-index load answers in ~2 embed times — its query embed does not wait behind the backlog', async function () {
  var SERVICE = 25; // ms of fake embedder service time per call
  var BULK_CALLS = 40; // concurrent bulk requests -> ~40 calls queued at the embedder
  var PER_CALL = 100; // the route's own max per request
  setEmbedFakeDelay(SERVICE);
  try {
    var bulkPosts = [];
    for (var b = 0; b < BULK_CALLS; b++) {
      var items = [];
      for (var i = 0; i < PER_CALL; i++) {
        items.push({
          source_type: 'priority_probe',
          source_id: 'bulk-' + b + '-' + i,
          content_text: 'priority probe bulk row ' + b + ' ' + i
        });
      }
      // One needle row in the first request so the search has a real hit.
      if (b === 0) items[0].content_text = 'priority probe needle quark strange';
      bulkPosts.push(call('POST', '/memory/index/bulk', { items: items }));
    }
    await Promise.all(bulkPosts); // routes answer immediately; embed chains keep draining

    var t0 = Date.now();
    var r = await call('POST', '/memory/search', { query: 'priority probe needle', mode: 'hybrid' });
    var elapsed = Date.now() - t0;

    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'hybrid',
      'a healthy search must answer hybrid, not keyword-fallback (degraded: ' +
      JSON.stringify(r.body.degraded || null) + ')');
    assert.ok(r.body.degraded === undefined, 'no degraded block — the query embed must not abort');
    var hit = r.body.results.filter(function (x) { return x.source_id === 'bulk-0-0'; });
    assert.ok(hit.length >= 1, 'the needle row still surfaces');
    // Bound: one in-flight embed + the query's own embed, plus HTTP/scheduler
    // overhead. The pre-fix tree queues the query behind ~BULK_CALLS pending
    // embeds (~BULK_CALLS * SERVICE ms) and blows this by an order of magnitude.
    var bound = 2 * SERVICE + 100;
    // Log the measured latency — this test IS the benchmark receipt for
    // query-embed priority (before/after numbers live in the DONE report).
    console.log('[priority] search under ' + (BULK_CALLS * PER_CALL) + '-row bulk load: ' + elapsed + 'ms (bound ' + bound + 'ms)');
    assert.ok(elapsed < bound,
      'search answered in ' + elapsed + 'ms; bound is ' + bound + 'ms — the query embed waited behind the bulk backlog');
  } finally {
    resetEmbedFake(); // fast-forward the remaining backlog instead of waiting it out
    await waitFor(function () { return embedsPending === 0; }, 30000);
  }
});

test('priority: the bounded scheduler keeps backfill throughput within 20% of the embedder service rate', async function () {
  var SERVICE = 5; // ms per embed — the serial rate every path already shared
  var ROWS = 200;
  setEmbedFakeDelay(SERVICE);
  try {
    // Seed unembedded rows directly (no bulk route) so the timed backfill is
    // the only embedder client — this measures throughput, not contention.
    for (var i = 0; i < ROWS; i++) {
      mem.index('throughput_probe', 'row-' + i, 'throughput probe row ' + i);
    }
    var backlog = mem.countUnembedded(); // seeded rows + any NULLs left by earlier tests
    var t0 = Date.now();
    var r = await call('POST', '/memory/backfill-embeddings?limit=1000', {});
    var elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    // embedded can exceed backlog: oversized NULL rows are chunk-split before
    // embedding (expandOversizedRows), so the route counts post-chunking rows.
    // The guard is self-consistency + drain, with processed as the work count.
    assert.ok(r.body.embedded >= backlog,
      'every seeded row embedded (backlog was ' + backlog + '; response: ' + JSON.stringify(r.body) + ')');
    assert.equal(r.body.embedded, r.body.processed,
      'no silent failures (response: ' + JSON.stringify(r.body) + ')');
    assert.equal(r.body.remaining, 0);
    // Bound: the serial service rate (+20% — the fix may not slow the bulk
    // lane) plus an absolute jitter allowance for HTTP/timer overhead.
    var bound = Math.round(1.2 * r.body.processed * SERVICE) + 150;
    console.log('[priority] backfill of ' + r.body.processed + ' rows: ' + elapsed + 'ms (' +
      (elapsed / r.body.processed).toFixed(2) + 'ms/embed at ' + SERVICE + 'ms service; bound ' + bound + 'ms)');
    assert.ok(elapsed <= bound,
      'backfill of ' + ROWS + ' rows took ' + elapsed + 'ms; bound is ' + bound + 'ms — the scheduler slowed the bulk lane');
  } finally {
    resetEmbedFake();
    await waitFor(function () { return embedsPending === 0; }, 30000);
  }
});

test('db: stats() exposes embed_backlog + embed_queue — the pipeline is visible instead of guessed from timeouts', function () {
  var before = mem.countUnembedded();
  mem.index('stats_probe', 'backlog-a', 'backlog probe a');
  mem.index('stats_probe', 'backlog-b', 'backlog probe b');
  var s = mem.stats();
  assert.equal(s.embed_backlog, before + 2, 'embed_backlog counts rows awaiting embedding');
  assert.equal(s.embed_backlog, mem.countUnembedded(), 'embed_backlog agrees with the DB count');
  assert.ok(s.embed_queue, 'embed_queue block present');
  assert.equal(typeof s.embed_queue.in_flight, 'number', 'embed_queue.in_flight is a number');
  assert.equal(typeof s.embed_queue.queued_high, 'number', 'embed_queue.queued_high is a number');
  assert.equal(typeof s.embed_queue.queued_low, 'number', 'embed_queue.queued_low is a number');
});

// -- Ollama batch embed (2026-09-18, task 217) --------------------------------
//
// generateEmbeddingBatch's ollama branch used to loop texts ONE scheduled call
// each under a stale "Ollama doesn't have a batch endpoint" comment — /api/embed
// takes `input` as a string OR an array and answers { embeddings: [[...]] } in
// input order (embedOllama already POSTs it). Measured cost of the loop: the
// Jetson's ollama embedder is serial ~0.3–0.5 s/row, a timeline n=50 writes
// ~20k rows (episodes + facts), run B4 died at answer 20/50 behind a 13,869-row
// backlog, and the 09-17 smoke (receipts/2026-09-17-p1-225526.md) waited the
// full 8-min floor on 58 rows. The fix: the batch is ONE scheduler unit per
// chunk of EMBEDDING_OLLAMA_BATCH_MAX texts — same shape as the OpenAI path.
// These tests pin four properties: the call-count collapse, the
// STRICTLY-NO-WORSE degrade (batch-shaped failure → sequential fallback, zero
// nulls from the batch itself; per-item failure inside the fallback → null),
// the old-ollama degrade path, and the query-embed priority jump BETWEEN
// chunks (the regression a whole-list-as-one-unit refactor would break).

// Vector derived from the text's own index ('row t37' → [37, 38, 39]) so
// ORDER preservation is asserted by value, not by position-in-argument luck.
function tvec(s) {
  var m = /t(\d+)\s*$/.exec(String(s));
  var n = m ? parseInt(m[1], 10) : -1;
  return [n, n + 1, n + 2];
}

function ollamaBatchConfig() {
  return {
    embedding_provider: 'ollama',
    embedding_url: 'http://embed.test:9999',
    embedding_model: 'nomic-embed-text'
  };
}

test('ollama batch: 500 texts collapse to ceil(500/batch_max) array calls, order preserved, single-text path unchanged', async function () {
  var seen = []; // { isArray, input } in arrival order at the embedder
  var prevFetch = global.fetch;
  global.fetch = function (url, opts) {
    var body = JSON.parse((opts && opts.body) || '{}');
    var isArray = Array.isArray(body.input);
    seen.push({ isArray: isArray, input: body.input, model: body.model });
    var inputs = isArray ? body.input : [body.input];
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ embeddings: inputs.map(tvec) }); }
    });
  };
  try {
    var cfg = ollamaBatchConfig();

    // The "1" in 1 + ceil(500/64): a single-text embed (the search-query path)
    // against the same fake, proving the non-batch path is untouched.
    var q = await generateEmbedding(cfg, 'query row t0');
    assert.deepEqual(q, [0, 1, 2], 'single-text embed still resolves the vector');
    assert.equal(seen[0].isArray, false, 'the single-text call still sends input as a string, not an array');

    var texts = [];
    for (var i = 0; i < 500; i++) texts.push('probe row t' + i);
    var out = await generateEmbeddingBatch(cfg, texts);

    var batches = seen.filter(function (s) { return s.isArray; });
    var expectedBatches = Math.ceil(500 / EMBEDDING_OLLAMA_BATCH_MAX);
    // THE pre-committed hermetic number: 500 sequential calls before, at most
    // 1 + ceil(500/batch_max) after. Both counts are logged, not just asserted.
    assert.equal(seen.length, 1 + expectedBatches,
      'total /api/embed calls must be 1 (single-text probe) + ceil(500/' +
      EMBEDDING_OLLAMA_BATCH_MAX + '), got ' + seen.length);
    assert.equal(batches.length, expectedBatches, 'batch calls carry array-shaped bodies');
    for (var b = 0; b < batches.length; b++) {
      assert.ok(batches[b].input.length <= EMBEDDING_OLLAMA_BATCH_MAX,
        'chunk ' + b + ' bounded by EMBEDDING_OLLAMA_BATCH_MAX=' + EMBEDDING_OLLAMA_BATCH_MAX);
      assert.equal(batches[b].model, 'nomic-embed-text', 'the CONFIGURED model rides on batch calls');
    }
    assert.equal(out.length, 500, 'one vector per input text');
    for (var j = 0; j < 500; j++) {
      assert.deepEqual(out[j], [j, j + 1, j + 2],
        'result ' + j + ' must be text ' + j + "'s vector — chunking must preserve order");
    }
    console.log('[ollama-batch] hermetic call counts: 500 texts -> ' + seen.length +
      ' embedder calls (' + batches.length + ' array batch + 1 single-text); the pre-batch tree made ' + (1 + 500));
  } finally {
    global.fetch = prevFetch;
  }
});

test('ollama batch: a batch-shaped failure (HTTP 400) fires the sequential fallback — the batch itself yields ZERO nulls', async function () {
  var calls = [];
  var prevFetch = global.fetch;
  global.fetch = function (url, opts) {
    var body = JSON.parse((opts && opts.body) || '{}');
    var isArray = Array.isArray(body.input);
    calls.push({ isArray: isArray, input: body.input });
    if (isArray) {
      // The old-ollama / rejected-shape case: the whole batch call fails.
      return Promise.resolve({
        ok: false, status: 400,
        json: function () { return Promise.resolve({ error: 'unsupported input shape' }); }
      });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ embeddings: [tvec(body.input)] }); }
    });
  };
  try {
    var texts = [];
    for (var i = 0; i < 10; i++) texts.push('degrade row t' + i);
    var out = await generateEmbeddingBatch(ollamaBatchConfig(), texts);
    assert.equal(calls.length, 1 + 10,
      'call count 1 + N (1 failed batch + 10 sequential) — the fallback re-embeds every row');
    assert.equal(calls.filter(function (c) { return c.isArray; }).length, 1, 'exactly one batch attempt');
    for (var j = 0; j < 10; j++) {
      assert.ok(out[j], 'no null for item ' + j + ' — a batch-shaped failure must not become per-item nulls');
      assert.deepEqual(out[j], [j, j + 1, j + 2], 'fallback preserves order and vector values');
    }
  } finally {
    global.fetch = prevFetch;
  }
});

test('ollama batch: a per-item failure INSIDE the sequential fallback stays null, like the pre-batch loop', async function () {
  var prevFetch = global.fetch;
  global.fetch = function (url, opts) {
    var body = JSON.parse((opts && opts.body) || '{}');
    if (Array.isArray(body.input)) {
      return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ error: 'no' }); } });
    }
    if (/t4\s*$/.test(String(body.input))) {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ error: 'embedder hiccup' }); } });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ embeddings: [tvec(body.input)] }); }
    });
  };
  try {
    var texts = [];
    for (var i = 0; i < 10; i++) texts.push('peritem row t' + i);
    var out = await generateEmbeddingBatch(ollamaBatchConfig(), texts);
    assert.equal(out.length, 10);
    assert.equal(out[4], null, 'the per-item failure is null — the fallback degrades exactly like the old loop');
    for (var j = 0; j < 10; j++) {
      if (j === 4) continue;
      assert.deepEqual(out[j], [j, j + 1, j + 2], 'item ' + j + ' embedded despite its sibling failing');
    }
  } finally {
    global.fetch = prevFetch;
  }
});

test('ollama batch: an old ollama without array /api/embed degrades on the first batch and answers the legacy shape', async function () {
  var calls = [];
  var prevFetch = global.fetch;
  global.fetch = function (url, opts) {
    var body = JSON.parse((opts && opts.body) || '{}');
    var isArray = Array.isArray(body.input);
    calls.push(isArray);
    if (isArray) {
      return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ error: 'old ollama' }); } });
    }
    // Pre-array ollamas answered /api/embed with the single-row shape.
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ embedding: tvec(body.input) }); }
    });
  };
  try {
    var texts = [];
    for (var i = 0; i < 5; i++) texts.push('legacy row t' + i);
    var out = await generateEmbeddingBatch(ollamaBatchConfig(), texts);
    assert.equal(calls.length, 1 + 5, 'one degraded batch, then the exact sequential traffic of the pre-batch tree');
    for (var j = 0; j < 5; j++) {
      assert.deepEqual(out[j], [j, j + 1, j + 2], 'old ollama behaves exactly as today: every row embedded, in order');
    }
    // The single-text path still reads the legacy shape too.
    var q = await generateEmbedding(ollamaBatchConfig(), 'legacy row t9');
    assert.deepEqual(q, [9, 10, 11], 'single-text path still handles the legacy { embedding } response');
  } finally {
    global.fetch = prevFetch;
  }
});

test('ollama batch: a high-priority query embed arriving between two chunks still precedes the second chunk — one scheduler unit per batch', async function () {
  var order = []; // { isArray, n } per request that REACHED the embedder
  var releaseChunk1 = null;
  var prevFetch = global.fetch;
  global.fetch = function (url, opts) {
    var body = JSON.parse((opts && opts.body) || '{}');
    var isArray = Array.isArray(body.input);
    if (isArray && order.filter(function (o) { return o.isArray; }).length === 0) {
      // First chunk: hold it in flight so the test can queue the query embed
      // while the slot is occupied (embed_max_concurrency defaults to 1).
      order.push({ isArray: true, n: body.input.length });
      return new Promise(function (resolve) {
        releaseChunk1 = function () {
          resolve({
            ok: true, status: 200,
            json: function () { return Promise.resolve({ embeddings: body.input.map(tvec) }); }
          });
        };
      });
    }
    order.push({ isArray: isArray, n: isArray ? body.input.length : 1 });
    var inputs = isArray ? body.input : [body.input];
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ embeddings: inputs.map(tvec) }); }
    });
  };
  try {
    var texts = [];
    for (var i = 0; i < 2 * EMBEDDING_OLLAMA_BATCH_MAX; i++) texts.push('prio row t' + i); // exactly 2 chunks
    var batchP = generateEmbeddingBatch(ollamaBatchConfig(), texts); // low lane, not awaited yet
    var ok = await waitFor(function () { return !!releaseChunk1; }, 2000);
    assert.ok(ok, 'chunk 1 must be in flight at the fake embedder');

    // Query embed queued HIGH while chunk 1 holds the only slot.
    var queryP = generateEmbedding(ollamaBatchConfig(), 'needle row t9999', { priority: 'high' });
    assert.equal(order.length, 1,
      'chunk 2 must not be dispatched while chunk 1 is in flight — a chunk is one scheduler unit, not 64 lane entries');
    releaseChunk1();
    await Promise.all([batchP, queryP]);

    assert.equal(order.length, 3, 'exactly 2 batch calls + 1 query call for ' + texts.length + ' texts');
    assert.equal(order[0].isArray, true);
    assert.equal(order[0].n, EMBEDDING_OLLAMA_BATCH_MAX, 'chunk 1 is a full batch_max');
    assert.equal(order[1].isArray, false, 'the high-priority query embed jumps between the two chunks');
    assert.equal(order[2].isArray, true);
    assert.equal(order[2].n, EMBEDDING_OLLAMA_BATCH_MAX, 'chunk 2 is the second half');
  } finally {
    global.fetch = prevFetch;
  }
});

// -- Boot drain + self-check (2026-09-18, task 219) ----------------------------
//
// The embed scheduler's queue (embedLanes in embeddings.js) is IN-MEMORY, so a
// platform restart forgets every row it had not yet embedded, and nothing on
// the platform re-discovers them — the only thing that did was the Mac's
// launchd job com.gilbert.memory-embed-backfill (StartInterval 1800), i.e. up
// to 30 minutes of a dead embedder per restart. Measured on jetson01
// 2026-09-18 00:05-00:09 CDT: after the director's deploy, GET /memory/stats
// read embed_backlog 32,282 with embed_queue {in_flight 0, queued_high 0,
// queued_low 0} and the embedded count frozen for four minutes while a bench
// sat in its embedding wait. Fix: on boot the plugin re-enqueues every
// sm_embeddings row with embedding IS NULL at LOW priority in
// EMBEDDING_OLLAMA_BATCH_MAX chunks (query embeds keep their high-priority
// jump), and a periodic self-check (embedding_self_drain_interval_s, default
// 300, 0 disables) re-enqueues stragglers when the queue is empty. The drain
// mirrors the Mac job's contract (bounded rounds, {embedded, failed,
// remaining}); the Mac job stays as the belt-and-braces outer loop.

// Recording fake with the same serial-array contract as the file-level fake,
// plus a record of every call — the boot-drain tests assert on BATCH SHAPES
// (input lengths, arrival order), which the plain fake does not expose.
function installRecordingEmbedFake(record) {
  var prev = global.fetch;
  global.fetch = function (url, opts) {
    var body;
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = {}; }
    var inputs = Array.isArray(body.input) ? body.input : [body.input];
    record.push({ url: String(url), model: body.model, inputs: inputs });
    embedCalls++;
    embedsPending++;
    var job = embedChain.then(function () {
      if (embedDelayMs <= 0) return;
      return new Promise(function (done) { setTimeout(done, embedDelayMs); });
    });
    embedChain = job.then(function () { embedsPending--; }, function () { embedsPending--; });
    return job.then(function () {
      return {
        ok: true, status: 200,
        json: function () { return Promise.resolve({ embeddings: inputs.map(function () { return FAKE_VECTOR; }) }); }
      };
    });
  };
  return function () { global.fetch = prev; };
}

// A provider that answers HTTP 500 to everything: a batch failure degrades to
// the sequential loop (embeddings.js), whose calls fail too — every row stays
// NULL, which is the "dropped batch" the self-check exists to retry.
function installFailingEmbedFake() {
  var prev = global.fetch;
  global.fetch = function (url, opts) {
    if (String(url).indexOf('11434') !== -1) {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}); } });
    }
    return prev(url, opts);
  };
  return function () { global.fetch = prev; };
}

test('boot drain: N NULL rows enqueue as ceil(N/64) low-priority batch calls and land embedded, with a stats receipt', async function () {
  var f = await freshInstance();
  f.mem.setConfig('embedding_provider', 'ollama');
  f.mem.setConfig('embedding_url', 'http://localhost:11434');
  f.mem.setConfig('embedding_model', 'nomic-embed-text');
  var N = 100; // ceil(100/64) = 2 batches
  for (var i = 0; i < N; i++) {
    f.mem.index('drain_probe', 'row-' + i, 'boot drain probe row ' + i);
  }
  assert.equal(f.mem.countUnembedded(), N, 'fixture starts with N NULL rows');
  var receiptBefore = f.mem.stats().embed_queue;
  var record = [];
  var restore = installRecordingEmbedFake(record);
  try {
    var r = await startBootDrain(f.mem);
    assert.equal(r.cause, 'boot');
    assert.equal(r.enqueued, N, 'every NULL row was enqueued');
    assert.equal(r.embedded, N, 'every enqueued row embedded');
    assert.equal(r.failed, 0);
    assert.equal(r.remaining, 0);

    // The batch contract: 2 calls, array input, 64 + 36 — one scheduler unit
    // per EMBEDDING_OLLAMA_BATCH_MAX chunk, same as 217's bulk path.
    assert.equal(record.length, 2, 'ceil(N/64) batch calls, got ' + record.length);
    assert.deepEqual(record.map(function (c) { return c.inputs.length; }).sort(function (a, b) { return b - a; }), [64, 36]);

    // The rows are actually embedded now.
    assert.equal(f.mem.countUnembedded(), 0);

    // The receipt: /memory/stats can prove the boot drain happened.
    var eq = f.mem.stats().embed_queue;
    assert.equal(eq.rows_enqueued_at_boot - receiptBefore.rows_enqueued_at_boot, N,
      'rows_enqueued_at_boot counts the boot pass rows');
    assert.ok(eq.last_drain_at, 'last_drain_at is stamped');
    assert.ok(!isNaN(Date.parse(eq.last_drain_at)), 'last_drain_at parses as a timestamp');
  } finally {
    stopBootDrain();
    restore();
  }
  f.close();
});

test('boot drain: a query embed submitted mid-drain runs before the next chunk (the high lane still jumps)', async function () {
  var f = await freshInstance();
  f.mem.setConfig('embedding_provider', 'ollama');
  f.mem.setConfig('embedding_url', 'http://localhost:11434');
  f.mem.setConfig('embedding_model', 'nomic-embed-text');
  var N = 192; // 3 full chunks of 64
  for (var i = 0; i < N; i++) {
    f.mem.index('drain_race', 'row-' + i, 'boot drain race row ' + i);
  }
  var SERVICE = 15;
  setEmbedFakeDelay(SERVICE);
  var record = [];
  var restore = installRecordingEmbedFake(record);
  try {
    var p = startBootDrain(f.mem);
    // Wait until the first chunk is being served, then fire a query embed —
    // it must enter the HIGH lane and be served before the next LOW chunk.
    var gotFirst = await waitFor(function () { return record.length >= 1; }, 5000);
    assert.ok(gotFirst, 'the first drain chunk was dispatched');
    assert.equal(record[0].inputs.length, EMBEDDING_OLLAMA_BATCH_MAX);
    var queryP = generateEmbedding(f.mem.getAllConfig(), 'mid-drain query', { priority: 'high' });
    await p;
    var qv = await queryP;
    assert.ok(qv, 'the query embed resolved');
    assert.equal(record.length, 4, '3 drain chunks + 1 query call');
    assert.equal(record[1].inputs.length, 1, 'the query embed is the single-input call');
    assert.equal(record[1].inputs[0], 'mid-drain query');
    assert.equal(record[2].inputs.length, EMBEDDING_OLLAMA_BATCH_MAX,
      'the next drain chunk waited behind the query — the high lane jumped the low lane');
    assert.equal(f.mem.countUnembedded(), 0, 'drain completed despite the interleave');
  } finally {
    resetEmbedFake();
    stopBootDrain();
    restore();
    await waitFor(function () { return embedsPending === 0; }, 30000);
  }
  f.close();
});

test('boot drain: registerHooks starts it fire-and-forget, oversized rows chunk-split like backfill, stats carries the receipt', async function () {
  // This is the loader's real boot path (plugins.js calls registerHooks at
  // boot). The drain must start WITHOUT anyone calling it, must not block
  // registration, and must handle an oversized row the way /backfill does
  // (chunk-split, then embed the pieces) instead of failing it forever.
  var iso = new Database(':memory:');
  iso.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  iso.exec(PLATFORM_TABLES);
  var m = createMemoryDB(iso);
  m.setConfig('embedding_provider', 'ollama');
  m.setConfig('embedding_url', 'http://localhost:11434');
  m.setConfig('embedding_model', 'nomic-embed-text');
  var chunkSize = m.getChunkSize();
  m.index('drain_boot', 'small-1', 'small boot row one');
  m.index('drain_boot', 'small-2', 'small boot row two');
  m.index('drain_boot', 'big-1', 'X'.repeat(chunkSize * 2 + 11)); // oversized → re-chunked
  var bigDocBefore = m.getDocChunks('drain_boot', 'big-1').length;
  var core = makeCore(iso);
  var record = [];
  var restore = installRecordingEmbedFake(record);
  try {
    registerHooks(core);            // must return without blocking on the drain
    var p = lastDrainPromise();     // the boot pass it started
    assert.ok(p && typeof p.then === 'function', 'registerHooks started a boot drain pass');
    var r = await p;
    assert.equal(r.cause, 'boot');
    assert.equal(r.failed, 0, 'no silent failures (response: ' + JSON.stringify(r) + ')');
    assert.equal(m.countUnembedded(), 0, 'everything embedded, including the oversized row');
    // The oversized doc was re-chunked at the current threshold and each
    // piece embedded (the pieces carry the vectors, so recall can rank it).
    var bigDoc = m.getDocChunks('drain_boot', 'big-1');
    assert.ok(bigDoc.length > 1 || bigDocBefore > 1, 'the oversized row was chunk-split');
    assert.ok(bigDoc.every(function (c) { return c.embedding; }), 'every chunk of the oversized doc has a vector');
    var eq = m.stats().embed_queue;
    assert.ok(typeof eq.rows_enqueued_at_boot === 'number', 'stats embed_queue carries rows_enqueued_at_boot');
    assert.ok(typeof eq.last_drain_at === 'string', 'stats embed_queue carries last_drain_at');
  } finally {
    stopBootDrain();
    restore();
    iso.close();
  }
});

test('boot drain: no provider configured is an honest skip, and the self-check picks the rows up once one exists', async function () {
  var f = await freshInstance();
  f.mem.index('drain_noprovider', 'row-1', 'no provider row');
  var record = [];
  var restore = installRecordingEmbedFake(record);
  try {
    var r = await startBootDrain(f.mem);
    assert.equal(r.skipped, 'no_provider', 'the skip is named');
    assert.equal(r.enqueued, 0);
    assert.equal(f.mem.countUnembedded(), 1, 'the row stays NULL for the next configured pass');
    assert.equal(record.length, 0, 'no embed call was made');
    // Fresh-install-then-configure: once a provider EXISTS, the self-check
    // (interval 1s for the test) drains the rows no boot pass ever saw.
    stopBootDrain(); // reset the interval gate an earlier fixture's pass armed
    f.mem.setConfig('embedding_provider', 'ollama');
    f.mem.setConfig('embedding_self_drain_interval_s', '1');
    var r2 = await selfDrainTick(f.mem);
    assert.equal(r2.skipped, undefined, 'tick ran a pass once a provider exists');
    assert.equal(r2.embedded, 1);
    assert.equal(f.mem.countUnembedded(), 0);
  } finally {
    stopBootDrain();
    restore();
    f.close();
  }
});

test('self-check: re-enqueues NULL rows after a dropped batch once the queue is empty, honoring the interval', async function () {
  var f = await freshInstance();
  try {
    f.mem.setConfig('embedding_provider', 'ollama');
    f.mem.setConfig('embedding_url', 'http://localhost:11434');
    f.mem.setConfig('embedding_model', 'nomic-embed-text');
    f.mem.setConfig('embedding_self_drain_interval_s', '1');
    for (var i = 0; i < 3; i++) {
      f.mem.index('drain_retry', 'row-' + i, 'dropped batch row ' + i);
    }
    var failRestore = installFailingEmbedFake();
    var r1;
    try {
      r1 = await selfDrainTick(f.mem); // provider up, provider failing — the dropped batch
    } finally {
      failRestore();
    }
    assert.equal(r1.enqueued, 3, 'the pass attempted every NULL row');
    assert.equal(r1.embedded, 0);
    assert.equal(r1.failed, 3, 'the failure is counted, not swallowed');
    assert.equal(f.mem.countUnembedded(), 3, 'rows stay NULL — exactly the post-restart state');
    var t1 = f.mem.stats().embed_queue.last_drain_at;

    // Too soon: the interval gate holds (a tick just ran).
    var soon = await selfDrainTick(f.mem);
    assert.equal(soon.skipped, 'before_interval', 'the interval gate spaces retries');

    // After the interval, with the provider healthy again, the same rows embed.
    await new Promise(function (r) { setTimeout(r, 1100); });
    var r2 = await selfDrainTick(f.mem);
    assert.equal(r2.embedded, 3, 'the dropped batch was retried and landed');
    assert.equal(f.mem.countUnembedded(), 0);
    var t2 = f.mem.stats().embed_queue.last_drain_at;
    assert.ok(new Date(t2) >= new Date(t1), 'last_drain_at advanced');

    // The queue-busy gate: while the scheduler has work, the self-check stands
    // down instead of piling a second drain onto the lane.
    setEmbedFakeDelay(60);
    var record = [];
    var restore = installRecordingEmbedFake(record);
    try {
      f.mem.index('drain_retry', 'row-busy', 'queued-busy probe row');
      var occupy = generateEmbedding(f.mem.getAllConfig(), 'occupy the lane', { priority: 'low' });
      var gotInFlight = await waitFor(function () { return embedsPending > 0; }, 5000);
      assert.ok(gotInFlight, 'the occupying embed is in flight');
      var busy = await selfDrainTick(f.mem);
      assert.equal(busy.skipped, 'queue_busy', 'a busy queue defers the self-check');
      await occupy;
      await new Promise(function (r) { setTimeout(r, 1100); }); // clear the interval gate the busy tick skipped
      var idle = await selfDrainTick(f.mem);
      assert.equal(idle.embedded, 1, 'once the queue empties, the straggler drains');
    } finally {
      resetEmbedFake();
      restore();
      await waitFor(function () { return embedsPending === 0; }, 30000);
    }
  } finally {
    stopBootDrain();
    f.close();
  }
});

test('self-check: embedding_self_drain_interval_s=0 disables it; absent config defaults to 300s', async function () {
  // The resolver: absent → 300 (the pinned default), '0' → 0 (off), junk →
  // default, real value → itself.
  var f = await freshInstance();
  try {
    assert.equal(resolveSelfDrainIntervalS(f.mem), 300, 'absent config defaults to 300s');
    f.mem.setConfig('embedding_self_drain_interval_s', 'junk');
    assert.equal(resolveSelfDrainIntervalS(f.mem), 300, 'unparseable config falls back to the default');
    f.mem.setConfig('embedding_self_drain_interval_s', '42');
    assert.equal(resolveSelfDrainIntervalS(f.mem), 42);
    f.mem.setConfig('embedding_self_drain_interval_s', '0');
    assert.equal(resolveSelfDrainIntervalS(f.mem), 0, '0 reads as 0 — the disabled sentinel');

    // And the tick honours it: rows stay NULL, nothing is attempted, and
    // last_drain_at does NOT move (the drain receipt is process-global, so
    // "no pass ran" is asserted as UNCHANGED, not as null).
    f.mem.setConfig('embedding_provider', 'ollama');
    f.mem.setConfig('embedding_url', 'http://localhost:11434');
    f.mem.index('drain_disabled', 'row-1', 'disabled tick row');
    var before = f.mem.stats().embed_queue.last_drain_at;
    var r = await selfDrainTick(f.mem);
    assert.equal(r.skipped, 'disabled', 'interval 0 disables the self-check');
    assert.equal(f.mem.countUnembedded(), 1, 'the row was not swept behind the test');
    assert.equal(f.mem.stats().embed_queue.last_drain_at, before, 'no pass ran, so the receipt did not move');
  } finally {
    stopBootDrain();
    f.close();
  }
});
