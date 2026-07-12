import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// CHARACTERIZATION tests — ADMIN surface of server/routes/mycelium.js.
//
// This is a tests-first net under the 6,539-line god-file BEFORE decomposition.
// Everything here locks CURRENT behavior — what the code DOES, not what it
// should do. Where behavior smells like a bug it is asserted as-is and flagged
// with a `LATENT BUG` / `SMELL` comment. Fix nothing from this file; if a
// refactor breaks one of these tests, the refactor changed observable behavior.
//
// Surface covered:
//   GET  /admin/overview            (slim + verbose dashboard snapshot)
//   GET  /admin/config, GET /admin/config/:key, PUT /admin/config/:key
//   PUT  /admin/override            (KILL SWITCH) + POST /work/request gating
//   POST /admin/cleanup
//   GET  /admin/health, GET /admin/health/history (stale patrol)
//   GET  /reconciliation
//   GET  /stats/public
//   POST /admin/churn-check, POST /admin/deploy/health-check-all (RETIRED → 404)
//
// Auth model being locked (from checkAdmin / checkAgentOrAdmin / checkAgent):
//   checkAdmin:          studio JWT with role==='admin' OR X-Admin-Key.
//                        - no credentials at all        → 401 'Authentication required'
//                        - JWT with any non-admin role  → 403 'Admin role required'
//                        - wrong admin key              → 403 'Invalid admin key'
//                        - a valid AGENT key            → 403 'Admin role required'
//                          (FIXED 2026-07, findings §1: authenticated-but-not-admin
//                          is an authorization failure, not an authentication one)
//   checkAgentOrAdmin:   JWT (any role) OR admin key OR agent key.
//                        - nothing                      → 401 'Missing X-Agent-Key header'
//                        - bad agent key                → 403 'Invalid agent key'
//
// RATE-LIMIT BUDGET: adminWriteLimiter allows 30 req/min/IP across
// PUT /admin/config/:key, PUT /admin/override, POST/DELETE /admin/agents,
// PUT /admin/agents/:id/key — and it counts REJECTED (401/403) requests too,
// because the limiter runs before auth. This file currently spends ~19 of the
// 30; be careful adding more writes.
//
// Harness copied from studio-login.test.js: real router, fresh temp DB, env
// set before the dynamic import, supertest. pool:'forks' isolates the
// module-global rate-limiter stores.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let app
let db
let agentKey // real registered agent key (char-agent)

function jwtFor(role, displayName) {
  return jwt.sign(
    { studioUser: true, userId: 4242, username: displayName.toLowerCase(), displayName, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}
let operatorJwt // role 'operator' — authenticates fine, is NOT admin

const api = (p) => '/api/mycelium' + p

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-admin-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  operatorJwt = jwtFor('operator', 'Hijack')

  // Two agents registered through the REAL admin route (spends 2 of the
  // admin-write budget). char-agent is the auth probe + work-routing agent;
  // patrol-stale-1 is the health-patrol staleness target.
  for (const id of ['char-agent', 'patrol-stale-1']) {
    const reg = await request(app)
      .post(api('/admin/agents'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ id, name: id, project_id: 'char-proj' })
    if (reg.status !== 200) throw new Error('test setup: agent registration failed: ' + JSON.stringify(reg.body))
    if (id === 'char-agent') agentKey = reg.body.api_key
  }
})

afterAll(() => {
  rmSync(tmpDataDir, { recursive: true, force: true })
})

// =====================================================================
// 1. THE AUTH GATE — the sensitive lock. Every admin-only endpoint must
//    keep rejecting exactly the way it rejects today.
// =====================================================================

