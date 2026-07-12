import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION tests — TASKS / WORK / REQUESTS slice of the 6.5k-line
// server/routes/mycelium.js god-file, written as a safety net BEFORE decomposition.
//
// These tests pin what the code DOES today, not what it should do. Where current
// behavior looks like a bug it is flagged with `BUG(locked):` comments and STILL
// asserted — a later refactor changing any of these is a behavior change and must
// consciously update this file.
//
// Endpoints covered:
//   GET    /tasks (+ ?project_id= ?status= ?assignee= ?limit=)
//   POST   /tasks
//   GET    /tasks/:id
//   PUT    /tasks/:id            (incl. the status='done' cascade)
//   DELETE /tasks/:id            (admin only)
//   POST   /requests             + GET /requests/pending
//   PUT    /requests/:id         (ack / resolve lifecycle)
//   PUT    /messages/:id/resolve
//
// Latent-bug smells locked below (search "BUG(locked)"):
//   1. FIXED (findings §15): POST /requests auto_task — 'request_id' is now in
//      updateTask()'s field allowlist, so the task→request link PERSISTS and the
//      done-cascade's "auto-resolve linked request" branch fires for route-created
//      tasks (was silently DROPPED — link stayed null, request stayed pending).
//   2. POST /tasks does NOT validate priority (PUT does) — any string is stored.
//   3. FIXED (findings §1): DELETE /tasks/:id with a valid AGENT key → 403
//      "Admin role required" — checkAdmin now classifies a valid agent key as
//      authenticated-but-not-authorized (grants nothing).
//   4. FIXED (findings §1 sibling): a garbage Bearer token on an admin route
//      → 401 "Authentication required" (was a misleading 403 "Invalid admin key").
//   5. GET /tasks?status=<garbage> is not enum-checked — silently returns [].
//   6. PUT /tasks/:id can blank a title ('' passes; POST requires non-empty).
//   7. FIXED (findings §19): done-cascade no longer re-runs when an already-done
//      task is set done again — guarded on a genuine transition INTO 'done', so
//      total_tasks_completed no longer double-counts.
//   8. FIXED (findings §20): plans_completed is gated on the same status='active'
//      condition as the status flip — a 'draft' plan is no longer reported
//      completed while staying 'draft'.
//   9. Auto-dispatch assigns a task to an idle agent but leaves status 'open'
//      (the assignment IS the dispatch — documented behavior, pinned here).
//  10. Requests: content is stored RAW (tasks escape HTML; requests don't),
//      to_agent existence is never checked, POST /requests carries NO
//      agentWriteLimiter (POST /tasks and POST /messages do), and ANY
//      authenticated party — not just the addressee — can ack/resolve.
//
// Harness copied from studio-login.test.js / task-done-cascade-transaction.test.js:
// real router, fresh temp DB, env set before the dynamic import; pool:'forks'
// isolates module-global state (rate limiter buckets, agent key cache).

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

const TASK_STATUSES = ['open', 'in_progress', 'review', 'done', 'cancelled']
const TASK_PRIORITIES = ['low', 'normal', 'high']

let tmpDataDir
let db
let app
let agentKey // char-agent  (project char-proj)
let peerKey  // char-peer   (project char-proj)
let idleKey  // char-idle   (project char-dispatch-proj) — heartbeats ONLY in the auto-dispatch test

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-tasks-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET
  // Keep POST /admin/agents' getInstanceUrl() on its tier-3 fallback path
  delete process.env.PUBLIC_BASE_URL
  delete process.env.ALLOWED_HOSTS

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Fixtures via the REAL registration route (returns the plaintext key once).
  agentKey = await registerAgent('char-agent', 'Char Agent', 'char-proj')
  peerKey = await registerAgent('char-peer', 'Char Peer', 'char-proj')
  idleKey = await registerAgent('char-idle', 'Char Idle', 'char-dispatch-proj')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

async function registerAgent(id, name, projectId) {
  const res = await request(app)
    .post('/api/mycelium/admin/agents')
    .set({ 'X-Admin-Key': ADMIN_KEY })
    .send({ id, name, project_id: projectId })
  if (res.status !== 200) throw new Error('test setup: agent registration failed: ' + JSON.stringify(res.body))
  return res.body.api_key
}

function admin() {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'char-admin' }
}

function agent(key) {
  return { 'X-Agent-Key': key }
}

