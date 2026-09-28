import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Gate: `mycelium/enforcement_rules` — the one context key whose value is an
// authorization gate. checkEnforcementRules (server/routes/mycelium.js) turns
// it into 403s on POST /messages (tool send_message) and PR merges
// (merge_pr). Review B of PR #191 (2026-09-28) found three live holes, all
// pinned RED here before the fix:
//
//   1. ANY agent key could write the key (PUT /context/keys is
//      checkAgentOrAdmin) and switch every rule off — the principal the rules
//      gate could delete the gate.
//   2. A malformed write silently EMPTIED the ruleset: upsertContextKey
//      Object.assign-merges, so a bare-array PUT over {"rules":[…]} became
//      {"0":…,"1":…} — which the reader's `data.rules || []` reads as zero
//      rules. A bare array or malformed rule must be 400, never stored.
//   3. Rule changes lagged up to ENFORCEMENT_CACHE_TTL (60s) behind a write.
//      An admin disabling a block rule must take effect at once (and
//      re-arming one must too).
//
// What is deliberately NOT changed: the enforcement behaviour itself — block
// → 403 + enforcement_rule field, warn → event only, no rules → everything
// passes. Tests in the C describe pin that the fix does not move it.
//
// Census (why only this key): the other context keys read server-side are
// informational, not authorization — roles/<agentId> + <project>/guidelines
// feed the boot role contract (db.js), standups and admin/api_limits /
// admin/api_usage are display caches behind admin-only routes. Only
// enforcement_rules turns into a 403. SECURITY_CONTEXT_KEYS in
// server/enforcement-rules.js is the census; adding a future gating key
// there inherits every guarantee this file pins.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY = 'dvk_test_enf_agent_0123456789abcdef012345678'
const AGENT_HASH = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')

const BASE = '/api/mycelium'
const RULES = `${BASE}/context/keys/mycelium/enforcement_rules`

const BLOCK_RULE = {
  id: 'no-passwords',
  tool: 'send_message',
  match: { content_pattern: 'password' },
  severity: 'block',
  message: 'never send passwords',
}
const WARN_RULE = {
  id: 'flag-external',
  tool: '*',
  match: { content_pattern: 'externally' },
  severity: 'warn',
  message: 'flag external sends',
}
const GOOD = { rules: [BLOCK_RULE] }
const GOOD_V2 = { rules: [BLOCK_RULE, WARN_RULE] }

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-enf-rules-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  db.createProject('enf', 'Enf', '', '', null, 'product')
  db.createAgent('enf-agent', 'Enf Agent', 'enf', AGENT_HASH, '["test"]')
  db.createAgent('enf-bob', 'Enf Bob', 'enf', crypto.createHash('sha256').update('dvk_enf_bob_none').digest('hex'), '[]')

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use(BASE, routes)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function admin() {
  return { 'X-Admin-Key': ADMIN_KEY }
}
function agent() {
  return { 'X-Agent-Key': AGENT_KEY }
}

// Send a message that matches BLOCK_RULE's pattern; resolves the HTTP response.
function sendBlockedContent() {
  return request(app)
    .post(`${BASE}/messages`)
    .set(agent())
    .send({ content: 'my password is hunter2', to_agent: 'enf-bob' })
}

async function readRules() {
  const res = await request(app).get(RULES).set(admin())
  if (res.status === 404) return null
  return JSON.parse(res.body.data)
}

