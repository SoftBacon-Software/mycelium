import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION TESTS — PLANS + APPROVALS API (server/routes/mycelium.js).
//
// Part of the tests-first safety net under the 6,539-line god-file before it is
// decomposed. These tests LOCK CURRENT BEHAVIOR — they describe what the code
// DOES today, not what it should do. Where current behavior smells like a bug,
// the test asserts it anyway and carries a "BUG (locked)" comment so the
// decomposition can preserve-or-consciously-fix, never silently drift.
//
// Endpoints under characterization:
//   GET  /plans                       — list + progress/current_step decoration
//   POST /plans                       — create (+ inline steps, plan_create gate)
//   GET  /plans/:id                   — single plan + steps + comments
//   PUT  /plans/:id                   — status enum + update
//   PUT  /plans/:id/steps/:stepId     — step update, links, assignee resolution,
//                                       AUTO-COMPLETION CASCADE, failed-step
//                                       self-heal ladder (retry → exhaust → block)
//   DELETE /plans/:id                 — approval-gate interlock (soft/hard asymmetry)
//   POST /approvals                   — create (risk_tier, required_approvals)
//   GET  /approvals, /approvals/:id   — list/get, payload JSON parsing
//   PUT  /approvals/:id/vote          — quorum machine + any-single-deny rule
//   GET  /approvals/:id/votes         — vote rows
//
// Latent-bug smells LOCKED (not fixed) — the headline list:
//   S1. POST /plans ignores the approval-gate result except for its soft warning:
//       an agent passing a bogus/denied approval_id still creates the plan, with
//       NO warning. (DELETE /plans hard-fails the same condition — asymmetry.)
//   S2. FIXED (safety-first, 2026-07-12): PUT and DELETE /plans/:id/steps/:stepId
//       now 404 on a nonexistent stepId (existence check BEFORE mutation/emit),
//       closing both the ghost-200 PUT and the EMPTY-plan phantom
//       auto-completion ([].every() === true on zero real steps). See the
//       "FIXED (safety-first) S2a/S2b" tests below.
//   S3. FIXED (safety-first, 2026-07-12): the same existence check is SCOPED to
//       the URL's plan (plan.steps.find), so a step that belongs to a
//       DIFFERENT plan now also 404s instead of being silently mutated via the
//       wrong plan's URL. See "FIXED (safety-first) S3" below.
//   S4. Cascade ignores plan lifecycle: a 'draft' plan jumps straight to
//       'completed'; exhausted-retry sets plans to 'blocked', a status NOT in
//       PLAN_STATUSES (clients can never set or restore it via the API).
//   S5. 'skipped' is honored by the cascade but is NOT in PLAN_STEP_STATUSES —
//       no API client can ever set it.
//   S6. There is NO risk_tier → required_approvals mapping: required_approvals
//       defaults to 1 even for risk_tier:'critical' (docs table says critical =
//       ALL humans). required_approvals:0 also coerces to 1 (|| 1).
//   S7. The vote route collapses ALL admin-key callers to voter '__admin__' and
//       ALL studio-JWT callers to voter 'studio_user' (X-Acting-As ignored),
//       and votes upsert on (approval_id, voter) — so quorums > 2 are
//       UNREACHABLE through the API, and two humans sharing the admin key can
//       never reach quorum 2.
//   S8. approvals.current_approvals is never maintained — stays 0 forever.
//   S9. GET /approvals/:id/votes on a nonexistent approval returns 200 [].
//
// Harness: same as studio-login.test.js — real router, fresh temp DB (DATA_DIR
// set before the dynamic import), supertest. pool:'forks' isolates module state.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const STUDIO_PASSWORD = 'correct-horse-battery'

let tmpDataDir
let app
let agentKey // lucy-a (project 'proj-a') — registered via the real admin route
let studioToken // admin-role studio JWT — the second voter identity

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-plans-approvals-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Agent fixture through the real registration route (plaintext key returned once)
  const reg = await request(app)
    .post('/api/mycelium/admin/agents')
    .set('X-Admin-Key', ADMIN_KEY)
    .send({ id: 'lucy-a', name: 'Lucy', project_id: 'proj-a' })
  if (reg.status !== 200) throw new Error('test setup: agent registration failed: ' + JSON.stringify(reg.body))
  agentKey = reg.body.api_key

  // Studio admin user + login → JWT (the only second voter identity the vote
  // route can mint — see S7)
  const usr = await request(app)
    .post('/api/mycelium/studio/users')
    .set('X-Admin-Key', ADMIN_KEY)
    .send({ username: 'gilbert', password: STUDIO_PASSWORD, display_name: 'Gilbert', role: 'admin' })
  if (usr.status !== 200) throw new Error('test setup: studio user failed: ' + JSON.stringify(usr.body))
  const login = await request(app)
    .post('/api/mycelium/studio/login')
    .send({ username: 'gilbert', password: STUDIO_PASSWORD })
  if (login.status !== 200) throw new Error('test setup: studio login failed: ' + JSON.stringify(login.body))
  studioToken = login.body.token
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const base = '/api/mycelium'
function admin() { return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'tester' } }
function agent() { return { 'X-Agent-Key': agentKey } }

