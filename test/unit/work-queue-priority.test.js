import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pins the core dispatch contract: the order `buildWorkQueue` hands every agent
// its next item in. This ordering is the platform's heart — it decides what each
// agent works on next — and it had ZERO coverage before this file. The comment
// at server/db.js L608 records why that gap is dangerous: a bare directive a
// worker couldn't close once re-claimed ~170x/sec, flooded the events table to
// 18M rows / 3GB, and pegged the server. A regression in this exact function is
// the class of bug a pinning test catches.
//
// Documented /work priority ladder (README §Auto-coordination), as ACTUALLY
// implemented by buildWorkQueue in server/db.js:
//   1  request                (respond before new work)
//   2  plan_step in_progress  (assigned to this agent)
//   3  plan_step pending      (assigned + every earlier step completed)
//   4  task in_progress
//   5  task open
//   6  bug assigned
//   7  plan_step_unassigned   (pending, unassigned, every earlier step completed)
//   8  bug_unassigned         (planner-triage tier; README omits this 8th rung)
// Directives are `void`-ed at db.js L616 and NEVER appear in the queue, no matter
// what is passed in. This test seeds exactly one item per tier 1–7, plus (a) a
// directive message and (b) an assigned plan step whose priors are NOT complete,
// and asserts both stay out of the queue.
//
// Same temp-DB pattern as the other db-*.test.js unit tests: db.js reads DATA_DIR
// at module-eval time, so set it before the dynamic import. pool:'forks' isolates
// this file's module state. initDB() writes only to the temp DATA_DIR. The fixture
// is seeded ONCE in beforeAll; buildWorkQueue is pure, so each test re-derives the
// queue from the shared inputs.

let tmpDataDir
let db
let fx

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-workqueue-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
  fx = seedFixture()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Seed one fixture agent + exactly one item per priority tier, plus the two
// items that must be EXCLUDED (a voided directive + a priors-incomplete step).
// Returns the gathered inputs and the expected ordered id ladder so the
// assertions stay in sync with the seed.
function seedFixture() {
  const AGENT = 'wq-agent'
  const PROJECT = 'wq-project'
  db.createAgent(AGENT, 'WorkQueue Test Agent', PROJECT, 'apikeyhash-wq', '[]')

  // --- Plan A: assigned plan steps (tiers 2 + 3, plus the gated-out one) ---
  const planA = db.createPlan('Plan A', '', PROJECT, AGENT, 'normal', '[]', 'tester')
  const stepA0 = db.createPlanStep(planA, 'A0 completed prior', '', AGENT, '')   // order 0 — completed, never offered
  db.updatePlanStep(stepA0, { status: 'completed' })
  const stepA1 = db.createPlanStep(planA, 'A1 pending ready', '', AGENT, '')     // order 1 — prior A0 done → tier 3
  const stepA2 = db.createPlanStep(planA, 'A2 pending gated', '', AGENT, '')     // order 2 — prior A1 NOT done → gated out
  const stepA3 = db.createPlanStep(planA, 'A3 in progress', '', AGENT, '')       // order 3 — in_progress → tier 2
  db.updatePlanStep(stepA3, { status: 'in_progress' })

  // --- Plan B: an unassigned, ready plan step in the agent's project (tier 7) ---
  const planB = db.createPlan('Plan B', '', PROJECT, AGENT, 'normal', '[]', 'tester')
  const stepB0 = db.createPlanStep(planB, 'B0 completed prior', '', null, '')    // order 0 — completed prior
  db.updatePlanStep(stepB0, { status: 'completed' })
  const stepB1 = db.createPlanStep(planB, 'B1 unassigned ready', '', null, '')   // order 1 — unassigned + ready → tier 7

  // --- Tasks (tiers 4 + 5) ---
  // createTask's 4th arg is requester, NOT assignee — it sets no assignee. Assign
  // via updateTask (mirroring db-tasks.test.js) so the /work handler's
  // `WHERE assignee = ?` filter actually returns them.
  const taskInProg = db.createTask('wq in-progress task', '', PROJECT, AGENT, 'normal', '[]')
  db.updateTask(taskInProg, { assignee: AGENT, status: 'in_progress' })
  const taskOpen = db.createTask('wq open task', '', PROJECT, AGENT, 'normal', '[]') // default status 'open'
  db.updateTask(taskOpen, { assignee: AGENT }) // stays 'open' → tier 5

  // --- Bug (tier 6) ---
  const bugAssigned = db.createBug(PROJECT, 'wq assigned bug', '', 'logic', 'high', 'tester', AGENT, null)

  // --- Request (tier 1) ---
  const req = db.createRequest('requester', AGENT, null, PROJECT, 'please respond', '{}')

  // --- Directive (must be EXCLUDED — voided at db.js L616) ---
  const directive = db.createMessage('boss', AGENT, null, PROJECT, 'do the thing', '{}', 'directive', null, 'urgent')

  // Gather inputs through the SAME query path the /work handler uses
  // (server/routes/mycelium.js L1267–1287), so the shapes fed to buildWorkQueue
  // are exactly what production feeds it.
  const liveDB = db.getDB()
  const inputs = {
    directives: liveDB
      .prepare("SELECT * FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC")
      .all(AGENT),
    requests: db.listPendingRequests(AGENT),
    tasks: liveDB
      .prepare("SELECT * FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC")
      .all(AGENT),
    bugs: db.listBugs({ status: 'open', limit: 20 }),
    plans: db.listPlans({ project_id: PROJECT, limit: 20 }),
  }

  return {
    AGENT, PROJECT, inputs,
    ids: {
      request: req,
      stepInProgress: stepA3,
      stepPendingReady: stepA1,
      stepPendingGated: stepA2,
      taskInProg, taskOpen, bugAssigned,
      stepUnassigned: stepB1,
      directive,
    },
    // Expected queue order, top first.
    ladder: [
      { priority: 1, type: 'request', id: req },
      { priority: 2, type: 'plan_step', id: stepA3 },
      { priority: 3, type: 'plan_step', id: stepA1 },
      { priority: 4, type: 'task', id: taskInProg },
      { priority: 5, type: 'task', id: taskOpen },
      { priority: 6, type: 'bug', id: bugAssigned },
      { priority: 7, type: 'plan_step_unassigned', id: stepB1 },
    ],
  }
}

