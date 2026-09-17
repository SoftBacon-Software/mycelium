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
    // Same envelope contract server/routes/mycelium.js exports (task 200).
    pageEnvelope: function (items, total, limit, offset) {
      return {
        items: items,
        total: total,
        limit: limit,
        offset: offset,
        next_offset: (offset + items.length) < total ? offset + limit : null
      };
    },
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

// 4b. Approval gate: running -> awaiting_approval (linked to an approval) -> running.
test('gate: running -> awaiting_approval (approval link) -> running, surfaced on the stream', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  await call('POST', '/workflows/' + wf.id + '/claim', {});
  await call('PUT', '/workflows/' + wf.id, { status: 'running' });

  // pause on a gate, linking the approval the workflow waits on
  var pause = await call('PUT', '/workflows/' + wf.id, { status: 'awaiting_approval', approval_id: 42 });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.workflow.status, 'awaiting_approval');
  assert.equal(pause.body.workflow.approval_id, 42, 'approval link set on the workflow');
  assert.ok(emitted.some(function (e) {
    return e.type === 'workflow_awaiting_approval' && e.data && e.data.workflow_id === wf.id;
  }), 'awaiting_approval surfaced on the stream so the app can prompt');

  // a gate is not terminal: cannot jump straight to completed
  var jump = await call('PUT', '/workflows/' + wf.id, { status: 'completed' });
  assert.equal(jump.status, 400);

  // resume on approve, then it can complete normally
  var resume = await call('PUT', '/workflows/' + wf.id, { status: 'running' });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.workflow.status, 'running');
  var done = await call('PUT', '/workflows/' + wf.id, { status: 'completed' });
  assert.equal(done.status, 200);
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

// 5b. Invocation update emits workflow_invocation_finished/failed on terminal
// status, nothing on non-terminal (live cockpit animation).
test('invocation: terminal status emits event for live cockpit animation', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  emitted = []; // clear from create

  // non-terminal (running) -> no emit
  await call('PUT', '/workflows/' + wf.id + '/invocations/w0', { status: 'running' });
  assert.equal(emitted.length, 0, 'running does not emit');

  // completed -> workflow_invocation_finished
  var fin = await call('PUT', '/workflows/' + wf.id + '/invocations/w0',
    { status: 'completed', result: 'done' });
  assert.equal(fin.status, 200);
  var finishedEvt = emitted.find(function (e) { return e.type === 'workflow_invocation_finished'; });
  assert.ok(finishedEvt, 'completed emits workflow_invocation_finished');
  assert.equal(finishedEvt.data.workflow_id, wf.id);
  assert.equal(finishedEvt.data.inv_id, 'w0');
  assert.equal(finishedEvt.data.status, 'completed');

  // failed -> workflow_invocation_failed
  var fail = await call('PUT', '/workflows/' + wf.id + '/invocations/w1',
    { status: 'failed', result: 'boom' });
  assert.equal(fail.status, 200);
  var failedEvt = emitted.find(function (e) { return e.type === 'workflow_invocation_failed'; });
  assert.ok(failedEvt, 'failed emits workflow_invocation_failed');
  assert.equal(failedEvt.data.inv_id, 'w1');
  assert.equal(failedEvt.data.status, 'failed');

  // skipped -> workflow_invocation_finished (same bucket as completed)
  var skip = await call('PUT', '/workflows/' + wf.id + '/invocations/verify',
    { status: 'skipped' });
  assert.equal(skip.status, 200);
  var skippedEvt = emitted.find(function (e) { return e.type === 'workflow_invocation_finished' && e.data.status === 'skipped'; });
  assert.ok(skippedEvt, 'skipped emits workflow_invocation_finished');
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
  assert.ok(kinds.includes('cancelling'), 'running->cancelling transition logged as event');
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

// Runner poll ordering: oldest pending first with ?order=asc. Reads the
// envelope's items (task 200) — the runner's poll consumer updates with the
// server; an UN-updated runner keeps reading a list via ?shape=array during
// the compat window (pinned by the 'list (200)' test above).
test('list: runner poll returns oldest pending first', async function () {
  var a = (await call('POST', '/workflows', Object.assign({}, FANOUT, { name: 'older' }))).body.workflow;
  var b = (await call('POST', '/workflows', Object.assign({}, FANOUT, { name: 'newer' }))).body.workflow;
  var page = (await call('GET', '/workflows?status=pending&order=asc')).body;
  var ids = page.items.map(function (w) { return w.id; });
  assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id), 'older before newer');
});

