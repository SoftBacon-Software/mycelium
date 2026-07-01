import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// H8 — project-scope guards on POST /runs/:id/rerun and PUT /approvals/:id.
//
// IMPORTANT (defense-in-depth): both routes are gated by checkAdminOrOperator /
// checkAdmin, which admit only studio users + admins. checkProjectScope BYPASSES
// whenever req._authAgentId is unset (studio users) or req._authIsAdmin is set
// (admins). So a cross-project 403 is structurally UNREACHABLE through these
// routes' current auth gates — the added lines are defense-in-depth (they fire
// only if the auth gate ever admits an agent). The first two tests therefore
// assert NO-REGRESSION: the added checkProjectScope line evaluates and returns
// true for legitimate callers without breaking rerun/approval. The third test
// exercises the actual enforcement mechanism (checkProjectScope 403-ing a
// cross-project AGENT) via PUT /tasks/:id — the route that DOES admit agents —
// proving the mechanism the two new lines rely on works.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY_B = 'dvk_test_agent_b_key_0123456789abcdef0123456789'
const AGENT_HASH_B = crypto.createHash('sha256').update(AGENT_KEY_B).digest('hex')

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-project-scope-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function adminHeaders() {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'tester' }
}

describe('H8: checkProjectScope on POST /runs/:id/rerun', () => {
  test('no regression — admin/operator can rerun a run (added scope line returns true)', async () => {
    const proj = 'scope-rerun-proj'
    db.createProject(proj, 'Rerun Proj', '', '', null, 'product')
    db.createRun({ id: 'run-scope-1', agent_id: 'agent-x', model: 'm', project_id: proj, brief: 'b', status: 'completed' })

    const res = await request(app)
      .post('/api/mycelium/runs/run-scope-1/rerun')
      .set(adminHeaders())

    // The added checkProjectScope line must not block a legitimate operator rerun
    expect(res.status).toBe(200)
    expect(res.body.id).toBeTruthy()
    expect(res.body.id).not.toBe('run-scope-1')
    expect(res.body.rerun_of).toBe('run-scope-1')
  })
})

describe('H8: checkProjectScope on PUT /approvals/:id', () => {
  test('no regression — admin can approve a pending approval (added scope line returns true)', async () => {
    const proj = 'scope-approval-proj'
    db.createProject(proj, 'Approval Proj', '', '', null, 'product')
    const aid = db.createApproval('deploy', 'Lucy', 'Deploy v1', {}, proj, 'low', 1)
    expect(db.getApproval(aid).status).toBe('pending')

    const res = await request(app)
      .put('/api/mycelium/approvals/' + aid)
      .set(adminHeaders())
      .send({ status: 'approved' })

    // The added checkProjectScope line must not block a legitimate admin approval
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(db.getApproval(aid).status).toBe('approved')
  })
})

describe('H8: checkProjectScope enforcement mechanism (cross-project AGENT → 403)', () => {
  test('an agent scoped to project B is blocked (403) updating a task in project A', async () => {
    db.createProject('scope-proj-a', 'Proj A', '', '', null, 'product')
    db.createProject('scope-proj-b', 'Proj B', '', '', null, 'product')
    db.createAgent('scope-agent-b', 'Agent B', 'scope-proj-b', AGENT_HASH_B, '["code"]')
    const taskA = db.createTask('Task in A', 'belongs to proj A', 'scope-proj-a', 'tester', 'normal', '[]')

    const res = await request(app)
      .put('/api/mycelium/tasks/' + taskA)
      .set('X-Agent-Key', AGENT_KEY_B)
      .send({ status: 'done' })

    // Agent B (project B) acting on project A's resource → project-scope 403.
    // This is the enforcement path the rerun/approval lines mirror.
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toMatch(/project/i)
  })
})
