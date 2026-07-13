import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Two safety fixes re-applied on master from the held refactor batch:
//   1. Mutations to a MISSING child resource must 404 BEFORE mutating/emitting —
//      not a silent 200 + phantom event (plan steps; drone pause/resume). Closes
//      an IDOR-flavored path (a step of plan B mutated via plan A's URL).
//   2. GET /admin/health must be side-effect-free (read-only computeHealthReport,
//      dry_run:true); the mutating patrol moved to admin-only POST /admin/health/run,
//      so an agent key can preview but can no longer offline peers via a GET.
//
// Harness mirrors drone-mesh-rce.test.js.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'e'.repeat(48)

let tmpDataDir
let db
let app
let planId

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-safety-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('safety-agent', 'Safety Agent', 'safety-proj', hash, '["code"]')
  planId = db.createPlan('Safety Plan', 'for 404 tests', 'safety-proj', 'safety-agent', 'normal', '[]', 'safety-agent')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('phantom sub-resource mutations 404 (not silent-200 + ghost event)', () => {
  test('PUT /plans/:id/steps/:stepId on a non-existent step → 404', async () => {
    const res = await request(app)
      .put(`/api/mycelium/plans/${planId}/steps/99999`)
      .set('X-Agent-Key', AGENT_KEY)
      .send({ status: 'in_progress' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/step not found/i)
  })

  test('DELETE /plans/:id/steps/:stepId on a non-existent step → 404', async () => {
    const res = await request(app)
      .delete(`/api/mycelium/plans/${planId}/steps/99999`)
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/step not found/i)
  })

  test('PUT /drones/:id/pause on a ghost drone → 404 (not silent ok:true)', async () => {
    const res = await request(app)
      .put('/api/mycelium/drones/ghost-drone/pause')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404)
  })

  test('PUT /drones/:id/resume on a ghost drone → 404', async () => {
    const res = await request(app)
      .put('/api/mycelium/drones/ghost-drone/resume')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404)
  })
})

describe('GET /admin/health is side-effect-free; mutation is admin-only POST', () => {
  test('GET /admin/health returns a read-only preview (dry_run:true)', async () => {
    const res = await request(app)
      .get('/api/mycelium/admin/health')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    expect(res.body.dry_run).toBe(true)
    expect(res.body).toHaveProperty('actions')
    expect(res.body).toHaveProperty('stale_agents')
  })

  test('POST /admin/health/run is admin-only — a non-admin agent is denied', async () => {
    const res = await request(app)
      .post('/api/mycelium/admin/health/run')
      .set('X-Agent-Key', AGENT_KEY)
    // Master returns 401 here; the separate §1 finding (checkAdmin → 403 for a
    // valid-but-non-admin agent) will tighten it to 403. Either way, denied.
    expect([401, 403]).toContain(res.status)
  })

  test('POST /admin/health/run as admin runs the patrol (200)', async () => {
    const res = await request(app)
      .post('/api/mycelium/admin/health/run')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
    expect(res.status).toBe(200)
  })
})