describe('A — writes to a security context key are admin-only', () => {
  test('an agent key PUTting the rules key is refused 403 and nothing is stored', async () => {
    const res = await request(app).put(RULES).set(agent()).send({ data: GOOD })
    expect(res.status, 'an agent the rules gate must not be able to rewrite the rules — ' +
      'if this reds green the gate is writable by the gated').toBe(403)
    expect(await readRules()).toBeNull()
  })

  test('the admin key can still write a valid ruleset', async () => {
    const res = await request(app).put(RULES).set(admin()).send({ data: GOOD })
    expect(res.status).toBe(200)
    expect(await readRules()).toEqual(GOOD)
  })

  test('bulk: an agent entry touching the rules key gets a per-entry admin-only error; the value is NOT written', async () => {
    const res = await request(app)
      .post(`${BASE}/context/keys/bulk`)
      .set(agent())
      .send({ keys: [
        { namespace: 'mycelium', key: 'enforcement_rules', data: { rules: [] } },
        { namespace: 'mycelium', key: 'unrelated', data: 'fine' },
      ] })
    expect(res.status).toBe(200) // the batch itself still 200s (partial-success contract)
    const poison = res.body.results.find((r) => r.key === 'enforcement_rules')
    expect(poison.ok).toBeUndefined()
    expect(poison.error).toMatch(/admin-only|forbidden/i)
    const own = res.body.results.find((r) => r.key === 'unrelated')
    expect(own.ok).toBe(true)
    // the emptying write did not land
    expect(await readRules()).toEqual(GOOD)
  })

  test('bulk: the admin key can write the rules key through the same endpoint', async () => {
    const res = await request(app)
      .post(`${BASE}/context/keys/bulk`)
      .set(admin())
      .send({ keys: [{ namespace: 'mycelium', key: 'enforcement_rules', data: GOOD_V2 }] })
    expect(res.status).toBe(200)
    expect(res.body.results[0].ok).toBe(true)
    expect(await readRules()).toEqual(GOOD_V2)
  })

  test('rollback of the rules key is admin-only too', async () => {
    // v2 is current (from the bulk test); history holds v1
    const hist = await request(app).get(`${RULES}/history`).set(admin())
    expect(hist.status).toBe(200)
    expect(hist.body.length, 'expected the overwrite to have archived v1').toBeGreaterThan(0)
    const historyId = hist.body[0].id

    const res = await request(app).post(`${BASE}/context/keys/rollback/${historyId}`).set(agent())
    expect(res.status, 'a rollback is a write — an agent must not be able to resurrect an ' +
      'old ruleset past the gate').toBe(403)
    expect(await readRules()).toEqual(GOOD_V2) // not restored
  })
})

describe('B — the rules value is validated on write; it cannot silently empty', () => {
  test('a bare-array PUT is 400 and the stored ruleset is untouched (no merge corruption)', async () => {
    const before = await readRules()
    const res = await request(app).put(RULES).set(admin()).send({ data: [BLOCK_RULE] })
    expect(res.status, 'a bare array merged over {"rules":[…]} becomes {"0":…} and reads as ' +
      'zero rules — it must be rejected, never stored').toBe(400)
    expect(res.body.error).toMatch(/invalid enforcement rules|rules array/i)
    expect(await readRules()).toEqual(before)
  })

  test('rules that is not an array is 400', async () => {
    const res = await request(app).put(RULES).set(admin()).send({ data: { rules: 'nope' } })
    expect(res.status).toBe(400)
  })

  test('a rule missing its id is 400 (events and 403s cite the id)', async () => {
    const bad = { rules: [{ tool: 'send_message', severity: 'block', message: 'x' }] }
    const res = await request(app).put(RULES).set(admin()).send({ data: bad })
    expect(res.status).toBe(400)
  })

  test('a rule missing its tool is 400', async () => {
    const bad = { rules: [{ id: 'r', severity: 'block' }] }
    const res = await request(app).put(RULES).set(admin()).send({ data: bad })
    expect(res.status).toBe(400)
  })

  test('an unknown severity is 400 (the reader would silently treat it as warn)', async () => {
    const bad = { rules: [{ id: 'r', tool: '*', severity: 'aggressive' }] }
    const res = await request(app).put(RULES).set(admin()).send({ data: bad })
    expect(res.status).toBe(400)
  })

  test('a rule whose content_pattern does not compile is 400 (the reader would silently skip it)', async () => {
    const bad = { rules: [{ id: 'r', tool: '*', match: { content_pattern: '((' }, severity: 'block' }] }
    const res = await request(app).put(RULES).set(admin()).send({ data: bad })
    expect(res.status).toBe(400)
  })

  test('a bare-string payload is 400', async () => {
    const res = await request(app).put(RULES).set(admin()).send({ data: 'no rules' })
    expect(res.status).toBe(400)
  })

  test('a null payload is 400', async () => {
    const res = await request(app).put(RULES).set(admin()).send({ data: null })
    expect(res.status).toBe(400)
  })

  test('an explicitly empty ruleset from admin is legal (disabling is an admin right)', async () => {
    const res = await request(app).put(RULES).set(admin()).send({ data: { rules: [] } })
    expect(res.status).toBe(200)
    expect(await readRules()).toEqual({ rules: [] })
  })

  test('a rule using every enforce condition is accepted (positive control)', async () => {
    const full = { rules: [{
      id: 'merge-needs-review',
      tool: 'merge_pr',
      severity: 'block',
      message: 'merges need review',
      match: { content_pattern: 'repo' },
      enforce: { expected_tool: 'merge_pr', expected_args: { number: 1 }, required_role: 'admin' },
    }] }
    const res = await request(app).put(RULES).set(admin()).send({ data: full })
    expect(res.status).toBe(200)
    expect(await readRules()).toEqual(full)
  })

  test('db layer: upsertContextKey NEVER merges an array into the stored object for the rules key', async () => {
    // The HTTP path rejects arrays; this pins the deeper invariant at the layer
    // where the merge lives — even a future writer that skips validation
    // cannot manufacture the {"0":…} soup the reader reads as "no rules".
    await request(app).put(RULES).set(admin()).send({ data: GOOD })
    db.upsertContextKey('mycelium', 'enforcement_rules', JSON.stringify([BLOCK_RULE]), 'direct-writer')
    const stored = await readRules()
    expect(Array.isArray(stored), 'the stored value must be exactly what was written — ' +
      'Object.assign merge artifacts ({"0":…,"rules":…}) are the silent-empty defect').toBe(true)
  })
})

