import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// CHARACTERIZATION tests for the AGENTS surface of server/routes/mycelium.js —
// part of the tests-first safety net under the god-file before decomposition.
// These tests pin what the code DOES today, not what it should do. Latent-bug
// smells are noted in comments but the CURRENT behavior is still asserted.
//
// Endpoints covered:
//   POST /admin/agents            (the admin "register agent" route)
//   GET  /agents
//   GET  /agents/:id
//   POST /agents/heartbeat        (incl. admin-on-behalf via body agent_id)
//   GET  /boot/:agentId           (slim + verbose)
//   GET  /work/:agentId           (+ ?auto_claim=true)
//   POST /work/request
//   GET  /agents/:id/profile, PUT /agents/:id/profile
//   GET  /agents/profiles, GET /agents/leaderboard
//   GET  /agents/:agentId/skills
//   /agent-templates CRUD + apply
//
// Latent smells noted (and LOCKED as current behavior):
//   S1. Admin-on-behalf heartbeat does NOT validate agent_id exists — a
//       heartbeat for a ghost agent returns 200 and writes a savepoint row
//       (agent_savepoints has no FK on agents).
//   S2. Auto-claim's `claimed` object carries the PRE-claim status ('open'),
//       even though the task row is already 'in_progress' in the DB.
//   S3. GET /agents/:agentId/skills returns [] (200) for unknown agents —
//       no existence check, no 404.
//   S4. Boot's changes_since_last is an OBJECT (savepoint summary counts),
//       not the human-readable string formatSavepointSummary means to build:
//       that formatter reads diff.new_messages/task_changes/... — fields
//       computeSavepointDiff never emits (they live under diff.changes with
//       different names) — so it always falls through to `diff.summary`,
//       the counts object. Only a savepoint-less agent gets the string
//       fallback 'No changes since last session.'
//
// Harness copied from test/unit/studio-login.test.js: real router mounted
// against a fresh temp DB, env set before the dynamic import. pool:'forks'
// isolates the module-global rate limiters. Test ORDER inside this file is
// load-bearing (fixtures accumulate; see section comments) — do not reorder.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let app

// Agent fixtures registered in beforeAll through the REAL admin route.
// worker1: general heartbeat/boot testbed (accumulates savepoints + 1 request)
// worker2: kept "clean" — single heartbeat (savepoint determinism), profile
//          404-then-create, auto-claim testbed
// queue-agent: work-queue priority-ordering testbed (own project, no boots)
const agents = {} // id -> api_key

