import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION NET — the ASSETS + FILES + FILE-SERVER + WIDGETS slice of the
// 6,539-line god-file server/routes/mycelium.js, locked ahead of decomposition.
//
// These tests pin CURRENT behavior — bugs included. They are a tripwire, not a
// spec: when decomposition changes one of these on purpose, update the test WITH
// the move, knowingly. Latent bugs locked below (search "BUG(locked)"):
//
//   1. PUT /assets/link-job is SHADOWED by PUT /assets/:id (':id' is registered
//      first and matches the literal string 'link-job' → parseIntParam → null →
//      getAsset(null) → 404). The bulk link-job endpoint is UNREACHABLE.
//   2. db.initTransactions() is exported but never called anywhere → the
//      autoTaskFromAsset hook stays null → POST /assets with status 'requested'
//      silently skips the documented auto-task; response carries no task_id.
//   3. PUT /widgets/:id with no recognized field returns 404 'widget not found'
//      even when the widget EXISTS (buildUpdate() "nothing to update" → null is
//      conflated with "row missing").
//   4. POST /assets/:id/upload on a nonexistent asset returns 404, but multer
//      has ALREADY written the file to FILES_DIR → orphaned file on disk.
//   5. Asset uploads are stored in FILES_DIR — the SAME dir the 24h temp-file
//      TTL sweep cleans and GET /files lists. "Permanent" asset files share the
//      temp-file lifecycle (they will be deleted by the sweep after 24h even
//      though the asset row keeps pointing at them).
//   6. PUT /assets/:id rejects traversal in `path` but does NOT validate
//      `file_path` — an agent can store an arbitrary absolute file_path; only
//      the runtime download gate (403) protects the read side.
//
// The asset-download path-traversal guard (audit 2026-07-02) is asserted again
// here on purpose — keep it locked even though
// test/unit/asset-download-path-traversal.test.js also pins it.
//
// Harness mirrors studio-login.test.js: real router + fresh temp DB, env set
// before the dynamic import; pool:'forks' gives this file its own module state.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'c'.repeat(48)
const AGENT_ID = 'lucy-cfw'
const PROJECT = 'cfw-proj'

let tmpDataDir
let FILES_DIR
let ARTIFACTS_DIR
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-afw-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = 'test-jwt-secret'

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent(AGENT_ID, 'Lucy', PROJECT, hash, '["code"]')

  // The router creates both dirs at import time from DATA_DIR.
  FILES_DIR = join(tmpDataDir, 'files')
  ARTIFACTS_DIR = join(tmpDataDir, 'drone_artifacts')

  // Canary "secret" living directly in DATA_DIR (mirrors mycelium.db's location)
  // — must never be servable through any download path.
  writeFileSync(join(tmpDataDir, 'canary-secret.txt'), 'TOP-SECRET-DB-CONTENTS')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const asAgent = (req) => req.set('X-Agent-Key', AGENT_KEY)
const asAdmin = (req) => req.set('X-Admin-Key', ADMIN_KEY)
const api = () => request(app)

// ======================== AUTH GATE (shared across the slice) ========================