// Pure validator unit checks (the scheduler-mirror).
test('validateInvocations: unit', function () {
  assert.equal(validateInvocations([{ id: 'a', agent: 'x' }]), null);
  assert.match(validateInvocations([]), /non-empty/);
  assert.match(validateInvocations([{ id: 'a' }]), /agent/);
  assert.match(validateInvocations([{ id: 'a', agent: 'x', deps: 'w0' }]), /array/);
});

// (a) getWorkflowFull: event payloads come back as parsed objects, not escaped
// JSON strings (events are stored JSON.stringify(payload) in addEvent).
test('getWorkflowFull: event payloads parsed as objects', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  var full = (await call('GET', '/workflows/' + wf.id)).body;
  var createdEvt = full.events.find(function (e) { return e.kind === 'created'; });
  assert.ok(createdEvt, 'created event exists');
  assert.equal(typeof createdEvt.payload, 'object', 'payload is parsed object, not string');
  assert.notEqual(createdEvt.payload, null, 'payload is not null');
  assert.equal(createdEvt.payload.name, wf.name, 'payload.name accessible');
  assert.equal(typeof createdEvt.payload.invocations, 'number', 'payload.invocations is number');
});

// (b) The approval_id migration is idempotent and does not blanket-swallow
// errors: PRAGMA-check first, ALTER only if the column is missing.
test('migration: approval_id column added safely, idempotent on re-open', async function () {
  var db2 = new Database(':memory:');
  db2.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  var dbApi = createWorkflowsDB(db2);
  assert.ok(dbApi, 'createWorkflowsDB succeeds on fresh schema');
  var cols = db2.prepare('PRAGMA table_info(workflows)').all();
  assert.ok(cols.some(function (c) { return c.name === 'approval_id'; }), 'approval_id column present');
  // Re-creating on the same DB must not throw (idempotent — no blanket ALTER).
  var dbApi2 = createWorkflowsDB(db2);
  assert.ok(dbApi2, 'createWorkflowsDB idempotent on existing column');
});

// (c) updateWorkflowStatus: terminal-state workflows reject ALL mutations,
// including field-only updates (a PUT {risk:'red'} with no status used to
// bypass the transition guard because newStatus was falsy).
test('status: terminal workflow rejects field-only mutation', async function () {
  var wf = (await call('POST', '/workflows', FANOUT)).body.workflow;
  await call('POST', '/workflows/' + wf.id + '/claim', {});
  await call('PUT', '/workflows/' + wf.id, { status: 'running' });
  await call('PUT', '/workflows/' + wf.id, { status: 'completed' });

  var mutate = await call('PUT', '/workflows/' + wf.id, { risk: 'red' });
  assert.equal(mutate.status, 400);
  assert.match(mutate.body.error, /terminal/);

  var wf2 = (await call('POST', '/workflows', FANOUT)).body.workflow;
  await call('POST', '/workflows/' + wf2.id + '/claim', {});
  await call('PUT', '/workflows/' + wf2.id, { status: 'running' });
  await call('PUT', '/workflows/' + wf2.id, { status: 'failed' });
  var mutate2 = await call('PUT', '/workflows/' + wf2.id, { error: 'new error' });
  assert.equal(mutate2.status, 400);
  assert.match(mutate2.body.error, /terminal/);
});

// (d) shape:'repair' requires spec.params — rejected AT FIRE TIME with the
// runner's own message, so the defect never reaches the runner's claim seam
// (wf380: a param-less repair sat PENDING behind the runner's preflight for an
// hour before dying there).
test('create: repair without spec.params is rejected 400 at fire time', async function () {
  var body = {
    name: 'repair: no params',
    shape: 'repair',
    spec: { invocations: [{ id: 'repair', agent: 'lucy', brief: '(loop)', deps: [] }] }
  };
  var r = await call('POST', '/workflows', body);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /repair shape requires spec\.params/);

  // a non-object params is the same defect
  var arr = await call('POST', '/workflows', Object.assign({}, body, {
    spec: { invocations: body.spec.invocations, params: ['nope'] }
  }));
  assert.equal(arr.status, 400);
  assert.match(arr.body.error, /repair shape requires spec\.params/);

  // case-insensitive on the shape label
  var upper = await call('POST', '/workflows', Object.assign({}, body, { shape: 'Repair' }));
  assert.equal(upper.status, 400);

  // the flat MCP-tool form (top-level invocations/params) is validated the same
  var flat = await call('POST', '/workflows', {
    name: 'repair: flat, no params',
    shape: 'repair',
    invocations: [{ id: 'repair', agent: 'lucy', brief: '(loop)', deps: [] }]
  });
  assert.equal(flat.status, 400);
  assert.match(flat.body.error, /repair shape requires spec\.params/);
});

