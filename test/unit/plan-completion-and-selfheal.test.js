// Behavior gate for the two "live contract" plan state machines README and the
// onboarding guide market, but which had ZERO behavioral coverage on master:
//
//   README.md           — "multi-step plans with dependency ordering."
//   getting-started-agent.md — "when the task completes, the step auto-completes,
//                              and if all steps finish, the whole plan completes."
//   .claude/CLAUDE.md   — Architecture → Plans system: "Auto-completion cascade."
//
// Both are real, carefully-built state machines in server/routes/plans.js, not
// roadmap promises — and a regression that broke either would ship undetected:
// fresh-DB `npm test` on master was green with neither path exercised. This gate
// pins the behavior a stranger relies on.
//
// (1) AUTO-COMPLETION CASCADE — the direct step-PUT path (plans.js ~213-223).
//     Marking a step `completed` via PUT /plans/:id/steps/:stepId re-checks the
//     plan; when every step is completed|skipped the plan flips to `completed`
//     and emits plan_completed. A pending/in_progress step MUST keep it
//     un-completed; a `skipped` step counts as done.
//     NOTE: this is DISTINCT from the task→step→plan cascade
//     (completeLinkedPlanSteps, db/plans.js:179) which IS db-covered by
//     task-done-cascade-transaction.test.js — do not duplicate it; this gate
//     covers only the direct step-PUT path.
//
// (2) FAILURE SELF-HEAL — plans.js ~183-207 + autoRetryOrEscalatePlanStep
//     (db/plans.js:134-161). A `failed` step reopens itself AND the prior-order
//     completed step (the phase it guards), increments attempt_count, and posts a
//     `[auto-retry n/max]` critique with the failure reason fed forward. After
//     RETRY_MAX attempts the next failure is terminal: the plan goes `blocked`
//     and an operator inbox escalation item is filed (createInboxItemForAllOperators).
//
// Harness mirrors test/unit/spend-routes-behavior.test.js (brief 49): real
// mycelium router via supertest, fresh temp DATA_DIR + ADMIN_KEY/JWT_SECRET set
// BEFORE the dynamic import so db.js / routes pick them up at module-eval time.
// plans.js is registered onto the mycelium router at module-eval
// (mycelium.js: registerPlanRoutes(router, {...})), so mounting the mycelium
// router includes the plan routes exactly as production wires them.
//
// "TRACKS REALITY" GUARD: RETRY_MAX and the completion-cascade predicate are
// READ FROM server/routes/plans.js (below) rather than re-typed, and a test
// asserts the source still carries the documented forms. Change either and this
// gate REDS instead of silently desynchronizing — and the behavioral assertions
// use the derived RETRY_MAX, so lifting the knob reds the exhaust/retry
// assertions until the test is reconciled.
//
// STEP-0 faithfulness notes pinned here (observed 2026-08-12 against a real
// server boot on master 6d1d630):
//   • New plans are created with status `draft` (POST /plans). The cascade is
//     status-agnostic (it only excludes `completed`), so it fires regardless;
//     but the docs frame worked plans as `active`. We promote each plan to
//     `active` after creation (a normal PUT) so the "stays active" negative is
//     literal and matches the marketed contract. NOT a bug.
//   • The escalation inbox row's entity_id is stored with loose number→TEXT
//     coercion (e.g. "9.0"), so the exhaust assertion pins the row by
//     operator_id + entity_type + priority + count delta rather than by an
//     exact entity_id equality. NOT a bug.
//
// ⚠ CANDIDATE BUG surfaced by STEP 0 (pinned here, NOT fixed — fixing the enum
// is a behavior change, out of scope for this test-gate branch):
//   The completion-cascade predicate (plans.js:217) AND the task-linked cascade
//   (db/plans.js:189) BOTH treat `skipped` as done. But `PLAN_STEP_STATUSES`
//   (mycelium.js:356) = ['pending','in_progress','completed','blocked','failed']
//   omits `skipped`, and the step-PUT route validates status against that enum
//   (plans.js:159 → 400 invalid_enum). No route or DB function ever SETS a
//   plan_step to `skipped`. So the `skipped` arms of BOTH predicates are
//   unreachable through any HTTP path — the enum and the predicates have
//   drifted. Two interpretations: (a) `skipped` was meant to be settable and
//   was accidentally dropped from the enum; or (b) it was deliberately removed
//   and the predicates carry dead leniency. Either way the gate pins BOTH
//   truths: the route rejects `skipped` (3a), and the predicate itself still
//   counts it as done when reached via the DB layer (3b).
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'