describe('admin auth gate — checkAdmin endpoints', () => {
  // NOTE: override probes use action:'unfreeze' so that if a future auth
  // regression ever let one THROUGH, it would not freeze the platform and
  // cascade failures into the rest of this file.
  const ADMIN_ONLY = [
    ['get', '/admin/overview', undefined],
    ['put', '/admin/config/char_authprobe', { value: 'x' }],
    ['put', '/admin/override', { action: 'unfreeze' }],
    ['post', '/admin/cleanup', {}],
    ['get', '/reconciliation', undefined],
  ]

  test('no credentials → 401 "Authentication required"', async () => {
    for (const [method, path, body] of ADMIN_ONLY) {
      const res = await request(app)[method](api(path)).send(body)
      expect(res.status, method.toUpperCase() + ' ' + path).toBe(401)
      expect(res.body.error, method.toUpperCase() + ' ' + path).toBe('Authentication required')
    }
  })

  test('studio JWT with non-admin role → 403 "Admin role required"', async () => {
    // NOTE (doc drift, not asserted-away): .claude/CLAUDE.md says "any human
    // operator can freeze/unfreeze" the kill switch, but PUT /admin/override
    // uses checkAdmin — an operator-role JWT gets 403. Locked as-is.
    for (const [method, path, body] of ADMIN_ONLY) {
      const res = await request(app)[method](api(path))
        .set('Authorization', 'Bearer ' + operatorJwt)
        .send(body)
      expect(res.status, method.toUpperCase() + ' ' + path).toBe(403)
      expect(res.body.error, method.toUpperCase() + ' ' + path).toBe('Admin role required')
    }
  })

  test('wrong admin key → 403 "Invalid admin key"', async () => {
    for (const [method, path, body] of ADMIN_ONLY) {
      const res = await request(app)[method](api(path))
        .set('X-Admin-Key', 'not-the-admin-key')
        .send(body)
      expect(res.status, method.toUpperCase() + ' ' + path).toBe(403)
      expect(res.body.error, method.toUpperCase() + ' ' + path).toBe('Invalid admin key')
    }
  })

  test('valid AGENT key → 403 "Admin role required" (proves the findings-§1 fix)', async () => {
    // Agents cannot reach admin-only endpoints — and since the 2026-07 fix the
    // status is an honest 403 (authenticated but not authorized), not the old
    // 401 that pretended the credential was never seen.
    const res = await request(app).get(api('/admin/overview')).set('X-Agent-Key', agentKey)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })
})

describe('admin auth gate — checkAgentOrAdmin endpoints (agent-READABLE admin surface)', () => {
  const AGENT_OK = [
    '/admin/config',
    '/admin/config/admin_status',
    '/admin/health',
    '/admin/health/history',
  ]

  test('valid agent key → 200 on all four (SMELL: agents can read the whole admin config + trigger the patrol)', async () => {
    // SMELL (locked, not fixed): /admin/config exposes the FULL instance
    // config (risk_tiers, admin_agent_id, any operator-set key) to ANY agent
    // key, and /admin/health lets any agent run a MUTATING patrol sweep
    // (it marks stale agents offline — see health-patrol block below).
    for (const path of AGENT_OK) {
      const res = await request(app).get(api(path)).set('X-Agent-Key', agentKey)
      expect(res.status, 'GET ' + path).toBe(200)
    }
  })

  test('studio JWT (non-admin operator) → 200', async () => {
    const res = await request(app).get(api('/admin/config')).set('Authorization', 'Bearer ' + operatorJwt)
    expect(res.status).toBe(200)
  })

  test('no credentials → 401 "Missing X-Agent-Key header"', async () => {
    for (const path of AGENT_OK) {
      const res = await request(app).get(api(path))
      expect(res.status, 'GET ' + path).toBe(401)
      expect(res.body.error, 'GET ' + path).toBe('Missing X-Agent-Key header')
    }
  })

  test('bad agent key → 403 "Invalid agent key"', async () => {
    const res = await request(app).get(api('/admin/config')).set('X-Agent-Key', 'dvk_forged')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })
})

// =====================================================================
// 2. GET /stats/public — intentionally UNAUTHENTICATED aggregate stats.
//    Runs early: later blocks create messages/events that would shift counts.
// =====================================================================

