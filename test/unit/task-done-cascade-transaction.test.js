import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// M4 — the done-cascade (PUT /tasks/:id status=done) must be atomic.
//
// The four DB side-effects — resolveTaskDependencies, updateAsset,
// completeLinkedPlanSteps, resolveMessage — now run inside
// getDB().transaction(...); a mid-cascade throw rolls them ALL back.
// dispatchWorkToIdleAgents runs AFTER commit (it does non-DB SSE dispatch).
//
// We prove rollback with a positive control + a forced failure. Blocker A
// blocks B; completing A unblocks B (resolveTaskDependencies removes A from
// B.blocked_by). With the forced throw, B must STILL be blocked — the unblock
// ran inside the transaction and was rolled back. Without the throw, B is
// unblocked (the control proves update would otherwise have taken effect).
//
// Note: updateTask(task.id, {status:'done'}) runs BEFORE the cascade and is
// NOT in the transaction — on cascade failure the task itself stays 'done'
// while only the downstream cascade side-effects roll back. That is the
// intended boundary; this test asserts the cascade rollback (B's blocked_by).

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

// vi.hoisted so the (hoisted) mock factory can close over a stable mutable flag.
const cascadeMock = vi.hoisted(() => ({ throwOnPlanSteps: false }))

vi.mock('../../server/db.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    completeLinkedPlanSteps: (taskId) => {
      if (cascadeMock.throwOnPlanSteps) throw new Error('cascade-boom')
      return actual.completeLinkedPlanSteps(taskId)
    }
  }
})

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-cascade-tx-'))
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

function blockedByOf(taskId) {
  const t = db.getTask(taskId)
  return JSON.parse(t.blocked_by || '[]')
}

describe('M4: done-cascade transaction atomicity', () => {
  test('positive control — cascade commits, blocked task is unblocked', async () => {
    cascadeMock.throwOnPlanSteps = false
    const proj = 'cascade-proj-pos'
    db.createProject(proj, 'Cascade Pos', '', '', null, 'product')
    const a = db.createTask('Blocker', 'blocks B', proj, 'tester', 'normal', '[]')
    const b = db.createTask('Blocked', 'waiting on A', proj, 'tester', 'normal', '[]')
    db.setTaskDependency(b, a) // b blocked_by a
    expect(blockedByOf(b)).toContain(a)

    const res = await request(app)
      .put('/api/mycelium/tasks/' + a)
      .set(adminHeaders())
      .send({ status: 'done' })

    expect(res.status).toBe(200)
    // resolveTaskDependencies committed → B no longer blocked by A
    expect(blockedByOf(b)).not.toContain(a)
  })

  test('mid-cascade failure rolls back — blocked task stays blocked', async () => {
    cascadeMock.throwOnPlanSteps = true
    const proj = 'cascade-proj-rollback'
    db.createProject(proj, 'Cascade Rollback', '', '', null, 'product')
    const a = db.createTask('Blocker', 'blocks B', proj, 'tester', 'normal', '[]')
    const b = db.createTask('Blocked', 'waiting on A', proj, 'tester', 'normal', '[]')
    db.setTaskDependency(b, a)
    expect(blockedByOf(b)).toContain(a)

    const res = await request(app)
      .put('/api/mycelium/tasks/' + a)
      .set(adminHeaders())
      .send({ status: 'done' })

    // The cascade transaction caught the throw and returned 500
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/Failed to complete task cascade/)
    // resolveTaskDependencies ran inside the tx but was rolled back: B is STILL blocked
    expect(blockedByOf(b)).toContain(a)
  })
})
