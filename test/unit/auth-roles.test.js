import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// Auth-role discipline tests for checkAgentOrAdmin (routes/mycelium.js).
//
// Regression pinned: ANY valid studio JWT used to set req._authIsAdmin = true
// (privilege flattening — a non-admin operator silently became full admin on
// every checkAgentOrAdmin endpoint). The fix mirrors checkAdmin's discipline:
// _authIsAdmin = (user.role === 'admin'). Non-admin studio users still
// authenticate (they are operators) but must NOT carry the admin flag.
//
// Observable contract used here: GET /work/:agentId and the savepoint reads
// gate cross-agent access on req._authIsAdmin — admin sees any agent's data,
// a non-admin caller gets 403 (authenticated, but scoped to self).
//
// Same harness as route-enum-reject-and-reconciliation.test.js: real router,
// fresh temp DB, env set before dynamic import. pool:'forks' isolates us.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY = 'dvk_' + 'a'.repeat(48)

let tmpDataDir
let db
let app

function jwtFor(role, displayName) {
  return jwt.sign(
    { studioUser: true, userId: 999, username: displayName.toLowerCase(), displayName, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-auth-roles-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Two agents: one whose key we hold, one we try to reach cross-agent
  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-test', 'Lucy Test', 'auth-proj', hash, '["code"]')
  db.createAgent('echo-test', 'Echo Test', 'auth-proj', 'no-key-known', '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('checkAgentOrAdmin — admin-role studio JWT', () => {
  test('admin JWT reaches another agent\'s work queue (admin flag carried)', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/echo-test')
      .set('Authorization', 'Bearer ' + jwtFor('admin', 'Greatness'))
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('queue')
  })

  test('admin JWT reads another agent\'s savepoint', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents/echo-test/savepoint')
      .set('Authorization', 'Bearer ' + jwtFor('admin', 'Greatness'))
    expect(res.status).toBe(200)
    expect(res.body.has_savepoint).toBe(false)
  })
})

describe('checkAgentOrAdmin — NON-admin studio JWT (the flattening regression)', () => {
  test('still authenticates: can list agents (operator-scoped access stays)', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
    expect(res.status).toBe(200)
    expect(res.body.map((a) => a.id)).toContain('lucy-test')
  })

  test('does NOT carry the admin flag: cross-agent work queue is 403, not 200', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/echo-test')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
    // 403 (scoped to self), NOT 401 (they did authenticate) and NOT 200 (not admin)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Can only access your own work queue')
  })

  test('does NOT carry the admin flag: cross-agent savepoint read is 403', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents/echo-test/savepoint')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Can only access your own savepoints')
  })
})

describe('checkAgentOrAdmin — agent key path (unchanged)', () => {
  test('agent key reaches its OWN work queue', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/lucy-test')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('queue')
  })

  test('agent key is still denied another agent\'s queue', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/echo-test')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Can only access your own work queue')
  })

  test('invalid agent key is rejected', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/lucy-test')
      .set('X-Agent-Key', 'dvk_' + 'f'.repeat(48))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('admin KEY (X-Admin-Key) still carries the admin flag', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/echo-test')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'm5Max')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('queue')
  })
})