describe('GET /stats/public', () => {
  test('no auth required; exact shape from a fresh DB with 2 registered agents', async () => {
    const res = await request(app).get(api('/stats/public'))
    expect(res.status).toBe(200)
    expect(res.body.agents).toEqual({ total: 2, online: 0 })
    // QUIRK (locked): SQL SUM() over zero rows is NULL, so "completed"/
    // "resolved" are null — not 0 — until the first row exists. Clients doing
    // arithmetic on these get null propagation.
    expect(res.body.tasks).toEqual({ total: 0, completed: null })
    expect(res.body.plans).toEqual({ total: 0, completed: null })
    expect(res.body.bugs).toEqual({ total: 0, resolved: null })
    expect(res.body.messages).toBe(0)
    expect(res.body.projects).toBe(0)
    // Two agent_registered events from setup, humanized (underscores → spaces)
    expect(res.body.recent_activity).toEqual(['agent registered', 'agent registered'])
  })
})

// =====================================================================
// 3. GET /admin/overview — the dashboard snapshot (slim default, verbose opt-in)
// =====================================================================

describe('GET /admin/overview', () => {
  test('default (slim): agents/counts/attention/recent_activity', async () => {
    const res = await request(app).get(api('/admin/overview')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['agents', 'attention', 'counts', 'recent_activity'])
    // Never-heartbeated agents render heartbeat:'never'
    const byId = Object.fromEntries(res.body.agents.map((a) => [a.id, a]))
    expect(byId['char-agent']).toEqual({ id: 'char-agent', status: 'offline', working_on: '', heartbeat: 'never' })
    expect(byId['patrol-stale-1']).toEqual({ id: 'patrol-stale-1', status: 'offline', working_on: '', heartbeat: 'never' })
    expect(res.body.counts).toEqual({
      tasks_open: 0,
      tasks_in_progress: 0,
      bugs_open: 0,
      plans_active: 0,
      requests_pending: 0,
      approvals_pending: 0,
      drones_online: 0,
      drone_jobs_pending: 0,
    })
    expect(res.body.attention).toEqual([])
    expect(res.body.recent_activity).toHaveLength(2) // the 2 registration events
    for (const line of res.body.recent_activity) expect(typeof line).toBe('string')
  })

  test('?verbose=true: full snapshot — key inventory locked for decomposition', async () => {
    const res = await request(app).get(api('/admin/overview') + '?verbose=true').set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual([
      'active_operators', 'agents', 'approval_queue', 'assets', 'bug_counts',
      'bugs', 'channel_counts', 'channels', 'concepts', 'context',
      'context_keys', 'drone_jobs', 'drones', 'events', 'instance_config',
      'messages', 'operators', 'organizations', 'pending_approvals',
      'pending_requests', 'plans', 'plugins', 'projects', 'tasks', 'team_chat',
    ].sort())
    expect(res.body.agents).toHaveLength(2)
    expect(res.body.tasks).toEqual({ open: [], in_progress: [], review: [], done: [] })
    expect(res.body.operators).toEqual([])
    // Seeded instance config rides along in full
    const cfgKeys = res.body.instance_config.map((r) => r.key).sort()
    expect(cfgKeys).toEqual(['admin_agent_id', 'admin_status', 'instance_mode', 'risk_tiers'])
  })

  test('verbose is a STRICT string check: ?verbose=1 still returns slim', async () => {
    // QUIRK (locked): req.query.verbose === 'true' — '1', 'yes', 'TRUE' all
    // silently fall back to the slim payload.
    const res = await request(app).get(api('/admin/overview') + '?verbose=1').set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['agents', 'attention', 'counts', 'recent_activity'])
  })
})

// =====================================================================
// 4. Instance config — GET list / GET one / PUT
// =====================================================================

