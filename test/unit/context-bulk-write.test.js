import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Gate: POST /context/keys/bulk — the bulk-write HTTP contract.
//
// README markets "Bulk writes supported" on a context store that is "versioned
// on every write", and .claude/CLAUDE.md documents the exact shape ("Bulk set
// up to 50 keys in one call"). Until this gate that contract had zero
// behavioral coverage — only route/db manifest snapshots name the endpoint.
//
// WHAT THIS PINS (observed live on a real boot, STEP 0 probe 2026-08-18):
//   1. happy path — a <=cap batch writes every key (readable back via the
//      single-key GET) and returns one {ok:true} per entry;
//   2. cap — keys.length > cap -> 400 "Maximum <cap> keys per batch";
//      empty or non-array keys -> 400 "keys array is required";
//   3. per-entry validation + PARTIAL SUCCESS — an entry missing
//      namespace/key/data yields a per-entry error while valid entries in the
//      SAME batch still land (200 with a mixed results array, never a
//      whole-batch 500);
//   4. F1 scope — an entry overwriting an existing key owned by a project the
//      caller can't access -> per-entry 'forbidden: cross-project'; the other
//      entries in the batch are unaffected and the target key is NOT written;
//   5. VERSIONING COUPLING (the load-bearing one) — bulk writes go through the
//      same upsertContextKey as single-key PUTs, so a bulk OVERWRITE archives
//      the prior value to context_history (brief 47's single-write invariant,
//      extended to bulk load). A refactor that routes bulk around
//      upsertContextKey (raw INSERT, no history row) reds here. Shared shape
//      of that invariant: the FIRST write of a key has no history row (no
//      prior value to archive); history rows appear on overwrite — identical
//      to the PUT path, which uses the same function.
//   6. auth — missing X-Agent-Key -> 401; invalid key -> 403.
//
// TRACKS REALITY: the cap and the exact per-entry messages are DERIVED from
// server/routes/context.js at load and then checked against the pinned
// literals below. Change either in the route and this gate reds until the pin
// (and the documented "up to 50 keys" line) are reconciled in the same
// commit — the gate never silently follows a contract change.
//
// Out of scope, deliberately: POST /context/keys/bulk-delete (cap 200,
// admin-only) needs its own brief; single-write versioning itself is owned by
// the context rollback/contract gate — this file only asserts bulk doesn't
// bypass it.

// ---- derive the contract from the route source (do not re-type) ----
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTE_SOURCE = readFileSync(join(__dirname, '../../server/routes/context.js'), 'utf8')

const CAP = Number((ROUTE_SOURCE.match(/keys\.length > (\d+)/) || [])[1])
const CAP_MSG = (ROUTE_SOURCE.match(/'([^']*Maximum \d+ keys per batch[^']*)'/) || [])[1]
const KEYS_ARRAY_MSG = (ROUTE_SOURCE.match(/'([^']*keys array is required[^']*)'/) || [])[1]
const REQUIRED_MSG = (ROUTE_SOURCE.match(/'([^']*namespace, key, and data are required[^']*)'/) || [])[1]
const CROSS_PROJECT_MSG = (ROUTE_SOURCE.match(/'([^']*forbidden: cross-project[^']*)'/) || [])[1]

// The documented contract (README "Bulk writes supported"; .claude/CLAUDE.md
// "Bulk set up to 50 keys in one call" — that file is untracked, so the
// literal lives HERE and must be reconciled here if the cap ever changes).
const PINNED_CAP = 50

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY_ALPHA = 'dvk_test_ctx_bulk_alpha_0123456789abcdef01'
const AGENT_KEY_BRAVO = 'dvk_test_ctx_bulk_bravo_0123456789abcdef012'
const AGENT_HASH_ALPHA = crypto.createHash('sha256').update(AGENT_KEY_ALPHA).digest('hex')
const AGENT_HASH_BRAVO = crypto.createHash('sha256').update(AGENT_KEY_BRAVO).digest('hex')