describe('auth gate on this slice (checkAgentOrAdmin)', () => {
  test('no credentials → 401 "Missing X-Agent-Key header" on every entry point', async () => {
    for (const path of [
      '/api/mycelium/assets',
      '/api/mycelium/widgets',
      '/api/mycelium/files',
      '/api/mycelium/file-server/status',
    ]) {
      const res = await api().get(path)
      expect(res.status, path).toBe(401)
      expect(res.body.error, path).toBe('Missing X-Agent-Key header')
    }
  })

  test('bogus agent key → 403 "Invalid agent key"', async () => {
    const res = await api().get('/api/mycelium/assets').set('X-Agent-Key', 'dvk_' + 'f'.repeat(48))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('admin key is accepted wherever an agent key is', async () => {
    const res = await asAdmin(api().get('/api/mycelium/assets'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})

// ======================== ASSETS — metadata CRUD ========================

describe('assets — metadata CRUD', () => {
  test('POST /assets minimal → 200 (NOT 201 — asymmetric with POST /widgets) body is exactly {id, name}', async () => {
    const res = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'hero-sprite' })
    expect(res.status).toBe(200)
    expect(typeof res.body.id).toBe('number')
    expect(res.body.name).toBe('hero-sprite')
    // BUG(locked) #2: status defaults to 'requested', which is documented to
    // auto-create a task — but initTransactions() is never called, so
    // autoTaskFromAsset() returns null and NO task_id appears in the response.
    expect(Object.keys(res.body).sort()).toEqual(['id', 'name'])

    const row = (await asAgent(api().get('/api/mycelium/assets/' + res.body.id))).body
    expect(row).toMatchObject({
      id: res.body.id,
      name: 'hero-sprite',
      type: 'sprite',       // route default (schema default is 'asset' — route wins)
      project_id: 'shared', // route default
      status: 'requested',  // route default
      path: '',
      metadata: '{}',
      requester: AGENT_ID,  // agent-key caller is pinned as requester
      file_path: '',
      download_url: '',
    })
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
  })

  test('POST /assets: name is HTML-entity-escaped on write', async () => {
    const res = await asAgent(api().post('/api/mycelium/assets')).send({ name: '<b>art</b>' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('&lt;b&gt;art&lt;/b&gt;')
    const row = (await asAgent(api().get('/api/mycelium/assets/' + res.body.id))).body
    expect(row.name).toBe('&lt;b&gt;art&lt;/b&gt;') // stored escaped, not just echoed
  })

  test('POST /assets without name → 400 "name is required"', async () => {
    const res = await asAgent(api().post('/api/mycelium/assets')).send({ type: 'sprite' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('name is required')
  })

  test('POST /assets with invalid status → 400 machine-readable invalid_enum', async () => {
    const res = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'x', status: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_enum')
    expect(res.body.field).toBe('status')
    expect(res.body.value).toBe('bogus')
    expect(res.body.allowed).toEqual(['requested', 'in_progress', 'ready', 'delivered', 'cancelled'])
  })

  test('POST /assets rejects traversal and absolute paths at store time (LOCKED guard)', async () => {
    const dotdot = await asAgent(api().post('/api/mycelium/assets'))
      .send({ name: 'evil', path: '../canary-secret.txt' })
    expect(dotdot.status).toBe(400)
    expect(dotdot.body.error).toBe('invalid asset path')

    const absolute = await asAgent(api().post('/api/mycelium/assets'))
      .send({ name: 'evil2', path: '/etc/passwd' })
    expect(absolute.status).toBe(400)
    expect(absolute.body.error).toBe('invalid asset path')
  })

  test('POST /assets with admin key + X-Acting-As pins requester to the acting-as name', async () => {
    const res = await asAdmin(api().post('/api/mycelium/assets'))
      .set('X-Acting-As', 'm5Max')
      .send({ name: 'admin-asset', project_id: PROJECT })
    expect(res.status).toBe(200)
    const row = (await asAgent(api().get('/api/mycelium/assets/' + res.body.id))).body
    expect(row.requester).toBe('m5Max')
  })

  test('GET /assets/:id: nonexistent and non-numeric ids both → 404 "Asset not found"', async () => {
    const missing = await asAgent(api().get('/api/mycelium/assets/999999'))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Asset not found')
    // parseIntParam('abc') → null → getAsset(null) → undefined → same 404
    const nonNumeric = await asAgent(api().get('/api/mycelium/assets/abc'))
    expect(nonNumeric.status).toBe(404)
    expect(nonNumeric.body.error).toBe('Asset not found')
  })

  test('PUT /assets/:id updates fields → 200 {ok, id}; metadata is re-stringified', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets'))
      .send({ name: 'put-me', project_id: PROJECT })
    const id = created.body.id
    const res = await asAgent(api().put('/api/mycelium/assets/' + id)).send({
      status: 'in_progress',
      assigned_to: AGENT_ID,
      prompt: 'make it red',
      metadata: { k: 'v' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id })
    const row = (await asAgent(api().get('/api/mycelium/assets/' + id))).body
    expect(row.status).toBe('in_progress')
    expect(row.assigned_to).toBe(AGENT_ID)
    expect(row.prompt).toBe('make it red')
    expect(row.metadata).toBe('{"k":"v"}')
  })

  test('PUT /assets/:id with EMPTY body → 200 {ok} no-op (asymmetric: widgets 404 on the same shape)', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'noop', project_id: PROJECT })
    const res = await asAgent(api().put('/api/mycelium/assets/' + created.body.id)).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: created.body.id })
  })

  test('PUT /assets/:id with invalid status → 400 invalid_enum; nonexistent id → 404', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'enum-put', project_id: PROJECT })
    const bad = await asAgent(api().put('/api/mycelium/assets/' + created.body.id)).send({ status: 'nope' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('invalid_enum')

    const missing = await asAgent(api().put('/api/mycelium/assets/999999')).send({ status: 'ready' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Asset not found')
  })

  test('PUT /assets/:id rejects traversal in `path` (LOCKED guard)', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'trav-put', project_id: PROJECT })
    const res = await asAgent(api().put('/api/mycelium/assets/' + created.body.id))
      .send({ path: '../canary-secret.txt' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid asset path')
  })

  // BUG(locked) #6: `file_path` is NOT validated at store time — the same PUT
  // that 400s on a traversal `path` happily stores an absolute file_path
  // pointing anywhere. The download gate below is the ONLY protection.
  test('BUG(locked): PUT accepts an arbitrary absolute file_path (no store-time check) — download gate still 403s', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'fp-evil', project_id: PROJECT })
    const id = created.body.id
    const put = await asAgent(api().put('/api/mycelium/assets/' + id))
      .send({ file_path: join(tmpDataDir, 'canary-secret.txt') })
    expect(put.status).toBe(200) // accepted!
    const dl = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(dl.status).toBe(403)
    expect(dl.body.error).toBe('File path outside allowed directory')
    expect(dl.text || '').not.toContain('TOP-SECRET')
  })

  // BUG(locked) #1: PUT /assets/link-job is registered AFTER PUT /assets/:id,
  // so Express matches ':id' = 'link-job' first → parseIntParam → null →
  // getAsset(null) → 404. The bulk link-job endpoint is unreachable — every
  // call, however valid, returns 404 'Asset not found'.
  test('BUG(locked): PUT /assets/link-job is shadowed by PUT /assets/:id → always 404 "Asset not found"', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'linkable', project_id: PROJECT })
    const res = await asAgent(api().put('/api/mycelium/assets/link-job'))
      .send({ asset_ids: [created.body.id], drone_job_id: 1, status: 'ready' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Asset not found')
  })

  test('DELETE /assets/:id is admin-only; agent key gets 401 (quirk: not 403 — checkAdmin sees no admin creds at all)', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'undeletable', project_id: PROJECT })
    const res = await asAgent(api().delete('/api/mycelium/assets/' + created.body.id))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
    // still there
    expect((await asAgent(api().get('/api/mycelium/assets/' + created.body.id))).status).toBe(200)
  })

  test('DELETE /assets/:id with admin key → {ok, id}, row gone; nonexistent → 404', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'deletable', project_id: PROJECT })
    const id = created.body.id
    const res = await asAdmin(api().delete('/api/mycelium/assets/' + id))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id })
    expect((await asAgent(api().get('/api/mycelium/assets/' + id))).status).toBe(404)

    const missing = await asAdmin(api().delete('/api/mycelium/assets/999999'))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Asset not found')
  })
})

