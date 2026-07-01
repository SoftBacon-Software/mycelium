import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// H1: project_id must NOT be HTML-escaped before storage.
//
// Previously the POST /tasks, POST /plans and PUT /plans handlers ran
// `escapeHtml(req.body.project_id)`, corrupting any id containing &, < or >
// (e.g. "proj&a" was stored as "proj&amp;a"). The downstream inserts use
// parameterized (?-placeholder) queries, so escapeHtml was both wrong (a
// misplaced XSS guard on DB-bound data) and unnecessary (SQL injection is
// already prevented). This test round-trips a special-char project_id through
// the REAL POST /tasks route via supertest and asserts it is stored verbatim.
//
// db.js reads DATA_DIR at module-eval time -> set it before importing the route.

const ADMIN_KEY = 'test-admin-key-for-project-id'

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-project-id-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  db = await import('../../server/db.js')
  const router = (await import('../../server/routes/mycelium.js')).default
  db.initDB()
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('H1: project_id is not HTML-escaped (round-trips verbatim)', () => {
  test('POST /tasks stores a special-char project_id unchanged', async () => {
    const special = 'proj&a<b>"x"'
    const res = await request(app)
      .post('/api/tasks')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ title: 'round-trip test', project_id: special })

    expect(res.status).toBe(200)
    expect(res.body.id).toBeTruthy()

    // The DB row must hold the project_id EXACTLY as the client sent it.
    const task = db.getTask(res.body.id)
    expect(task.project_id).toBe(special)
  })

  test('no escapeHtml(req.body.project_id) remains in the route source', async () => {
    // Regression guard: if escapeHtml is re-wrapped around project_id in any of
    // the three handlers, this assertion fails.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(process.cwd(), 'server/routes/mycelium.js'), 'utf8')
    expect(src).not.toContain('escapeHtml(req.body.project_id')
  })
})
