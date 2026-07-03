import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Regression test for the CRITICAL asset-download path traversal (audit 2026-07-02):
// any AGENT key could store an asset path of '../mycelium.db' and GET
// /assets/:id/download to exfiltrate the entire SQLite DB (Stripe/webhook secrets,
// bcrypt password + agent-key hashes) — because DATA_DIR (the DB's own dir) was in
// the download allowlist alongside its children FILES_DIR + ARTIFACTS_DIR.
// Fix: allowlist ONLY FILES_DIR + ARTIFACTS_DIR (the download containment gate),
// and reject '..'/absolute paths at store time (defense in depth).
// Harness mirrors directive-and-upload-auth.test.js.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'b'.repeat(48)

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-asset-traversal-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-traversal', 'Lucy', 'trav-proj', hash, '["code"]')

  // A canary "secret" living directly in DATA_DIR (mirrors mycelium.db's location).
  writeFileSync(join(tmpDataDir, 'canary-secret.txt'), 'TOP-SECRET-DB-CONTENTS')
  // A legit downloadable file in the allowed FILES_DIR.
  const filesDir = join(tmpDataDir, 'files')
  if (!existsSync(filesDir)) mkdirSync(filesDir, { recursive: true })
  writeFileSync(join(filesDir, 'legit.txt'), 'hello')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('asset download — DATA_DIR path traversal is blocked', () => {
  test('PUT /assets/:id rejects a ../ path at store time (400)', async () => {
    const created = await request(app).post('/api/mycelium/assets')
      .set('X-Agent-Key', AGENT_KEY).send({ name: 'a', status: 'ready' })
    expect(created.status).toBe(200)
    const res = await request(app).put(`/api/mycelium/assets/${created.body.id}`)
      .set('X-Agent-Key', AGENT_KEY).send({ path: '../canary-secret.txt' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid asset path')
  })

  test('POST /assets rejects a ../ path at creation (400)', async () => {
    const res = await request(app).post('/api/mycelium/assets')
      .set('X-Agent-Key', AGENT_KEY).send({ name: 'b', status: 'ready', path: '../canary-secret.txt' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid asset path')
  })

  test('download gate blocks a malicious path stored directly, and leaks NO secret (403)', async () => {
    // Simulate a pre-existing / store-guard-bypassed bad record by writing straight to the DB.
    const id = db.createAsset('evil', 'sprite', 'trav-proj', 'ready', '../canary-secret.txt', '{}', 'lucy-traversal')
    const res = await request(app).get(`/api/mycelium/assets/${id}/download`).set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(403)
    expect(res.text || '').not.toContain('TOP-SECRET')
  })

  test('the real DB (../mycelium.db) is NOT exfiltratable via download (403)', async () => {
    const id = db.createAsset('evil2', 'sprite', 'trav-proj', 'ready', '../mycelium.db', '{}', 'lucy-traversal')
    const res = await request(app).get(`/api/mycelium/assets/${id}/download`).set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(403)
  })

  test('a legit file in FILES_DIR still downloads (200) — fix is not over-restrictive', async () => {
    const id = db.createAsset('good', 'sprite', 'trav-proj', 'ready', 'legit.txt', '{}', 'lucy-traversal')
    const res = await request(app).get(`/api/mycelium/assets/${id}/download`).set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    expect(res.text).toBe('hello')
  })
})
