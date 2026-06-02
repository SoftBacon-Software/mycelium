import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// Behavioral route tests for the A7 changes:
//   1. Illegal status PUT is rejected with a machine-readable reason.
//   2. A LEGAL status PUT still succeeds (no regression).
//   3. The /reconciliation admin route surfaces stuck in_progress records.
//
// We mount the REAL router against a fresh temp DB and a known admin key.
// ADMIN_KEY/JWT_SECRET/DATA_DIR are read at module-eval time, so they MUST be
// set before the dynamic import of db.js + routes/mycelium.js. pool:'forks'
// isolates this file — the live mycelium.db is never touched.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-route-enum-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = 'test-jwt-secret'

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

function admin(req) {
  return req.set('X-Admin-Key', ADMIN_KEY).set('X-Acting-As', 'm5Max')
}

describe('PUT /bugs/:id — reject illegal status with reason', () => {
  test('illegal status -> 400 with code:invalid_enum + allowed-list', async () => {
    const bugId = db.createBug('enum-proj', 'Reject me', 'd', 'bug', 'normal', 'm5Max', 'Lucy')

    const res = await admin(request(app).put(`/api/mycelium/bugs/${bugId}`))
      .send({ status: 'totally-not-a-status' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_enum')
    expect(res.body.field).toBe('status')
    expect(res.body.value).toBe('totally-not-a-status')
    expect(res.body.allowed).toEqual(['open', 'in_progress', 'fixed', 'closed'])
    // Human message preserved for legacy string-matching consumers.
    expect(res.body.error).toContain('status must be one of')

    // Record was NOT mutated by the rejected request.
    expect(db.getBug(bugId).status).toBe('open')
  })

  test('legal status -> 200 and the record actually transitions', async () => {
    const bugId = db.createBug('enum-proj', 'Accept me', 'd', 'bug', 'normal', 'm5Max', 'Lucy')

    const res = await admin(request(app).put(`/api/mycelium/bugs/${bugId}`))
      .send({ status: 'fixed' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(db.getBug(bugId).status).toBe('fixed')
  })

  test('a suspect (terminal -> reopen) transition is ALLOWED (log-warn only, not rejected)', async () => {
    const bugId = db.createBug('enum-proj', 'Reopen me', 'd', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(bugId, { status: 'fixed' })

    const res = await admin(request(app).put(`/api/mycelium/bugs/${bugId}`))
      .send({ status: 'open' })

    // Gradual rollout: questionable transitions are warned, never hard-broken.
    expect(res.status).toBe(200)
    expect(db.getBug(bugId).status).toBe('open')
  })
})

describe('PUT /tasks/:id — illegal status rejected with reason', () => {
  test('illegal status -> 400 invalid_enum; legal one still works', async () => {
    const taskId = db.createTask('Enum task', '', 'enum-proj', 'm5Max', 'normal', '[]')

    const bad = await admin(request(app).put(`/api/mycelium/tasks/${taskId}`))
      .send({ status: 'frobnicated' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('invalid_enum')
    expect(bad.body.allowed).toContain('in_progress')

    const good = await admin(request(app).put(`/api/mycelium/tasks/${taskId}`))
      .send({ status: 'in_progress' })
    expect(good.status).toBe(200)
    expect(db.getTask(taskId).status).toBe('in_progress')
  })
})

describe('GET /reconciliation — A7 read-surface route', () => {
  test('surfaces stuck in_progress records and requires admin', async () => {
    // Unauthenticated -> 401.
    const noauth = await request(app).get('/api/mycelium/reconciliation')
    expect(noauth.status).toBe(401)

    // Seed a stuck bug (in_progress, 30h old).
    const stuckId = db.createBug('recon-route', 'Silent stuck', 'd', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(stuckId, { status: 'in_progress' })
    db.getDB()
      .prepare("UPDATE bugs SET updated_at = datetime('now', '-1800 minutes') WHERE id = ?")
      .run(stuckId)

    const res = await admin(request(app).get('/api/mycelium/reconciliation'))
    expect(res.status).toBe(200)
    expect(res.body.threshold_minutes).toBe(24 * 60)
    expect(res.body.bugs.map((b) => b.id)).toContain(stuckId)
    expect(res.body.counts.total).toBeGreaterThanOrEqual(1)

    // threshold_hours query param is honored.
    const tight = await admin(
      request(app).get('/api/mycelium/reconciliation').query({ threshold_hours: 1 })
    )
    expect(tight.status).toBe(200)
    expect(tight.body.threshold_minutes).toBe(60)
  })
})
