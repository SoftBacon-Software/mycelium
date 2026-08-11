import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Kill-switch behavioral gate.
//
// README.md sells `PUT /admin/override` as a kill switch that "freezes all work
// routing" (README.md:22), and the route's own success message tells the
// operator "All work assignments paused" (admin.js:70). That contract was
// enforced in exactly ONE handler — the DEPRECATED `POST /work/request`
// (mycelium.js) — and was ABSENT from the two paths work actually flows on:
//
//   1. GET /work/:agentId?auto_claim=true  — the live pull-claim path every
//      agent uses since directives were retired (README.md:157).
//   2. dispatchWorkToIdleAgents()          — the auto-assignment the server
//      runs on heartbeat / task-complete (README.md:157: "the assignment IS
//      the dispatch").
//
// So an operator who slammed the kill switch during an incident would watch
// agents keep claiming AND the server keep assigning. This test freezes, then
// proves BOTH vectors stop — and that unfreezing restores them.
//
// Harness mirrors claim-scope-and-spoof-auth.test.js: real router, fresh temp
// DB, env set before the dynamic import so db.js / routes pick up DATA_DIR +
// ADMIN_KEY. The router is mounted exactly as server/index.js mounts it
// (bare, no global freeze middleware) — verified there is no hidden guard.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const CLAIMER_KEY = 'dvk_' + 'c'.repeat(48)   // pull-claim agent (proj-c)
const DISPATCHER_KEY = 'dvk_' + 'd'.repeat(48) // auto-dispatch agent (proj-d)

let tmpDataDir
let db
let app
let claimTask    // assigned to claimer, open  — exercises /work auto-claim
let dispatchTask // unassigned, open, proj-d   — exercises auto-dispatch

// ---- Tracks-reality: derive the live status strings the setter actually
// writes, straight from admin.js source. Hard-coding 'frozen'/'coordinator'
// here would silently desync if someone renames the constant on the SET side
// (admin.js) but forgets the CHECK side (the guard). Pairing each value to its
// action branch makes this robust to reordering; a rename reds this test
// instead of rotting the safety contract. ----
const adminSrc = readFileSync(
  fileURLToPath(new URL('../../server/routes/admin.js', import.meta.url)),
  'utf8'
)
function adminStatusFor(action) {
  // Match `action === '<action>') { ... setInstanceConfig('admin_status', '<val>'`
  // (the call has a 3rd `who` arg, so do NOT require a close-paren after the value).
  const re = new RegExp(
    "action === '" + action + "'\\s*\\)\\s*\\{[\\s\\S]*?" +
    "setInstanceConfig\\('admin_status'\\s*,\\s*'([^']+)'"
  )
  const m = adminSrc.match(re)
  if (!m) {
    throw new Error(
      "test harness: could not find setInstanceConfig('admin_status', ...) " +
      "for action '" + action + "' in admin.js — did the setter change?"
    )
  }
  return m[1]
}
const FROZEN_STATUS = adminStatusFor('freeze')    // 'frozen'
const RUNNING_STATUS = adminStatusFor('unfreeze') // 'coordinator'

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-killswitch-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = 'test-jwt-secret'

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Two agents in two SEPARATE projects so the auto-dispatch loop (which
  // scopes by agent project) cannot cross-contaminate the two vectors.
  const hashC = crypto.createHash('sha256').update(CLAIMER_KEY).digest('hex')
  const hashD = crypto.createHash('sha256').update(DISPATCHER_KEY).digest('hex')
  db.createAgent('claimer', 'Claimer', 'proj-c', hashC, '["code"]')
  db.createAgent('dispatcher', 'Dispatcher', 'proj-d', hashD, '["code"]')

  // /work vector: a task assigned to claimer, open, so it is the top
  // (and only) item in claimer's queue — auto-claim will flip it to in_progress.
  claimTask = db.createTask('claim task', 'desc', 'proj-c', 'admin', 'normal', '[]')
  db.updateTask(claimTask, { assignee: 'claimer', status: 'open' })

  // Auto-dispatch vector: an UNASSIGNED open task in proj-d, the work an idle
  // dispatcher heartbeat will pick up.
  dispatchTask = db.createTask('dispatch task', 'desc', 'proj-d', 'admin', 'normal', '[]')
  db.updateTask(dispatchTask, { assignee: null, status: 'open' })
})

