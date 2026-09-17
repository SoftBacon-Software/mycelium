import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// Task 200, defect 2 — the board hides tasks. GET /tasks paged at 50 with no
// signal (74 open, you saw 50 and nothing told you), and mycelium_overview
// capped open tasks at 20 with no total. Two invariants are pinned here:
//
//   1. Every list route that pages returns an HONEST envelope by default:
//      { items, total, limit, offset, next_offset } where total is the count
//      of rows matching the FILTERS (not the page) and next_offset is null at
//      the end. The pre-envelope bare array survives ONE release behind
//      ?shape=array so external old clients keep reading during the window.
//   2. GET /admin/overview carries open_total beside its capped open list, so
//      the board can say "74 open, showing 20" instead of silently lying.
//
// Harness mirrors claim-scope-and-spoof-auth.test.js: the REAL router on a
// fresh temp DB, env set before the dynamic import so db.js / routes pick up
// DATA_DIR + ADMIN_KEY.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-list-pagination-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // 7 tasks (all open — createTask defaults status to 'open'), 2 plans, 3 bugs.
  for (let i = 0; i < 7; i++) {
    db.createTask('task ' + i, 'desc', 'pag-proj', 'admin', 'normal', '[]')
  }
  db.createPlan('plan A', 'desc', 'pag-proj', 'admin', 'normal', '[]', 'admin')
  db.createPlan('plan B', 'desc', 'pag-proj', 'admin', 'normal', '[]', 'admin')
  for (let i = 0; i < 3; i++) {
    db.createBug('pag-proj', 'bug ' + i, 'desc', 'other', 'normal', 'admin', null, null)
  }
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const auth = { 'X-Admin-Key': ADMIN_KEY }

describe('GET /tasks — the honest envelope', () => {
  test('default shape is {items,total,limit,offset,next_offset}, not a bare array', async () => {
    const res = await request(app).get('/api/mycelium/tasks?project_id=pag-proj&limit=3').set(auth)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(false)
    expect(res.body.items).toHaveLength(3)
    expect(res.body.total).toBe(7)
    expect(res.body.limit).toBe(3)
    expect(res.body.offset).toBe(0)
    expect(res.body.next_offset).toBe(3)
  })

  test('next_offset walks to the end and then goes null, pages tile total without dupes', async () => {
    const seen = []
    let offset = 0
    for (let hop = 0; hop < 10; hop++) {
      const res = await request(app)
        .get('/api/mycelium/tasks?project_id=pag-proj&limit=3&offset=' + offset).set(auth)
      expect(res.status).toBe(200)
      seen.push(...res.body.items.map((t) => t.id))
      if (res.body.next_offset === null) break
      offset = res.body.next_offset
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  test('total honors the filters, not just the page size', async () => {
    const res = await request(app).get('/api/mycelium/tasks?project_id=pag-proj&status=done').set(auth)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(0)
    expect(res.body.total).toBe(0)
  })

  test('?shape=array keeps the bare array for one release', async () => {
    const res = await request(app).get('/api/mycelium/tasks?project_id=pag-proj&shape=array').set(auth)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(7)
  })
})

describe('GET /plans — same envelope', () => {
  test('default shape carries items/total/next_offset; shape=array stays a bare array', async () => {
    const res = await request(app).get('/api/mycelium/plans?project_id=pag-proj&limit=1').set(auth)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(false)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.total).toBe(2)
    expect(res.body.next_offset).toBe(1)

    const legacy = await request(app).get('/api/mycelium/plans?project_id=pag-proj&shape=array').set(auth)
    expect(Array.isArray(legacy.body)).toBe(true)
    expect(legacy.body).toHaveLength(2)
  })
})

describe('GET /bugs — envelope + counts; the old .bugs readers keep one release', () => {
  test('default shape carries the envelope fields plus counts and the bugs alias', async () => {
    const res = await request(app).get('/api/mycelium/bugs?project_id=pag-proj&limit=2').set(auth)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(false)
    expect(res.body.items).toHaveLength(2)
    expect(res.body.total).toBe(3)
    expect(res.body.next_offset).toBe(2)
    expect(res.body.counts).toBeDefined()
    expect(res.body.bugs).toEqual(res.body.items)
  })

  test('?shape=array returns the bare array', async () => {
    const res = await request(app).get('/api/mycelium/bugs?project_id=pag-proj&shape=array').set(auth)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(3)
  })
})

describe('GET /admin/overview — open_total beside the capped list', () => {
  test('tasks.open_total reflects every open task, not the 20-cap', async () => {
    const res = await request(app).get('/api/mycelium/admin/overview?verbose=true').set(auth)
    expect(res.status).toBe(200)
    expect(res.body.tasks.open_total).toBe(7)
    expect(res.body.tasks.open.length).toBeLessThanOrEqual(20)
  })
})