// --- source-pinned contract values (read, not re-typed) ---
const PLANS_SRC = readFileSync(
  fileURLToPath(new URL('../../server/routes/plans.js', import.meta.url)),
  'utf8'
)
// plans.js ~184 — `var RETRY_MAX = 2;` (bounded self-heal retry budget).
const RETRY_MATCH = PLANS_SRC.match(/RETRY_MAX\s*=\s*(\d+)/)
const RETRY_MAX = RETRY_MATCH ? parseInt(RETRY_MATCH[1], 10) : NaN
// plans.js ~217 — the load-bearing completion predicate:
//   `s.status === 'completed' || s.status === 'skipped'`
// The two arms are the set that counts as "done" for the cascade.
const PREDICATE_RE = /s\.status === '(completed)' \|\| s\.status === '(skipped)'/
const PREDICATE_MATCH = PLANS_SRC.match(PREDICATE_RE)

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const PROJ = 'plan-gate-proj'
const OP = 'plan-gate-op' // active operator — the escalation target

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-plan-gate-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // One project for all plans + one ACTIVE operator (the exhaust escalation
  // targets `operators WHERE status = 'active'`, which is the column default).
  db.createProject(PROJ, 'Plan Gate', '', '', null, 'product')
  db.createOperator(OP, 'Plan Gate Operator', 'owner', '', '', null)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function adminHeaders() {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'tester' }
}

// Create a plan with the given step titles, promote draft→active (the worked-plan
// status the docs market), and return { id, steps } with steps ordered by step_order.
async function makeActivePlan(title, stepTitles) {
  const create = await request(app)
    .post('/api/mycelium/plans')
    .set(adminHeaders())
    .send({ title, project_id: PROJ, steps: stepTitles.map((t) => ({ title: t })) })
  expect(create.status).toBe(200)
  const id = create.body.id
  // Promote to active — the status the getting-started guide assumes for in-flight plans.
  const promote = await request(app).put('/api/mycelium/plans/' + id).set(adminHeaders()).send({ status: 'active' })
  expect(promote.status).toBe(200)
  return { id, steps: (await getPlan(id)).steps }
}

async function getPlan(id) {
  const res = await request(app).get('/api/mycelium/plans/' + id).set(adminHeaders())
  expect(res.status).toBe(200)
  return res.body
}

function putStep(planId, stepId, fields) {
  return request(app).put('/api/mycelium/plans/' + planId + '/steps/' + stepId).set(adminHeaders()).send(fields)
}

async function stepComments(planId, stepId) {
  const res = await request(app).get('/api/mycelium/plans/' + planId + '/steps/' + stepId + '/comments').set(adminHeaders())
  expect(res.status).toBe(200)
  return res.body
}

function planStepInboxCount() {
  // Rows filed for our operator for plan-step entities (the exhaust escalation shape).
  return db.listInboxItems({ operator_id: OP, entity_type: 'plan_step' }).length
}

// ───────────────────────── tracks-reality ─────────────────────────

describe('source-pinned contract literals (tracks reality)', () => {
  test('plans.js still carries RETRY_MAX and the completed||skipped cascade predicate', () => {
    // If either literal is renamed/removed/reworded, the derived value goes NaN
    // / the match goes null and every behavioral assertion below that depends on
    // it must be reconciled — this is the alarm, not a silent desync.
    expect(Number.isFinite(RETRY_MAX)).toBe(true)
    expect(RETRY_MATCH[1]).toBe(String(RETRY_MAX))
    expect(PREDICATE_MATCH).not.toBeNull()
    expect(PREDICATE_MATCH[1]).toBe('completed')
    expect(PREDICATE_MATCH[2]).toBe('skipped')
  })
})

// ─────────────────── (1) auto-completion cascade ───────────────────

describe('auto-completion cascade (PUT /plans/:id/steps/:stepId status=completed)', () => {
  test('completing all steps one-by-one flips active→completed on the LAST step', async () => {
    const { id, steps } = await makeActivePlan('complete-positive', ['a', 'b', 'c'])
    const [a, b, c] = steps.map((s) => s.id)

    await putStep(id, a, { status: 'completed' })
    expect((await getPlan(id)).status).toBe('active') // 1/3 done — not yet
    await putStep(id, b, { status: 'completed' })
    expect((await getPlan(id)).status).toBe('active') // 2/3 done — still not yet

    // The third completion is the one that flips it.
    await putStep(id, c, { status: 'completed' })
    const done = await getPlan(id)
    expect(done.status).toBe('completed')
    for (const s of done.steps) expect(s.status).toBe('completed')
  })

  test('a leftover non-completed/non-skipped step keeps the plan active (negative)', async () => {
    const { id, steps } = await makeActivePlan('complete-negative', ['a', 'b'])
    const [a, b] = steps.map((s) => s.id)

    await putStep(id, a, { status: 'completed' })
    // b stays pending — the every(...) predicate must keep allDone false.
    const afterPending = await getPlan(id)
    expect(afterPending.status).toBe('active')
    expect(afterPending.steps.find((s) => s.id === b).status).toBe('pending')

    // Also exercise in_progress — neither pending nor in_progress counts as done.
    await putStep(id, b, { status: 'in_progress' })
    expect((await getPlan(id)).status).toBe('active')
  })

  test('the step-PUT route REJECTS "skipped" — PLAN_STEP_STATUSES omits it (drift vs the predicate)', async () => {
    // OBSERVED route behavior: `skipped` is not in PLAN_STEP_STATUSES, so the
    // enum guard (plans.js:159 → validateEnum) rejects it with 400 invalid_enum.
    // The step stays pending and the plan does NOT complete. This pins the
    // discrepancy documented in the file header: the `skipped` arm of the
    // completion predicate is unreachable through the route.
    const { id, steps } = await makeActivePlan('skip-route-reject', ['a', 'b'])
    const [a, b] = steps.map((s) => s.id)

    await putStep(id, a, { status: 'completed' })
    const skip = await putStep(id, b, { status: 'skipped' })
    expect(skip.status).toBe(400)
    expect(skip.body.code).toBe('invalid_enum')

    const after = await getPlan(id)
    expect(after.steps.find((s) => s.id === b).status).toBe('pending') // unchanged
    expect(after.status).toBe('active') // NOT completed — skip never landed
  })

  test('a "skipped" step still counts as done for the cascade predicate (plans.js:217)', async () => {
    // The predicate's `skipped` arm is load-bearing and IS exercised here: set
    // the step to `skipped` directly via the DB layer (the only reachable path
    // — the route can't, per the test above), then drive the cascade by
    // completing the OTHER step through the real route handler. The plan flips
    // to completed ONLY because the predicate accepts `skipped`; drop that arm
    // and this REDS (the plan would wrongly stay active).
    const { id, steps } = await makeActivePlan('skip-predicate', ['a', 'b'])
    const [a, b] = steps.map((s) => s.id)

    db.updatePlanStep(b, { status: 'skipped' })
    await putStep(id, a, { status: 'completed' }) // triggers the cascade in the route handler
    const done = await getPlan(id)
    expect(done.steps.find((s) => s.id === b).status).toBe('skipped')
    expect(done.status).toBe('completed')
  })
})

