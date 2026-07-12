import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION tests — GITHUB proxy + SPEND + RUNS + VOICE slices of the
// 6,539-line server/routes/mycelium.js god-file, locked BEFORE decomposition.
// These pin what the code DOES today, not what it should do. Latent-bug smells
// are flagged in comments but the CURRENT behavior is still asserted — fix
// nothing here; a behavior change after the split must fail one of these.
//
// Harness: same as studio-login.test.js — the REAL router mounted on a bare
// express app over a fresh temp DB (DATA_DIR + env set before the dynamic
// import; pool:'forks' isolates the module-global state per file).
//
// GitHub proxy: GITHUB_TOKEN is DELETED before the module import (the route
// file captures process.env.GITHUB_TOKEN at eval time), so every github test
// exercises the graceful-degradation path — no network I/O ever happens
// because the 503 short-circuits before fetch().

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let app
let lucyKey   // agent 'lucy'  (project proj-a) — writer in most tests
let echoKey   // agent 'echo'  (project proj-b) — the "someone else" agent

const api = (p) => '/api/mycelium' + p
const asAdmin = (req) => req.set('X-Admin-Key', ADMIN_KEY)

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-gsrv-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET
  delete process.env.GITHUB_TOKEN // lock the no-token degradation path

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Register two real agents through the real admin route so key hashing and
  // auth caching behave exactly as production. Plaintext keys returned once.
  for (const [id, project] of [['lucy', 'proj-a'], ['echo', 'proj-b']]) {
    const res = await asAdmin(request(app).post(api('/admin/agents')))
      .send({ id, name: id, project_id: project })
    if (res.status !== 200) throw new Error('agent registration failed: ' + JSON.stringify(res.body))
    if (id === 'lucy') lucyKey = res.body.api_key
    else echoKey = res.body.api_key
  }
})

afterAll(() => {
  rmSync(tmpDataDir, { recursive: true, force: true })
})

// ════════════════════════════════════════════════════════════════════════
// GITHUB PROXY — /github/prs/* (no GITHUB_TOKEN configured)
// ════════════════════════════════════════════════════════════════════════

