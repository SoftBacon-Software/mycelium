// Regression test for audit finding S7 (attribution spoof).
//
// PROBLEM: the author of a comment / deliverable used to come straight from
// req.body.author, so any authenticated agent could post UNDER ANOTHER AGENT'S
// NAME. The three affected handlers (task comments, task deliverable, plan-step
// comments) now derive attribution from AUTH: a regular agent's author is
// ALWAYS the authenticated caller (`who`); only ADMIN may set author on behalf
// via req.body.author. This mirrors the pattern already used by the /messages
// directive gate and the task/bug claim handlers (privilege from
// req._authIsAdmin, never the client body).
//
// Harness mirrors test/unit/directive-and-upload-auth.test.js: real router via
// supertest, a fresh temp DATA_DIR + ADMIN_KEY set BEFORE the dynamic import so
// db.js / routes pick them up at module-eval time, and an agent with a real
// SHA-256 key hash.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'a'.repeat(48) // 192-bit machine key, like a real agent
const AGENT_ID = 'lucy-test'
const PROJECT = 'auth-proj'
const SPOOF = 'someone-else' // the name a non-admin tries to impersonate

let tmpDataDir
let app
let taskId
let planId
let stepId

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-attribution-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // A regular agent (default role 'agent', NOT admin) whose key we hold.
  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent(AGENT_ID, 'Lucy Test', PROJECT, hash, '["code"]')

  // Task to attach comments / deliverables to. project_id matches the agent's
  // scope so the plan-step checkProjectScope gate also passes.
  const taskRes = await request(app)
    .post('/api/mycelium/tasks')
    .set('X-Agent-Key', AGENT_KEY)
    .send({ title: 'attribution task', project_id: PROJECT })
  expect(taskRes.status).toBe(200)
  taskId = taskRes.body.id

  // Plan with one inline step; read it back to recover the numeric step id.
  const planRes = await request(app)
    .post('/api/mycelium/plans')
    .set('X-Agent-Key', AGENT_KEY)
    .send({ title: 'attribution plan', project_id: PROJECT, steps: [{ title: 'step one' }] })
  expect(planRes.status).toBe(200)
  planId = planRes.body.id
  const plan = (
    await request(app).get('/api/mycelium/plans/' + planId).set('X-Agent-Key', AGENT_KEY)
  ).body
  stepId = plan.steps[0].id
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Apply admin auth headers to an already-started supertest request (after the
// verb). X-Admin-Key authenticates as admin (sets req._authIsAdmin = true), so
// the body author is honored as "on behalf of".
function adminAuth (req) {
  return req.set('X-Admin-Key', ADMIN_KEY).set('X-Acting-As', 'greatness')
}

describe('POST /tasks/:id/comments — author derives from AUTH, not req.body.author', () => {
  test('a regular agent spoofing author is recorded as the CALLER, not the spoof', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks/' + taskId + '/comments')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ content: 'hi', author: SPOOF })
    expect(res.status).toBe(200)
    expect(res.body.author).toBe(AGENT_ID)
    expect(res.body.author).not.toBe(SPOOF)
  })

  test('an admin KEY can set author on behalf via the body', async () => {
    const res = await adminAuth(
      request(app).post('/api/mycelium/tasks/' + taskId + '/comments')
    ).send({ content: 'on behalf', author: 'on-behalf-name' })
    expect(res.status).toBe(200)
    expect(res.body.author).toBe('on-behalf-name')
  })
})

describe('POST /tasks/:id/deliverable — author derives from AUTH, not req.body.author', () => {
  test('a regular agent spoofing author is recorded as the CALLER, not the spoof', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks/' + taskId + '/deliverable')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ content: 'deliverable body', author: SPOOF })
    expect(res.status).toBe(200)
    expect(res.body.author).toBe(AGENT_ID)
    expect(res.body.author).not.toBe(SPOOF)
  })

  test('an admin KEY can set author on behalf via the body', async () => {
    const res = await adminAuth(
      request(app).post('/api/mycelium/tasks/' + taskId + '/deliverable')
    ).send({ content: 'admin deliverable', author: 'on-behalf-name' })
    expect(res.status).toBe(200)
    expect(res.body.author).toBe('on-behalf-name')
  })
})

describe('POST /plans/:id/steps/:stepId/comments — author derives from AUTH, not req.body.author', () => {
  test('a regular agent spoofing author is recorded as the CALLER, not the spoof', async () => {
    const res = await request(app)
      .post('/api/mycelium/plans/' + planId + '/steps/' + stepId + '/comments')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ content: 'plan comment', author: SPOOF })
    expect(res.status).toBe(200)
    expect(res.body.author).toBe(AGENT_ID)
    expect(res.body.author).not.toBe(SPOOF)
  })

  test('an admin KEY can set author on behalf via the body', async () => {
    const res = await adminAuth(
      request(app).post('/api/mycelium/plans/' + planId + '/steps/' + stepId + '/comments')
    ).send({ content: 'admin plan comment', author: 'on-behalf-name' })
    expect(res.status).toBe(200)
    expect(res.body.author).toBe('on-behalf-name')
  })
})