function jwtFor(role, displayName) {
  return jwt.sign(
    { studioUser: true, userId: 999, username: displayName.toLowerCase(), displayName, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

function admin(req) {
  return req.set('X-Admin-Key', ADMIN_KEY)
}

async function registerAgent(id, name, projectId, extra) {
  const res = await admin(request(app).post('/api/mycelium/admin/agents'))
    .send(Object.assign({ id, name, project_id: projectId }, extra || {}))
  if (res.status !== 200) throw new Error('test setup: agent registration failed: ' + JSON.stringify(res.body))
  agents[id] = res.body.api_key
  return res
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-agents-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET
  // getInstanceUrl tiers 1/2 must be OFF so registration uses the legacy
  // Host-header fallback (what production-without-env does today).
  delete process.env.PUBLIC_BASE_URL
  delete process.env.ALLOWED_HOSTS

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  await registerAgent('worker1', 'Worker One', 'proj-a')
  await registerAgent('worker2', 'Worker Two', 'proj-b')
  await registerAgent('queue-agent', 'Queue Agent', 'queue-proj')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// ======== 1. POST /admin/agents — register (admin only) ========

describe('POST /admin/agents (register)', () => {
  test('success: returns one-time api_key (dvk_ prefix) + mcp_config + message', async () => {
    const res = await admin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'reg-probe', name: 'Reg Probe', project_id: 'proj-reg' })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('reg-probe')
    expect(res.body.api_key).toMatch(/^dvk_[0-9a-f]{48}$/)
    expect(res.body.message).toMatch(/Store this key/)
    // MCP config is pre-wired to this instance for the new agent
    const env = res.body.mcp_config.mcpServers.mycelium.env
    expect(env.MYCELIUM_AGENT_ID).toBe('reg-probe')
    expect(env.MYCELIUM_API_KEY).toBe(res.body.api_key)
    expect(env.MYCELIUM_URL).toMatch(/\/api\/mycelium$/)
    agents['reg-probe'] = res.body.api_key
  })

  test('returned key round-trips as X-Agent-Key auth', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents')
      .set('X-Agent-Key', agents['reg-probe'])
    expect(res.status).toBe(200)
  })

  test('missing id/name/project_id → 400', async () => {
    const res = await admin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'incomplete', name: 'No Project' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('id, name, and project_id are required')
  })

  test('duplicate id → 409', async () => {
    const res = await admin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'worker1', name: 'Imposter', project_id: 'proj-x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Agent worker1 already exists')
  })

  test('unknown template_id → 400', async () => {
    const res = await admin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'tmpl-fail', name: 'T', project_id: 'p', template_id: 'no-such-template' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Template no-such-template not found')
  })

  test('auth matrix: no creds 401 / bad key 403 / non-admin JWT 403 / agent key 403', async () => {
    const body = { id: 'authz', name: 'A', project_id: 'p' }
    const none = await request(app).post('/api/mycelium/admin/agents').send(body)
    expect(none.status).toBe(401)
    expect(none.body.error).toBe('Authentication required')

    const badKey = await request(app).post('/api/mycelium/admin/agents')
      .set('X-Admin-Key', 'wrong-key').send(body)
    expect(badKey.status).toBe(403)
    expect(badKey.body.error).toBe('Invalid admin key')

    const member = await request(app).post('/api/mycelium/admin/agents')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack')).send(body)
    expect(member.status).toBe(403)
    expect(member.body.error).toBe('Admin role required')

    // FIXED (findings §1): checkAdmin still never GRANTS via agent keys, but a
    // valid X-Agent-Key now counts as authentication → 403 (not authorized),
    // no longer the misleading 401 (as-if-anonymous).
    const agentKey = await request(app).post('/api/mycelium/admin/agents')
      .set('X-Agent-Key', agents['worker1']).send(body)
    expect(agentKey.status).toBe(403)
    expect(agentKey.body.error).toBe('Admin role required')
  })
})

// ======== 2. GET /agents ========

describe('GET /agents', () => {
  test('agent key → 200 array with registered agents; api_key_hash never leaks', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents')
      .set('X-Agent-Key', agents['worker1'])
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const ids = res.body.map((a) => a.id)
    expect(ids).toEqual(expect.arrayContaining(['worker1', 'worker2', 'queue-agent']))
    for (const a of res.body) {
      expect(a).not.toHaveProperty('api_key_hash')
      expect(a).toHaveProperty('status')
      expect(a).toHaveProperty('capabilities')
    }
    // Default capabilities when none supplied at registration
    const w1 = res.body.find((a) => a.id === 'worker1')
    expect(w1.capabilities).toBe('["code","assets"]')
    expect(w1.project_id).toBe('proj-a')
  })

  test('agents registered under project_id "drone" are filtered out of the list', async () => {
    await registerAgent('drone-1', 'Drone One', 'drone')
    const res = await admin(request(app).get('/api/mycelium/agents'))
    expect(res.status).toBe(200)
    expect(res.body.map((a) => a.id)).not.toContain('drone-1')
  })

  test('unauthenticated → 401', async () => {
    const res = await request(app).get('/api/mycelium/agents')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })
})

// ======== 3. POST /agents/heartbeat ========
// NOTE: every heartbeat here sends a non-empty working_on ON PURPOSE — an
// online/idle heartbeat with empty working_on triggers auto-dispatch
// (dispatchWorkToIdleAgents), which would steal the unassigned work fixtures
// staged for the priority-ordering tests below.

