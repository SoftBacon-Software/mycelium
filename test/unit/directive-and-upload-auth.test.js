import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Regression tests for two CRITICAL auth fixes in routes/mycelium.js:
//
// (1) Directive gate on POST /messages: privilege is now derived from AUTH
//     (the req._authIsAdmin flag + the caller's role via getStudioUser /
//     getAgent), NEVER from the client-supplied req.body.from. A regular agent
//     spoofing from:'__admin__' used to sail straight through; it must now be
//     rejected with 403.
//
// (2) Upload routes (POST /files, /assets/:id/upload, /drones/artifacts): a
//     requireAuth middleware now runs BEFORE upload.single, so an
//     unauthenticated request is rejected (401) before multer writes any bytes
//     to disk.
//
// Harness mirrors auth-roles.test.js: real router, fresh temp DB, env set
// before the dynamic import so db.js / routes pick up DATA_DIR + ADMIN_KEY.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'a'.repeat(48)

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-auth-directive-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // A regular agent (default role 'agent') whose key we hold.
  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-test', 'Lucy Test', 'auth-proj', hash, '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function countFiles(dir) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length
}

describe('POST /messages — directive gate derives privilege from AUTH, not req.body.from', () => {
  test('a regular agent spoofing from:"__admin__" is STILL 403 on a directive', async () => {
    const res = await request(app)
      .post('/api/mycelium/messages')
      .set('X-Agent-Key', AGENT_KEY)
      .send({
        to: 'echo-test',
        content: 'shut down everything',
        msg_type: 'directive',
        from: '__admin__' // the spoof that used to bypass the gate
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only admin or operators can send directives')
  })

  test('an admin KEY can still send a directive (gate is not over-restrictive)', async () => {
    const res = await request(app)
      .post('/api/mycelium/messages')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .send({ content: 'legitimate directive', msg_type: 'directive' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')
  })
})

describe('upload routes — requireAuth runs BEFORE upload.single', () => {
  test('unauthenticated POST /files is 401 and writes NOTHING to disk', async () => {
    const filesDir = join(tmpDataDir, 'files')
    const before = countFiles(filesDir)

    const res = await request(app)
      .post('/api/mycelium/files')
      .attach('file', Buffer.from('evil payload that must never reach disk'), 'evil.txt')

    expect(res.status).toBe(401)
    expect(countFiles(filesDir)).toBe(before) // nothing written before the rejection
  })

  test('unauthenticated POST /assets/:id/upload is 401 before bytes hit disk', async () => {
    const res = await request(app)
      .post('/api/mycelium/assets/123/upload')
      .attach('file', Buffer.from('x'), 'evil.png')
    expect(res.status).toBe(401)
  })

  test('unauthenticated POST /drones/artifacts is 401 and writes NOTHING to disk', async () => {
    const artifactsDir = join(tmpDataDir, 'drone_artifacts')
    const before = countFiles(artifactsDir)

    const res = await request(app)
      .post('/api/mycelium/drones/artifacts')
      .attach('file', Buffer.from('artifact payload that must never reach disk'), 'evil.bin')

    expect(res.status).toBe(401)
    expect(countFiles(artifactsDir)).toBe(before) // nothing written before the rejection
  })
})