async function mkPlan(body, headers) {
  const res = await request(app).post(base + '/plans').set(headers || admin()).send(body)
  expect(res.status).toBe(200)
  return res.body
}

async function getPlan(id) {
  const res = await request(app).get(base + '/plans/' + id).set(admin())
  expect(res.status).toBe(200)
  return res.body
}

async function putStep(planId, stepId, body, headers) {
  return request(app).put(base + '/plans/' + planId + '/steps/' + stepId).set(headers || admin()).send(body)
}

async function mkApproval(body, headers) {
  const res = await request(app).post(base + '/approvals').set(headers || admin())
    .send(Object.assign({ action_type: 'deploy', title: 'Deploy v1', payload: { sha: 'abc123' } }, body || {}))
  expect(res.status).toBe(200)
  return res.body
}

async function vote(id, body, headers) {
  return request(app).put(base + '/approvals/' + id + '/vote').set(headers || admin()).send(body || {})
}

// =============================== AUTH ===============================

describe('auth pins', () => {
  test('GET /plans with no auth → 401 Missing X-Agent-Key header (checkAgentOrAdmin falls through to agent auth)', async () => {
    const res = await request(app).get(base + '/plans')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('POST /plans and POST /approvals with no auth → 401', async () => {
    expect((await request(app).post(base + '/plans').send({ title: 'x' })).status).toBe(401)
    expect((await request(app).post(base + '/approvals').send({ action_type: 'deploy', title: 'x', payload: {} })).status).toBe(401)
  })

  test('PUT /approvals/:id/vote is ADMIN-ONLY: agent key → 403, wrong admin key → 403', async () => {
    const { id } = await mkApproval()
    // findings-§1 fix: checkAdmin recognizes the valid agent key as
    // authentication → honest 403 "Admin role required" — agents still cannot vote.
    const asAgent = await vote(id, { vote: 'approve' }, agent())
    expect(asAgent.status).toBe(403)
    expect(asAgent.body.error).toBe('Admin role required')

    const badKey = await vote(id, { vote: 'approve' }, { 'X-Admin-Key': 'wrong-key-wrong-key-wrong-key-wrong' })
    expect(badKey.status).toBe(403)
    expect(badKey.body.error).toBe('Invalid admin key')
  })

  test('agent key IS accepted on the read/create surfaces (GET /plans, POST /approvals)', async () => {
    expect((await request(app).get(base + '/plans').set(agent())).status).toBe(200)
    const res = await request(app).post(base + '/approvals').set(agent())
      .send({ action_type: 'git_push', title: 'push it', payload: { branch: 'main' } })
    expect(res.status).toBe(200)
    // requested_by is the authenticated agent id
    const got = await request(app).get(base + '/approvals/' + res.body.id).set(admin())
    expect(got.body.requested_by).toBe('lucy-a')
  })
})

// =============================== POST /plans ===============================

describe('POST /plans', () => {
  test('minimal create → { id, title }; plan lands with status "draft", empty steps, zeroed progress', async () => {
    const created = await mkPlan({ title: 'Bare plan' })
    expect(created).toEqual({ id: expect.any(Number), title: 'Bare plan' })
    const plan = await getPlan(created.id)
    expect(plan.status).toBe('draft') // schema default — POST /plans has no status param
    expect(plan.steps).toEqual([])
    expect(plan.progress).toEqual({ total: 0, completed: 0, percent: 0 })
    expect(plan.priority).toBe('normal')
    expect(plan.tags).toBe('[]') // stored/returned as a JSON *string*, not parsed
  })

  test('inline steps: titled steps created in order; untitled steps SILENTLY dropped', async () => {
    const created = await mkPlan({
      title: 'Plan with steps',
      steps: [{ title: 'step one' }, { description: 'no title — dropped' }, { title: 'step two' }]
    })
    expect(created.steps_created).toBe(2) // the untitled step vanishes without error
    const plan = await getPlan(created.id)
    expect(plan.steps.map(s => s.title)).toEqual(['step one', 'step two'])
    expect(plan.steps.map(s => s.step_order)).toEqual([0, 1])
    expect(plan.steps.every(s => s.status === 'pending')).toBe(true)
    expect(plan.steps.every(s => Array.isArray(s.comments))).toBe(true)
  })

  test('title/description are HTML-entity-escaped ON WRITE (stored escaped, served escaped)', async () => {
    const created = await mkPlan({ title: '<b>Plan & "q"</b>', description: 'a <i>b</i>' })
    expect(created.title).toBe('&lt;b&gt;Plan &amp; &quot;q&quot;&lt;/b&gt;')
    const plan = await getPlan(created.id)
    expect(plan.title).toBe('&lt;b&gt;Plan &amp; &quot;q&quot;&lt;/b&gt;')
    expect(plan.description).toBe('a &lt;i&gt;b&lt;/i&gt;')
  })

  test('missing/empty title → 400 "title is required"', async () => {
    const res1 = await request(app).post(base + '/plans').set(admin()).send({})
    expect(res1.status).toBe(400)
    expect(res1.body.error).toBe('title is required')
    const res2 = await request(app).post(base + '/plans').set(admin()).send({ title: '' })
    expect(res2.status).toBe(400)
  })

  test('AGENT create without approval_id → 200 with soft approval_warning (plan_create gate warns, never blocks)', async () => {
    const res = await request(app).post(base + '/plans').set(agent()).send({ title: 'agent plan' })
    expect(res.status).toBe(200)
    expect(res.body.approval_warning).toContain('plan_create')
    expect(res.body.approval_warning).toContain('approval')
  })

  test('BUG (locked) S1: AGENT create with a BOGUS approval_id → 200 and NO warning (gate result silently ignored)', async () => {
    // checkApprovalGate returns { ok:false, error:'Approval #999999 not found' }
    // but POST /plans only reads gate.warning — a hard gate failure is treated
    // as full success. Invalid/denied/foreign approval_ids all pass silently.
    const res = await request(app).post(base + '/plans').set(agent())
      .send({ title: 'gate-dodging plan', approval_id: 999999 })
    expect(res.status).toBe(200)
    expect(res.body.id).toEqual(expect.any(Number))
    expect(res.body.approval_warning).toBeUndefined()
  })
})

// =============================== GET /plans (+ :id) ===============================

describe('GET /plans and GET /plans/:id', () => {
  test('list decorates each plan with step_count, progress, and current_step (first in_progress else first pending)', async () => {
    const created = await mkPlan({
      title: 'List decoration plan', project_id: 'list-proj-1',
      steps: [{ title: 'a' }, { title: 'b' }, { title: 'c' }]
    })
    const plan = await getPlan(created.id)
    await putStep(created.id, plan.steps[0].id, { status: 'completed' })
    await putStep(created.id, plan.steps[1].id, { status: 'in_progress' })

    const res = await request(app).get(base + '/plans?project_id=list-proj-1').set(admin())
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    const p = res.body[0]
    expect(p.step_count).toBe(3)
    expect(p.progress).toEqual({ total: 3, completed: 1, percent: 33 }) // completed only; rounded
    expect(p.current_step).toBe('b') // the in_progress step wins over pending 'c'
  })

  test('?status= filter narrows the list', async () => {
    const created = await mkPlan({ title: 'Filter status plan', project_id: 'list-proj-2' })
    await request(app).put(base + '/plans/' + created.id).set(admin()).send({ status: 'active' })
    const active = await request(app).get(base + '/plans?project_id=list-proj-2&status=active').set(admin())
    expect(active.body.map(p => p.id)).toContain(created.id)
    const draft = await request(app).get(base + '/plans?project_id=list-proj-2&status=draft').set(admin())
    expect(draft.body).toEqual([])
  })

  test('GET /plans/:id → 404 for unknown and non-numeric ids', async () => {
    const missing = await request(app).get(base + '/plans/999999').set(admin())
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Plan not found')
    const nonNumeric = await request(app).get(base + '/plans/abc').set(admin())
    expect(nonNumeric.status).toBe(404) // parseIntParam → null → not found
  })
})

// =============================== PUT /plans/:id ===============================

describe('PUT /plans/:id', () => {
  test('invalid status → 400 with machine-readable invalid_enum shape', async () => {
    const created = await mkPlan({ title: 'Enum plan' })
    const res = await request(app).put(base + '/plans/' + created.id).set(admin()).send({ status: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'status must be one of: draft, active, completed, cancelled',
      code: 'invalid_enum',
      field: 'status',
      value: 'bogus',
      allowed: ['draft', 'active', 'completed', 'cancelled']
    })
  })

  test('valid update → { ok:true, id }; fields persist', async () => {
    const created = await mkPlan({ title: 'Updatable plan' })
    const res = await request(app).put(base + '/plans/' + created.id).set(admin())
      .send({ status: 'active', owner: 'gilbert', priority: 'high' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: created.id })
    const plan = await getPlan(created.id)
    expect(plan.status).toBe('active')
    expect(plan.owner).toBe('gilbert')
    expect(plan.priority).toBe('high')
  })

  test('unknown plan → 404', async () => {
    const res = await request(app).put(base + '/plans/999999').set(admin()).send({ status: 'active' })
    expect(res.status).toBe(404)
  })

  test('cross-project AGENT write → 403 project-scope; agent READ of foreign plan → 200', async () => {
    const created = await mkPlan({ title: 'Foreign plan', project_id: 'proj-b' })
    const write = await request(app).put(base + '/plans/' + created.id).set(agent()).send({ status: 'active' })
    expect(write.status).toBe(403)
    expect(String(write.body.error)).toMatch(/project/i)
    // agents can read across projects (shared swarm context)
    const read = await request(app).get(base + '/plans/' + created.id).set(agent())
    expect(read.status).toBe(200)
  })
})

// ====================== PUT /plans/:id/steps/:stepId — basics ======================

describe('PUT /plans/:id/steps/:stepId — updates, links, assignee', () => {
  test('status update → { ok:true, step_id }; completed sets completed_at; plan progress follows', async () => {
    const created = await mkPlan({ title: 'Step basics', steps: [{ title: 's1' }, { title: 's2' }] })
    const plan = await getPlan(created.id)
    const [s1] = plan.steps

    const res = await putStep(created.id, s1.id, { status: 'completed' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, step_id: s1.id })

    const after = await getPlan(created.id)
    const s1After = after.steps.find(s => s.id === s1.id)
    expect(s1After.status).toBe('completed')
    expect(s1After.completed_at).toBeTruthy()
    expect(after.progress).toEqual({ total: 2, completed: 1, percent: 50 })
  })

  test('BUG (locked) S5: "skipped" is rejected by the enum even though the cascade honors it', async () => {
    // The auto-completion cascade treats status==='skipped' as done, but
    // PLAN_STEP_STATUSES = [pending, in_progress, completed, blocked, failed]
    // — no API client can ever set 'skipped'. Dead branch locked here.
    const created = await mkPlan({ title: 'Skipped enum', steps: [{ title: 's1' }] })
    const plan = await getPlan(created.id)
    const res = await putStep(created.id, plan.steps[0].id, { status: 'skipped' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_enum')
    expect(res.body.allowed).toEqual(['pending', 'in_progress', 'completed', 'blocked', 'failed'])
  })

  test('assignee is resolved by agent id/name (case-insensitive); unknown assignee passes through verbatim', async () => {
    const created = await mkPlan({ title: 'Assignee resolution', steps: [{ title: 's1' }, { title: 's2' }] })
    const plan = await getPlan(created.id)
    // 'Lucy' is the agent NAME → resolves to id 'lucy-a'
    await putStep(created.id, plan.steps[0].id, { assignee: 'Lucy' })
    // no such agent → stored as sent
    await putStep(created.id, plan.steps[1].id, { assignee: 'ghost-agent' })
    const after = await getPlan(created.id)
    expect(after.steps[0].assignee).toBe('lucy-a')
    expect(after.steps[1].assignee).toBe('ghost-agent')
  })

  test('assigned agent may update its step ACROSS projects (assignee carve-out in checkProjectScope)', async () => {
    const created = await mkPlan({ title: 'Carve-out plan', project_id: 'proj-b', steps: [{ title: 'lucy work', assignee: 'lucy-a' }] })
    const plan = await getPlan(created.id)
    const res = await putStep(created.id, plan.steps[0].id, { status: 'in_progress' }, agent())
    expect(res.status).toBe(200) // lucy-a is proj-a, plan is proj-b — assignee match allows the write
  })

  test('linked_task_id / linked_branch / linked_pr_url persist', async () => {
    const created = await mkPlan({ title: 'Linked step', steps: [{ title: 's1' }] })
    const plan = await getPlan(created.id)
    await putStep(created.id, plan.steps[0].id, {
      linked_task_id: 42, linked_branch: 'feature/x', linked_pr_url: 'https://github.com/x/y/pull/1'
    })
    const after = await getPlan(created.id)
    expect(after.steps[0].linked_task_id).toBe(42)
    expect(after.steps[0].linked_branch).toBe('feature/x')
    expect(after.steps[0].linked_pr_url).toBe('https://github.com/x/y/pull/1')
  })

  test('FIXED (safety-first) S2a: nonexistent stepId → 404, no ghost update', async () => {
    const created = await mkPlan({ title: 'Ghost step plan', steps: [{ title: 'real step' }] })
    const res = await putStep(created.id, 987654, { status: 'in_progress' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Plan step not found' })
    const after = await getPlan(created.id)
    expect(after.steps[0].status).toBe('pending') // real step untouched
  })

  test('FIXED (safety-first): DELETE of a nonexistent stepId → 404, no phantom delete', async () => {
    const created = await mkPlan({ title: 'Ghost step delete plan', steps: [{ title: 'real step' }] })
    const res = await request(app).delete(base + '/plans/' + created.id + '/steps/987654').set(admin())
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Plan step not found' })
    const after = await getPlan(created.id)
    expect(after.steps).toHaveLength(1) // real step untouched
    expect(after.steps[0].status).toBe('pending')
  })
})

// ====================== the AUTO-COMPLETION CASCADE ======================

describe('plan-step auto-completion cascade', () => {
  test('completing the LAST open step auto-completes the plan (draft → completed, skipping active)', async () => {
    const created = await mkPlan({ title: 'Cascade plan', steps: [{ title: 's1' }, { title: 's2' }] })
    const plan = await getPlan(created.id)
    const [s1, s2] = plan.steps

    await putStep(created.id, s1.id, { status: 'completed' })
    expect((await getPlan(created.id)).status).toBe('draft') // one step still pending — no cascade

    await putStep(created.id, s2.id, { status: 'completed' })
    const after = await getPlan(created.id)
    // BUG-ish (locked) S4: the cascade never checks plan lifecycle — this plan
    // was never 'active', yet it lands on 'completed' directly from 'draft'.
    expect(after.status).toBe('completed')
    expect(after.progress).toEqual({ total: 2, completed: 2, percent: 100 })
  })

  test('FIXED (safety-first) S2b: ghost-completing a step on an EMPTY plan → 404, plan stays draft (no phantom auto-complete)', async () => {
    // Previously: the missing-step guard didn't exist, so updatePlanStep no-op'd,
    // the cascade re-fetched the (still-empty) plan, and [].every() === true
    // vacuously "completed" a plan with zero real steps. The 404 guard now
    // short-circuits before the mutation OR the cascade ever run.
    const created = await mkPlan({ title: 'Empty plan' }) // zero steps
    const res = await putStep(created.id, 987655, { status: 'completed' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Plan step not found' })
    const after = await getPlan(created.id)
    expect(after.status).toBe('draft') // no phantom completion
  })

  test('FIXED (safety-first) S3: a foreign plan\'s step via the wrong plan URL → 404, neither plan mutated', async () => {
    // Previously: the handler resolved updatePlanStep by step id alone, so a
    // step belonging to plan B could be silently mutated by hitting plan A's
    // URL. The existence check is SCOPED to the URL's plan (plan.steps.find),
    // so a step that is real but not a child of THIS plan now 404s too — the
    // safety-first fix closes the cross-plan mutation path as a side effect.
    const planA = await mkPlan({ title: 'Plan A (URL)', steps: [{ title: 'a1' }] })
    const planB = await mkPlan({ title: 'Plan B (owner)', steps: [{ title: 'b1' }] })
    const stepB1 = (await getPlan(planB.id)).steps[0]

    const res = await putStep(planA.id, stepB1.id, { status: 'completed' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Plan step not found' })

    const afterB = await getPlan(planB.id)
    expect(afterB.steps[0].status).toBe('pending') // B's step NOT touched via A's URL
    expect(afterB.status).toBe('draft')
    const afterA = await getPlan(planA.id)
    expect(afterA.steps[0].status).toBe('pending') // A untouched
    expect(afterA.status).toBe('draft')
  })
})

// ====================== failed-step self-heal ladder ======================

describe('failed step → bounded self-heal (retry x2 → exhaust → block)', () => {
  test('1st failure: step reopened to pending (attempt 1/2), prior completed step reopened WITH critique comment', async () => {
    const created = await mkPlan({ title: 'Self-heal plan', steps: [{ title: 'impl' }, { title: 'verify' }] })
    const plan = await getPlan(created.id)
    const [impl, verify] = plan.steps
    await putStep(created.id, impl.id, { status: 'completed' })

    const res = await putStep(created.id, verify.id, { status: 'failed', critique: 'tests are red' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, step_id: verify.id })

    const after = await getPlan(created.id)
    const implAfter = after.steps.find(s => s.id === impl.id)
    const verifyAfter = after.steps.find(s => s.id === verify.id)
    // the failed step itself is reopened, not left 'failed'
    expect(verifyAfter.status).toBe('pending')
    expect(verifyAfter.attempt_count).toBe(1)
    // the phase it guards (greatest step_order below it, completed) is reopened too
    expect(implAfter.status).toBe('pending')
    expect(implAfter.completed_at).toBeNull()
    // ...with the critique fed forward as a __system__ comment on the reopened step
    expect(implAfter.comments).toHaveLength(1)
    expect(implAfter.comments[0].author).toBe('__system__')
    expect(implAfter.comments[0].content).toContain('[auto-retry 1/2]')
    expect(implAfter.comments[0].content).toContain('tests are red')
    // the failed step does NOT get the critique comment (only reopened priors do)
    expect(verifyAfter.comments).toHaveLength(0)
    expect(after.status).toBe('draft') // plan not blocked while retries remain

    // 2nd failure: retry budget still has room → attempt 2/2; impl (now pending,
    // not completed) is NOT reopened again, so no second comment
    await putStep(created.id, verify.id, { status: 'failed', critique: 'still red' })
    const after2 = await getPlan(created.id)
    expect(after2.steps.find(s => s.id === verify.id).status).toBe('pending')
    expect(after2.steps.find(s => s.id === verify.id).attempt_count).toBe(2)
    expect(after2.steps.find(s => s.id === impl.id).comments).toHaveLength(1)
    expect(after2.status).toBe('draft')

    // 3rd failure: attempts (2) >= RETRY_MAX (2) → exhausted. Step stays failed,
    // plan is BLOCKED and escalated.
    await putStep(created.id, verify.id, { status: 'failed', critique: 'red forever' })
    const after3 = await getPlan(created.id)
    expect(after3.steps.find(s => s.id === verify.id).status).toBe('failed') // terminal
    expect(after3.steps.find(s => s.id === verify.id).attempt_count).toBe(2)
    // BUG-ish (locked) S4: 'blocked' is not in PLAN_STATUSES — the server writes
    // a plan status that no API client can set (or set BACK: PUT {status:'blocked'}
    // would 400). Unblocking requires setting some OTHER valid status.
    expect(after3.status).toBe('blocked')
  })
})

// =============================== DELETE /plans/:id gate ===============================

describe('DELETE /plans/:id — approval-gate interlock (asymmetric soft/hard)', () => {
  test('agent delete with NO approval_id → deletion PROCEEDS with soft warning; BOGUS approval_id → 403 hard block', async () => {
    // No approval_id: gate returns { ok:false, soft:true, warning } → the route
    // only hard-fails on (!ok && !soft) → delete goes through, warned.
    const p1 = await mkPlan({ title: 'agent-deletable', project_id: 'proj-a' })
    const soft = await request(app).delete(base + '/plans/' + p1.id).set(agent())
    expect(soft.status).toBe(200)
    expect(soft.body.deleted).toBe(p1.id)
    expect(soft.body.approval_warning).toContain('delete')
    expect((await request(app).get(base + '/plans/' + p1.id).set(admin())).status).toBe(404)

    // Bogus approval_id: gate returns { ok:false } WITHOUT soft → 403.
    // Locked asymmetry: naming a bad approval is treated more harshly than
    // ignoring the approval system entirely (and POST /plans ignores both — S1).
    const p2 = await mkPlan({ title: 'agent-blocked-delete', project_id: 'proj-a' })
    const hard = await request(app).delete(base + '/plans/' + p2.id + '?approval_id=999999').set(agent())
    expect(hard.status).toBe(403)
    expect(hard.body.approval_required).toBe(true)
    expect((await request(app).get(base + '/plans/' + p2.id).set(admin())).status).toBe(200) // not deleted
  })
})

// =============================== POST /approvals ===============================

describe('POST /approvals', () => {
  test('create → { id, status:"pending", approval_required:true }; row carries tier/quorum/payload', async () => {
    const created = await mkApproval({ risk_tier: 'high', required_approvals: 2, project: 'proj-x' })
    expect(created).toEqual({ id: expect.any(Number), status: 'pending', approval_required: true })
    const res = await request(app).get(base + '/approvals/' + created.id).set(admin())
    expect(res.status).toBe(200)
    expect(res.body.action_type).toBe('deploy')
    expect(res.body.risk_tier).toBe('high')
    expect(res.body.required_approvals).toBe(2)
    expect(res.body.requested_by).toBe('tester') // X-Acting-As attribution on create
    expect(res.body.project_id).toBe('proj-x')
    expect(res.body.payload).toEqual({ sha: 'abc123' }) // stored as JSON string, parsed on read
    expect(res.body.status).toBe('pending')
    expect(res.body.current_approvals).toBe(0)
  })

  test('defaults: risk_tier "medium", required_approvals 1, project "mycelium"', async () => {
    const created = await mkApproval()
    const row = (await request(app).get(base + '/approvals/' + created.id).set(admin())).body
    expect(row.risk_tier).toBe('medium')
    expect(row.required_approvals).toBe(1)
    expect(row.project_id).toBe('mycelium')
  })

  test('BUG (locked) S6: NO risk_tier → quorum mapping — "critical" still defaults to required_approvals 1; 0 coerces to 1', async () => {
    // The documented tier table (critical = ALL humans, high = 2+) is not
    // enforced anywhere in this path: createApproval does `requiredApprovals || 1`.
    const critical = await mkApproval({ risk_tier: 'critical' })
    expect((await request(app).get(base + '/approvals/' + critical.id).set(admin())).body.required_approvals).toBe(1)
    const zero = await mkApproval({ required_approvals: 0 })
    expect((await request(app).get(base + '/approvals/' + zero.id).set(admin())).body.required_approvals).toBe(1)
  })

  test('validation: bad action_type / missing title / missing payload → 400', async () => {
    const badAction = await request(app).post(base + '/approvals').set(admin())
      .send({ action_type: 'reboot_universe', title: 't', payload: {} })
    expect(badAction.status).toBe(400)
    expect(badAction.body.error).toBe('action_type must be one of: deploy, git_push, plan_create, money_action, delete, external_comm')

    const noTitle = await request(app).post(base + '/approvals').set(admin())
      .send({ action_type: 'deploy', payload: {} })
    expect(noTitle.status).toBe(400)
    expect(noTitle.body.error).toBe('title is required')

    // NOTE (locked): the payload check is plain falsiness — an explicit empty
    // string (or 0) is rejected the same as absent.
    const noPayload = await request(app).post(base + '/approvals').set(admin())
      .send({ action_type: 'deploy', title: 't' })
    expect(noPayload.status).toBe(400)
    expect(noPayload.body.error).toBe('payload is required')
    const emptyPayload = await request(app).post(base + '/approvals').set(admin())
      .send({ action_type: 'deploy', title: 't', payload: '' })
    expect(emptyPayload.status).toBe(400)
  })

  test('GET /approvals list: filterable by status, payload parsed to object; GET /approvals/:id 404 for unknown', async () => {
    const created = await mkApproval({ title: 'listable', payload: { k: 'v' } })
    const list = await request(app).get(base + '/approvals?status=pending').set(admin())
    expect(list.status).toBe(200)
    const mine = list.body.find(a => a.id === created.id)
    expect(mine).toBeTruthy()
    expect(mine.payload).toEqual({ k: 'v' })

    const missing = await request(app).get(base + '/approvals/999999').set(admin())
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Approval not found')
  })
})

// ====================== PUT /approvals/:id/vote — the quorum machine ======================

describe('approval voting: quorum + any-single-deny', () => {
  test('quorum 1: a single admin-key approve decides it — decided_by "__admin__" (X-Acting-As IGNORED here)', async () => {
    const created = await mkApproval({ required_approvals: 1 })
    const res = await vote(created.id, { vote: 'approve' }, { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'gilbert-human' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true, status: 'approved',
      votes: { approves: 1, denies: 0 },
      message: 'Quorum reached. Approval granted.'
    })
    const row = (await request(app).get(base + '/approvals/' + created.id).set(admin())).body
    expect(row.status).toBe('approved')
    // BUG-ish (locked) S7: unlike POST /approvals (which records X-Acting-As as
    // requested_by), the vote route hardcodes '__admin__' — attribution is lost.
    expect(row.decided_by).toBe('__admin__')
    expect(row.reason).toBe('Quorum reached (1/1)')
    expect(row.decided_at).toBeTruthy()
    // BUG (locked) S8: current_approvals is never maintained — still 0 after approval.
    expect(row.current_approvals).toBe(0)
  })

  test('missing vote field defaults to "approve"', async () => {
    const created = await mkApproval({ required_approvals: 1 })
    const res = await vote(created.id, {}) // no body.vote
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('approved')
  })

  test('quorum 2: same admin-key voter cannot double-vote (upsert on (approval_id, voter)); a studio-JWT voter completes quorum', async () => {
    const created = await mkApproval({ required_approvals: 2, risk_tier: 'high' })

    const first = await vote(created.id, { vote: 'approve' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true, status: 'pending', votes: { approves: 1, denies: 0 }, remaining: 1 })

    // BUG (locked) S7: EVERY admin-key caller is voter '__admin__' — a second
    // human voting with the same key just upserts the same row. Quorum stays 1.
    const dup = await vote(created.id, { vote: 'approve' })
    expect(dup.status).toBe(200)
    expect(dup.body).toEqual({ ok: true, status: 'pending', votes: { approves: 1, denies: 0 }, remaining: 1 })

    // The only other identity the route can mint: any studio-JWT admin → 'studio_user'
    const second = await vote(created.id, { vote: 'approve' }, { Authorization: 'Bearer ' + studioToken })
    expect(second.status).toBe(200)
    expect(second.body.status).toBe('approved')
    expect(second.body.votes).toEqual({ approves: 2, denies: 0 })

    const votes = (await request(app).get(base + '/approvals/' + created.id + '/votes').set(admin())).body
    expect(votes.map(v => v.voter).sort()).toEqual(['__admin__', 'studio_user'])
    const row = (await request(app).get(base + '/approvals/' + created.id).set(admin())).body
    expect(row.decided_by).toBe('studio_user')
    expect(row.reason).toBe('Quorum reached (2/2)')
  })

  test('BUG (locked) S7: quorum 3 is UNREACHABLE via the API — only 2 voter identities exist', async () => {
    const created = await mkApproval({ required_approvals: 3, risk_tier: 'critical' })
    await vote(created.id, { vote: 'approve' }) // '__admin__'
    const last = await vote(created.id, { vote: 'approve' }, { Authorization: 'Bearer ' + studioToken }) // 'studio_user'
    // Both possible voters have voted; the approval is stuck pending forever.
    expect(last.status).toBe(200)
    expect(last.body).toEqual({ ok: true, status: 'pending', votes: { approves: 2, denies: 0 }, remaining: 1 })
    expect((await request(app).get(base + '/approvals/' + created.id).set(admin())).body.status).toBe('pending')
  })

  test('ANY single deny = instant denial, even with prior approves; denier recorded as decided_by, notes as reason', async () => {
    const created = await mkApproval({ required_approvals: 2 })
    await vote(created.id, { vote: 'approve' }) // 1/2 — pending

    const deny = await vote(created.id, { vote: 'deny', notes: 'too risky tonight' }, { Authorization: 'Bearer ' + studioToken })
    expect(deny.status).toBe(200)
    expect(deny.body).toEqual({ ok: true, status: 'denied', message: 'Approval denied.' })

    const row = (await request(app).get(base + '/approvals/' + created.id).set(admin())).body
    expect(row.status).toBe('denied')
    expect(row.decided_by).toBe('studio_user')
    expect(row.reason).toBe('too risky tonight')

    const votes = (await request(app).get(base + '/approvals/' + created.id + '/votes').set(admin())).body
    expect(votes).toHaveLength(2)
    expect(votes.find(v => v.voter === '__admin__').vote).toBe('approve')
    expect(votes.find(v => v.voter === 'studio_user').vote).toBe('deny')
  })

  test('a voter can flip approve → deny (upsert), and the deny still kills it', async () => {
    const created = await mkApproval({ required_approvals: 2 })
    await vote(created.id, { vote: 'approve' })
    const flip = await vote(created.id, { vote: 'deny' }) // same '__admin__' voter
    expect(flip.body.status).toBe('denied')
    const votes = (await request(app).get(base + '/approvals/' + created.id + '/votes').set(admin())).body
    expect(votes).toHaveLength(1) // upserted, not appended
    expect(votes[0].vote).toBe('deny')
    // deny with no notes → synthesized reason
    const row = (await request(app).get(base + '/approvals/' + created.id).set(admin())).body
    expect(row.reason).toBe('Denied by __admin__')
  })

  test('voting on a decided approval → 400 "Approval is already <status>"', async () => {
    const created = await mkApproval({ required_approvals: 1 })
    await vote(created.id, { vote: 'deny' })
    const res = await vote(created.id, { vote: 'approve' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Approval is already denied')
  })

  test('invalid vote value → 400; unknown approval → 404', async () => {
    const created = await mkApproval()
    const bad = await vote(created.id, { vote: 'maybe' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('vote must be approve or deny')
    const missing = await vote(999999, { vote: 'approve' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Approval not found')
  })
})

// =============================== GET /approvals/:id/votes ===============================

describe('GET /approvals/:id/votes', () => {
  test('returns vote rows (voter/vote/notes) readable by agents too', async () => {
    const created = await mkApproval({ required_approvals: 2 })
    await vote(created.id, { vote: 'approve', notes: 'lgtm' })
    const res = await request(app).get(base + '/approvals/' + created.id + '/votes').set(agent())
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ approval_id: created.id, voter: '__admin__', vote: 'approve', notes: 'lgtm' })
    expect(res.body[0].created_at).toBeTruthy()
  })

  test('BUG-ish (locked) S9: nonexistent approval → 200 [] (no 404, indistinguishable from "no votes yet")', async () => {
    const res = await request(app).get(base + '/approvals/999999/votes').set(admin())
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})
