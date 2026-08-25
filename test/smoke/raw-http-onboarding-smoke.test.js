import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Smoke gate for the README "Raw HTTP" onboarding path — the lowest-friction
// stranger path (no SDK, no MCP install): register an agent over the admin API,
// capture the once-returned dvk_ key, then boot and pull work with it. This was
// the 4th onboarding path with zero coverage until this test.
//
// DISCIPLINE: in-process supertest, reused verbatim from
// test/unit/context-project-scope.test.js and test/unit/claim-scope-and-spoof-auth.test.js
// (random secrets, temp DATA_DIR, mount myceliumRoutes at /api/mycelium — which
// pulls in /admin/agents via registerAdminRoutes). We deliberately do NOT spawn
// `node server/index.js`; that spawn shape is the /13 cold-start gate's territory.
//
// What this pins (and would RED if broken):
//   - registration is POST /admin/agents (NOT /agents — that 404s) and returns
//     api_key (dvk_…) EXACTLY ONCE — admin.js:337,374
//   - that api_key IS the X-Agent-Key for /boot/:id and /work/:id
//   - no key → 401, wrong key → 403 (checkAgent, mycelium.js:568)
//   - the boot payload's discriminator fields come from the REAL getSlimBootPayload
//     (db.js) + the route-added savepoint — not a hardcoded fixture
//
// What this deliberately does NOT pin (other briefs own it):
//   - /work QUEUE ORDERING — owned by /26 (buildWorkQueue, db.js). We assert the
//     auth round-trip + queue ARRAY only.

const ADMIN_KEY = 'test-admin-' + crypto.randomBytes(16).toString('hex')
const JWT_SECRET = crypto.randomBytes(32).toString('hex')
const AGENT_ID = 'dev-agent'

let tmpDataDir
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-raw-http-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB()
  // No project pre-created: the README registers with project_id "my-project"
  // verbatim, and agents.project_id has no FK to projects — so the documented
  // path must work without a projects-table row. (If that ever changes, this test
  // is the gate that catches it.)

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const BASE = '/api/mycelium'

describe('Raw HTTP onboarding round-trip (register → boot → work)', () => {
  let agentKey

  test('1. POST /admin/agents registers and returns a dvk_ api_key once', async () => {
    const res = await request(app)
      .post(`${BASE}/admin/agents`)
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ id: AGENT_ID, name: 'Dev Agent', project_id: 'my-project' })

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(AGENT_ID)
    // Key-once contract: the dvk_ key is returned HERE and nowhere else.
    expect(res.body.api_key).toMatch(/^dvk_/)
    expect(res.body).toHaveProperty('mcp_config')
    agentKey = res.body.api_key
  })

  test('2. GET /boot/:id with that key returns the real slim boot payload', async () => {
    expect(agentKey).toMatch(/^dvk_/) // step 1 must have captured the key
    const res = await request(app)
      .get(`${BASE}/boot/${AGENT_ID}`)
      .set('X-Agent-Key', agentKey)

    expect(res.status).toBe(200)
    // These fields come straight from getSlimBootPayload (db.js) + the route
    // (which adds savepoint). They prove the registered key resolved to THIS
    // agent and that the boot contract is intact — not a hardcoded fixture.
    expect(res.body.agent.id).toBe(AGENT_ID)
    expect(res.body.role_contract.agent_id).toBe(AGENT_ID)
    expect(res.body.role_contract.project_id).toBe('my-project')
    expect(Array.isArray(res.body.role_contract.capabilities)).toBe(true)
    expect(Array.isArray(res.body.work_queue)).toBe(true)
    expect(typeof res.body.counts).toBe('object')
    expect(res.body.counts).not.toBeNull()
    expect(res.body.counts.tasks_mine).toBe(0)
    expect(res.body).toHaveProperty('savepoint') // route-added; { has_savepoint:false } for a fresh agent
  })

  test('3. GET /work/:id with the same key round-trips and returns a queue array', async () => {
    const res = await request(app)
      .get(`${BASE}/work/${AGENT_ID}`)
      .set('X-Agent-Key', agentKey)

    expect(res.status).toBe(200)
    // AUTH round-trip only. Queue may be empty; we do NOT assert ordering (/26).
    expect(Array.isArray(res.body.queue)).toBe(true)
  })

  test('4. negative control: /boot with NO X-Agent-Key is rejected (401)', async () => {
    const res = await request(app).get(`${BASE}/boot/${AGENT_ID}`)
    expect(res.status).toBe(401) // checkAgent: "Missing X-Agent-Key header"
  })

  test('5. negative control: /work with a WRONG X-Agent-Key is rejected (403)', async () => {
    const res = await request(app)
      .get(`${BASE}/work/${AGENT_ID}`)
      .set('X-Agent-Key', 'dvk_not_the_real_key_0123456789abcdef0123456789')
    expect(res.status).toBe(403) // checkAgent: "Invalid agent key"
  })
})