describe('instance config', () => {
  test('GET /admin/config — seeded defaults, sorted by key, updated_by attribution', async () => {
    const res = await request(app).get(api('/admin/config')).set('X-Agent-Key', agentKey)
    expect(res.status).toBe(200)
    const seeded = res.body.filter((r) => r.updated_by === 'system')
    expect(seeded.map((r) => r.key)).toEqual(['admin_agent_id', 'admin_status', 'instance_mode', 'risk_tiers'])
    const byKey = Object.fromEntries(res.body.map((r) => [r.key, r.value]))
    expect(byKey.admin_status).toBe('coordinator')
    expect(byKey.instance_mode).toBe('developer')
    expect(byKey.admin_agent_id).toBe('')
    expect(JSON.parse(byKey.risk_tiers).money_action).toBe('critical')
  })

  test('GET /admin/config/:key — { key, value }; unknown key → 404', async () => {
    const ok = await request(app).get(api('/admin/config/admin_status')).set('X-Agent-Key', agentKey)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ key: 'admin_status', value: 'coordinator' })

    const missing = await request(app).get(api('/admin/config/no_such_key')).set('X-Agent-Key', agentKey)
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'Config key not found' })
  })

  test('PUT /admin/config/:key — missing value → 400 "value required"', async () => {
    const res = await request(app).put(api('/admin/config/char_probe')).set('X-Admin-Key', ADMIN_KEY).send({})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'value required' })
  })

  test('PUT string value round-trips; response echoes the stored value', async () => {
    const res = await request(app)
      .put(api('/admin/config/char_probe'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ value: 'hello' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ key: 'char_probe', value: 'hello' })
  })

  test('PUT non-string value is JSON.stringify-ed — reads back as a STRING', async () => {
    // QUIRK (locked): objects/numbers are stored stringified and the GET
    // returns the raw string — the caller must JSON.parse it themselves.
    const res = await request(app)
      .put(api('/admin/config/char_probe_obj'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ value: { a: 1 } })
    expect(res.status).toBe(200)
    expect(res.body.value).toBe('{"a":1}')
  })

  test('PUT value:null slips past validation and stores the string "null"', async () => {
    // LATENT BUG (locked): the guard is `value === undefined` only, so an
    // explicit null passes and JSON.stringify(null) → the 4-char string
    // 'null'. There is no way to distinguish it from a user typing "null".
    const res = await request(app)
      .put(api('/admin/config/char_probe_null'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ value: null })
    expect(res.status).toBe(200)
    expect(res.body.value).toBe('null')
  })

  test('updated_by attribution: X-Acting-As is honored; bare admin key → "__system__"', async () => {
    await request(app)
      .put(api('/admin/config/char_probe'))
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'm5Max')
      .send({ value: 'attributed' })
    const list = await request(app).get(api('/admin/config')).set('X-Admin-Key', ADMIN_KEY)
    const byKey = Object.fromEntries(list.body.map((r) => [r.key, r]))
    expect(byKey.char_probe.updated_by).toBe('m5Max')
    expect(byKey.char_probe_obj.updated_by).toBe('__system__')
  })
})

// =====================================================================
// 5. THE KILL SWITCH — PUT /admin/override + what "work routing paused"
//    actually gates.
// =====================================================================