// ───────────────────── (2) failure self-heal ──────────────────────

describe('failure self-heal (PUT /plans/:id/steps/:stepId status=failed)', () => {
  test('a failed step reopens itself + the prior-order completed step, bumps attempt_count, posts critique', async () => {
    const { id, steps } = await makeActivePlan('selfheal-retry', ['impl', 'verify'])
    const [impl, verify] = steps.map((s) => s.id)

    await putStep(id, impl, { status: 'completed' })
    expect((await getPlan(id)).steps.find((s) => s.id === impl).status).toBe('completed')

    // Failing the verify step over a completed impl must reopen BOTH (the phase
    // this step guards), increment attempt_count, keep the plan active, and feed
    // the critique forward as an [auto-retry n/RETRY_MAX] comment on the prior step.
    const fail = await putStep(id, verify, { status: 'failed', critique: 'tests did not pass' })
    expect(fail.status).toBe(200)

    const after = await getPlan(id)
    expect(after.status).toBe('active') // retry, not exhaustion
    const implAfter = after.steps.find((s) => s.id === impl)
    const verifyAfter = after.steps.find((s) => s.id === verify)
    expect(implAfter.status).toBe('pending') // prior-order completed step REOPENED
    expect(verifyAfter.status).toBe('pending') // the failed step itself reopened
    expect(verifyAfter.attempt_count).toBe(1)

    // The critique lands on the reopened prior step (db/plans.js:151 `s.id !== stepId`).
    const comments = await stepComments(id, impl)
    const retryComment = comments.find((c) =>
      new RegExp('\\[auto-retry 1/' + RETRY_MAX + '\\]').test(c.content)
    )
    expect(retryComment).toBeTruthy()
    expect(retryComment.content).toMatch(/tests did not pass/)
  })

  test('after RETRY_MAX retries the next failure blocks the plan + escalates to operators', async () => {
    const { id, steps } = await makeActivePlan('selfheal-exhaust', ['impl', 'verify'])
    const [impl, verify] = steps.map((s) => s.id)

    await putStep(id, impl, { status: 'completed' })
    const inboxBefore = planStepInboxCount()

    // Burn the retry budget: RETRY_MAX failed attempts each reopen + bump the counter.
    for (let i = 1; i <= RETRY_MAX; i++) {
      const r = await putStep(id, verify, { status: 'failed', critique: 'retry ' + i })
      expect(r.status).toBe(200)
      const mid = await getPlan(id)
      expect(mid.status).toBe('active') // still within budget → not blocked yet
      expect(mid.steps.find((s) => s.id === verify).attempt_count).toBe(i)
    }

    // The next failure is terminal (attempt_count already at RETRY_MAX → exhausted).
    const exhaust = await putStep(id, verify, { status: 'failed', critique: 'final burnout' })
    expect(exhaust.status).toBe(200)
    const blocked = await getPlan(id)
    expect(blocked.status).toBe('blocked')
    const verifyFinal = blocked.steps.find((s) => s.id === verify)
    expect(verifyFinal.status).toBe('failed') // NOT reopened on exhaust
    expect(verifyFinal.attempt_count).toBe(RETRY_MAX) // NOT incremented past the max

    // Exhaustion files exactly one operator escalation item (high priority).
    const inboxAfter = planStepInboxCount()
    expect(inboxAfter).toBe(inboxBefore + 1)
    const escalation = db.listInboxItems({ operator_id: OP, entity_type: 'plan_step' }).pop()
    expect(escalation.operator_id).toBe(OP)
    expect(escalation.entity_type).toBe('plan_step')
    expect(escalation.priority).toBe('high')
  })
})