describe('C — a rules change invalidates the enforcement cache at once', () => {
  test('block rule takes effect immediately (behaviour unchanged by the fix)', async () => {
    const put = await request(app).put(RULES).set(admin()).send({ data: GOOD })
    expect(put.status).toBe(200)
    const res = await sendBlockedContent()
    expect(res.status).toBe(403)
    expect(res.body.enforcement_rule).toBe('no-passwords')
  })

  test('emptying the rules takes effect immediately — no 60s window', async () => {
    const put = await request(app).put(RULES).set(admin()).send({ data: { rules: [] } })
    expect(put.status).toBe(200)
    const res = await sendBlockedContent()
    expect(res.status, 'an admin-disabled rule must stop blocking at once — a cache TTL ' +
      'between the write and the gate is a 60s window where the old rules still bite').toBe(200)
  })

  test('re-arming the rule takes effect immediately too', async () => {
    const put = await request(app).put(RULES).set(admin()).send({ data: GOOD })
    expect(put.status).toBe(200)
    const res = await sendBlockedContent()
    expect(res.status).toBe(403)
  })

  test('deleting the key takes effect immediately', async () => {
    const del = await request(app).delete(RULES).set(admin())
    expect(del.status).toBe(200)
    const res = await sendBlockedContent()
    expect(res.status).toBe(200)
  })
})

describe('D — the cache module contract (server/enforcement-rules.js)', () => {
  test('invalidate forces the next read to reload; within the TTL a warm read does not reload', async () => {
    const mod = await import('../../server/enforcement-rules.js')
    mod.invalidateEnforcementRulesCache() // the C describes left a warm cache behind — start cold
    let loads = 0
    const loader = () => { loads++; return ['rule'] }

    expect(mod.getCachedEnforcementRules(loader)).toEqual(['rule'])
    expect(mod.getCachedEnforcementRules(loader)).toEqual(['rule'])
    expect(loads, 'within the TTL the cache must serve without reloading (the TTL still bounds DB reads)').toBe(1)

    mod.invalidateEnforcementRulesCache()
    expect(mod.getCachedEnforcementRules(loader)).toEqual(['rule'])
    expect(loads, 'after an invalidation the next read must reload (write → read-your-writes)').toBe(2)
  })

  test('the security-key census: enforcement_rules is gated, ordinary keys are not', async () => {
    const mod = await import('../../server/enforcement-rules.js')
    expect(mod.isSecurityContextKey('mycelium', 'enforcement_rules')).toBe(true)
    expect(mod.isSecurityContextKey('mycelium', 'anything_else')).toBe(false)
    expect(mod.isSecurityContextKey('roles', 'some-agent')).toBe(false)
  })
})