describe('kill switch — PUT /admin/override', () => {
  test('EMPTY body defaults to FREEZE (destructive default, locked)', async () => {
    // SMELL (locked): `req.body.action || 'freeze'` — a body-less PUT (or a
    // typo'd field name) FREEZES the platform. The safe default would be 400.
    const res = await request(app).put(api('/admin/override')).set('X-Admin-Key', ADMIN_KEY).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      admin_status: 'frozen',
      message: 'Claude Admin frozen. All work assignments paused.',
    })
  })

  test('frozen state is persisted in instance config (admin_status=frozen)', async () => {
    const res = await request(app).get(api('/admin/config/admin_status')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.body.value).toBe('frozen')
  })

  test('while frozen: POST /work/request → 503 (the routing pause)', async () => {
    const res = await request(app)
      .post(api('/work/request'))
      .set('X-Agent-Key', agentKey)
      .send({ type: 'work_request' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Claude Admin is frozen. Work routing paused. Contact a human operator.' })
  })

  test('while frozen: GET /work/:agentId STILL WORKS — the freeze only gates /work/request', async () => {
    // LATENT GAP (locked): admin_status==='frozen' is checked in exactly ONE
    // place — POST /work/request. The work-pull path (GET /work/:agentId,
    // incl. ?auto_claim) and auto-dispatch are NOT gated, so a frozen
    // platform still hands out work to polling agents. "All work assignments
    // paused" (the freeze message) overstates what the switch does.
    const res = await request(app).get(api('/work/char-agent')).set('X-Agent-Key', agentKey)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('queue')
  })

  test('unfreeze restores coordinator status', async () => {
    const res = await request(app)
      .put(api('/admin/override'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ action: 'unfreeze' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      admin_status: 'coordinator',
      message: 'Claude Admin unfrozen. Resuming operations.',
    })
    const cfg = await request(app).get(api('/admin/config/admin_status')).set('X-Admin-Key', ADMIN_KEY)
    expect(cfg.body.value).toBe('coordinator')
  })

  test('after unfreeze: /work/request routes again — to the HARDCODED default admin agent', async () => {
    // SMELL (locked): admin_agent_id is seeded '' (falsy), so the fallback
    // 'greatness-claude' — a personal agent id hardcoded in platform code —
    // is where work requests land on every fresh instance.
    const res = await request(app)
      .post(api('/work/request'))
      .set('X-Agent-Key', agentKey)
      .send({ type: 'work_request' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.message_id).toBe('number')
    expect(res.body.routed_to).toBe('greatness-claude')
  })

  test('unknown action → 400', async () => {
    const res = await request(app)
      .put(api('/admin/override'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ action: 'explode' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'action must be freeze or unfreeze' })
  })
})

// =====================================================================
// 6. POST /admin/cleanup
// =====================================================================

describe('POST /admin/cleanup', () => {
  test('success shape — and savepoints_pruned is ABSENT from the response', async () => {
    // LATENT BUG (locked): the handler calls pruneSavepoints(eventDays) but
    // the db.js signature is pruneSavepoints(agentId, keepCount) — so it
    // "prunes" savepoints for a non-existent agent literally named 60/90 and
    // returns undefined. JSON.stringify drops undefined, so the documented
    // `savepoints_pruned` field never appears in the body, and NO savepoint
    // pruning actually happens through this endpoint.
    // ALSO (smell): this is an admin WRITE endpoint with no adminWriteLimiter,
    // unlike config/override/agents.
    const res = await request(app).post(api('/admin/cleanup')).set('X-Admin-Key', ADMIN_KEY).send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.messages_archived).toBe(0)
    expect(res.body.events_archived).toBe(0)
    expect(res.body.webhooks_archived).toBe(0)
    expect('savepoints_pruned' in res.body).toBe(false)
  })
})

// =====================================================================
// 7. HEALTH PATROL — GET /admin/health (runs the sweep) + /admin/health/history
// =====================================================================