describe('github proxy without GITHUB_TOKEN (graceful degradation, zero network)', () => {
  test('GET list PRs unauthenticated → 401 BEFORE the token check (auth gate outranks 503)', async () => {
    const res = await request(app).get(api('/github/prs/acme/widgets'))
    expect(res.status).toBe(401)
    // checkAgentOrAdmin falls through to agent auth; its error names the agent header
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('GET list PRs with an AGENT key → 503 GITHUB_TOKEN not configured (agents may reach the proxy)', async () => {
    const res = await request(app).get(api('/github/prs/acme/widgets')).set('X-Agent-Key', lucyKey)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'GITHUB_TOKEN not configured on server' })
  })

  test('GET list PRs with the admin key → same 503 (token gate is unconditional)', async () => {
    const res = await asAdmin(request(app).get(api('/github/prs/acme/widgets?state=closed')))
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('GITHUB_TOKEN not configured on server')
  })

  test('POST create PR is ADMIN-ONLY: agent key → 403 "Admin role required" (findings-§1 fix)', async () => {
    // checkAdmin now recognizes a valid X-Agent-Key as authentication
    // (classification only, grants nothing): authenticated-but-not-admin is an
    // honest 403, no longer the as-if-anonymous 401.
    const res = await request(app).post(api('/github/prs/acme/widgets'))
      .set('X-Agent-Key', lucyKey)
      .send({ title: 't', head: 'h', base: 'b' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  test('POST create PR with a WRONG admin key → 403 Invalid admin key', async () => {
    const res = await request(app).post(api('/github/prs/acme/widgets'))
      .set('X-Admin-Key', 'wrong-key-wrong-key-wrong-key-wrong-key-wrong')
      .send({ title: 't', head: 'h', base: 'b' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid admin key')
  })

  test('POST create PR with the admin key → 503 no-token (before any GitHub call)', async () => {
    const res = await asAdmin(request(app).post(api('/github/prs/acme/widgets')))
      .send({ title: 't', head: 'feat', base: 'master' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('GITHUB_TOKEN not configured on server')
  })

  test('POST merge PR with the admin key → 503 no-token (enforcement rules pass on empty DB, then token gate)', async () => {
    // Order locked: checkAdmin → checkEnforcementRules (no rules ⇒ allowed) → token check.
    const res = await asAdmin(request(app).post(api('/github/prs/acme/widgets/42/merge')))
      .send({ merge_method: 'squash' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('GITHUB_TOKEN not configured on server')
  })

  test('POST merge PR with only an agent key → 403 (merge is operator-track, not squad-track; findings-§1 fix)', async () => {
    const res = await request(app).post(api('/github/prs/acme/widgets/42/merge'))
      .set('X-Agent-Key', echoKey)
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })
})

// ════════════════════════════════════════════════════════════════════════
// SPEND — POST /spend, GET /spend, GET /spend/:agentId
// ════════════════════════════════════════════════════════════════════════

describe('spend tracking', () => {
  test('unauthenticated GET /spend → 401 (agent-key fall-through error)', async () => {
    const res = await request(app).get(api('/spend'))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('POST /spend full body as an agent → {ok:true}; entry readable with all fields', async () => {
    const post = await request(app).post(api('/spend')).set('X-Agent-Key', lucyKey).send({
      cost_usd: 0.5, source: 'claude', description: 'char test', model: 'opus',
      tokens_in: 1000, tokens_out: 200, project_id: 'spend-proj',
    })
    expect(post.status).toBe(200)
    expect(post.body).toEqual({ ok: true })

    const get = await asAdmin(request(app).get(api('/spend/lucy?project_id=spend-proj')))
    expect(get.status).toBe(200)
    expect(Array.isArray(get.body)).toBe(true)
    expect(get.body[0]).toMatchObject({
      agent_id: 'lucy', project_id: 'spend-proj', cost_usd: 0.5,
      source: 'claude', description: 'char test', model: 'opus',
      tokens_in: 1000, tokens_out: 200,
    })
    expect(get.body[0].created_at).toBeTruthy()
  })

  test('GET /spend aggregation: two agents on one project → exact total + per-(agent,project) breakdown DESC', async () => {
    await request(app).post(api('/spend')).set('X-Agent-Key', echoKey)
      .send({ cost_usd: 0.25, project_id: 'spend-proj', tokens_in: 10, tokens_out: 5 })

    const res = await asAdmin(request(app).get(api('/spend?project_id=spend-proj')))
    expect(res.status).toBe(200)
    expect(res.body.total_cost_usd).toBe(0.75) // 0.5 (lucy) + 0.25 (echo)
    expect(res.body.breakdown).toHaveLength(2)
    // Ordered total_cost DESC — lucy (0.5) before echo (0.25)
    expect(res.body.breakdown[0]).toMatchObject({
      agent_id: 'lucy', project_id: 'spend-proj', total_cost: 0.5,
      entry_count: 1, total_tokens_in: 1000, total_tokens_out: 200,
    })
    expect(res.body.breakdown[1]).toMatchObject({
      agent_id: 'echo', project_id: 'spend-proj', total_cost: 0.25,
      entry_count: 1, total_tokens_in: 10, total_tokens_out: 5,
    })
  })

  test('float math: total_cost_usd is rounded to 4dp, breakdown total_cost is the RAW sum', async () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE754. The top-line total gets
    // Math.round(x*10000)/10000 → exactly 0.3; the breakdown rows do NOT get
    // rounded (asymmetry locked here — consumers of breakdown see float dust).
    await request(app).post(api('/spend')).set('X-Agent-Key', lucyKey).send({ cost_usd: 0.1, project_id: 'round-proj' })
    await request(app).post(api('/spend')).set('X-Agent-Key', lucyKey).send({ cost_usd: 0.2, project_id: 'round-proj' })
    const res = await asAdmin(request(app).get(api('/spend?project_id=round-proj')))
    expect(res.body.total_cost_usd).toBe(0.3) // exact — the 4dp round
    expect(res.body.breakdown).toHaveLength(1)
    expect(res.body.breakdown[0].entry_count).toBe(2)
    expect(res.body.breakdown[0].total_cost).toBeCloseTo(0.3, 10) // raw sum, not rounded
  })

  test('LATENT SMELL (locked): non-numeric cost_usd is silently coerced to $0 and logged as ok', async () => {
    // parseFloat('not-a-number') → NaN → `NaN || 0` → 0. Garbage input does NOT
    // 400 — it books a zero-cost row. A spend meter that silently drops cost on
    // malformed input under-reports; still: current behavior is 200 {ok:true}.
    const res = await request(app).post(api('/spend')).set('X-Agent-Key', lucyKey)
      .send({ cost_usd: 'not-a-number', project_id: 'garbage-proj' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const entries = await asAdmin(request(app).get(api('/spend/lucy?project_id=garbage-proj')))
    expect(entries.body).toHaveLength(1)
    expect(entries.body[0].cost_usd).toBe(0)
  })

  test('negative cost_usd → 400 (the one validation the route does perform)', async () => {
    const res = await request(app).post(api('/spend')).set('X-Agent-Key', lucyKey)
      .send({ cost_usd: -1, project_id: 'spend-proj' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cost_usd must be non-negative')
  })

  test('admin key + X-Acting-As attributes spend to the acting identity; without it → literal "__system__"', async () => {
    await asAdmin(request(app).post(api('/spend')))
      .set('X-Acting-As', 'm5max-attrib')
      .send({ cost_usd: 0.07, project_id: 'attrib-proj' })
    const attributed = await asAdmin(request(app).get(api('/spend/m5max-attrib?project_id=attrib-proj')))
    expect(attributed.body).toHaveLength(1)
    expect(attributed.body[0]).toMatchObject({ agent_id: 'm5max-attrib', cost_usd: 0.07 })

    // SMELL (locked): admin key with no X-Acting-As books spend under the
    // sentinel id "__system__" — real cost rows attributed to a pseudo-agent.
    await asAdmin(request(app).post(api('/spend'))).send({ cost_usd: 0.03, project_id: 'attrib-proj' })
    const sys = await asAdmin(request(app).get(api('/spend/__system__?project_id=attrib-proj')))
    expect(sys.body).toHaveLength(1)
    expect(sys.body[0].cost_usd).toBe(0.03)
  })

  test('GET /spend/:agentId honors ?limit; cross-agent reads are ALLOWED (any agent reads any ledger)', async () => {
    // lucy has ≥3 entries by now; limit=1 returns exactly one.
    const limited = await request(app).get(api('/spend/lucy?limit=1')).set('X-Agent-Key', lucyKey)
    expect(limited.body).toHaveLength(1)
    // echo's key reading lucy's ledger: permitted — spend reads have no
    // ownership check (characterized, not endorsed).
    // NOTE: entries are ORDER BY created_at DESC with NO rowid tiebreak —
    // same-second entries have unspecified relative order, so we don't pin it.
    const cross = await request(app).get(api('/spend/lucy')).set('X-Agent-Key', echoKey)
    expect(cross.status).toBe(200)
    expect(cross.body.length).toBeGreaterThanOrEqual(3)
    expect(cross.body.every((e) => e.agent_id === 'lucy')).toBe(true)
  })

  test('?since in the future filters everything out (entries list AND summary)', async () => {
    const entries = await asAdmin(request(app).get(api('/spend/lucy?since=2999-01-01')))
    expect(entries.body).toEqual([])
    const summary = await asAdmin(request(app).get(api('/spend?since=2999-01-01')))
    expect(summary.body).toEqual({ total_cost_usd: 0, breakdown: [] })
  })
})

// ════════════════════════════════════════════════════════════════════════
// RUNS — POST/GET/PUT /runs, /runs/claim, /runs/:id/rerun
// ════════════════════════════════════════════════════════════════════════

describe('runs CRUD + claim queue (route layer over the db-runs contract)', () => {
  test('unauthenticated POST /runs → 401', async () => {
    const res = await request(app).post(api('/runs')).send({ brief: 'nope' })
    expect(res.status).toBe(401)
  })

  test('POST /runs as an agent opens a RUNNING run bound to the caller; full row returned', async () => {
    const res = await request(app).post(api('/runs')).set('X-Agent-Key', lucyKey)
      .send({ model: 'glm-5.2', project_id: 'proj-a', brief: 'characterize me' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      agent_id: 'lucy', model: 'glm-5.2', project_id: 'proj-a',
      brief: 'characterize me', status: 'running',
    })
    expect(res.body.id).toBeTruthy()          // server-minted UUID
    expect(res.body.started_at).toBeTruthy()  // running ⇒ execution started now
    expect(res.body.claimed_by).toBeNull()
    expect(res.body.finished_at).toBeNull()
    expect(res.body.rerun_of).toBeNull()
  })

  test('impersonation guard: a NON-admin body agent_id is ignored — run binds to the authenticated agent', async () => {
    const res = await request(app).post(api('/runs')).set('X-Agent-Key', lucyKey)
      .send({ agent_id: 'echo', brief: 'not echos run' })
    expect(res.status).toBe(200)
    expect(res.body.agent_id).toBe('lucy')
  })

  test('admin MAY attribute a run to any agent via body agent_id (the bridge-records-on-behalf path)', async () => {
    const res = await asAdmin(request(app).post(api('/runs')))
      .send({ agent_id: 'scout-x', brief: 'admin recorded', status: 'pending' })
    expect(res.status).toBe(200)
    expect(res.body.agent_id).toBe('scout-x')  // no existence check on the agent id
    expect(res.body.status).toBe('pending')
    expect(res.body.started_at).toBeNull()     // pending ⇒ starts on claim, not at queue time
  })

  test('client-supplied run id is honored; LATENT SMELL (locked): a DUPLICATE id → raw 500, not 409', async () => {
    const first = await request(app).post(api('/runs')).set('X-Agent-Key', lucyKey)
      .send({ id: 'run-dup-1', brief: 'first' })
    expect(first.status).toBe(200)
    expect(first.body.id).toBe('run-dup-1')
    // UNIQUE constraint escapes as an unhandled throw → Express default 500.
    // (Compare POST /skills which maps UNIQUE → 409.) Locked as-is.
    const dup = await request(app).post(api('/runs')).set('X-Agent-Key', lucyKey)
      .send({ id: 'run-dup-1', brief: 'second' })
    expect(dup.status).toBe(500)
  })

  test('PUT /runs/:id by the OWNER records telemetry; JSON arrays stored as strings; untouched fields persist', async () => {
    const open = await request(app).post(api('/runs')).set('X-Agent-Key', lucyKey)
      .send({ id: 'run-tel-1', model: 'glm-5.2', brief: 'telemetry' })
    expect(open.status).toBe(200)
    const res = await request(app).put(api('/runs/run-tel-1')).set('X-Agent-Key', lucyKey)
      .send({
        status: 'completed', turns: 12, tokens_in: 4000, tokens_out: 900,
        tool_calls: [{ name: 'edit_file', count: 3 }], artifacts: [{ name: 'Foo.swift' }],
        result: 'done', duration_ms: 42000,
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('completed')
    expect(res.body.turns).toBe(12)
    expect(res.body.tool_calls).toBe('[{"name":"edit_file","count":3}]') // array → string
    expect(res.body.artifacts).toBe('[{"name":"Foo.swift"}]')
    expect(res.body.result).toBe('done')
    expect(res.body.model).toBe('glm-5.2') // not passed ⇒ unchanged
  })

  test('PUT /runs/:id by a DIFFERENT agent → 403 Forbidden — not your run', async () => {
    const res = await request(app).put(api('/runs/run-tel-1')).set('X-Agent-Key', echoKey)
      .send({ status: 'failed' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden — not your run')
  })

  test('PUT /runs/:id by admin is allowed on anyone\'s run', async () => {
    const res = await asAdmin(request(app).put(api('/runs/run-tel-1')))
      .send({ energy_joules: 0.5 })
    expect(res.status).toBe(200)
    expect(res.body.energy_joules).toBeCloseTo(0.5)
  })

  test('PUT / GET on a missing run id → 404 Run not found', async () => {
    const put = await asAdmin(request(app).put(api('/runs/no-such-run'))).send({ status: 'failed' })
    expect(put.status).toBe(404)
    expect(put.body.error).toBe('Run not found')
    const get = await asAdmin(request(app).get(api('/runs/no-such-run')))
    expect(get.status).toBe(404)
    expect(get.body.error).toBe('Run not found')
  })

  test('GET /runs/:id returns the FULL row (result present); GET /runs list is SLIM (heavy fields dropped)', async () => {
    const detail = await asAdmin(request(app).get(api('/runs/run-tel-1')))
    expect(detail.status).toBe(200)
    expect(detail.body.result).toBe('done')

    const list = await asAdmin(request(app).get(api('/runs?agent_id=lucy')))
    expect(list.status).toBe(200)
    expect(list.body.every((r) => r.agent_id === 'lucy')).toBe(true)
    const row = list.body.find((r) => r.id === 'run-tel-1')
    expect(row).toBeTruthy()
    expect(row.result).toBeUndefined()      // slim list: no result/tool_calls/error
    expect(row.tool_calls).toBeUndefined()
    expect(row.error).toBeUndefined()
    expect('claimed_by' in row).toBe(true)  // light claim/timing fields kept
    expect('created_at' in row).toBe(true)

    const limited = await asAdmin(request(app).get(api('/runs?limit=1')))
    expect(limited.body).toHaveLength(1)
  })

  test('claim flow: worker claims the pending run under ITS OWN identity; empty queue → 204', async () => {
    await asAdmin(request(app).post(api('/runs')))
      .send({ id: 'run-claim-1', agent_id: 'clm-target', brief: 'queued work', status: 'pending' })

    // echo (the authenticated principal) claims — claimed_by is the WORKER,
    // never client-supplied; body agent_id only SCOPES which queue to pull.
    const claim = await request(app).post(api('/runs/claim')).set('X-Agent-Key', echoKey)
      .send({ agent_id: 'clm-target' })
    expect(claim.status).toBe(200)
    expect(claim.body.id).toBe('run-claim-1')
    expect(claim.body.status).toBe('claimed')
    expect(claim.body.claimed_by).toBe('echo')
    expect(claim.body.started_at).toBeTruthy() // execution starts on claim

    // Queue for that agent is now empty → 204 with no body
    const empty = await request(app).post(api('/runs/claim')).set('X-Agent-Key', echoKey)
      .send({ agent_id: 'clm-target' })
    expect(empty.status).toBe(204)
    expect(empty.body).toEqual({})
  })

  test('the CLAIMER (not just the owner) may report telemetry on the claimed run', async () => {
    const res = await request(app).put(api('/runs/run-claim-1')).set('X-Agent-Key', echoKey)
      .send({ status: 'completed', result: 'worker done' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('completed')
    expect(res.body.result).toBe('worker done')
  })

  test('rerun is OPERATOR-track: agent key → 403; admin key → fresh PENDING run linked via rerun_of', async () => {
    const denied = await request(app).post(api('/runs/run-tel-1/rerun')).set('X-Agent-Key', lucyKey)
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('Operator or admin access required')

    const rerun = await asAdmin(request(app).post(api('/runs/run-tel-1/rerun')))
    expect(rerun.status).toBe(200)
    expect(rerun.body.rerun_of).toBe('run-tel-1')
    expect(rerun.body.status).toBe('pending')
    expect(rerun.body.started_at).toBeNull()
    expect(rerun.body.agent_id).toBe('lucy')          // same agent
    expect(rerun.body.brief).toBe('telemetry')        // same brief
    expect(rerun.body.id).not.toBe('run-tel-1')       // new row, original untouched

    const missing = await asAdmin(request(app).post(api('/runs/no-such-run/rerun')))
    expect(missing.status).toBe(404)
  })
})

// ════════════════════════════════════════════════════════════════════════
// VOICE — POST /voice/command intent routing
// ════════════════════════════════════════════════════════════════════════

describe('voice command routing', () => {
  const voice = (text, auth = true) => {
    const req = request(app).post(api('/voice/command'))
    return (auth ? asAdmin(req) : req).send(text === undefined ? {} : { text })
  }

  test('unauthenticated → 401; missing text → 400 text required', async () => {
    expect((await voice('status', false)).status).toBe(401)
    const res = await voice(undefined)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('text required')
  })

  test('wake word alone → {action:none, "How can I help?"}', async () => {
    const res = await voice('Hey Mycelium.')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ action: 'none', response: 'How can I help?' })
  })

  test('"Hey Mycelium, status" → wake word stripped, status intent fires', async () => {
    const res = await voice('Hey Mycelium, status')
    expect(res.body.action).toBe('status')
    expect(res.body.response).toMatch(/^\d+ agents online, \d+ working\./)
  })

  test('task query → tasks intent with count (empty DB: "0 open tasks. All clear.")', async () => {
    const res = await voice('what tasks are open')
    expect(res.body.action).toBe('tasks')
    expect(res.body.response).toBe('0 open tasks. All clear.')
  })

  test('bug query → bugs intent (empty DB: "0 open bugs. No open bugs.")', async () => {
    const res = await voice('any open bugs')
    expect(res.body.action).toBe('bugs')
    expect(res.body.response).toBe('0 open bugs. No open bugs.')
  })

  test('"check on <agent>" → agent_status for a registered agent', async () => {
    const res = await voice('check on lucy')
    expect(res.body.action).toBe('agent_status')
    expect(res.body.response).toMatch(/^lucy is /)
  })

  test('drone query without the word "status" → drone_status', async () => {
    const res = await voice('how are the drones')
    expect(res.body.action).toBe('drone_status')
    expect(res.body.response).toBe('0 drones registered. ') // trailing space: empty join
  })

  test('LATENT SMELL (locked): "drone status" is captured by the STATUS branch, never reaching drone_status', async () => {
    // Intent branches are checked in order and the status regex matches the
    // literal word "status" anywhere — so any drone/agent phrase containing
    // "status" is swallowed by the generic status intent.
    const res = await voice('drone status')
    expect(res.body.action).toBe('status')
  })

  test('LATENT SMELL (locked): "assign task X to Y" hits the TASKS branch (contains "task"), not assign', async () => {
    const res = await voice('assign task cleanup to lucy')
    expect(res.body.action).toBe('tasks')
  })

  test('assign phrasing without the word "task" → assign intent, echoes the parsed request', async () => {
    const res = await voice('assign fix the header to lucy')
    expect(res.body.action).toBe('assign')
    expect(res.body.response).toContain('assign "fix the header" to lucy.')
  })

  test('LATENT SMELL (locked): "what is lucy doing" falls to UNKNOWN — the agent-status regex needs a word AFTER "doing"', async () => {
    // /(?:status|what.* doing|where.*is|check on)\s+(\S+)/ — "what.* doing"
    // consumes to end of string, leaving nothing for \s+(\S+). The most natural
    // agent-status phrasing is unroutable; locked as current behavior.
    const res = await voice('what is lucy doing')
    expect(res.body.action).toBe('unknown')
  })

  test('unmatched text → unknown with the heard-text echo', async () => {
    const res = await voice('make me a sandwich')
    expect(res.body.action).toBe('unknown')
    expect(res.body.response).toBe('I heard: "make me a sandwich". Try asking about agent status, tasks, bugs, or drones.')
  })
})