const BASE = '/api/mycelium/context/keys'
const BULK = `${BASE}/bulk`

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-ctx-bulk-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  // Two projects; bulk-alpha writes in project alpha, bulk-bravo in bravo.
  db.createProject('alpha', 'Alpha', '', '', null, 'product')
  db.createProject('bravo', 'Bravo', '', '', null, 'product')
  db.createAgent('bulk-alpha', 'Bulk Alpha', 'alpha', AGENT_HASH_ALPHA, '["code"]')
  db.createAgent('bulk-bravo', 'Bulk Bravo', 'bravo', AGENT_HASH_BRAVO, '["code"]')

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function agentHeaders(key) {
  return { 'X-Agent-Key': key }
}

describe('source pins — the gate tracks server/routes/context.js', () => {
  test('the bulk cap is derivable from the route and equals the documented 50', () => {
    expect(Number.isInteger(CAP), 'could not derive the bulk cap from server/routes/context.js ' +
      '(looked for /keys\\.length > (\\d+)/) — the route shape changed; reconcile this gate and ' +
      'the documented "up to N keys" line in the same commit').toBe(true)
    expect(CAP, 'the bulk cap in server/routes/context.js no longer matches the documented ' +
      '50-key contract — if the change is intentional, update PINNED_CAP here and the docs ' +
      'in the same commit').toBe(PINNED_CAP)
  })

  test('the cap message is derivable and consistent with the numeric cap', () => {
    expect(CAP_MSG, 'could not find the cap rejection message in server/routes/context.js').toBeTruthy()
    expect(CAP_MSG).toBe(`Maximum ${PINNED_CAP} keys per batch`)
  })

  test('the per-entry/validation message literals are derivable and unchanged', () => {
    expect(KEYS_ARRAY_MSG, 'could not find "keys array is required" in server/routes/context.js').toBeTruthy()
    expect(KEYS_ARRAY_MSG).toBe('keys array is required')
    expect(REQUIRED_MSG, 'could not find the per-entry required-fields message in server/routes/context.js').toBeTruthy()
    expect(REQUIRED_MSG).toBe('namespace, key, and data are required')
    expect(CROSS_PROJECT_MSG, 'could not find the per-entry cross-project message in server/routes/context.js').toBeTruthy()
    expect(CROSS_PROJECT_MSG).toBe('forbidden: cross-project')
  })
})