describe('health patrol', () => {
  test('quiet DB: all stale counts zero, no actions, run_at is ISO', async () => {
    const res = await request(app).get(api('/admin/health')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      stale_agents: 0,
      stale_tasks: 0,
      stale_requests: 0,
      stale_drones: 0,
      stale_plan_steps: 0,
      actions: [],
      run_at: expect.any(String),
    })
    expect(Number.isNaN(Date.parse(res.body.run_at))).toBe(false)
  })

  test('history is empty while no patrol has found anything (quiet runs emit no events)', async () => {
    const res = await request(app).get(api('/admin/health/history')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('stale agent detection: online agent past threshold → counted, marked offline, action recorded', async () => {
    // Fixture via real routes: admin heartbeats ON BEHALF of the agent
    // (X-Admin-Key + agent_id body — the documented on-behalf path).
    const hb = await request(app)
      .post(api('/agents/heartbeat'))
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ agent_id: 'patrol-stale-1', status: 'online' })
    expect(hb.status).toBe(200)

    // No route can move the clock, so ONE surgical UPDATE backdates the
    // heartbeat past the 15-min default threshold. Everything else in this
    // block flows through real routes.
    db.getDB()
      .prepare("UPDATE agents SET last_heartbeat = datetime('now', '-60 minutes') WHERE id = ?")
      .run('patrol-stale-1')

    // Trigger the patrol WITH AN AGENT KEY — locking the smell that any agent
    // can run this MUTATING sweep via a GET (it force-marks peers offline).
    const res = await request(app).get(api('/admin/health')).set('X-Agent-Key', agentKey)
    expect(res.status).toBe(200)
    expect(res.body.stale_agents).toBe(1)
    expect(res.body.stale_tasks).toBe(0)
    expect(res.body.stale_requests).toBe(0)
    expect(res.body.stale_drones).toBe(0)
    expect(res.body.stale_plan_steps).toBe(0)
    expect(res.body.actions).toEqual([{ type: 'agent_offline', agent_id: 'patrol-stale-1' }])
  })

  test('patrol side effect: the stale agent is now offline (visible in overview)', async () => {
    const res = await request(app).get(api('/admin/overview')).set('X-Admin-Key', ADMIN_KEY)
    const agent = res.body.agents.find((a) => a.id === 'patrol-stale-1')
    expect(agent.status).toBe('offline')
  })

  test('patrol is self-limiting: a second run finds nothing (offline agents are skipped)', async () => {
    const res = await request(app).get(api('/admin/health')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.body.stale_agents).toBe(0)
    expect(res.body.actions).toEqual([])
  })

  test('GET /admin/health/history — patrol events, filterable by ?limit', async () => {
    const res = await request(app).get(api('/admin/health/history')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThanOrEqual(1)
    expect(res.body[0].type).toBe('health_patrol')
    expect(res.body[0].summary).toContain('patrol-stale-1')
    expect(res.body[0].summary).toContain('marked offline')

    const limited = await request(app).get(api('/admin/health/history') + '?limit=1').set('X-Admin-Key', ADMIN_KEY)
    expect(limited.body).toHaveLength(1)
  })
})

// =====================================================================
// 8. GET /reconciliation — read-only state-desync report (admin only)
// =====================================================================

describe('GET /reconciliation', () => {
  test('default: 24h threshold, zero counts, empty candidate arrays', async () => {
    const res = await request(app).get(api('/reconciliation')).set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      threshold_minutes: 1440,
      generated_at: expect.any(String),
      counts: { bugs: 0, tasks: 0, plan_steps: 0, total: 0 },
      bugs: [],
      tasks: [],
      plan_steps: [],
    })
  })

  test('?threshold_minutes and ?threshold_hours are honored; minutes wins when both given', async () => {
    const mins = await request(app).get(api('/reconciliation') + '?threshold_minutes=90').set('X-Admin-Key', ADMIN_KEY)
    expect(mins.body.threshold_minutes).toBe(90)

    const hours = await request(app).get(api('/reconciliation') + '?threshold_hours=2').set('X-Admin-Key', ADMIN_KEY)
    expect(hours.body.threshold_minutes).toBe(120)

    const both = await request(app)
      .get(api('/reconciliation') + '?threshold_minutes=30&threshold_hours=5')
      .set('X-Admin-Key', ADMIN_KEY)
    expect(both.body.threshold_minutes).toBe(30)
  })

  test('garbage / zero / negative thresholds silently fall back to 1440', async () => {
    for (const q of ['?threshold_minutes=abc', '?threshold_minutes=0', '?threshold_minutes=-5']) {
      const res = await request(app).get(api('/reconciliation') + q).set('X-Admin-Key', ADMIN_KEY)
      expect(res.body.threshold_minutes, q).toBe(1440)
    }
  })
})

// =====================================================================
// 9. RETIRED endpoints still listed in .claude/CLAUDE.md — locked as 404 so
//    a decomposition doesn't silently resurrect (or keep documenting) them.
// =====================================================================

describe('retired admin endpoints (doc drift — .claude/CLAUDE.md still lists them)', () => {
  test('POST /admin/churn-check → 404 (billing/provisioning surface removed)', async () => {
    const res = await request(app).post(api('/admin/churn-check')).set('X-Admin-Key', ADMIN_KEY).send({})
    expect(res.status).toBe(404)
  })

  test('POST /admin/deploy/health-check-all → 404 (billing/provisioning surface removed)', async () => {
    const res = await request(app).post(api('/admin/deploy/health-check-all')).set('X-Admin-Key', ADMIN_KEY).send({})
    expect(res.status).toBe(404)
  })
})