function queue() {
  return db.buildWorkQueue(fx.AGENT, fx.PROJECT, fx.inputs.directives, fx.inputs.requests, fx.inputs.tasks, fx.inputs.bugs, fx.inputs.plans)
}

describe('buildWorkQueue — /work agent-queue priority ordering', () => {
  test('returns the documented tier ladder, sorted by priority ascending', () => {
    const q = queue()

    // One item per tier 1–7 — no more, no less.
    expect(q).toHaveLength(fx.ladder.length)

    // The exact documented ladder, in order.
    expect(q.map((item) => item.priority)).toEqual([1, 2, 3, 4, 5, 6, 7])

    // Each item lands in its tier, top first.
    fx.ladder.forEach((rung, i) => {
      expect(q[i]).toMatchObject({ priority: rung.priority, type: rung.type, id: rung.id })
    })

    // Sort invariant, checked independently of the exact ladder.
    for (let i = 1; i < q.length; i++) {
      expect(q[i].priority).toBeGreaterThanOrEqual(q[i - 1].priority)
    }
  })

  test('directives passed in are voided and never reach the queue', () => {
    // Prove the directive was genuinely gathered and handed to buildWorkQueue.
    expect(fx.inputs.directives).toHaveLength(1)
    expect(fx.inputs.directives[0].id).toBe(fx.ids.directive)

    const q = queue()

    // buildWorkQueue voids directives (db.js L616) and never emits a 'directive'
    // item. Ids overlap across item TYPES (messages, tasks, plan_steps each
    // autoincrement from 1), so the robust invariant is the type, not a bare id.
    expect(q.filter((item) => item.type === 'directive')).toHaveLength(0)
  })

  test('an assigned plan step whose priors are incomplete is gated out', () => {
    const q = queue()

    // stepA2 (order 2) is pending + assigned, but its prior stepA1 (order 1) is
    // still pending → _planPriorsComplete is false → it must not appear.
    expect(q.find((item) => item.type === 'plan_step' && item.id === fx.ids.stepPendingGated)).toBeUndefined()
    // Sanity: its ready sibling (stepA1) DOES appear, so the gate is what excluded it.
    expect(q.find((item) => item.type === 'plan_step' && item.id === fx.ids.stepPendingReady)).toBeDefined()
  })
})
