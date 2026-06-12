// Workflows plugin acceptance tests — the spec's test plan, executable.
// Run from server/:  node --test plugins/workflows/test.js
// Real schema.sql + real routes on an in-memory better-sqlite3 DB; core
// helpers faked faithfully (same shapes as routes/mycelium.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import express from 'express';
import Database from 'better-sqlite3';

import createRoutes from './routes.js';
import createWorkflowsDB, { validateInvocations, RESULT_CAP } from './db.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- faithful fakes of the pluginCore helpers ----
function apiError(res, status, message, extra) {
  return res.status(status).json(Object.assign({ error: message }, extra || {}));
}
function parseIntParam(val) {
  var n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}
var emitted = [];
function makeCore(db) {
  return {
    db: db,
    auth: {
      // Mirrors checkAgentOrAdmin: deny (send response + falsy) on x-test-deny,
      // else return the caller identity.
      checkAgentOrAdmin: function (req, res) {
        if (req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return req.headers['x-acting-as'] || 'tester';
      },
      checkAdmin: function () { return true; },
      getAdminDisplayName: function () { return 'tester'; }
    },
    apiError: apiError,
    parseIntParam: parseIntParam,
    validateEnum: function () { return true; },
    emitEvent: function (type, agent, projectId, summary, data) {
      emitted.push({ type: type, agent: agent, summary: summary, data: data });
    },
    onEvent: function () {},
    gatedActions: [],
    inbox: {}
  };
}

var server, base, db;

before(function () {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  var app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/workflows', createRoutes(makeCore(db)));
  server = http.createServer(app);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(function () { server.close(); });

async function call(method, p, body, headers) {
  var res = await fetch(base + p, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

var FANOUT = {
  name: 'research: test subject',
  shape: 'fanout',
  spec: {
    invocations: [
      { id: 'w0', agent: 'scout', model: 'gemma', brief: 'research A', deps: [] },
      { id: 'w1', agent: 'scout', model: 'gemma', brief: 'research B', deps: [] },
      { id: 'verify', agent: 'echo', model: 'qwen', brief: 'synthesize', deps: ['w0', 'w1'] }
    ]
  }
};

// 1. POST a 2-worker fanout + verifier -> full record, 3 invocation rows, 'created' event.
test('create: fanout spec -> workflow + invocation rows + created event', async function () {
  var r = await call('POST', '/workflows', FANOUT);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  var wf = r.body.workflow;
  assert.equal(wf.status, 'pending');
  assert.equal(wf.invocations.length, 3);
  assert.deepEqual(wf.invocations.map(function (i) { return i.inv_id; }), ['w0', 'w1', 'verify']);
  assert.deepEqual(wf.invocations[2].deps, ['w0', 'w1']);
  assert.equal(wf.events.length, 1);
  assert.equal(wf.events[0].kind, 'created');
  assert.ok(emitted.some(function (e) { return e.type === 'workflow_created'; }));
});

// 2. Duplicate inv ids / unknown deps / cycles -> 400 (mirrors scheduler ValueErrors).
test('create: invalid specs are rejected 400', async function () {
  var dup = await call('POST', '/workflows', { name: 'bad', spec: { invocations: [
    { id: 'a', agent: 'x' }, { id: 'a', agent: 'y' }] } });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /duplicate/);

  var unknown = await call('POST', '/workflows', { name: 'bad', spec: { invocations: [
    { id: 'a', agent: 'x', deps: ['ghost'] }] } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /unknown/);

  var cycle = await call('POST', '/workflows', { name: 'bad', spec: { invocations: [
    { id: 'a', agent: 'x', deps: ['b'] }, { id: 'b', agent: 'y', deps: ['a'] }] } });
  assert.equal(cycle.status, 400);
  assert.match(cycle.body.error, /cyclic/);

  var empty = await call('POST', '/workflows', { name: 'bad', spec: { invocations: [] } });
  assert.equal(empty.status, 400);
});

// MCP-convenience shape: top-level invocations (no spec wrapper).
test('create: top-level invocations accepted (MCP tool shape)', async function () {
  var r = await call('POST', '/workflows', {
    name: 'flat shape', invocations: [{ id: 'solo', agent: 'scout', deps: [] }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.workflow.invocations.length, 1);
});

// 3. Two claims -> exactly one winner, one 409.
test('claim: atomic — second claim 409s', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  var first = await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-a' });
  var second = await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-b' });
  assert.equal(first.status, 200);
  assert.equal(first.body.workflow.claimed_by, 'runner-a');
  assert.equal(second.status, 409);
});

// 4. Illegal status transitions -> 400 with the allowed list; legal path works.
test('status: transition guard', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  var jump = await call('PUT', '/workflows/' + wf.id, { status: 'completed' });
  assert.equal(jump.status, 400);
  assert.match(jump.body.error, /illegal transition pending -> completed/);

  await call('POST', '/workflows/' + wf.id + '/claim', {});
  var run = await call('PUT', '/workflows/' + wf.id, { status: 'running', risk: 'green' });
  assert.equal(run.status, 200);
  assert.equal(run.body.workflow.risk, 'green');
  assert.ok(run.body.workflow.started_at, 'started_at stamped on running');

  var done = await call('PUT', '/workflows/' + wf.id, { status: 'completed' });
  assert.equal(done.status, 200);
  assert.ok(done.body.workflow.finished_at, 'finished_at stamped on terminal');
  // terminal is terminal
  var undead = await call('PUT', '/workflows/' + wf.id, { status: 'running' });
  assert.equal(undead.status, 400);
});

// 5. Result > 32000 chars stored capped with a LOUD truncation marker.
test('invocation: result capped loudly, lifecycle stamps set', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  var big = 'x'.repeat(RESULT_CAP + 9000);
  var start = await call('PUT', '/workflows/' + wf.id + '/invocations/w0', { status: 'running' });
  assert.equal(start.status, 200);
  assert.ok(start.body.invocation.started_at);
  var fin = await call('PUT', '/workflows/' + wf.id + '/invocations/w0',
    { status: 'completed', result: big });
  assert.equal(fin.status, 200);
  assert.ok(fin.body.invocation.result.length <= RESULT_CAP + 100);
  assert.match(fin.body.invocation.result, /\[truncated at \d+ chars\]$/);
  assert.ok(fin.body.invocation.finished_at);

  var missing = await call('PUT', '/workflows/' + wf.id + '/invocations/nope', { status: 'running' });
  assert.equal(missing.status, 404);
  var badStatus = await call('PUT', '/workflows/' + wf.id + '/invocations/w1', { status: 'exploded' });
  assert.equal(badStatus.status, 400);
});

// 6. Cancel: running -> cancelling (cooperative); runner marks cancelled; events flow.
test('cancel: cooperative stop + event log', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  await call('POST', '/workflows/' + wf.id + '/claim', {});
  await call('PUT', '/workflows/' + wf.id, { status: 'running' });

  var ev = await call('POST', '/workflows/' + wf.id + '/events',
    { kind: 'wave_started', payload: { wave: 0, models: ['gemma'] } });
  assert.equal(ev.status, 200);
  var badKind = await call('POST', '/workflows/' + wf.id + '/events', { kind: 'vibes' });
  assert.equal(badKind.status, 400);

  var cancel = await call('POST', '/workflows/' + wf.id + '/cancel');
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelling');

  var marked = await call('PUT', '/workflows/' + wf.id, { status: 'cancelled' });
  assert.equal(marked.status, 200);

  var full = (await call('GET', '/workflows/' + wf.id)).body;
  var kinds = full.events.map(function (e) { return e.kind; });
  assert.ok(kinds.includes('created'));
  assert.ok(kinds.includes('claimed'));
  assert.ok(kinds.includes('wave_started'));
  assert.ok(kinds.includes('cancelled'));

  // pending workflows cancel immediately
  var wf2 = (await call('POST', '/workflows', FANOUT)).body.workflow;
  var c2 = await call('POST', '/workflows/' + wf2.id + '/cancel');
  assert.equal(c2.body.status, 'cancelled');
  // and a terminal cancel is a 409 no-op
  var c3 = await call('POST', '/workflows/' + wf2.id + '/cancel');
  assert.equal(c3.status, 409);
});

// Auth: unauthenticated requests are rejected before any work happens.
test('auth: denied caller gets 401, nothing created', async function () {
  var before_count = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  var r = await call('POST', '/workflows', FANOUT, { 'x-test-deny': '1' });
  assert.equal(r.status, 401);
  var after_count = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  assert.equal(after_count, before_count);
});

// Runner poll ordering: oldest pending first with ?order=asc.
test('list: runner poll returns oldest pending first', async function () {
  var a = (await call('POST', '/workflows', Object.assign({}, FANOUT, { name: 'older' }))).body.workflow;
  var b = (await call('POST', '/workflows', Object.assign({}, FANOUT, { name: 'newer' }))).body.workflow;
  var list = (await call('GET', '/workflows?status=pending&order=asc')).body;
  var ids = list.map(function (w) { return w.id; });
  assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id), 'older before newer');
});

// Pure validator unit checks (the scheduler-mirror).
test('validateInvocations: unit', function () {
  assert.equal(validateInvocations([{ id: 'a', agent: 'x' }]), null);
  assert.match(validateInvocations([]), /non-empty/);
  assert.match(validateInvocations([{ id: 'a' }]), /agent/);
  assert.match(validateInvocations([{ id: 'a', agent: 'x', deps: 'w0' }]), /array/);
});