// ======================== ASSETS — list filters + pagination ========================

describe('assets — GET /assets filters + pagination', () => {
  beforeAll(async () => {
    await asAgent(api().post('/api/mycelium/assets')).send({ name: 'f1', project_id: 'cfw-filter', type: 'sprite', status: 'ready' })
    await asAgent(api().post('/api/mycelium/assets')).send({ name: 'f2', project_id: 'cfw-filter', type: 'model', status: 'requested' })
    await asAgent(api().post('/api/mycelium/assets')).send({ name: 'f3', project_id: 'cfw-filter-other', type: 'sprite', status: 'ready' })
    for (const n of ['p1', 'p2', 'p3']) {
      await asAgent(api().post('/api/mycelium/assets')).send({ name: n, project_id: 'cfw-page' })
    }
  })

  test('?project_id narrows to that project (full rows, updated_at DESC)', async () => {
    const res = await asAgent(api().get('/api/mycelium/assets?project_id=cfw-filter'))
    expect(res.status).toBe(200)
    expect(res.body.map((a) => a.name).sort()).toEqual(['f1', 'f2'])
    expect(res.body[0]).toHaveProperty('metadata')
    expect(res.body[0]).toHaveProperty('requester')
  })

  test('?type and ?status combine with ?project_id (AND semantics)', async () => {
    const byType = await asAgent(api().get('/api/mycelium/assets?project_id=cfw-filter&type=sprite'))
    expect(byType.body.map((a) => a.name)).toEqual(['f1'])
    const byStatus = await asAgent(api().get('/api/mycelium/assets?project_id=cfw-filter&status=requested'))
    expect(byStatus.body.map((a) => a.name)).toEqual(['f2'])
  })

  test('filter values are NOT enum-validated: ?status=bogus just matches nothing', async () => {
    const res = await asAgent(api().get('/api/mycelium/assets?status=bogus'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('limit + offset paginate (default limit 50)', async () => {
    const page1 = await asAgent(api().get('/api/mycelium/assets?project_id=cfw-page&limit=2'))
    const page2 = await asAgent(api().get('/api/mycelium/assets?project_id=cfw-page&limit=2&offset=2'))
    expect(page1.body.length).toBe(2)
    expect(page2.body.length).toBe(1)
    const ids = new Set([...page1.body, ...page2.body].map((a) => a.id))
    expect(ids.size).toBe(3)
  })
})

// ======================== ASSETS — upload → download round trip + containment ========================

describe('assets — upload → download round trip + containment gate', () => {
  test('round trip: POST metadata → upload multipart → asset flips to ready → download streams the bytes', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets'))
      .send({ name: 'round-asset', project_id: PROJECT, status: 'in_progress' })
    const id = created.body.id

    const up = await asAgent(api().post('/api/mycelium/assets/' + id + '/upload'))
      .attach('file', Buffer.from('ROUND-TRIP-BYTES'), 'round.txt')
    expect(up.status).toBe(200)
    expect(up.body).toEqual({
      ok: true,
      asset_id: id,
      download_url: '/api/mycelium/assets/' + id + '/download',
    })

    const row = (await asAgent(api().get('/api/mycelium/assets/' + id))).body
    expect(row.status).toBe('ready') // upload force-flips status
    expect(row.path).toMatch(/^round_\d+\.txt$/) // multer: base_<timestamp>.ext
    expect(row.file_path).toBe(join(FILES_DIR, row.path)) // absolute multer path
    expect(row.download_url).toBe('/api/mycelium/assets/' + id + '/download')

    const dl = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(dl.status).toBe(200)
    expect(dl.text).toBe('ROUND-TRIP-BYTES')
    expect(dl.headers['content-disposition']).toBe('attachment; filename="' + row.path + '"')
  })

  test('upload with no file field → 400 "No file uploaded"', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'no-file', project_id: PROJECT })
    const res = await asAgent(api().post('/api/mycelium/assets/' + created.body.id + '/upload')).send()
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No file uploaded')
  })

  test('unauthenticated upload → 401 BEFORE multer runs: no file written to disk', async () => {
    const before = readdirSync(FILES_DIR).length
    const res = await api()
      .post('/api/mycelium/assets/1/upload')
      .attach('file', Buffer.from('SHOULD-NOT-LAND'), 'noauth.txt')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
    expect(readdirSync(FILES_DIR).length).toBe(before) // requireAuth precedes upload.single
  })

  // BUG(locked) #4: for an AUTHENTICATED upload to a nonexistent asset, multer
  // runs before the handler's 404 — the file lands in FILES_DIR and stays there
  // (orphan; only the 24h TTL sweep will collect it).
  test('BUG(locked): upload to nonexistent asset → 404, but the multer file is already on disk (orphan)', async () => {
    const before = readdirSync(FILES_DIR)
    const res = await asAgent(api().post('/api/mycelium/assets/999999/upload'))
      .attach('file', Buffer.from('ORPHANED-BYTES'), 'orphan.txt')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Asset not found')
    const after = readdirSync(FILES_DIR)
    expect(after.length).toBe(before.length + 1)
    expect(after.some((f) => /^orphan_\d+\.txt$/.test(f))).toBe(true)
  })

  test('download with no file attached (metadata-only asset) → 404 "No file attached to this asset"', async () => {
    const created = await asAgent(api().post('/api/mycelium/assets')).send({ name: 'bare', project_id: PROJECT })
    const res = await asAgent(api().get('/api/mycelium/assets/' + created.body.id + '/download'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('No file attached to this asset')
  })

  test('download when stored path has no file on disk → 404 "File not found on disk"', async () => {
    const id = db.createAsset('ghost', 'sprite', PROJECT, 'ready', 'ghost.txt', '{}', AGENT_ID)
    const res = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('File not found on disk')
  })

  // LOCKED (audit 2026-07-02): the download containment gate. A '../' path
  // stored straight into the DB (store-guard bypass) must 403 and leak nothing.
  test('LOCKED traversal guard: stored "../" path → 403, canary does not leak', async () => {
    const id = db.createAsset('evil', 'sprite', PROJECT, 'ready', '../canary-secret.txt', '{}', AGENT_ID)
    const res = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('File path outside allowed directory')
    expect(res.text || '').not.toContain('TOP-SECRET')
  })

  test('LOCKED traversal guard: "../mycelium.db" (the real DB) is not exfiltratable → 403', async () => {
    const id = db.createAsset('evil-db', 'sprite', PROJECT, 'ready', '../mycelium.db', '{}', AGENT_ID)
    const res = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(res.status).toBe(403)
  })

  test('containment allowlist includes ARTIFACTS_DIR (file_path branch) — gate is not over-restrictive', async () => {
    writeFileSync(join(ARTIFACTS_DIR, 'weights.txt'), 'WEIGHTS')
    const id = db.createAsset('artifact', 'model', PROJECT, 'ready', '', '{}', AGENT_ID)
    db.updateAsset(id, { file_path: join(ARTIFACTS_DIR, 'weights.txt') })
    const res = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(res.status).toBe(200)
    expect(res.text).toBe('WEIGHTS')
  })

  test('download falls back to FILES_DIR + path when file_path is empty', async () => {
    writeFileSync(join(FILES_DIR, 'plain.txt'), 'PLAIN')
    const id = db.createAsset('plain', 'sprite', PROJECT, 'ready', 'plain.txt', '{}', AGENT_ID)
    const res = await asAgent(api().get('/api/mycelium/assets/' + id + '/download'))
    expect(res.status).toBe(200)
    expect(res.text).toBe('PLAIN')
  })
})

// ======================== FILES — temp uploads (24h TTL) ========================

describe('files — temp upload/list/download', () => {
  let tempFilename // set by the first upload, reused below

  test('POST /files multipart → {ok, filename, url, size, expires_at}; filename is sanitized base_<ts>.ext', async () => {
    const res = await asAgent(api().post('/api/mycelium/files'))
      .attach('file', Buffer.from('TEMPFILE'), 'my notes (v2).txt')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // base 'my notes (v2)' → non-[a-zA-Z0-9_-] chars become '_'
    expect(res.body.filename).toMatch(/^my_notes__v2__\d+\.txt$/)
    expect(res.body.size).toBe(8)
    expect(res.body.url).toMatch(/^http/)
    expect(res.body.url.endsWith('/api/mycelium/files/' + res.body.filename)).toBe(true)
    const msLeft = new Date(res.body.expires_at).getTime() - Date.now()
    expect(msLeft).toBeGreaterThan(24 * 3600 * 1000 - 120000) // ~24h TTL
    expect(msLeft).toBeLessThanOrEqual(24 * 3600 * 1000)
    tempFilename = res.body.filename
  })

  test('POST /files without a file → 400 with field-name hint', async () => {
    const res = await asAgent(api().post('/api/mycelium/files')).send()
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No file uploaded. Use multipart form with field name "file"')
  })

  test('blocked extensions are neutered to ".blocked" (upload succeeds, file defanged)', async () => {
    const res = await asAgent(api().post('/api/mycelium/files'))
      .attach('file', Buffer.from('#!/bin/sh\necho pwn'), 'evil.sh')
    expect(res.status).toBe(200)
    expect(res.body.filename).toMatch(/^evil_\d+\.blocked$/)
  })

  test('GET /files/:filename round trip with attachment Content-Disposition', async () => {
    const res = await asAgent(api().get('/api/mycelium/files/' + tempFilename))
    expect(res.status).toBe(200)
    expect(res.text).toBe('TEMPFILE')
    expect(res.headers['content-disposition']).toBe('attachment; filename="' + tempFilename + '"')
  })

  test('GET /files/:filename for a missing file → 404 "File not found or expired"', async () => {
    const res = await asAgent(api().get('/api/mycelium/files/definitely-not-here.txt'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('File not found or expired')
  })

  test('traversal probe (..%2F) is neutered by the filename sanitizer → 404, no canary leak', async () => {
    // Express decodes the param to '../canary-secret.txt'; the route strips
    // everything outside [a-zA-Z0-9_.-] → '..canary-secret.txt' (stays inside
    // FILES_DIR, doesn't exist) → 404.
    const res = await asAgent(api().get('/api/mycelium/files/..%2Fcanary-secret.txt'))
    expect(res.status).toBe(404)
    expect(res.text || '').not.toContain('TOP-SECRET')
  })

  test('GET /files lists entries with {filename,size,uploaded,expires_in_seconds,url}', async () => {
    const res = await asAgent(api().get('/api/mycelium/files'))
    expect(res.status).toBe(200)
    const mine = res.body.find((f) => f.filename === tempFilename)
    expect(mine).toBeTruthy()
    expect(mine.size).toBe(8)
    expect(typeof mine.uploaded).toBe('string')
    expect(mine.expires_in_seconds).toBeGreaterThan(86400 - 300)
    expect(mine.expires_in_seconds).toBeLessThanOrEqual(86400)
    expect(mine.url.endsWith('/api/mycelium/files/' + tempFilename)).toBe(true)
  })

  // BUG(locked) #5: asset uploads share FILES_DIR with temp files — they show
  // up in the temp listing AND are subject to the same 24h TTL sweep, so a
  // "permanent" asset's file quietly disappears after a day.
  test('BUG(locked): asset-upload files appear in the temp GET /files listing (shared dir + shared TTL)', async () => {
    const res = await asAgent(api().get('/api/mycelium/files'))
    expect(res.body.some((f) => /^round_\d+\.txt$/.test(f.filename))).toBe(true)
  })
})

// ======================== FILE-SERVER — WebSocket tunnel routes ========================

describe('file-server — no drone connected', () => {
  test('GET /file-server/status → 200 {online:false} (not an error status)', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/status'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ online: false, message: 'No file drone connected' })
  })

  test('browse / search / info → 503 "No file drone connected"', async () => {
    for (const path of ['browse', 'search', 'info']) {
      const res = await asAgent(api().post('/api/mycelium/file-server/' + path)).send({ path: '/' })
      expect(res.status, path).toBe(503)
      expect(res.body.error, path).toBe('No file drone connected')
    }
  })

  test('download + download-folder: the drone gate fires BEFORE path validation (503 even with no ?path)', async () => {
    for (const path of ['download', 'download-folder']) {
      const res = await asAgent(api().get('/api/mycelium/file-server/' + path))
      expect(res.status, path).toBe(503)
      expect(res.body.error, path).toBe('No file drone connected')
    }
  })
})

describe('file-server — stubbed drone via the app.locals seam', () => {
  // server/index.js normally populates these; the routes only touch
  // req.app.locals — so the seam is stubbable without a real WebSocket.
  const sent = []
  beforeAll(() => {
    app.locals.fileDrones = new Map([
      ['drone-1', { ws: { readyState: 1 }, info: { host: 'mac-studio' } }],
      ['drone-off', { ws: { readyState: 3 }, info: {} }],
    ])
    app.locals.sendFileDroneRequest = async (droneId, op, params, timeout) => {
      sent.push({ droneId, op, params, timeout })
      if (params && params.path === '/boom') throw new Error('drone timed out')
      return { ok: true, op, params }
    }
    app.locals.streamFileDroneDownload = async (droneId, params, res, mode) => {
      if (params.path === '/boom') throw new Error('stream failed')
      res.type('text/plain').send('STREAM:' + (mode || 'file') + ':' + params.path)
    }
  })
  afterAll(() => {
    delete app.locals.fileDrones
    delete app.locals.sendFileDroneRequest
    delete app.locals.streamFileDroneDownload
  })

  test('status → {online:true, drone_id, info} for the first CONNECTED drone', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/status'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ online: true, drone_id: 'drone-1', info: { host: 'mac-studio' } })
  })

  test('status?drone_id targeting a drone whose ws is not OPEN → treated as offline', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/status?drone_id=drone-off'))
    expect(res.status).toBe(200)
    expect(res.body.online).toBe(false)
  })

  test('browse forwards op "file_list" with default path "/" and returns the drone result verbatim', async () => {
    const res = await asAgent(api().post('/api/mycelium/file-server/browse')).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, op: 'file_list', params: { path: '/' } })
    expect(sent.at(-1)).toMatchObject({ droneId: 'drone-1', op: 'file_list', params: { path: '/' } })
  })

  test('search forwards op "file_search" with default query "*" and a 30s timeout', async () => {
    const res = await asAgent(api().post('/api/mycelium/file-server/search')).send({ path: '/projects' })
    expect(res.status).toBe(200)
    expect(sent.at(-1)).toEqual({
      droneId: 'drone-1',
      op: 'file_search',
      params: { query: '*', path: '/projects' },
      timeout: 30000,
    })
  })

  test('info forwards op "file_info"', async () => {
    const res = await asAgent(api().post('/api/mycelium/file-server/info')).send({ path: '/etc' })
    expect(res.status).toBe(200)
    expect(sent.at(-1)).toMatchObject({ op: 'file_info', params: { path: '/etc' } })
  })

  test('drone-request failure surfaces as 504 with the raw error message', async () => {
    const res = await asAgent(api().post('/api/mycelium/file-server/browse')).send({ path: '/boom' })
    expect(res.status).toBe(504)
    expect(res.body.error).toBe('drone timed out')
  })

  test('download without ?path (drone present) → 400 "path query parameter required"', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/download'))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('path query parameter required')
  })

  test('download streams through streamFileDroneDownload (no mode arg)', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/download?path=/stuff/a.txt'))
    expect(res.status).toBe(200)
    expect(res.text).toBe('STREAM:file:/stuff/a.txt')
  })

  test('download-folder passes mode "folder_download"', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/download-folder?path=/stuff'))
    expect(res.status).toBe(200)
    expect(res.text).toBe('STREAM:folder_download:/stuff')
  })

  test('stream failure before headers → 504 with the raw error message', async () => {
    const res = await asAgent(api().get('/api/mycelium/file-server/download?path=/boom'))
    expect(res.status).toBe(504)
    expect(res.body.error).toBe('stream failed')
  })
})

