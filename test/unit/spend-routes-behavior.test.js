// Behavior gate for the spend-tracking HTTP contract.
//
// WHY THIS EXISTS: README.md markets spend tracking as a live feature
// ("per-agent / per-project / per-model cost logging with summary endpoints")
// and the three routes in server/routes/spend.js are real and carefully built,
// but NOTHING exercised the HTTP contract — no test POSTed a cost and read it
// back, asserted aggregation/rounding/filtering, or pinned auth. A regression
// that broke getSpendSummary's reduce or flipped an auth check shipped
// undetected (fresh-DB `npm test` was green). This gate pins the behavior a
// stranger relies on: "I POST a cost; it appears in my summary; the summary
// aggregates with correct rounding; the filters narrow; auth is enforced."
//
// Harness mirrors test/unit/attribution-spoof-auth.test.js: real router via
// supertest, a fresh temp DATA_DIR + ADMIN_KEY set BEFORE the dynamic import so
// db.js / routes pick them up at module-eval time, and agents with real SHA-256
// key hashes. spend.js is registered onto the mycelium router at module-eval
// (mycelium.js: registerSpendRoutes(router, { asyncHandler, checkAgentOrAdmin,
// checkGuardrails })), so mounting the mycelium router includes the spend routes
// exactly as production wires them.
//
// "TRACKS REALITY" GUARD: the rounding factor and the default per-agent limit
// are READ FROM server/routes/spend.js (below) rather than re-typed, and a test
// asserts the source still carries the documented literals (10000, 50). Change
// either literal and this gate REDS instead of silently desynchronizing.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// --- source-pinned contract values (read, not re-typed) ---
const SPEND_SRC = readFileSync(
  fileURLToPath(new URL('../../server/routes/spend.js', import.meta.url)),
  'utf8'
)
// spend.js:56 — `Math.round(total * 10000) / 10000` (rounds total_cost_usd to 4dp).
// The `/ 10000` is division after the call, so there is no trailing paren.
const ROUND_MATCH = SPEND_SRC.match(/Math\.round\(total\s*\*\s*(\d+)\)\s*\/\s*(\d+)/)
const ROUND_FACTOR = ROUND_MATCH ? parseInt(ROUND_MATCH[1], 10) : NaN
const ROUND_DIVISOR = ROUND_MATCH ? parseInt(ROUND_MATCH[2], 10) : NaN
// spend.js:43 — `parseInt(req.query.limit) || 50` (default per-agent read limit)
const LIMIT_MATCH = SPEND_SRC.match(/parseInt\(req\.query\.limit\)\s*\|\|\s*(\d+)/)
const DEFAULT_LIMIT = LIMIT_MATCH ? parseInt(LIMIT_MATCH[1], 10) : NaN

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const KEYA = 'dvk_' + 'a'.repeat(48) // agentA — owns the spend we log
const KEYB = 'dvk_' + 'b'.repeat(48) // agentB — a DIFFERENT agent (authz probe)
const AGENTA = 'spend-agentA'
const AGENTB = 'spend-agentB'

let tmpDataDir
let app

