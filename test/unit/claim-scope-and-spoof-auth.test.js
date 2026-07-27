import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Regression tests for audit finding S4: the two claim endpoints
//   POST /tasks/:id/claim  and  POST /bugs/:id/claim
// used to (a) accept a claim in ANY project (no project-scope check) and
// (b) let any caller set the assignee to ANOTHER agent via req.body.agent_id
// (assignee spoof).
//
// FIX: both handlers now call checkProjectScope(req, res, resource.project_id,
// resource.assignee) before mutating (403 cross-project, admin passes), and
// derive the assignee from AUTH — a regular agent may only claim for itself
// (the `who` value); only admin may assign on behalf via req.body.agent_id.
// (Mirrors the POST /messages directive gate: privilege from req._authIsAdmin,
// never from client-supplied body fields.)
//
// Harness mirrors directive-and-upload-auth.test.js: real router, fresh temp DB,
// env set before the dynamic import so db.js / routes pick up DATA_DIR + ADMIN_KEY.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const ALICE_KEY = 'dvk_' + 'a'.repeat(48) // regular agent in proj-a
const BOB_KEY = 'dvk_' + 'b'.repeat(48) // regular agent in proj-b (unused key, just exists)

let tmpDataDir
let db
let app

// Resources, created in beforeAll so each test owns a distinct row (no
// cross-test state interference).
let taskXproj, bugXproj // in proj-b — for cross-project 403
let taskSpoof, bugSpoof // in proj-a — for the assignee-spoof guard
let taskAdmin, bugAdmin // in proj-a — for the admin-assign-on-behalf override
let taskHappy, bugHappy // in proj-a — for the same-project happy path

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-auth-claim-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Two regular agents in two different projects.
  const hashA = crypto.createHash('sha256').update(ALICE_KEY).digest('hex')
  const hashB = crypto.createHash('sha256').update(BOB_KEY).digest('hex')
  db.createAgent('alice', 'Alice', 'proj-a', hashA, '["code"]')
  db.createAgent('bob', 'Bob', 'proj-b', hashB, '["code"]')

  // Tasks + bugs in each project. createTask(title, desc, projectId, requester, priority, tags);
  // createBug(projectId, title, desc, category, severity, reporter, assignee, diagnosticData).
  taskXproj = db.createTask('task in B', 'desc', 'proj-b', 'admin', 'normal', '[]')
  bugXproj = db.createBug('proj-b', 'bug in B', 'desc', 'other', 'normal', 'admin', null, null)
  taskSpoof = db.createTask('task spoof', 'desc', 'proj-a', 'admin', 'normal', '[]')
  bugSpoof = db.createBug('proj-a', 'bug spoof', 'desc', 'other', 'normal', 'admin', null, null)
  taskAdmin = db.createTask('task admin', 'desc', 'proj-a', 'admin', 'normal', '[]')
  bugAdmin = db.createBug('proj-a', 'bug admin', 'desc', 'other', 'normal', 'admin', null, null)
  taskHappy = db.createTask('task happy', 'desc', 'proj-a', 'admin', 'normal', '[]')
  bugHappy = db.createBug('proj-a', 'bug happy', 'desc', 'other', 'normal', 'admin', null, null)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('(a) project scope — a cross-project claim is 403 and does NOT assign', () => {
  test('alice (proj-a) cannot claim a task in proj-b', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks/' + taskXproj + '/claim')
      .set('X-Agent-Key', ALICE_KEY)
    expect(res.status).toBe(403)
    // The claim must not have mutated the task — alice is not the assignee.
    expect(db.getTask(taskXproj).assignee).not.toBe('alice')
  })

  test('alice (proj-a) cannot claim a bug in proj-b', async () => {
    const res = await request(app)
      .post('/api/mycelium/bugs/' + bugXproj + '/claim')
      .set('X-Agent-Key', ALICE_KEY)
    expect(res.status).toBe(403)
    expect(db.getBug(bugXproj).assignee).not.toBe('alice')
  })
})

describe('(b) assignee spoof — a regular agent passing agent_id is assigned to ITSELF', () => {
  test('task claim: agent_id:"someone-else" is ignored; assignee is the caller', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks/' + taskSpoof + '/claim')
      .set('X-Agent-Key', ALICE_KEY)
      .send({ agent_id: 'someone-else' }) // the spoof that used to assign someone-else
    expect(res.status).toBe(200)
    expect(res.body.assignee).toBe('alice') // the caller, NOT 'someone-else'
    expect(res.body.assignee).not.toBe('someone-else')
    expect(db.getTask(taskSpoof).assignee).toBe('alice')
  })

  test('bug claim: same spoof guard', async () => {
    const res = await request(app)
      .post('/api/mycelium/bugs/' + bugSpoof + '/claim')
      .set('X-Agent-Key', ALICE_KEY)
      .send({ agent_id: 'someone-else' })
    expect(res.status).toBe(200)
    expect(res.body.assignee).toBe('alice')
    expect(res.body.assignee).not.toBe('someone-else')
    expect(db.getBug(bugSpoof).assignee).toBe('alice')
  })
})

describe('(c) admin CAN assign on behalf of another agent via agent_id', () => {
  test('task claim: admin passing agent_id assigns that agent', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks/' + taskAdmin + '/claim')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .send({ agent_id: 'carol' })
    expect(res.status).toBe(200)
    expect(res.body.assignee).toBe('carol') // admin-assigned, not the admin's own id
    expect(db.getTask(taskAdmin).assignee).toBe('carol')
  })

  test('bug claim: admin passing agent_id assigns that agent', async () => {
    const res = await request(app)
      .post('/api/mycelium/bugs/' + bugAdmin + '/claim')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .send({ agent_id: 'carol' })
    expect(res.status).toBe(200)
    expect(res.body.assignee).toBe('carol')
    expect(db.getBug(bugAdmin).assignee).toBe('carol')
  })
})

describe('(d) a normal same-project claim still succeeds', () => {
  test('task claim: alice claims a proj-a task, no agent_id', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks/' + taskHappy + '/claim')
      .set('X-Agent-Key', ALICE_KEY)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(res.body.assignee).toBe('alice')
  })

  test('bug claim: alice claims a proj-a bug, no agent_id', async () => {
    const res = await request(app)
      .post('/api/mycelium/bugs/' + bugHappy + '/claim')
      .set('X-Agent-Key', ALICE_KEY)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(res.body.assignee).toBe('alice')
  })
})