afterAll(() => {
  // Hygiene: leave the instance unfrozen even though the temp DB is discarded.
  try { db.setInstanceConfig('admin_status', RUNNING_STATUS, 'test') } catch {}
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function adminHeaders() {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'tester' }
}
async function freeze() {
  return request(app).put('/api/mycelium/admin/override').set(adminHeaders()).send({ action: 'freeze' })
}
async function unfreeze() {
  return request(app).put('/api/mycelium/admin/override').set(adminHeaders()).send({ action: 'unfreeze' })
}

describe('kill switch freezes the live pull-claim path — GET /work/:agentId', () => {
  test('FROZEN: auto_claim returns 503, serves no queue, and does NOT claim', async () => {
    // Precondition: there IS claimable work (claimTask is open + assigned).
    expect(db.getTask(claimTask).status).toBe('open')

    const fr = await freeze()
    expect(fr.status).toBe(200)
    expect(db.getInstanceConfig('admin_status')).toBe(FROZEN_STATUS) // tracks-reality

    const res = await request(app)
      .get('/api/mycelium/work/claimer?auto_claim=true')
      .set('X-Agent-Key', CLAIMER_KEY)

    // No queue, no claim, 503 — matching README "freezes all work routing".
    expect(res.status).toBe(503)
    expect(res.body.queue).toBeUndefined()
    expect(res.body.claimed).toBeUndefined()

    // BITE-PROPER: a 503 that still claims inside a finally-block would pass a
    // status-only check. Assert the task row is UNCHANGED — not flipped to
    // in_progress, assignee untouched. This is the line that reds on master.
    const after = db.getTask(claimTask)
    expect(after.status).toBe('open')
    expect(after.assignee).toBe('claimer')
  })

  test('UNFROZEN: auto_claim serves the queue and claims again (toggle is real)', async () => {
    const ur = await unfreeze()
    expect(ur.status).toBe(200)
    expect(db.getInstanceConfig('admin_status')).toBe(RUNNING_STATUS) // tracks-reality

    const res = await request(app)
      .get('/api/mycelium/work/claimer?auto_claim=true')
      .set('X-Agent-Key', CLAIMER_KEY)

    // Reverse-bite: unfreezing must restore work serving + claiming. Proves the
    // gate exercises the real toggle, not a hard-coded stub.
    expect(res.status).toBe(200)
    expect(res.body.claimed).toBeTruthy()
    expect(res.body.claimed.id).toBe(claimTask)
    expect(db.getTask(claimTask).status).toBe('in_progress')
  })
})

describe('kill switch freezes auto-dispatch — heartbeat assignment', () => {
  test('CONTROL (unfrozen): an idle heartbeat auto-assigns the unassigned task', async () => {
    await unfreeze()
    expect(db.getTask(dispatchTask).assignee).toBeFalsy() // precondition: unassigned

    const res = await request(app)
      .post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', DISPATCHER_KEY)
      .send({ status: 'idle' })

    expect(res.status).toBe(200)
    // The control proves dispatch WOULD fire in this setup — so "nothing
    // happened" in the frozen case below can only be explained by the freeze.
    expect(res.body.auto_dispatched).toBeDefined()
    expect(res.body.auto_dispatched.length).toBeGreaterThan(0)
    expect(db.getTask(dispatchTask).assignee).toBe('dispatcher')
  })

  test('FROZEN: an idle heartbeat does NOT auto-assign (the leak vector)', async () => {
    // Reset the task to unassigned so there is once again work to dispatch.
    db.updateTask(dispatchTask, { assignee: null, status: 'open' })
    expect(db.getTask(dispatchTask).assignee).toBeFalsy() // reset confirmed

    await freeze()
    expect(db.getInstanceConfig('admin_status')).toBe(FROZEN_STATUS)

    const res = await request(app)
      .post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', DISPATCHER_KEY)
      .send({ status: 'idle' })

    expect(res.status).toBe(200)
    expect(res.body.auto_dispatched).toBeUndefined() // dispatch returned nothing
    // The assignment never happened — the auto-dispatch leak is closed.
    expect(db.getTask(dispatchTask).assignee).toBeFalsy()
  })
})