describe('POST /agents/heartbeat', () => {
  test('unauthenticated → 401; invalid agent key → 403', async () => {
    const none = await request(app).post('/api/mycelium/agents/heartbeat').send({ status: 'busy' })
    expect(none.status).toBe(401)
    expect(none.body.error).toBe('Missing X-Agent-Key header')

    const bad = await request(app).post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', 'dvk_' + 'f'.repeat(48)).send({ status: 'busy' })
    expect(bad.status).toBe(403)
    expect(bad.body.error).toBe('Invalid agent key')
  })

  test('success shape {ok, pending, wake}; status/working_on/llm_model/runtime land on the agent row', async () => {
    const res = await request(app).post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', agents['worker1'])
      .send({ status: 'busy', working_on: 'characterizing', llm_model: 'test-model', llm_backend: 'test-be', runtime: 'vitest' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, pending: 0, wake: false })

    const agent = await admin(request(app).get('/api/mycelium/agents/worker1'))
    expect(agent.body.status).toBe('busy')
    expect(agent.body.working_on).toBe('characterizing')
    expect(agent.body.llm_model).toBe('test-model')
    expect(agent.body.llm_backend).toBe('test-be')
    expect(agent.body.runtime).toBe('vitest')
  })

  test('invalid status → 400 machine-readable invalid_enum shape', async () => {
    const res = await request(app).post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', agents['worker1'])
      .send({ status: 'zonked', working_on: 'x' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'status must be one of: online, offline, idle, busy',
      code: 'invalid_enum',
      field: 'status',
      value: 'zonked',
      allowed: ['online', 'offline', 'idle', 'busy']
    })
  })

  test('omitted status defaults to online', async () => {
    const res = await request(app).post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', agents['worker1'])
      .send({ working_on: 'still here' })
    expect(res.status).toBe(200)
    const agent = await admin(request(app).get('/api/mycelium/agents/worker1'))
    expect(agent.body.status).toBe('online')
  })

  test('admin-on-behalf: X-Admin-Key + body agent_id heartbeats any agent', async () => {
    const res = await admin(request(app).post('/api/mycelium/agents/heartbeat'))
      .send({ agent_id: 'worker1', status: 'idle', working_on: 'delegated' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const agent = await admin(request(app).get('/api/mycelium/agents/worker1'))
    expect(agent.body.status).toBe('idle')
    expect(agent.body.working_on).toBe('delegated')
  })

  test('admin key WITHOUT agent_id falls through to agent auth → 401', async () => {
    const res = await admin(request(app).post('/api/mycelium/agents/heartbeat'))
      .send({ status: 'busy', working_on: 'x' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  // SMELL S1 (locked): the admin-on-behalf path never checks the agent exists.
  // A heartbeat for a ghost agent returns 200 and writes a savepoint row for it
  // (agent_savepoints has no FK), while the agents table stays untouched.
  test('LATENT S1: admin-on-behalf heartbeat for a NONEXISTENT agent still 200s and writes a savepoint', async () => {
    const res = await admin(request(app).post('/api/mycelium/agents/heartbeat'))
      .send({ agent_id: 'ghost-agent', status: 'busy', working_on: 'haunting' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, pending: 0, wake: false })
    // No agent row was created...
    const agent = await admin(request(app).get('/api/mycelium/agents/ghost-agent'))
    expect(agent.status).toBe(404)
    // ...but a savepoint WAS written for the ghost
    const sp = await admin(request(app).get('/api/mycelium/agents/ghost-agent/savepoint'))
    expect(sp.status).toBe(200)
    expect(sp.body.agent_id).toBe('ghost-agent')
    expect(sp.body.working_on).toBe('haunting')
  })

  test('every heartbeat writes a savepoint (session_id + state_snapshot round-trip)', async () => {
    // worker2's ONLY heartbeat in this file — keeps getLatestSavepoint
    // deterministic (heartbeat_at has second resolution; ties are unordered).
    const res = await request(app).post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', agents['worker2'])
      .send({
        status: 'busy', working_on: 'savepoint-probe',
        session_id: 'sess-42', state_snapshot: { phase: 'testing', n: 7 }
      })
    expect(res.status).toBe(200)
    const sp = await request(app)
      .get('/api/mycelium/agents/worker2/savepoint')
      .set('X-Agent-Key', agents['worker2'])
    expect(sp.status).toBe(200)
    expect(sp.body.agent_id).toBe('worker2')
    expect(sp.body.session_id).toBe('sess-42')
    expect(sp.body.working_on).toBe('savepoint-probe')
    // state_snapshot is stored/returned as a JSON *string*
    expect(JSON.parse(sp.body.state_snapshot)).toEqual({ phase: 'testing', n: 7 })
  })

  test('pending request surfaces in heartbeat inbox: pending>0, wake=true', async () => {
    const reqRes = await admin(request(app).post('/api/mycelium/requests'))
      .set('X-Acting-As', 'm5Max')
      .send({ to_agent: 'worker1', content: 'please answer the probe' })
    expect(reqRes.status).toBe(200)

    const hb = await request(app).post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', agents['worker1'])
      .send({ status: 'busy', working_on: 'inbox-probe' })
    expect(hb.status).toBe(200)
    expect(hb.body.pending).toBeGreaterThanOrEqual(1)
    expect(hb.body.wake).toBe(true)
    expect(hb.body.inbox.requests.map((r) => r.id)).toContain(reqRes.body.id)
  })
})

// ======== 4. GET /boot/:agentId ========

describe('GET /boot/:agentId', () => {
  test('agent-key-ONLY endpoint: admin key gets 401', async () => {
    const res = await admin(request(app).get('/api/mycelium/boot/worker1'))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('another agent\'s key → 403 key/ID mismatch', async () => {
    const res = await request(app)
      .get('/api/mycelium/boot/worker1')
      .set('X-Agent-Key', agents['worker2'])
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Agent key does not match agent ID')
  })

  test('slim boot (default): context bundle shape', async () => {
    const res = await request(app)
      .get('/api/mycelium/boot/worker1')
      .set('X-Agent-Key', agents['worker1'])
    expect(res.status).toBe(200)
    const b = res.body
    expect(b.agent).toMatchObject({ id: 'worker1', project: 'proj-a' })
    expect(Array.isArray(b.agent.capabilities)).toBe(true)
    // counts block — all numeric
    for (const k of ['directives', 'requests', 'messages_unread', 'tasks_mine', 'bugs_open', 'plans_active']) {
      expect(typeof b.counts[k], 'counts.' + k).toBe('number')
    }
    // the request sent in the heartbeat section is still pending
    expect(b.counts.requests).toBe(1)
    expect(b.pending_requests).toHaveLength(1)
    expect(b.pending_requests[0].content).toBe('please answer the probe')
    expect(Array.isArray(b.work_queue)).toBe(true)
    expect(Array.isArray(b.other_agents)).toBe(true)
    expect(b).toHaveProperty('savepoint')
    // SMELL S4 (locked): worker1 HAS savepoints, so changes_since_last is the
    // summary-counts OBJECT, not the formatted string (see header note).
    expect(b.savepoint.has_savepoint).toBe(true)
    for (const k of ['messages', 'tasks', 'context', 'plans', 'bugs', 'events']) {
      expect(typeof b.changes_since_last[k], 'changes_since_last.' + k).toBe('number')
    }
    expect(b).toHaveProperty('sleep_mode')
    expect(typeof b.autonomous_mode).toBe('boolean')
    expect(typeof b.operators_available).toBe('number')
    // boot auto-creates the profile and counts the session
    expect(b.profile.agent_id).toBe('worker1')
    expect(b.profile.session_count).toBeGreaterThanOrEqual(1)
  })

  test('verbose boot (?verbose=true): legacy full payload with route-added extras', async () => {
    const res = await request(app)
      .get('/api/mycelium/boot/worker1?verbose=true')
      .set('X-Agent-Key', agents['worker1'])
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('savepoint')
    expect(res.body).toHaveProperty('sleep_mode')
    expect(typeof res.body.autonomous_mode).toBe('boolean')
    expect(typeof res.body.operators_available).toBe('number')
    expect(res.body.profile.agent_id).toBe('worker1')
  })
})

// ======== 5. Agent profiles ========

describe('agent profiles', () => {
  test('GET /agents/:id/profile before any boot/PUT → 404 Profile not found', async () => {
    // worker2 has heartbeated but never booted — heartbeat does NOT create a profile
    const res = await admin(request(app).get('/api/mycelium/agents/worker2/profile'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Profile not found')
  })

  test('PUT /agents/:id/profile (admin) creates-if-missing and returns the parsed profile', async () => {
    const res = await admin(request(app).put('/api/mycelium/agents/worker2/profile'))
      .send({
        display_name: 'Worker Two Prime',
        specializations: ['swift', 'verify'],
        preferred_projects: ['proj-b'],
        max_concurrent: '3', // string in → parseInt'd
        profile_data: { motto: 'measure twice' }
      })
    expect(res.status).toBe(200)
    expect(res.body.agent_id).toBe('worker2')
    expect(res.body.display_name).toBe('Worker Two Prime')
    expect(res.body.specializations).toEqual(['swift', 'verify'])
    expect(res.body.preferred_projects).toEqual(['proj-b'])
    expect(res.body.max_concurrent).toBe(3)
    expect(res.body.profile_data).toEqual({ motto: 'measure twice' })
  })

  test('agent can update its OWN profile; cross-agent is 403', async () => {
    const own = await request(app).put('/api/mycelium/agents/worker1/profile')
      .set('X-Agent-Key', agents['worker1'])
      .send({ display_name: 'Worker One Self' })
    expect(own.status).toBe(200)
    expect(own.body.display_name).toBe('Worker One Self')

    const cross = await request(app).put('/api/mycelium/agents/worker2/profile')
      .set('X-Agent-Key', agents['worker1'])
      .send({ display_name: 'hijacked' })
    expect(cross.status).toBe(403)
    expect(cross.body.error).toBe('Can only update your own profile')
  })

  test('PUT profile for a nonexistent agent → 404 Agent not found (FK rejects the insert)', async () => {
    const res = await admin(request(app).put('/api/mycelium/agents/no-such-agent/profile'))
      .send({ display_name: 'nobody' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Agent not found')
  })

  test('GET /agents/profiles lists all profiles (route not shadowed by /agents/:id)', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents/profiles')
      .set('X-Agent-Key', agents['worker1'])
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const ids = res.body.map((p) => p.agent_id)
    expect(ids).toEqual(expect.arrayContaining(['worker1', 'worker2']))
    const w2 = res.body.find((p) => p.agent_id === 'worker2')
    expect(w2.specializations).toEqual(['swift', 'verify']) // parsed, not JSON string
  })

  test('GET /agents/leaderboard: stat columns, sorted view, limit param honored', async () => {
    const res = await admin(request(app).get('/api/mycelium/agents/leaderboard'))
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThanOrEqual(2)
    for (const row of res.body) {
      expect(row).toHaveProperty('agent_id')
      expect(row).toHaveProperty('total_tasks_completed')
      expect(row).toHaveProperty('total_bugs_fixed')
      expect(row).toHaveProperty('total_prs_created')
      expect(row).toHaveProperty('session_count')
      expect(Array.isArray(row.specializations)).toBe(true)
    }
    const limited = await admin(request(app).get('/api/mycelium/agents/leaderboard?limit=1'))
    expect(limited.body).toHaveLength(1)
  })

  test('profile reads require auth → 401', async () => {
    const res = await request(app).get('/api/mycelium/agents/profiles')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })
})

// ======== 6. GET /agents/:agentId/skills ========

describe('GET /agents/:agentId/skills', () => {
  test('agent with no skills → 200 []', async () => {
    const res = await request(app)
      .get('/api/mycelium/agents/worker1/skills')
      .set('X-Agent-Key', agents['worker1'])
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  // SMELL S3 (locked): no existence check — unknown agents get [] not 404.
  test('LATENT S3: unknown agent → 200 [] (no 404)', async () => {
    const res = await admin(request(app).get('/api/mycelium/agents/no-such-agent/skills'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('unauthenticated → 401', async () => {
    const res = await request(app).get('/api/mycelium/agents/worker1/skills')
    expect(res.status).toBe(401)
  })
})

// ======== 7. GET /agents/:id ========

describe('GET /agents/:id', () => {
  test('returns the agent row without api_key_hash', async () => {
    const res = await admin(request(app).get('/api/mycelium/agents/worker1'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('worker1')
    expect(res.body).not.toHaveProperty('api_key_hash')
  })

  test('unknown agent → 404', async () => {
    const res = await admin(request(app).get('/api/mycelium/agents/never-registered'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Agent not found')
  })
})

// ======== 8. Agent templates ========

describe('agent templates', () => {
  test('GET /agent-templates: agent-readable, empty at start', async () => {
    const res = await request(app)
      .get('/api/mycelium/agent-templates')
      .set('X-Agent-Key', agents['worker1'])
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('POST requires admin: agent key → 403 (findings-§1 fix); missing name → 400', async () => {
    const noAdmin = await request(app).post('/api/mycelium/agent-templates')
      .set('X-Agent-Key', agents['worker1'])
      .send({ id: 't1', name: 'T1' })
    expect(noAdmin.status).toBe(403)
    expect(noAdmin.body.error).toBe('Admin role required')

    const missing = await admin(request(app).post('/api/mycelium/agent-templates'))
      .send({ id: 'no-name' })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('id and name are required')
  })

  test('POST success → 201 with defaults; created_by = X-Acting-As', async () => {
    const res = await admin(request(app).post('/api/mycelium/agent-templates'))
      .set('X-Acting-As', 'm5Max')
      .send({ id: 'brain-template', name: 'Brain', description: 'squad brain', llm_backend: 'omlx', llm_model: 'qwen3', runtime: 'squad_loop', capabilities: ['code'] })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: 'brain-template', name: 'Brain', description: 'squad brain',
      llm_backend: 'omlx', llm_model: 'qwen3', runtime: 'squad_loop',
      agent_type: 'agent', created_by: 'm5Max'
    })
    expect(res.body.capabilities).toEqual(['code'])
    expect(res.body.team_ids).toEqual([])
    expect(res.body.profile_rules).toEqual({})
  })

  test('duplicate id → 409; GET one → 200; unknown → 404', async () => {
    const dup = await admin(request(app).post('/api/mycelium/agent-templates'))
      .send({ id: 'brain-template', name: 'Again' })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('Template brain-template already exists')

    const one = await admin(request(app).get('/api/mycelium/agent-templates/brain-template'))
    expect(one.status).toBe(200)
    expect(one.body.id).toBe('brain-template')

    const missing = await admin(request(app).get('/api/mycelium/agent-templates/nope'))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Template not found')
  })

  test('PUT updates and returns the parsed template; unknown → 404', async () => {
    const res = await admin(request(app).put('/api/mycelium/agent-templates/brain-template'))
      .send({ name: 'Brain v2', capabilities: ['code', 'research'] })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Brain v2')
    expect(res.body.capabilities).toEqual(['code', 'research'])

    const missing = await admin(request(app).put('/api/mycelium/agent-templates/nope'))
      .send({ name: 'x' })
    expect(missing.status).toBe(404)
  })

  test('apply template to an existing agent copies runtime/llm/capabilities', async () => {
    const res = await admin(request(app).post('/api/mycelium/agent-templates/brain-template/apply/worker2'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.template).toBe('brain-template')
    expect(res.body.agent.llm_backend).toBe('omlx')
    expect(res.body.agent.llm_model).toBe('qwen3')
    expect(res.body.agent.runtime).toBe('squad_loop')
    expect(JSON.parse(res.body.agent.capabilities)).toEqual(['code', 'research'])

    const noAgent = await admin(request(app).post('/api/mycelium/agent-templates/brain-template/apply/no-such-agent'))
    expect(noAgent.status).toBe(404)
    expect(noAgent.body.error).toBe('Agent not found')

    const noTmpl = await admin(request(app).post('/api/mycelium/agent-templates/nope/apply/worker2'))
    expect(noTmpl.status).toBe(404)
    expect(noTmpl.body.error).toBe('Template not found')
  })

  test('register with template_id inherits template defaults', async () => {
    await registerAgent('tmpl-agent', 'Templated', 'proj-t', { template_id: 'brain-template' })
    const agent = await admin(request(app).get('/api/mycelium/agents/tmpl-agent'))
    expect(agent.body.llm_backend).toBe('omlx')
    expect(agent.body.llm_model).toBe('qwen3')
    expect(agent.body.runtime).toBe('squad_loop')
    expect(JSON.parse(agent.body.capabilities)).toEqual(['code', 'research'])
  })

  test('DELETE → {ok, deleted}; template is gone; deleting again → 404', async () => {
    const del = await admin(request(app).delete('/api/mycelium/agent-templates/brain-template'))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true, deleted: 'brain-template' })

    const gone = await admin(request(app).get('/api/mycelium/agent-templates/brain-template'))
    expect(gone.status).toBe(404)

    const again = await admin(request(app).delete('/api/mycelium/agent-templates/brain-template'))
    expect(again.status).toBe(404)
  })
})

// ======== 9. GET /work/:agentId — basics + auto-claim ========
// worker2's queue must be empty at the start of this section: no requests,
// tasks, bugs, or plans touch proj-b before here.

describe('GET /work/:agentId', () => {
  test('empty queue → {ok, queue:[]}; auto_claim on empty queue adds NO claimed key', async () => {
    const plain = await request(app)
      .get('/api/mycelium/work/worker2')
      .set('X-Agent-Key', agents['worker2'])
    expect(plain.status).toBe(200)
    expect(plain.body).toEqual({ ok: true, queue: [] })

    const auto = await request(app)
      .get('/api/mycelium/work/worker2?auto_claim=true')
      .set('X-Agent-Key', agents['worker2'])
    expect(auto.status).toBe(200)
    expect(auto.body).toEqual({ ok: true, queue: [] })
    expect('claimed' in auto.body).toBe(false)
  })

  test('auth: cross-agent 403, unknown agent 404 (admin), unauthenticated 401', async () => {
    const cross = await request(app)
      .get('/api/mycelium/work/worker1')
      .set('X-Agent-Key', agents['worker2'])
    expect(cross.status).toBe(403)
    expect(cross.body.error).toBe('Can only access your own work queue')

    const unknown = await admin(request(app).get('/api/mycelium/work/never-registered'))
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Agent not found')

    const none = await request(app).get('/api/mycelium/work/worker1')
    expect(none.status).toBe(401)
  })

  test('auto_claim=true claims the top item: task flips to in_progress, claimed carries description', async () => {
    const task = await admin(request(app).post('/api/mycelium/tasks'))
      .send({ title: 'claim me', description: 'the probe task', project_id: 'proj-b', assignee: 'worker2' })
    expect(task.status).toBe(200)

    const res = await request(app)
      .get('/api/mycelium/work/worker2?auto_claim=true')
      .set('X-Agent-Key', agents['worker2'])
    expect(res.status).toBe(200)
    expect(res.body.queue[0]).toMatchObject({ type: 'task', id: task.body.id })
    expect(res.body.claimed).toMatchObject({
      type: 'task',
      id: task.body.id,
      title: 'claim me',
      description: 'the probe task',
      claimed: true
    })
    // SMELL S2 (locked): claimed.status is the PRE-claim snapshot ('open')
    // even though the row below is already in_progress.
    expect(res.body.claimed.status).toBe('open')

    const after = await admin(request(app).get('/api/mycelium/tasks/' + task.body.id))
    expect(after.body.status).toBe('in_progress')
    expect(after.body.assignee).toBe('worker2')
  })
})

// ======== 10. Work-queue priority ordering ========
// Staged on queue-agent in its own project. Fixtures created via the real
// routes. Expected ladder (buildWorkQueue):
//   1 request > 2 in-progress plan step > 3 pending assigned plan step >
//   4 in-progress task > 5 open task > 6 assigned bug >
//   7 unassigned plan step > 8 unassigned bug
// (directives are deprecated and never served). NOTE: the unassigned-bug
// fixture leaks into every agent's queue (no team = see everything), which is
// why this section runs after all other /work assertions.

describe('work queue priority ordering', () => {
  let ids = {}

  beforeAll(async () => {
    const A = 'queue-agent'
    const P = 'queue-proj'

    // priority 1 — pending request
    const reqRes = await admin(request(app).post('/api/mycelium/requests'))
      .send({ to_agent: A, content: 'priority-1 request' })
    ids.request = reqRes.body.id

    // priority 2 — in-progress plan step assigned to agent
    const plan1 = await admin(request(app).post('/api/mycelium/plans'))
      .send({ title: 'plan-inprog', project_id: P, steps: [{ title: 'step-in-progress', assignee: A }] })
    const plan1Full = await admin(request(app).get('/api/mycelium/plans/' + plan1.body.id))
    ids.stepInProgress = plan1Full.body.steps[0].id
    await admin(request(app).put('/api/mycelium/plans/' + plan1.body.id + '/steps/' + ids.stepInProgress))
      .send({ status: 'in_progress' })

    // priority 3 — pending plan step assigned to agent (first step: priors complete)
    const plan2 = await admin(request(app).post('/api/mycelium/plans'))
      .send({ title: 'plan-pending', project_id: P, steps: [{ title: 'step-pending', assignee: A }] })
    const plan2Full = await admin(request(app).get('/api/mycelium/plans/' + plan2.body.id))
    ids.stepPending = plan2Full.body.steps[0].id

    // priority 4 — in-progress task
    const t1 = await admin(request(app).post('/api/mycelium/tasks'))
      .send({ title: 'task-in-progress', project_id: P, assignee: A })
    await admin(request(app).put('/api/mycelium/tasks/' + t1.body.id)).send({ status: 'in_progress' })
    ids.taskInProgress = t1.body.id

    // priority 5 — open task
    const t2 = await admin(request(app).post('/api/mycelium/tasks'))
      .send({ title: 'task-open', project_id: P, assignee: A })
    ids.taskOpen = t2.body.id

    // priority 6 — open bug assigned to agent (POST /bugs requires title AND description)
    const b1 = await admin(request(app).post('/api/mycelium/bugs'))
      .send({ title: 'bug-assigned', description: 'assigned bug body', project_id: P, assignee: A })
    if (b1.status !== 200) throw new Error('bug fixture failed: ' + JSON.stringify(b1.body))
    ids.bugAssigned = b1.body.id

    // priority 7 — unassigned pending plan step in agent's project
    const plan3 = await admin(request(app).post('/api/mycelium/plans'))
      .send({ title: 'plan-unassigned', project_id: P, steps: [{ title: 'step-unassigned' }] })
    const plan3Full = await admin(request(app).get('/api/mycelium/plans/' + plan3.body.id))
    ids.stepUnassigned = plan3Full.body.steps[0].id

    // priority 8 — unassigned bug (no planner registered → shown, not deferred)
    const b2 = await admin(request(app).post('/api/mycelium/bugs'))
      .send({ title: 'bug-unassigned', description: 'unassigned bug body', project_id: P })
    if (b2.status !== 200) throw new Error('bug fixture failed: ' + JSON.stringify(b2.body))
    ids.bugUnassigned = b2.body.id
  })

  test('queue is served in the full 8-level priority ladder', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/queue-agent')
      .set('X-Agent-Key', agents['queue-agent'])
    expect(res.status).toBe(200)
    const q = res.body.queue
    expect(q.map((i) => i.type)).toEqual([
      'request',
      'plan_step',
      'plan_step',
      'task',
      'task',
      'bug',
      'plan_step_unassigned',
      'bug_unassigned'
    ])
    expect(q.map((i) => i.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(q.map((i) => i.id)).toEqual([
      ids.request,
      ids.stepInProgress,
      ids.stepPending,
      ids.taskInProgress,
      ids.taskOpen,
      ids.bugAssigned,
      ids.stepUnassigned,
      ids.bugUnassigned
    ])
    // shape spot-checks per item type
    expect(q[0]).toMatchObject({ type: 'request', content: 'priority-1 request', title: expect.stringContaining('Request from') })
    expect(q[1]).toMatchObject({ plan_title: 'plan-inprog', status: 'in_progress' })
    expect(q[2]).toMatchObject({ plan_title: 'plan-pending', status: 'pending' })
    expect(q[5]).toMatchObject({ type: 'bug', severity: 'normal', status: 'open' })
  })

  test('auto_claim on a request-topped queue returns the request WITHOUT mutating it', async () => {
    const res = await request(app)
      .get('/api/mycelium/work/queue-agent?auto_claim=true')
      .set('X-Agent-Key', agents['queue-agent'])
    expect(res.status).toBe(200)
    expect(res.body.claimed).toMatchObject({ type: 'request', id: ids.request })
    // requests are returned as-is — no claimed flag, still pending next poll
    expect(res.body.claimed.claimed).toBeUndefined()
    const again = await request(app)
      .get('/api/mycelium/work/queue-agent')
      .set('X-Agent-Key', agents['queue-agent'])
    expect(again.body.queue[0]).toMatchObject({ type: 'request', id: ids.request })
  })
})

// ======== 11. POST /work/request ========

describe('POST /work/request', () => {
  test('agent-key-ONLY endpoint: admin key gets 401', async () => {
    const res = await admin(request(app).post('/api/mycelium/work/request'))
      .send({ type: 'task_request' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('missing type → 400', async () => {
    const res = await request(app).post('/api/mycelium/work/request')
      .set('X-Agent-Key', agents['worker1'])
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('type required (task_request, asset_request, work_request)')
  })

  test('success routes a request message to the default Claude Admin agent', async () => {
    const res = await request(app).post('/api/mycelium/work/request')
      .set('X-Agent-Key', agents['worker1'])
      .send({ type: 'task_request', description: 'give me work' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.message_id).toBe('number')
    // admin_agent_id instance config is unset → hardcoded default
    expect(res.body.routed_to).toBe('greatness-claude')
  })
})
