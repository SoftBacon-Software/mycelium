// Gate for the per-route usage instrument (lib/route-usage.js + schema route_usage
// + GET /admin/route-usage). The removal audits (P-product 173/174+) read
// zero-write evidence from this table, so the gate proves the WHOLE chain with a
// real HTTP round-trip — not a stubbed counter call:
//   request → seam middleware → route_usage row → GET /admin/route-usage row.
// Red if the middleware is dropped from the mount, the pattern collapses to raw
// URLs (:ids leak), 4xx stops counting, or the reader endpoint loses its filter.
//
// Harness mirrors test/unit/request-lifecycle.test.js: REAL mycelium router via
// supertest, fresh temp DATA_DIR + ADMIN_KEY/JWT_SECRET set BEFORE the dynamic
// import, one agent with a real SHA-256 key hash. The middleware is mounted at
// the seam exactly as server/index.js mounts it (counter, then routes).

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

const ADMIN_KEY = 'test-admin-key-route-usage-0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret-route-usage'
const KEY_A = 'dvk_' + 'r'.repeat(48)
const A = 'route-usage-agent-a'

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-route-usage-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const { routeUsageCounter } = await import('../../server/lib/route-usage.js')
  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routeUsageCounter) // production mount order: counter FIRST
  app.use('/api/mycelium', routes)

  const hashOf = (k) => crypto.createHash('sha256').update(k).digest('hex')
  db.createAgent(A, 'Agent A', 'route-usage-proj', hashOf(KEY_A), '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const usage = (query = '') =>
  request(app).get('/api/mycelium/admin/route-usage' + query).set('X-Admin-Key', ADMIN_KEY)

const rowFor = (body, method, pattern) =>
  body.routes.find((r) => r.method === method && r.route_pattern === pattern)

describe('(1) real round-trip: request → row → endpoint', () => {
  test('POST /tasks (200) lands a POST /tasks row the endpoint serves back', async () => {
    const created = await request(app)
      .post('/api/mycelium/tasks')
      .set('X-Agent-Key', KEY_A)
      .send({ title: 'counted work item' })
    expect(created.status).toBe(200)

    const res = await usage()
    expect(res.status).toBe(200)
    const row = rowFor(res.body, 'POST', '/tasks')
    expect(row).toBeDefined()
    expect(row.count).toBe(1)
    expect(row.active_days).toBe(1)
    // UTC day bucket + timestamp sanity
    expect(row.first_seen).toBeTruthy()
    expect(row.last_seen >= row.first_seen).toBe(true)
    const dbRow = db.getDB().prepare("SELECT * FROM route_usage WHERE method='POST' AND route_pattern='/tasks'").get()
    expect(dbRow.day).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe('(2) :id-shaped requests collapse to ONE pattern row', () => {
  test('GET /tasks/:id × 3 (mixed 200/404) → one GET /tasks/:id row, count 3', async () => {
    const created = await request(app)
      .post('/api/mycelium/tasks')
      .set('X-Agent-Key', KEY_A)
      .send({ title: 'collapse probe' })
    const realId = created.body.id

    await request(app).get('/api/mycelium/tasks/' + realId).set('X-Agent-Key', KEY_A) // 200
    await request(app).get('/api/mycelium/tasks/999999').set('X-Agent-Key', KEY_A) // 404
    await request(app).get('/api/mycelium/tasks/888888').set('X-Agent-Key', KEY_A) // 404

    const res = await usage()
    // Exactly one pattern row — no raw /tasks/999999 anywhere in the table.
    const patternRows = res.body.routes.filter((r) => r.route_pattern.startsWith('/tasks/'))
    expect(patternRows).toHaveLength(1)
    expect(patternRows[0]).toMatchObject({ method: 'GET', route_pattern: '/tasks/:id', count: 3 })
    const rawLeak = db.getDB().prepare("SELECT COUNT(*) AS c FROM route_usage WHERE route_pattern LIKE '%999999%'").get()
    expect(rawLeak.c).toBe(0)
    // Same path, different method = separate row (GET /tasks vs POST /tasks already split).
    expect(rowFor(res.body, 'GET', '/tasks')).toBeUndefined()
  })
})

describe('(3) unmatched routes count as <unmatched>, not raw URLs', () => {
  test('GET /definitely-not-a-route-xyz (404) → single <unmatched> row', async () => {
    const res404 = await request(app).get('/api/mycelium/definitely-not-a-route-xyz')
    expect(res404.status).toBe(404)

    const res = await usage()
    const row = rowFor(res.body, 'GET', '<unmatched>')
    expect(row).toBeDefined()
    expect(row.count).toBe(1)
  })
})

describe('(4) ?since= filter scopes the window', () => {
  test('since=today returns rows; since far-future returns an empty set', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const withData = await usage('?since=' + today)
    expect(withData.body.since).toBe(today)
    expect(withData.body.routes.length).toBeGreaterThan(0)
    expect(withData.body.total_requests).toBeGreaterThan(0)

    const empty = await usage('?since=2999-01-01')
    expect(empty.body.routes).toEqual([])
    expect(empty.body.total_requests).toBe(0)
  })

  test('malformed since → 400', async () => {
    const res = await usage('?since=not-a-date')
    expect(res.status).toBe(400)
  })
})

describe('(5) admin gate', () => {
  test('no key → 401; wrong key → 403', async () => {
    const noKey = await request(app).get('/api/mycelium/admin/route-usage')
    expect(noKey.status).toBe(401)
    const badKey = await request(app).get('/api/mycelium/admin/route-usage').set('X-Admin-Key', 'wrong-key')
    expect(badKey.status).toBe(403)
  })
})

describe('(6) the counter counts the admin read itself (it sits behind the same seam)', () => {
  test('GET /admin/route-usage appears with count >= 1', async () => {
    const res = await usage()
    const row = rowFor(res.body, 'GET', '/admin/route-usage')
    expect(row).toBeDefined()
    expect(row.count).toBeGreaterThanOrEqual(1)
  })
})
