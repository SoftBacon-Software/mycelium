import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Regression test for task 177 (files-TTL sweeper must not sweep assets):
// the 24h TTL sweeper readdir'd FILES_DIR ROOT — the directory SHARED with the
// assets surface (POST /assets/:id/upload stores through the same multer
// storage, mycelium.js:79). Any asset file older than 24h was deleted from
// disk while its DB row survived as status=ready. That already happened on
// jetson01 (read-only census 2026-09-09): server/data/files/ holds ZERO files
// while all 13 assets rows point into it (rows 8-13 uploaded to that very dir
// Jul 6-23; the dir's own mtime 2026-07-24 17:31 is the last deletion burst).
// Every /assets/:id/download has been failing ever since.
//
// Contract pinned here:
//   1. a files-surface upload lands in FILES_DIR/uploads, NOT the shared root
//   2. the TTL sweep deletes ONLY aged files inside FILES_DIR/uploads
//   3. an aged asset file in FILES_DIR root SURVIVES the sweep and its
//      /assets/:id/download still serves afterwards
//   4. asset files in the root never leak into GET /files (the files listing)

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'c'.repeat(48)
const TTL_MS = 24 * 60 * 60 * 1000
const AGE_MS = 25 * 60 * 60 * 1000 // past the TTL

const state = {}
let tmpDataDir
let app
let sweepExpiredFiles
let filesDir
let uploadsDir
let assetId

function ageFile(p, ageMs) {
  const t = new Date(Date.now() - ageMs)
  utimesSync(p, t, t)
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-files-ttl-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  let filesModule = {}
  try {
    filesModule = await import('../../server/routes/files.js')
  } catch { /* surfaced by the assertions below */ }
  sweepExpiredFiles = filesModule.sweepExpiredFiles

  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-ttl-scope', 'Lucy', 'ttl-scope-proj', hash, '["code"]')

  filesDir = join(tmpDataDir, 'files')
  uploadsDir = join(filesDir, 'uploads')
  mkdirSync(uploadsDir, { recursive: true })

  // The victim class: an ASSET file in the shared root, aged past the TTL,
  // with a DB row pointing at it exactly like POST /assets/:id/upload leaves one.
  writeFileSync(join(filesDir, 'aged_asset.png'), 'asset-bytes')
  ageFile(join(filesDir, 'aged_asset.png'), AGE_MS)
  const created = await request(app).post('/api/mycelium/assets')
    .set('X-Agent-Key', AGENT_KEY)
    .send({ name: 'aged asset', status: 'ready', path: 'aged_asset.png' })
  expect(created.status).toBe(200)
  assetId = created.body.id

  // A files-surface upload, aged past the TTL, parked where uploads land.
  writeFileSync(join(uploadsDir, 'aged_upload.txt'), 'temp-bytes')
  ageFile(join(uploadsDir, 'aged_upload.txt'), AGE_MS)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('files TTL sweeper is scoped to the files surface', () => {
  test('files-surface upload lands in FILES_DIR/uploads, not the shared root', async () => {
    expect(typeof sweepExpiredFiles).toBe('function')
    const res = await request(app).post('/api/mycelium/files')
      .set('X-Agent-Key', AGENT_KEY)
      .attach('file', Buffer.from('fresh-bytes'), { filename: 'fresh.png', contentType: 'image/png' })
    expect(res.status).toBe(200)
    expect(res.body.filename).toBeTruthy()
    state.freshFilename = res.body.filename
    expect(existsSync(join(uploadsDir, state.freshFilename))).toBe(true)
    expect(existsSync(join(filesDir, state.freshFilename))).toBe(false)
  })

  test('TTL sweep deletes aged uploads but never the aged asset file in the root', async () => {
    // download works BEFORE the sweep
    const before = await request(app).get(`/api/mycelium/assets/${assetId}/download`)
      .set('X-Agent-Key', AGENT_KEY)
    expect(before.status).toBe(200)
    expect(String(before.body)).toBe('asset-bytes')

    const removed = sweepExpiredFiles({ dir: uploadsDir, ttlMs: TTL_MS })
    expect(Array.isArray(removed)).toBe(true)
    expect(removed).toContain('aged_upload.txt')
    expect(existsSync(join(uploadsDir, 'aged_upload.txt'))).toBe(false)

    // the fresh files-surface upload survives its own surface's sweep
    expect(existsSync(join(uploadsDir, state.freshFilename))).toBe(true)

    // THE regression: the aged asset file in the shared root survives
    expect(existsSync(join(filesDir, 'aged_asset.png'))).toBe(true)
    const after = await request(app).get(`/api/mycelium/assets/${assetId}/download`)
      .set('X-Agent-Key', AGENT_KEY)
    expect(after.status).toBe(200)
    expect(String(after.body)).toBe('asset-bytes')
  })

  test('asset files in the root never leak into the files listing', async () => {
    const res = await request(app).get('/api/mycelium/files').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    const names = (res.body || []).map(function (f) { return f.filename })
    expect(names).toContain(state.freshFilename)
    expect(names).not.toContain('aged_asset.png')
  })
})