describe('POST /context/keys/bulk — happy path', () => {
  test('a 2-key batch writes every key, readable back, one {ok:true} per entry', async () => {
    const res = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [
        { namespace: 'hp_ns', key: 'k1', data: 'v1' },
        { namespace: 'hp_ns', key: 'k2', data: 'v2' },
      ] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Array.isArray(res.body.results)).toBe(true)
    expect(res.body.results).toHaveLength(2)
    for (const r of res.body.results) {
      expect(r.ok).toBe(true)
      expect(r.error).toBeUndefined()
    }
    expect(res.body.results.map((r) => r.key).sort()).toEqual(['k1', 'k2'])

    // readable back through the single-key read path
    const k1 = await request(app).get(`${BASE}/hp_ns/k1`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(k1.status).toBe(200)
    expect(k1.body.data).toBe('v1') // string data is stored verbatim
    const k2 = await request(app).get(`${BASE}/hp_ns/k2`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(k2.body.data).toBe('v2')
  })
})

describe('POST /context/keys/bulk — batch cap and shape', () => {
  test(`a ${PINNED_CAP + 1}-key batch is rejected 400 with the cap message`, async () => {
    const keys = Array.from({ length: PINNED_CAP + 1 }, (_, i) => ({ namespace: 'cap_ns', key: `c${i}`, data: 'x' }))
    const res = await request(app).post(BULK).set(agentHeaders(AGENT_KEY_ALPHA)).send({ keys })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(CAP_MSG)
    // nothing from the oversized batch landed
    const landed = await request(app).get(`${BASE}/cap_ns`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(landed.body).toEqual([])
  })

  test('an exactly-at-cap batch is accepted (the off-by-one direction)', async () => {
    const keys = Array.from({ length: PINNED_CAP }, (_, i) => ({ namespace: 'edge_ns', key: `e${i}`, data: 'x' }))
    const res = await request(app).post(BULK).set(agentHeaders(AGENT_KEY_ALPHA)).send({ keys })
    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(PINNED_CAP)
    expect(res.body.results.every((r) => r.ok === true)).toBe(true)
  })

  test('an empty keys array is rejected 400 "keys array is required"', async () => {
    const res = await request(app).post(BULK).set(agentHeaders(AGENT_KEY_ALPHA)).send({ keys: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(KEYS_ARRAY_MSG)
  })

  test('a non-array keys field is rejected 400 (not 500)', async () => {
    const res = await request(app).post(BULK).set(agentHeaders(AGENT_KEY_ALPHA)).send({ keys: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(KEYS_ARRAY_MSG)
  })

  test('a missing keys field is rejected 400', async () => {
    const res = await request(app).post(BULK).set(agentHeaders(AGENT_KEY_ALPHA)).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(KEYS_ARRAY_MSG)
  })
})

describe('POST /context/keys/bulk — per-entry validation and partial success', () => {
  test('an entry missing data yields a per-entry error; valid entries in the SAME batch still land', async () => {
    const res = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [
        { namespace: 'pv_ns', key: 'no_data' /* data missing */ },
        { namespace: 'pv_ns', key: 'good', data: 'landed' },
      ] })
    // PARTIAL SUCCESS: the batch is 200 with a mixed results array — a
    // whole-batch 500 (or 400) on any bad entry breaks the contract.
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const bad = res.body.results.find((r) => r.key === 'no_data')
    expect(bad, 'the invalid entry must still appear in results').toBeTruthy()
    expect(bad.ok).toBeUndefined()
    expect(bad.error).toBe(REQUIRED_MSG)

    const good = res.body.results.find((r) => r.key === 'good')
    expect(good.ok).toBe(true)

    // the valid entry actually landed
    const read = await request(app).get(`${BASE}/pv_ns/good`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(read.status).toBe(200)
    expect(read.body.data).toBe('landed')
    // and the invalid one did not
    const missing = await request(app).get(`${BASE}/pv_ns/no_data`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(missing.status).toBe(404)
  })

  test('entries missing namespace or key get the same per-entry error', async () => {
    const res = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [
        { key: 'no_ns', data: 'x' /* namespace missing */ },
        { namespace: 'pv2_ns', data: 'x' /* key missing */ },
        { namespace: 'pv2_ns', key: 'fine', data: 'y' },
      ] })
    expect(res.status).toBe(200)
    expect(res.body.results.find((r) => r.key === 'no_ns').error).toBe(REQUIRED_MSG)
    expect(res.body.results.find((r) => r.key === undefined).error).toBe(REQUIRED_MSG)
    expect(res.body.results.find((r) => r.key === 'fine').ok).toBe(true)
  })
})

describe('POST /context/keys/bulk — cross-project scope (F1)', () => {
  beforeAll(async () => {
    // alpha owns xc_ns:owned (stamped with alpha's project on first write)
    const seed = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [{ namespace: 'xc_ns', key: 'owned', data: 'alpha-secret' }] })
    expect(seed.status).toBe(200)
  })

  test("bravo's batch gets a per-entry 'forbidden: cross-project' on alpha's key; other entries land", async () => {
    const res = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_BRAVO))
      .send({ keys: [
        { namespace: 'xc_ns', key: 'owned', data: 'POISONED_BY_BRAVO' },
        { namespace: 'xc_ns', key: 'bravo_own', data: 'bravo-was-here' },
      ] })
    // per-entry rejection — the batch itself still 200s
    expect(res.status).toBe(200)

    const poison = res.body.results.find((r) => r.key === 'owned')
    expect(poison.ok).toBeUndefined()
    expect(poison.error).toBe(CROSS_PROJECT_MSG)

    const own = res.body.results.find((r) => r.key === 'bravo_own')
    expect(own.ok).toBe(true)

    // alpha's key was NOT overwritten (no poison)
    const still = await request(app).get(`${BASE}/xc_ns/owned`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(still.status).toBe(200)
    expect(still.body.data).toBe('alpha-secret')
    // and bravo's own key did land
    const bravoKey = await request(app).get(`${BASE}/xc_ns/bravo_own`).set(agentHeaders(AGENT_KEY_BRAVO))
    expect(bravoKey.status).toBe(200)
    expect(bravoKey.body.data).toBe('bravo-was-here')
  })
})

describe('POST /context/keys/bulk — versioning coupling (bulk must not bypass context_history)', () => {
  test('a bulk OVERWRITE archives the prior value to context_history, like the single-key PUT path', async () => {
    // first bulk write — creates the key; nothing to archive yet (same shape
    // as PUT: history rows appear on overwrite, not on first write)
    const first = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [{ namespace: 'ver_ns', key: 'tracked', data: 'v1' }] })
    expect(first.status).toBe(200)
    expect(first.body.results[0].ok).toBe(true)

    const hist0 = await request(app).get(`${BASE}/ver_ns/tracked/history`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(hist0.status).toBe(200)
    expect(hist0.body).toEqual([])

    // bulk overwrite — the PRIOR value must be archived by the shared
    // upsertContextKey path
    const second = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [{ namespace: 'ver_ns', key: 'tracked', data: 'v2' }] })
    expect(second.status).toBe(200)
    expect(second.body.results[0].ok).toBe(true)

    const hist1 = await request(app).get(`${BASE}/ver_ns/tracked/history`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(hist1.status).toBe(200)
    expect(Array.isArray(hist1.body)).toBe(true)
    expect(hist1.body, 'a bulk overwrite must add a context_history row — if this reds, bulk ' +
      'writes are bypassing upsertContextKey and silently breaking the "versioned on every ' +
      'write" promise (README)').toHaveLength(1)
    expect(hist1.body[0].data).toBe('v1') // the archived PRIOR value
    expect(hist1.body[0].changed_by).toBe('bulk-alpha')

    // current value is the new one
    const cur = await request(app).get(`${BASE}/ver_ns/tracked`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(cur.body.data).toBe('v2')

    // a second overwrite archives again, newest first
    const third = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [{ namespace: 'ver_ns', key: 'tracked', data: 'v3' }] })
    expect(third.status).toBe(200)
    const hist2 = await request(app).get(`${BASE}/ver_ns/tracked/history`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(hist2.body).toHaveLength(2)
    expect(hist2.body[0].data).toBe('v2')
    expect(hist2.body[1].data).toBe('v1')
  })

  test('EVERY key in a multi-key bulk overwrite gets its own history row', async () => {
    // seed two keys, then bulk-overwrite both in one batch — each must archive
    const seed = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [
        { namespace: 'multi_ver_ns', key: 'a', data: 'a1' },
        { namespace: 'multi_ver_ns', key: 'b', data: 'b1' },
      ] })
    expect(seed.status).toBe(200)

    const overwrite = await request(app)
      .post(BULK)
      .set(agentHeaders(AGENT_KEY_ALPHA))
      .send({ keys: [
        { namespace: 'multi_ver_ns', key: 'a', data: 'a2' },
        { namespace: 'multi_ver_ns', key: 'b', data: 'b2' },
      ] })
    expect(overwrite.status).toBe(200)
    expect(overwrite.body.results.every((r) => r.ok === true)).toBe(true)

    const histA = await request(app).get(`${BASE}/multi_ver_ns/a/history`).set(agentHeaders(AGENT_KEY_ALPHA))
    const histB = await request(app).get(`${BASE}/multi_ver_ns/b/history`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(histA.body).toHaveLength(1)
    expect(histA.body[0].data).toBe('a1')
    expect(histB.body).toHaveLength(1)
    expect(histB.body[0].data).toBe('b1')
  })
})

describe('POST /context/keys/bulk — auth', () => {
  test('no credentials -> 401', async () => {
    const res = await request(app)
      .post(BULK)
      .send({ keys: [{ namespace: 'auth_ns', key: 'k', data: 'v' }] })
    expect(res.status).toBe(401)
  })

  test('an invalid agent key -> 403, nothing written', async () => {
    const res = await request(app)
      .post(BULK)
      .set(agentHeaders('dvk_not_a_real_key_at_all_0000000000000'))
      .send({ keys: [{ namespace: 'auth_ns', key: 'k', data: 'v' }] })
    expect(res.status).toBe(403)
    const read = await request(app).get(`${BASE}/auth_ns/k`).set(agentHeaders(AGENT_KEY_ALPHA))
    expect(read.status).toBe(404)
  })
})