// (e) repair WITH params (the flat MCP-tool form) round-trips into spec.params
// — the runner executes the loop from there, so the field must survive.
test('create: repair with params fires 200 and lands in spec.params', async function () {
  var params = {
    task_brief: 'Fix the ordering bug.',
    verify_brief: 'PASS only if the check fails on a shuffled list.',
    coder: { agent: 'lucy', model: 'qwen' },
    verifier: { agent: 'echo', model: 'qwen' },
    gate_cmd: 'bash tools/summon_gate.sh',
    gate_cwd: '/tmp/repo'
  };
  var r = await call('POST', '/workflows', {
    name: 'repair: gated',
    shape: 'repair',
    invocations: [
      { id: 'repair', agent: 'lucy', brief: '(repair loop)', deps: [] },
      { id: 'verify', agent: 'echo', brief: '(repair loop)', deps: ['repair'] }
    ],
    params: params
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.workflow.status, 'pending');
  var full = (await call('GET', '/workflows/' + r.body.workflow.id)).body;
  assert.deepEqual(full.spec.params, params);
  assert.equal(full.shape, 'repair');

  // the canonical {spec:{params}} form round-trips identically
  var canon = await call('POST', '/workflows', {
    name: 'repair: canonical form',
    shape: 'repair',
    spec: { invocations: [{ id: 'repair', agent: 'lucy', brief: '(loop)', deps: [] }],
            params: params }
  });
  assert.equal(canon.status, 200);
  var canonFull = (await call('GET', '/workflows/' + canon.body.workflow.id)).body;
  assert.deepEqual(canonFull.spec.params, params);

  // params are OPTIONAL on a non-repair shape (flat form — optional tuning only)
  var other = await call('POST', '/workflows', {
    name: 'fanout with params', shape: 'fanout',
    invocations: [{ id: 'w0', agent: 'scout', brief: 'research A', deps: [] }],
    params: { max_iter: 8 }
  });
  assert.equal(other.status, 200);
  var otherFull = (await call('GET', '/workflows/' + other.body.workflow.id)).body;
  assert.deepEqual(otherFull.spec.params, { max_iter: 8 });
});

// ======== Task 200: honest list paging + stale-claim release ========
// The clockwork audit (2026-09-12 §4/§5): a runner that dies mid-claim held its
// workflow 'claimed' forever (the receipt's await-timeouts), and GET /workflows
// paged with no signal. Two new disciplines, both pinned here:
//   - the list returns an HONEST envelope by default; ?shape=array keeps the
//     bare array for one release so external old clients keep reading;
//   - releaseStaleClaims(ttl) releases a claim whose RUNNER heartbeat has gone
//     silent past the TTL (positive evidence of death — a claimant with no
//     agents row is unknown, not dead, and is left alone), and never releases a
//     RUNNING workflow: live work earns one 'stalled' event per claim episode
//     and the head decides.

var wfdb = createWorkflowsDB(db);

async function fireSolo(name, projectId) {
  var r = await call('POST', '/workflows', {
    name: name,
    project_id: projectId,
    spec: { invocations: [{ id: 'w0', agent: 'lucy', brief: 'x', deps: [] }] }
  });
  assert.equal(r.status, 200);
  return r.body.workflow;
}

var agentsTableReady = false;
function seedRunnerHeartbeat(id, stale) {
  if (!agentsTableReady) {
    // Minimal mirror of the core agents table's sweep-relevant columns —
    // production runs the JOIN against the real one (same database file).
    db.exec('CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, last_heartbeat TEXT)');
    agentsTableReady = true;
  }
  db.prepare("INSERT OR REPLACE INTO agents (id, last_heartbeat) VALUES (?, datetime('now', " +
             (stale ? "'-2 hours'" : "'+0 minutes'") + '))').run(id);
}

test('list (200): envelope by default; ?shape=array legacy; offset pages', async function () {
  for (var i = 0; i < 3; i++) await fireSolo('paging ' + i, 'pag-200');
  var page1 = await call('GET', '/workflows?project_id=pag-200&order=asc&limit=2');
  assert.equal(page1.status, 200);
  assert.equal(Array.isArray(page1.body), false, 'default shape is the envelope, not a bare array');
  assert.equal(page1.body.items.length, 2);
  assert.equal(page1.body.total, 3);
  assert.equal(page1.body.limit, 2);
  assert.equal(page1.body.offset, 0);
  assert.equal(page1.body.next_offset, 2);

  var page2 = await call('GET', '/workflows?project_id=pag-200&order=asc&limit=2&offset=2');
  assert.equal(page2.body.items.length, 1);
  assert.equal(page2.body.next_offset, null);

  var legacy = await call('GET', '/workflows?project_id=pag-200&order=asc&limit=2&shape=array');
  assert.equal(legacy.status, 200);
  assert.equal(Array.isArray(legacy.body), true, 'shape=array keeps the bare array');
  assert.equal(legacy.body.length, 2);
});

test('claim (200): claimed_at is stamped at claim time', async function () {
  var wf = await fireSolo('claimed-at stamp');
  var r = await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-stamp' });
  assert.equal(r.status, 200);
  assert.ok(r.body.workflow.claimed_at, 'claimed_at set by the atomic claim');
});

test('migration (200): claimed_at added to a pre-200 schema, idempotent on re-open', async function () {
  var db3 = new Database(':memory:');
  db3.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db3.exec('ALTER TABLE workflows DROP COLUMN claimed_at'); // simulate the old DB
  var dbApi3 = createWorkflowsDB(db3);
  assert.ok(dbApi3, 'createWorkflowsDB succeeds on the old schema');
  var cols = db3.prepare('PRAGMA table_info(workflows)').all();
  assert.ok(cols.some(function (c) { return c.name === 'claimed_at'; }), 'claimed_at migrated back');
  var dbApi4 = createWorkflowsDB(db3); // idempotent — no blanket ALTER
  assert.ok(dbApi4, 'createWorkflowsDB idempotent when the column exists');
});

test('sweep (200): claim whose runner heartbeat is past TTL releases to pending + claim_released event', async function () {
  seedRunnerHeartbeat('runner-dead', true);
  var wf = await fireSolo('stale claim');
  var claimed = await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-dead' });
  assert.equal(claimed.status, 200);

  var sweep = wfdb.releaseStaleClaims(30);
  assert.deepEqual(sweep.released.map(function (w) { return w.id; }), [wf.id]);
  assert.deepEqual(sweep.stalled, []);

  var full = (await call('GET', '/workflows/' + wf.id)).body;
  assert.equal(full.status, 'pending', 'released back to pending — a healthy runner can claim it');
  assert.equal(full.claimed_by, null);
  assert.equal(full.claimed_at, null);
  var rel = full.events.filter(function (e) { return e.kind === 'claim_released'; });
  assert.equal(rel.length, 1);
  assert.equal(rel[0].payload.reason, 'runner_stale');
  assert.equal(rel[0].payload.claimed_by, 'runner-dead');
});

test('sweep (200): a fresh runner heartbeat is never released', async function () {
  seedRunnerHeartbeat('runner-fresh', false);
  var wf = await fireSolo('fresh claim');
  await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-fresh' });

  var sweep = wfdb.releaseStaleClaims(30);
  assert.equal(sweep.released.filter(function (w) { return w.id === wf.id; }).length, 0);
  var full = (await call('GET', '/workflows/' + wf.id)).body;
  assert.equal(full.status, 'claimed');
});

test('sweep (200): a heartbeatless claimant is never released (unknown is not dead)', async function () {
  var wf = await fireSolo('ghost claim');
  await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-ghost' });

  var sweep = wfdb.releaseStaleClaims(30);
  assert.equal(sweep.released.filter(function (w) { return w.id === wf.id; }).length, 0);
  var full = (await call('GET', '/workflows/' + wf.id)).body;
  assert.equal(full.status, 'claimed');
});

test('sweep (200): a RUNNING workflow is never released — one stalled event, no duplicates', async function () {
  seedRunnerHeartbeat('runner-stall', true);
  var wf = await fireSolo('running when runner died');
  await call('POST', '/workflows/' + wf.id + '/claim', { runner_id: 'runner-stall' });
  await call('PUT', '/workflows/' + wf.id, { status: 'running' });

  var sweep1 = wfdb.releaseStaleClaims(30);
  assert.deepEqual(sweep1.released, [], 'running work is never released by the sweep');
  assert.deepEqual(sweep1.stalled.map(function (w) { return w.id; }), [wf.id]);

  var full = (await call('GET', '/workflows/' + wf.id)).body;
  assert.equal(full.status, 'running', 'the head decides — the sweep only flags');
  assert.equal(full.events.filter(function (e) { return e.kind === 'stalled'; }).length, 1);

  var sweep2 = wfdb.releaseStaleClaims(30);
  assert.deepEqual(sweep2.stalled, [], 'stalled fires once per claim episode, not every 15 min');
  var full2 = (await call('GET', '/workflows/' + wf.id)).body;
  assert.equal(full2.events.filter(function (e) { return e.kind === 'stalled'; }).length, 1);
});