// ======================== WIDGETS — CRUD + filters ========================

describe('widgets — CRUD + filters', () => {
  test('POST /widgets → 201 with body exactly {id}; row gets defaults; agent caller pins agent_id (body agent_id IGNORED)', async () => {
    const res = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'CPU', project_id: 'w-defaults', agent_id: 'spoof-attempt' })
    expect(res.status).toBe(201)
    expect(Object.keys(res.body)).toEqual(['id'])
    expect(typeof res.body.id).toBe('number')

    const list = await asAgent(api().get('/api/mycelium/widgets?project_id=w-defaults'))
    expect(list.body.length).toBe(1)
    expect(list.body[0]).toMatchObject({
      id: res.body.id,
      agent_id: AGENT_ID, // NOT 'spoof-attempt' — agents cannot attribute to others
      project_id: 'w-defaults',
      title: 'CPU',
      widget_type: 'status', // default
      data: '{}',
      position: 0,
      status: 'active',
    })
  })

  test('POST /widgets without title → 400 "title required"', async () => {
    const res = await asAgent(api().post('/api/mycelium/widgets')).send({ widget_type: 'chart' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('title required')
  })

  test('admin-key attribution: body agent_id honored; bare admin → "__system__"; X-Acting-As overrides (body ignored)', async () => {
    await asAdmin(api().post('/api/mycelium/widgets')).send({ title: 'ghost-w', project_id: 'w-admin', agent_id: 'ghost' })
    await asAdmin(api().post('/api/mycelium/widgets')).send({ title: 'sys-w', project_id: 'w-admin' })
    await asAdmin(api().post('/api/mycelium/widgets')).set('X-Acting-As', 'm5Max')
      .send({ title: 'acting-w', project_id: 'w-admin', agent_id: 'ignored' })

    const list = await asAgent(api().get('/api/mycelium/widgets?project_id=w-admin'))
    const byTitle = Object.fromEntries(list.body.map((w) => [w.title, w.agent_id]))
    expect(byTitle).toEqual({
      'ghost-w': 'ghost',       // admin with no acting-as: body agent_id wins
      'sys-w': '__system__',    // admin with no acting-as, no body agent_id
      'acting-w': 'm5Max',      // X-Acting-As becomes `who` → body agent_id ignored
    })
  })

  test('data: objects are JSON-stringified; strings stored verbatim', async () => {
    const obj = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'd-obj', project_id: 'w-data', data: { x: 1 } })
    const str = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'd-str', project_id: 'w-data', data: '{"pre":"encoded"}' })
    const list = await asAgent(api().get('/api/mycelium/widgets?project_id=w-data'))
    const byId = Object.fromEntries(list.body.map((w) => [w.id, w.data]))
    expect(byId[obj.body.id]).toBe('{"x":1}')
    expect(byId[str.body.id]).toBe('{"pre":"encoded"}')
  })

  test('GET /widgets ?agent_id filter', async () => {
    const res = await asAgent(api().get('/api/mycelium/widgets?agent_id=ghost'))
    expect(res.body.length).toBe(1)
    expect(res.body[0].title).toBe('ghost-w')
  })

  test('PUT /widgets/:id → returns the FULL updated row', async () => {
    const created = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'before', project_id: 'w-put' })
    const res = await asAgent(api().put('/api/mycelium/widgets/' + created.body.id))
      .send({ title: 'after', data: { v: 2 } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: created.body.id,
      title: 'after',
      data: '{"v":2}',
      status: 'active',
    })
    expect(res.body.updated_at).toBeTruthy()
  })

  // BUG(locked) #3: buildUpdate() returns false when no recognized field is
  // present, and updateWidget() maps that to null — indistinguishable from a
  // missing row. So an empty-body PUT on an EXISTING widget 404s. (Contrast:
  // the same shape on PUT /assets/:id returns 200 {ok:true}.)
  test('BUG(locked): PUT /widgets/:id with empty body on an EXISTING widget → 404 "widget not found"', async () => {
    const created = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'exists', project_id: 'w-empty-put' })
    const res = await asAgent(api().put('/api/mycelium/widgets/' + created.body.id)).send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('widget not found')
  })

  test('PUT /widgets/:id on a nonexistent id → 404', async () => {
    const res = await asAgent(api().put('/api/mycelium/widgets/999999')).send({ title: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('widget not found')
  })

  test('position is the primary sort key of GET /widgets (position ASC)', async () => {
    const a = await asAgent(api().post('/api/mycelium/widgets')).send({ title: 'w-a', project_id: 'w-order' })
    const b = await asAgent(api().post('/api/mycelium/widgets')).send({ title: 'w-b', project_id: 'w-order' })
    await asAgent(api().put('/api/mycelium/widgets/' + a.body.id)).send({ position: 5 })
    await asAgent(api().put('/api/mycelium/widgets/' + b.body.id)).send({ position: 1 })
    const list = await asAgent(api().get('/api/mycelium/widgets?project_id=w-order'))
    expect(list.body.map((w) => w.title)).toEqual(['w-b', 'w-a'])
  })

  test('PUT status="archived" hides the widget from GET (list filters status=active)', async () => {
    const created = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'to-archive', project_id: 'w-archive' })
    await asAgent(api().put('/api/mycelium/widgets/' + created.body.id)).send({ status: 'archived' })
    const list = await asAgent(api().get('/api/mycelium/widgets?project_id=w-archive'))
    expect(list.body).toEqual([])
  })

  test('DELETE /widgets/:id → {ok:true}; soft-archive (gone from GET); nonexistent id ALSO → {ok:true}', async () => {
    const created = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'to-delete', project_id: 'w-delete' })
    const res = await asAgent(api().delete('/api/mycelium/widgets/' + created.body.id))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const list = await asAgent(api().get('/api/mycelium/widgets?project_id=w-delete'))
    expect(list.body).toEqual([])

    // No existence check on delete — a bogus id is a silent 200 success.
    const missing = await asAgent(api().delete('/api/mycelium/widgets/999999'))
    expect(missing.status).toBe(200)
    expect(missing.body).toEqual({ ok: true })
  })

  test('a DELETEd (archived) widget is still updatable via PUT — soft-delete is not enforced on update', async () => {
    const created = await asAgent(api().post('/api/mycelium/widgets'))
      .send({ title: 'zombie', project_id: 'w-zombie' })
    await asAgent(api().delete('/api/mycelium/widgets/' + created.body.id))
    const res = await asAgent(api().put('/api/mycelium/widgets/' + created.body.id)).send({ title: 'zombie-updated' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('zombie-updated')
    expect(res.body.status).toBe('archived') // update does NOT resurrect it
  })
})