// SQLite CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS' (second granularity).
function utcSec(d = new Date()) {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-spend-behavior-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Two real agents (default role 'agent', NOT admin) whose keys we hold.
  const hashA = crypto.createHash('sha256').update(KEYA).digest('hex')
  const hashB = crypto.createHash('sha256').update(KEYB).digest('hex')
  db.createAgent(AGENTA, 'Spend Agent A', 'a-proj', hashA, '["code"]')
  db.createAgent(AGENTB, 'Spend Agent B', 'b-proj', hashB, '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Log a cost as agentA. Returns the supertest response.
function postSpendAsA(body) {
  return request(app)
    .post('/api/mycelium/spend')
    .set('X-Agent-Key', KEYA)
    .send(body)
}

describe('POST /spend — records a row, read back via GET /spend/:agentId', () => {
  test('a posted cost is persisted and readable on the per-agent endpoint', async () => {
    const proj = 'record-proj'
    const res = await postSpendAsA({
      cost_usd: 1.5,
      model: 'model-x',
      project_id: proj,
      source: 'suite',
      description: 'a recorded cost',
      tokens_in: 123,
      tokens_out: 456,
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const read = await request(app)
      .get('/api/mycelium/spend/' + AGENTA + '?project_id=' + proj)
      .set('X-Agent-Key', KEYA)
    expect(read.status).toBe(200)
    expect(Array.isArray(read.body)).toBe(true)
    expect(read.body.length).toBeGreaterThanOrEqual(1)
    const row = read.body[0]
    expect(row.agent_id).toBe(AGENTA)
    expect(row.cost_usd).toBe(1.5)
    expect(row.model).toBe('model-x')
    expect(row.project_id).toBe(proj)
    expect(row.tokens_in).toBe(123)
    expect(row.tokens_out).toBe(456)
  })

  test('negative cost_usd is rejected with 400', async () => {
    const res = await postSpendAsA({ cost_usd: -1, project_id: 'neg-proj' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/non-negative/i)
  })
})

describe('GET /spend — aggregation with correct rounding', () => {
  test('two entries aggregate to their sum', async () => {
    const proj = 'agg-proj'
    await postSpendAsA({ cost_usd: 1.5, project_id: proj })
    await postSpendAsA({ cost_usd: 2.5, project_id: proj })

    const res = await request(app)
      .get('/api/mycelium/spend?project_id=' + proj)
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
    expect(res.body.total_cost_usd).toBe(4)
    expect(Array.isArray(res.body.breakdown)).toBe(true)
  })

  test('0.1 + 0.2 rounds to 0.3, not 0.30000000000000004 (exercises the 4dp round)', async () => {
    const proj = 'round-proj'
    await postSpendAsA({ cost_usd: 0.1, project_id: proj })
    await postSpendAsA({ cost_usd: 0.2, project_id: proj })

    const res = await request(app)
      .get('/api/mycelium/spend?project_id=' + proj)
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
    // Pinned contract value:
    expect(res.body.total_cost_usd).toBe(0.3)
    // And tied to the live source factor (so a precision change is loud):
    const raw = 0.1 + 0.2
    expect(res.body.total_cost_usd).toBe(Math.round(raw * ROUND_FACTOR) / ROUND_DIVISOR)
  })
})

describe('filters — ?project_id= and ?since= narrow BOTH endpoints', () => {
  test('?project_id= narrows the per-agent endpoint and the summary', async () => {
    await postSpendAsA({ cost_usd: 10, project_id: 'pA' })
    await postSpendAsA({ cost_usd: 20, project_id: 'pB' })

    const perAgent = await request(app)
      .get('/api/mycelium/spend/' + AGENTA + '?project_id=pA')
      .set('X-Agent-Key', KEYA)
    expect(perAgent.status).toBe(200)
    expect(perAgent.body.every((e) => e.project_id === 'pA')).toBe(true)

    const summary = await request(app)
      .get('/api/mycelium/spend?project_id=pA')
      .set('X-Agent-Key', KEYA)
    expect(summary.status).toBe(200)
    // pA has cost 10 (from this test); summary scoped to pA excludes pB's 20.
    expect(summary.body.breakdown.every((r) => r.project_id === 'pA')).toBe(true)
    expect(summary.body.total_cost_usd).toBe(10)
  })

  test('?since= narrows the per-agent endpoint and the summary', async () => {
    const proj = 'since-proj'
    await postSpendAsA({ cost_usd: 1, project_id: proj }) // E1 — before the boundary

    // Cross a SQLite second boundary so E1 and E2 have distinct created_at.
    await sleep(1100)
    const boundary = utcSec() // E2 will be inserted at/after this second
    await postSpendAsA({ cost_usd: 2, project_id: proj }) // E2 — at/after the boundary

    // Per-agent: since=boundary keeps only E2.
    const perAgent = await request(app)
      .get('/api/mycelium/spend/' + AGENTA + '?project_id=' + proj + '&since=' + encodeURIComponent(boundary))
      .set('X-Agent-Key', KEYA)
    expect(perAgent.status).toBe(200)
    expect(perAgent.body.length).toBe(1)
    expect(perAgent.body[0].cost_usd).toBe(2)

    // Sanity: without `since`, both entries are present.
    const allEntries = await request(app)
      .get('/api/mycelium/spend/' + AGENTA + '?project_id=' + proj)
      .set('X-Agent-Key', KEYA)
    expect(allEntries.body.length).toBe(2)

    // Summary: since=boundary totals only E2.
    const summary = await request(app)
      .get('/api/mycelium/spend?project_id=' + proj + '&since=' + encodeURIComponent(boundary))
      .set('X-Agent-Key', KEYA)
    expect(summary.status).toBe(200)
    expect(summary.body.total_cost_usd).toBe(2)
  })
})

describe('auth — X-Agent-Key is required and validated', () => {
  test('missing X-Agent-Key on the per-agent read -> 401', async () => {
    const res = await request(app).get('/api/mycelium/spend/' + AGENTA)
    expect(res.status).toBe(401)
  })

  test('an invalid X-Agent-Key on the per-agent read -> 403', async () => {
    const res = await request(app)
      .get('/api/mycelium/spend/' + AGENTA)
      .set('X-Agent-Key', 'dvk_not_a_real_key')
    expect(res.status).toBe(403)
  })

  test('missing X-Agent-Key on POST /spend -> 401', async () => {
    const res = await request(app)
      .post('/api/mycelium/spend')
      .send({ cost_usd: 1, project_id: 'noauth-proj' })
    expect(res.status).toBe(401)
  })

  test('an invalid X-Agent-Key on the summary -> 403', async () => {
    const res = await request(app)
      .get('/api/mycelium/spend')
      .set('X-Agent-Key', 'dvk_not_a_real_key')
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// AUTHZ PIN — per-agent spend read is currently OPEN across agents (IDOR).
// ===========================================================================
// DECISION RULE (brief 49): this gate PINS THE CURRENTLY OBSERVED BEHAVIOR.
// It does NOT choose the "correct" authz — that call is Gilbert's, deliberately
// left open here because flipping a public authz semantic silently is forbidden
// without confirmation.
//
// WHAT STEP-0 PROVED (dynamic, on a booted server): an authenticated agent B
// can GET /spend/agentA and read agentA's FULL spend log — costs, models, token
// counts, project membership. `who` is resolved by checkAgentOrAdmin but never
// compared to req.params.agentId (spend.js:37-39).
//
// WHY IT IS PROBABLY A FORGOTTEN CHECK, NOT A DELIBERATE POLICY:
//   - The house pattern for per-agent reads IS isolation: /work/:agentId
//     (mycelium.js: `who !== agentId -> 403 "Can only access your own work
//     queue"`), /boot/:agentId, and the savepoint routes (agents.js) all enforce
//     `who === agentId`. That pattern was established by the security-hardening
//     commit "IDOR fixes" (832d447, 2026-03-05).
//   - Spend was added 3 days later (f277f79, 2026-03-08) and did NOT pick up the
//     guard. There is no commit message, code comment, or doc anywhere asserting
//     spend should be shared/open across agents.
//   - A deliberate "open transparency" policy would more likely not resolve
//     `who` at all, or would document the asymmetry. It does neither.
//
// WHAT THIS TEST DOES: asserts the OPEN behavior (B reads A -> 200). If someone
// later adds the isolation guard (B -> 403), this test REDS — correctly flagging
// that the authz semantic changed, so the pin is updated deliberately and the
// README/contract is updated with it. If someone removes auth entirely, the
// auth tests above red first.
//
// WHAT THIS TEST DOES NOT DO: assert that open is *correct*. If Gilbert decides
// spend should be isolated like /work, add the `who === agentId` guard at
// spend.js:37 (mirroring mycelium.js /work), flip this assertion to expect 403,
// and document spend as isolated in README.md:24.
// ===========================================================================
describe('AUTHZ PIN — GET /spend/:agentId is currently OPEN across agents', () => {
  test('agentB can read agentA spend entries today (IDOR; see NOTE — open for Gilbert)', async () => {
    // Ensure agentA has at least one entry agentB could see.
    await postSpendAsA({ cost_usd: 7.77, model: 'visible-to-B', project_id: 'idor-proj' })

    const res = await request(app)
      .get('/api/mycelium/spend/' + AGENTA + '?project_id=idor-proj')
      .set('X-Agent-Key', KEYB) // a DIFFERENT, merely-authenticated agent
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThanOrEqual(1)
    // Cross-agent visibility confirmed: B sees A's rows.
    expect(res.body.some((e) => e.agent_id === AGENTA && e.cost_usd === 7.77)).toBe(true)
  })
})

describe('contract source-pins (tracks reality — reds if the literals drift)', () => {
  test('the rounding factor is read from source and is 10000 (4dp)', () => {
    expect(ROUND_FACTOR).toBe(10000)
    expect(ROUND_DIVISOR).toBe(10000) // both literals in `* 10000) / 10000`
  })

  test('the default per-agent limit is read from source and is 50', () => {
    expect(DEFAULT_LIMIT).toBe(50)
  })

  test('the default limit is actually applied (post limit+1, read back limit)', async () => {
    const proj = 'limit-proj'
    for (let i = 0; i < DEFAULT_LIMIT + 1; i++) {
      await postSpendAsA({ cost_usd: 0.01, project_id: proj })
    }
    const res = await request(app)
      .get('/api/mycelium/spend/' + AGENTA + '?project_id=' + proj)
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(DEFAULT_LIMIT) // truncated, not limit+1
  })
})