// POST /tasks helper. NOTE: POST /tasks sits behind agentWriteLimiter
// (30/min keyed by X-Agent-Key, else IP) — this file stays well under both
// buckets by splitting creations between the admin key (IP bucket) and agent keys.
async function mkTask(body, headers) {
  const res = await request(app)
    .post('/api/mycelium/tasks')
    .set(headers || admin())
    .send(body)
  expect(res.status).toBe(200)
  return res.body.id
}

async function getTask(id, headers) {
  const res = await request(app).get('/api/mycelium/tasks/' + id).set(headers || admin())
  expect(res.status).toBe(200)
  return res.body
}

// ---------------------------------------------------------------------------

describe('auth surface (tasks routes)', () => {
  test('GET /tasks with no auth → 401 agent-key error (falls through to checkAgent)', async () => {
    const res = await request(app).get('/api/mycelium/tasks')
    expect(res.status).toBe(401)
    // The unauthenticated error names the AGENT header even though admin key /
    // JWT would also have been accepted — checkAgentOrAdmin's last resort wins.
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('GET /tasks with an invalid agent key → 403', async () => {
    const res = await request(app).get('/api/mycelium/tasks').set(agent('dvk_not_a_real_key'))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('GET /tasks works with a valid agent key AND with the admin key', async () => {
    const asAgent = await request(app).get('/api/mycelium/tasks').set(agent(agentKey))
    expect(asAgent.status).toBe(200)
    expect(Array.isArray(asAgent.body)).toBe(true)
    const asAdmin = await request(app).get('/api/mycelium/tasks').set(admin())
    expect(asAdmin.status).toBe(200)
    expect(Array.isArray(asAdmin.body)).toBe(true)
  })

  test('POST /tasks with no auth → 401', async () => {
    const res = await request(app).post('/api/mycelium/tasks').send({ title: 'nope' })
    expect(res.status).toBe(401)
  })

  // BUG #3 FIXED (findings §1): a VALID agent key on the admin-only DELETE now
  // gets 403 "Admin role required" — the agent is authenticated, just not
  // authorized. No access granted; only the status code is honest now.
  test('DELETE /tasks/:id with a valid AGENT key → 403 "Admin role required"', async () => {
    const res = await request(app).delete('/api/mycelium/tasks/1').set(agent(agentKey))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  test('DELETE /tasks/:id with a wrong admin key → 403', async () => {
    const res = await request(app).delete('/api/mycelium/tasks/1').set({ 'X-Admin-Key': 'wrong-key' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid admin key')
  })

  // BUG #4 FIXED (findings §1 sibling): a garbage Bearer token is a failed
  // AUTHENTICATION — 401 about the caller's credentials, no longer a 403
  // blaming an admin key that was never sent.
  test('DELETE /tasks/:id with a garbage Bearer token → 401 "Authentication required"', async () => {
    const res = await request(app)
      .delete('/api/mycelium/tasks/1')
      .set({ Authorization: 'Bearer not.a.jwt' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })
})

// ---------------------------------------------------------------------------

describe('POST /tasks', () => {
  test('success returns EXACTLY { id, title } (no full task echo) — defaults visible on GET', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks')
      .set(admin())
      .send({ title: 'Characterize me', tags: ['ui'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: expect.any(Number), title: 'Characterize me' })
    expect(Object.keys(res.body).sort()).toEqual(['id', 'title'])

    const task = await getTask(res.body.id)
    expect(task).toMatchObject({
      id: res.body.id,
      title: 'Characterize me',
      description: '',
      project_id: '',
      status: 'open',
      priority: 'normal',
      tags: '["ui"]',       // tags stored as a JSON string
      blocked_by: '[]',
      blocks: '[]',
      needs_approval: 0,
      requester: 'char-admin', // admin identity = X-Acting-As header value
      assignee: null
    })
  })

  test('title and description are HTML-escaped ON WRITE (stored escaped, echoed escaped)', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks')
      .set(agent(agentKey))
      .send({ title: '<b>bold</b>', description: 'a "quoted" <i>desc</i>' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('&lt;b&gt;bold&lt;/b&gt;')
    const task = await getTask(res.body.id)
    expect(task.title).toBe('&lt;b&gt;bold&lt;/b&gt;')
    expect(task.description).toBe('a &quot;quoted&quot; &lt;i&gt;desc&lt;/i&gt;')
    expect(task.requester).toBe('char-agent') // agent-key identity = agent id
  })

  test('missing title → 400', async () => {
    const res = await request(app).post('/api/mycelium/tasks').set(admin()).send({ description: 'no title' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('title is required')
  })

  test('title over 500 chars → 400 with max-length message', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks')
      .set(admin())
      .send({ title: 'x'.repeat(501) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('title exceeds max length (500 chars)')
  })

  // BUG(locked) #2: POST /tasks does NOT run validateEnum on priority —
  // PUT /tasks/:id rejects the same value with 400 invalid_enum. Any string is
  // accepted and stored at create time.
  test('priority is NOT validated on create — arbitrary string stored as-is', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks')
      .set(agent(agentKey))
      .send({ title: 'bogus prio', priority: 'ludicrous' })
    expect(res.status).toBe(200)
    const task = await getTask(res.body.id)
    expect(task.priority).toBe('ludicrous')
  })

  test('assignee resolves case-insensitively to a registered agent id; unknown names pass through', async () => {
    const known = await mkTask({ title: 'assigned upper', assignee: 'CHAR-AGENT' }, agent(agentKey))
    expect((await getTask(known)).assignee).toBe('char-agent') // resolveAssignee canonicalized

    const unknown = await mkTask({ title: 'assigned ghost', assignee: 'ghost-agent' }, agent(agentKey))
    expect((await getTask(unknown)).assignee).toBe('ghost-agent') // unmatched → unchanged
  })

  test('blocked_by on create wires the dependency both ways', async () => {
    const a = await mkTask({ title: 'create-dep blocker' }, agent(agentKey))
    const b = await mkTask({ title: 'create-dep blocked', blocked_by: [a] }, agent(agentKey))
    const taskB = await getTask(b)
    const taskA = await getTask(a)
    expect(JSON.parse(taskB.blocked_by)).toEqual([a])
    expect(JSON.parse(taskA.blocks)).toEqual([b])
  })
})

// ---------------------------------------------------------------------------

describe('GET /tasks filters + GET /tasks/:id', () => {
  const PROJ = 'char-filter-proj'
  let f1, f2, f3

  beforeAll(async () => {
    f1 = await mkTask({ title: 'F1', project_id: PROJ, assignee: 'char-agent' }, agent(agentKey))
    f2 = await mkTask({ title: 'F2', project_id: PROJ, assignee: 'char-peer' }, agent(agentKey))
    f3 = await mkTask({ title: 'F3', project_id: PROJ }, agent(agentKey))
    const res = await request(app)
      .put('/api/mycelium/tasks/' + f2)
      .set(admin())
      .send({ status: 'in_progress' })
    expect(res.status).toBe(200)
  })

  test('?project_id= scopes to the project', async () => {
    const res = await request(app).get('/api/mycelium/tasks?project_id=' + PROJ).set(admin())
    expect(res.status).toBe(200)
    expect(res.body.map(t => t.id).sort((x, y) => x - y)).toEqual([f1, f2, f3].sort((x, y) => x - y))
  })

  test('?status= filters within the project', async () => {
    const open = await request(app).get(`/api/mycelium/tasks?project_id=${PROJ}&status=open`).set(admin())
    expect(open.body.map(t => t.id).sort((x, y) => x - y)).toEqual([f1, f3].sort((x, y) => x - y))
    const inProg = await request(app).get(`/api/mycelium/tasks?project_id=${PROJ}&status=in_progress`).set(admin())
    expect(inProg.body.map(t => t.id)).toEqual([f2])
  })

  test('?assignee= filters, and combines with project_id + status', async () => {
    const byAssignee = await request(app).get(`/api/mycelium/tasks?project_id=${PROJ}&assignee=char-agent`).set(admin())
    expect(byAssignee.body.map(t => t.id)).toEqual([f1])
    const combined = await request(app)
      .get(`/api/mycelium/tasks?project_id=${PROJ}&status=open&assignee=char-peer`)
      .set(admin())
    expect(combined.body).toEqual([])
  })

  // BUG(locked) #5: the status FILTER is not enum-validated (the PUT body is).
  // A garbage status silently matches nothing instead of 400ing.
  test('garbage ?status= value is not rejected — returns []', async () => {
    const res = await request(app).get(`/api/mycelium/tasks?project_id=${PROJ}&status=not-a-status`).set(admin())
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('?limit= caps the result set', async () => {
    const res = await request(app).get(`/api/mycelium/tasks?project_id=${PROJ}&limit=1`).set(admin())
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
  })

  test('GET /tasks/:id → 404 for unknown id and for non-numeric id', async () => {
    const missing = await request(app).get('/api/mycelium/tasks/999999').set(admin())
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Task not found')
    // parseIntParam maps non-numeric to null → getTask(null) → 404 (not 400)
    const nonNumeric = await request(app).get('/api/mycelium/tasks/abc').set(admin())
    expect(nonNumeric.status).toBe(404)
    expect(nonNumeric.body.error).toBe('Task not found')
  })
})

// ---------------------------------------------------------------------------

describe('PUT /tasks/:id', () => {
  let taskId

  beforeAll(async () => {
    taskId = await mkTask({ title: 'update target', project_id: 'char-put-proj' })
  })

  test('success returns EXACTLY { ok: true, id }; fields updated and escaped', async () => {
    const res = await request(app)
      .put('/api/mycelium/tasks/' + taskId)
      .set(admin())
      .send({ title: '<i>new</i>', description: 'd2', priority: 'high', assignee: 'char-agent' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: taskId })
    const task = await getTask(taskId)
    expect(task.title).toBe('&lt;i&gt;new&lt;/i&gt;')
    expect(task.description).toBe('d2')
    expect(task.priority).toBe('high')
    expect(task.assignee).toBe('char-agent')
  })

  // BUG(locked) #6: PUT allows blanking the title — POST requires non-empty,
  // but the update handler only checks `!== undefined`.
  test('PUT can blank the title (create cannot)', async () => {
    const res = await request(app).put('/api/mycelium/tasks/' + taskId).set(admin()).send({ title: '' })
    expect(res.status).toBe(200)
    expect((await getTask(taskId)).title).toBe('')
    // restore something readable for later assertions
    await request(app).put('/api/mycelium/tasks/' + taskId).set(admin()).send({ title: 'update target' })
  })

  test('invalid status → 400 machine-readable invalid_enum body', async () => {
    const res = await request(app).put('/api/mycelium/tasks/' + taskId).set(admin()).send({ status: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'status must be one of: ' + TASK_STATUSES.join(', '),
      code: 'invalid_enum',
      field: 'status',
      value: 'bogus',
      allowed: TASK_STATUSES
    })
  })

  test('invalid priority → 400 invalid_enum (unlike POST, which accepts anything)', async () => {
    const res = await request(app).put('/api/mycelium/tasks/' + taskId).set(admin()).send({ priority: 'ludicrous' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid_enum', field: 'priority', allowed: TASK_PRIORITIES })
  })

  test('unknown id → 404', async () => {
    const res = await request(app).put('/api/mycelium/tasks/999999').set(admin()).send({ status: 'done' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Task not found')
  })

  test('needs_approval coerces truthy→1 / falsy→0', async () => {
    await request(app).put('/api/mycelium/tasks/' + taskId).set(admin()).send({ needs_approval: true })
    expect((await getTask(taskId)).needs_approval).toBe(1)
    await request(app).put('/api/mycelium/tasks/' + taskId).set(admin()).send({ needs_approval: false })
    expect((await getTask(taskId)).needs_approval).toBe(0)
  })

  test('project scope: agent cannot write a foreign-project task unless assigned; admin bypasses', async () => {
    const foreign = await mkTask({ title: 'foreign task', project_id: 'char-scope-proj' })
    // char-agent (project char-proj) writing into char-scope-proj → 403
    const denied = await request(app)
      .put('/api/mycelium/tasks/' + foreign)
      .set(agent(agentKey))
      .send({ status: 'in_progress' })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('Agent char-agent cannot access resources in project char-scope-proj')
    // Admin assigns the agent → assignee bypass now allows the cross-project write
    await request(app).put('/api/mycelium/tasks/' + foreign).set(admin()).send({ assignee: 'char-agent' })
    const allowed = await request(app)
      .put('/api/mycelium/tasks/' + foreign)
      .set(agent(agentKey))
      .send({ status: 'in_progress' })
    expect(allowed.status).toBe(200)
  })

  test('blocked_by on PUT adds deps and echoes them; self-blocking is silently filtered', async () => {
    const blocker = await mkTask({ title: 'put-dep blocker' }, agent(agentKey))
    const res = await request(app)
      .put('/api/mycelium/tasks/' + taskId)
      .set(admin())
      .send({ blocked_by: [blocker] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: taskId, blocked_by: [blocker] })

    // depId === task.id is skipped without error — response carries no blocked_by key
    const self = await request(app)
      .put('/api/mycelium/tasks/' + taskId)
      .set(admin())
      .send({ blocked_by: [taskId] })
    expect(self.status).toBe(200)
    expect(self.body).toEqual({ ok: true, id: taskId })
  })
})

// ---------------------------------------------------------------------------

describe('done-cascade (PUT /tasks/:id status=done)', () => {
  test('completing a blocker unblocks dependents: response.unblocked + blocked_by cleared', async () => {
    const blocker = await mkTask({ title: 'cascade blocker', project_id: 'char-cascade-proj' })
    const blocked = await mkTask({ title: 'cascade blocked', project_id: 'char-cascade-proj', blocked_by: [blocker] })

    const res = await request(app)
      .put('/api/mycelium/tasks/' + blocker)
      .set(admin())
      .send({ status: 'done' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: blocker, unblocked: [blocked] })
    expect(JSON.parse((await getTask(blocked)).blocked_by)).toEqual([])
  })

  // FIXED (findings §19): the done-cascade is now guarded on a genuine
  // transition INTO 'done' — re-completing an already-done task is a no-op. The
  // cascade does not re-run, so incrementProfileCounter is not called again and
  // total_tasks_completed does NOT double-count. (The old lock only asserted the
  // response shape { ok, id }, which is identical either way — this version
  // observes the counter delta to actually prove the no-op.)
  test('re-completing an already-done task is a no-op: cascade does not re-run, counter not re-incremented', async () => {
    // ensureAgentProfile creates the counter row (incrementProfileCounter only
    // UPDATEs an existing row — it does not auto-create one). char-agent is a
    // registered agent, so the agent_profiles FK is satisfied; the task lives in
    // char-agent's own project so it may write it.
    db.ensureAgentProfile('char-agent')
    const t = await mkTask({ title: 'double done', project_id: 'char-proj' }, agent(agentKey))

    const beforeFirst = db.getAgentProfile('char-agent').total_tasks_completed
    const first = await request(app).put('/api/mycelium/tasks/' + t).set(agent(agentKey)).send({ status: 'done' })
    expect(first.status).toBe(200)
    const afterFirst = db.getAgentProfile('char-agent').total_tasks_completed
    expect(afterFirst).toBe(beforeFirst + 1) // first completion DID count — counter is live

    const again = await request(app).put('/api/mycelium/tasks/' + t).set(agent(agentKey)).send({ status: 'done' })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ ok: true, id: t })
    // the already-done guard skipped the cascade — counter unchanged (was +1 before the fix)
    expect(db.getAgentProfile('char-agent').total_tasks_completed).toBe(afterFirst)
  })

  test('linked plan steps auto-complete; a DRAFT plan is NOT reported completed (stays draft)', async () => {
    const t = await mkTask({ title: 'plan-linked task', project_id: 'char-plan-proj' })
    const plan = await request(app)
      .post('/api/mycelium/plans')
      .set(admin())
      .send({ title: 'cascade plan', project_id: 'char-plan-proj' })
    expect(plan.status).toBe(200)
    const planId = plan.body.id
    const step = await request(app)
      .post(`/api/mycelium/plans/${planId}/steps`)
      .set(admin())
      .send({ title: 'only step', linked_task_id: t })
    expect(step.status).toBe(200)

    const res = await request(app).put('/api/mycelium/tasks/' + t).set(admin()).send({ status: 'done' })
    expect(res.status).toBe(200)
    expect(res.body.plan_steps_completed).toBe(1)
    // FIXED (findings §20): plans_completed is now gated on the same status='active'
    // condition as the status flip — a default 'draft' plan is NOT announced as
    // completed. The step still auto-completes; the plan stays 'draft'.
    expect(res.body.plans_completed).toBeUndefined()
    const planAfter = await request(app).get('/api/mycelium/plans/' + planId).set(admin())
    expect(planAfter.body.status).toBe('draft')
    expect(planAfter.body.steps[0].status).toBe('completed')
  })

  // FIXED (findings §15): POST /requests?auto_task calls
  // updateTask(taskId, { assignee, request_id }) and 'request_id' is now in
  // updateTask's buildUpdate allowlist, so the link PERSISTS. The done-cascade's
  // "auto-resolve linked request" branch now fires for route-created tasks:
  // completing the auto-task resolves the linked request.
  test('auto_task links request_id → completing the task RESOLVES the request', async () => {
    const reqRes = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(peerKey))
      .send({ content: 'please do the thing', to_agent: 'char-agent', auto_task: true })
    expect(reqRes.status).toBe(200)
    expect(reqRes.body).toEqual({ id: expect.any(Number), task_id: expect.any(Number) })
    const requestId = reqRes.body.id
    const taskId = reqRes.body.task_id

    const task = await getTask(taskId)
    expect(task.assignee).toBe('char-agent') // assignee half of the update landed
    expect(task.request_id).toBe(requestId)  // request_id half now persists too (was dropped)

    const done = await request(app)
      .put('/api/mycelium/tasks/' + taskId)
      .set(agent(agentKey))
      .send({ status: 'done' })
    expect(done.status).toBe(200)

    // The cascade branch saw the request_id and auto-resolved it.
    const pending = await request(app).get('/api/mycelium/requests/pending').set(agent(agentKey))
    expect(pending.body.map(r => r.id)).not.toContain(requestId)
    expect(db.getMessage(requestId).status).toBe('resolved')
    expect(db.getMessage(requestId).resolved_by).toBe('char-agent') // resolver = the agent that completed the task
  })

  test('cascade request-branch DOES work when request_id is present (db-seeded control)', async () => {
    // Positive control for the bug above: seed the column the route can't set,
    // proving the cascade branch itself is live code.
    const reqRes = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(agentKey))
      .send({ content: 'seeded-link probe', to_agent: 'char-peer' })
    expect(reqRes.status).toBe(200)
    const requestId = reqRes.body.id
    const taskId = await mkTask({ title: 'seeded-link task' }, agent(agentKey))
    db.getDB().prepare('UPDATE tasks SET request_id = ? WHERE id = ?').run(requestId, taskId)

    const done = await request(app)
      .put('/api/mycelium/tasks/' + taskId)
      .set(agent(agentKey))
      .send({ status: 'done' })
    expect(done.status).toBe(200)

    const msg = db.getMessage(requestId)
    expect(msg.status).toBe('resolved')
    expect(msg.resolved_by).toBe('char-agent') // resolver = the agent that completed the task
    const pending = await request(app).get('/api/mycelium/requests/pending').set(agent(peerKey))
    expect(pending.body.map(r => r.id)).not.toContain(requestId)
  })

  // KEEP LAST in this describe: heartbeating char-idle makes it eligible for
  // auto-dispatch on EVERY subsequent done-cascade in the file; after this test
  // it holds an open assigned task, which excludes it from further dispatch.
  test('auto-dispatch: completing a task assigns unclaimed work to an idle agent (status stays open)', async () => {
    // Make char-idle idle: online heartbeat, no working_on
    const hb = await request(app)
      .post('/api/mycelium/agents/heartbeat')
      .set(agent(idleKey))
      .send({ status: 'online' })
    expect(hb.status).toBe(200)

    // Unassigned open task in char-idle's own project (dispatch is project-scoped)
    const dispatchable = await mkTask({ title: 'Dispatch me', project_id: 'char-dispatch-proj' })
    // Any completion anywhere triggers the sweep
    const trigger = await mkTask({ title: 'dispatch trigger', project_id: 'char-trigger-proj' })

    const res = await request(app)
      .put('/api/mycelium/tasks/' + trigger)
      .set(admin())
      .send({ status: 'done' })
    expect(res.status).toBe(200)
    expect(res.body.auto_dispatched).toEqual([
      { agent: 'char-idle', type: 'task', id: dispatchable, title: 'Dispatch me' }
    ])

    // BUG-ish(locked) #9: the assignment IS the dispatch — assignee set, but
    // status remains 'open' until the agent pull-claims it.
    const after = await getTask(dispatchable)
    expect(after.assignee).toBe('char-idle')
    expect(after.status).toBe('open')
  })
})

// ---------------------------------------------------------------------------

describe('DELETE /tasks/:id (admin only)', () => {
  test('admin delete → { ok, id }; task is gone', async () => {
    const t = await mkTask({ title: 'delete me' })
    const res = await request(app).delete('/api/mycelium/tasks/' + t).set(admin())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: t })
    const gone = await request(app).get('/api/mycelium/tasks/' + t).set(admin())
    expect(gone.status).toBe(404)
  })

  test('unknown id → 404', async () => {
    const res = await request(app).delete('/api/mycelium/tasks/999999').set(admin())
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Task not found')
  })
})

// ---------------------------------------------------------------------------

describe('POST /requests + GET /requests/pending', () => {
  // NOTE(smell, not asserted): POST /requests has NO agentWriteLimiter, unlike
  // POST /tasks and POST /messages — requests are an unmetered write path.

  test('missing content → 400', async () => {
    const res = await request(app).post('/api/mycelium/requests').set(agent(agentKey)).send({ to_agent: 'char-peer' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('content is required')
  })

  test('missing to_agent → 400 with the broadcasts hint', async () => {
    const res = await request(app).post('/api/mycelium/requests').set(agent(agentKey)).send({ content: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('to_agent is required for requests — use POST /messages for broadcasts')
  })

  test('no auth → 401', async () => {
    const res = await request(app).post('/api/mycelium/requests').send({ content: 'x', to_agent: 'y' })
    expect(res.status).toBe(401)
  })

  test('success returns EXACTLY { id }; row is pending/urgent; content stored RAW (unescaped)', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(agentKey))
      .send({ content: '<b>raw</b> & "unescaped"', to_agent: 'char-peer', project_id: 'char-proj' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: expect.any(Number) })

    const pending = await request(app).get('/api/mycelium/requests/pending').set(agent(peerKey))
    expect(pending.status).toBe(200)
    const row = pending.body.find(r => r.id === res.body.id)
    expect(row).toMatchObject({
      from_agent: 'char-agent',
      to_agent: 'char-peer',
      msg_type: 'request',
      status: 'pending',
      priority: 'urgent', // hardwired by createRequest, regardless of body
      project_id: 'char-proj',
      // BUG-ish(locked) #10: task titles are HTML-escaped, request content is not
      content: '<b>raw</b> & "unescaped"'
    })
  })

  // BUG-ish(locked) #10: the target agent's existence is never validated —
  // a request to a ghost agent is accepted and sits pending forever.
  test('to_agent does not need to exist', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(agentKey))
      .send({ content: 'anyone home?', to_agent: 'no-such-agent' })
    expect(res.status).toBe(200)
    expect(res.body.id).toEqual(expect.any(Number))
  })

  test('admin can read another agent\'s pending queue via ?agent_id=', async () => {
    const res = await request(app)
      .get('/api/mycelium/requests/pending?agent_id=char-peer')
      .set(admin())
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    for (const r of res.body) expect(r.to_agent).toBe('char-peer')
  })
})

// ---------------------------------------------------------------------------

describe('PUT /requests/:id (ack / resolve lifecycle)', () => {
  async function mkRequest(from, to, content) {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(from))
      .send({ content, to_agent: to })
    expect(res.status).toBe(200)
    return res.body.id
  }

  test('unknown id → 404 "Request not found"', async () => {
    const res = await request(app).put('/api/mycelium/requests/999999').set(agent(agentKey)).send({ status: 'resolved' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Request not found')
  })

  test('a non-request message id → 400', async () => {
    const msg = await request(app)
      .post('/api/mycelium/messages')
      .set(agent(agentKey))
      .send({ to: 'char-peer', content: 'plain message' })
    expect(msg.status).toBe(200)
    const res = await request(app)
      .put('/api/mycelium/requests/' + msg.body.id)
      .set(agent(agentKey))
      .send({ status: 'resolved' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Message #' + msg.body.id + ' is not a request')
  })

  test('missing status → 400; invalid status → 400 with the allowed hint', async () => {
    const id = await mkRequest(peerKey, 'char-agent', 'status validation probe')
    const missing = await request(app).put('/api/mycelium/requests/' + id).set(agent(agentKey)).send({})
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('status is required (acknowledged, resolved, completed)')
    const invalid = await request(app).put('/api/mycelium/requests/' + id).set(agent(agentKey)).send({ status: 'maybe' })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('Invalid status. Use: acknowledged, resolved, completed')
  })

  // BUG-ish(locked) #10: acknowledging a BLOCKING request removes it from the
  // pending queue (listPendingRequests only matches pending/sent) — an acked-but-
  // unresolved request is invisible to /requests/pending.
  test('ack → { ok, id, status: acknowledged } and the request leaves the pending queue', async () => {
    const id = await mkRequest(peerKey, 'char-agent', 'ack me')
    const res = await request(app).put('/api/mycelium/requests/' + id).set(agent(agentKey)).send({ status: 'ack' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id, status: 'acknowledged' })
    const pending = await request(app).get('/api/mycelium/requests/pending').set(agent(agentKey))
    expect(pending.body.map(r => r.id)).not.toContain(id)
  })

  test('resolve with response → { ok, id, status: resolved, response_id }; reply goes back to the sender', async () => {
    const id = await mkRequest(peerKey, 'char-agent', 'resolve me with a reply')
    const res = await request(app)
      .put('/api/mycelium/requests/' + id)
      .set(agent(agentKey))
      .send({ status: 'resolved', response: 'all done' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id, status: 'resolved', response_id: expect.any(Number) })

    const msg = db.getMessage(id)
    expect(msg.status).toBe('resolved')
    expect(msg.resolved_by).toBe('char-agent')
    const reply = db.getMessage(res.body.response_id)
    expect(reply.from_agent).toBe('char-agent')
    expect(reply.to_agent).toBe('char-peer') // routed to the original from_agent
    expect(reply.content).toBe('all done')
  })

  test('"completed" and "done" both map to resolved', async () => {
    const id = await mkRequest(peerKey, 'char-agent', 'complete me')
    const res = await request(app).put('/api/mycelium/requests/' + id).set(agent(agentKey)).send({ status: 'completed' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('resolved')
  })

  test('bare admin key (no X-Acting-As) resolves AS the request\'s to_agent (__system__ substitution)', async () => {
    const id = await mkRequest(peerKey, 'char-agent', 'system substitution probe')
    const res = await request(app)
      .put('/api/mycelium/requests/' + id)
      .set({ 'X-Admin-Key': ADMIN_KEY }) // deliberately NO X-Acting-As
      .send({ status: 'resolved' })
    expect(res.status).toBe(200)
    expect(db.getMessage(id).resolved_by).toBe('char-agent') // to_agent, not __system__
  })

  // BUG-ish(locked) #10: no ownership check — ANY authenticated agent can
  // resolve a request addressed to someone else.
  test('an unrelated agent can resolve a request not addressed to it', async () => {
    const id = await mkRequest(peerKey, 'char-agent', 'stranger resolution probe')
    const res = await request(app)
      .put('/api/mycelium/requests/' + id)
      .set(agent(idleKey)) // char-idle is neither sender nor addressee
      .send({ status: 'resolved' })
    expect(res.status).toBe(200)
    expect(db.getMessage(id).resolved_by).toBe('char-idle')
  })
})

// ---------------------------------------------------------------------------

describe('PUT /messages/:id/resolve', () => {
  test('unknown id → 404 "Message not found"', async () => {
    const res = await request(app).put('/api/mycelium/messages/999999/resolve').set(agent(agentKey)).send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Message not found')
  })

  test('no auth → 401', async () => {
    const res = await request(app).put('/api/mycelium/messages/1/resolve').send({})
    expect(res.status).toBe(401)
  })

  test('resolves a request → EXACTLY { ok, id, status: resolved }; resolved_by = caller', async () => {
    const reqRes = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(peerKey))
      .send({ content: 'resolve via messages route', to_agent: 'char-agent' })
    const id = reqRes.body.id
    const res = await request(app).put(`/api/mycelium/messages/${id}/resolve`).set(agent(agentKey)).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id, status: 'resolved' })
    const msg = db.getMessage(id)
    expect(msg.status).toBe('resolved')
    expect(msg.resolved_by).toBe('char-agent')
  })

  // BUG-ish(locked) #10 family: unlike PUT /requests/:id (which 400s on
  // non-requests), this route resolves ANY message type without a msg_type guard.
  test('resolves a plain (non-request) message too — no msg_type check', async () => {
    const msg = await request(app)
      .post('/api/mycelium/messages')
      .set(agent(agentKey))
      .send({ to: 'char-peer', content: 'not a request' })
    expect(msg.status).toBe(200)
    const res = await request(app)
      .put(`/api/mycelium/messages/${msg.body.id}/resolve`)
      .set(agent(peerKey))
      .send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: msg.body.id, status: 'resolved' })
    expect(db.getMessage(msg.body.id).status).toBe('resolved')
  })

  test('optional response body → response_id, reply routed from responder to original sender', async () => {
    const reqRes = await request(app)
      .post('/api/mycelium/requests')
      .set(agent(peerKey))
      .send({ content: 'resolve with reply', to_agent: 'char-agent' })
    const id = reqRes.body.id
    const res = await request(app)
      .put(`/api/mycelium/messages/${id}/resolve`)
      .set(agent(agentKey))
      .send({ response: 'here you go' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id, status: 'resolved', response_id: expect.any(Number) })
    const reply = db.getMessage(res.body.response_id)
    expect(reply.from_agent).toBe('char-agent')
    expect(reply.to_agent).toBe('char-peer')
    expect(reply.content).toBe('here you go')
  })
})
