import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION TESTS — context (versioned key-value) API.
//
// Part of the tests-first safety net under server/routes/mycelium.js before
// the god-file is decomposed. These tests LOCK CURRENT behavior — including
// behavior that looks like a bug. Where something smells wrong it is flagged
// with a "BUG SMELL" comment and the CURRENT behavior is still asserted.
// Fix nothing here; if a refactor changes one of these outcomes, that change
// must be deliberate.
//
// Routes covered (all under /api/mycelium):
//   PUT    /context/keys/:namespace/:key            (auto-versioned write)
//   GET    /context/keys                            (all namespaces + search)
//   GET    /context/keys/:namespace                 (list one namespace)
//   GET    /context/keys/:namespace/:key            (single key)
//   DELETE /context/keys/:namespace/:key            (admin only)
//   GET    /context/keys/:namespace/:key/history    (?limit=20, "max 100")
//   POST   /context/keys/rollback/:historyId        (restore prior version)
//   POST   /context/keys/bulk                       (max 50 keys/batch)
//   GET    /context/stats                           (admin only)
//
// Headline behaviors pinned (see individual tests):
//  1. PUT is a SHALLOW JSON MERGE when both old and new data parse as JSON —
//     NOT a replace. A scalar written over an object is SILENTLY SWALLOWED.
//  2. Auto-versioning: the PRIOR value is saved to context_history on every
//     overwrite (retention: last 50 versions/key). First write records nothing.
//  3. Rollback restores the raw historical value (no merge) and pushes the
//     current value onto history first — but rollback of a DELETED key
//     returns ok:true while restoring nothing.
//  4. History ?limit: default 20; >100 clamped to 100 (unobservable past the
//     50-version retention cap); non-numeric → 20; NEGATIVE → no limit.
//  5. category and ttl/expires_at are RESET by any later write that omits them.
//  6. DELETE and /stats are admin-only; a valid AGENT key gets 403 "Admin
//     role required" (FIXED 2026-07, findings §1 — was an as-if-anonymous 401).
//     Agents have NO namespace ACL — any agent can write any namespace.
//
// Same harness as studio-login.test.js / auth-roles.test.js: real router,
// fresh temp DB, env set before the dynamic import. pool:'forks' isolates
// module-global state (rate limiters, agent-key cache).

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY = 'ctxk_' + 'b'.repeat(48)
const AGENT_ID = 'ctx-agent'

let tmpDataDir
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-context-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // A real agent so we can exercise the X-Agent-Key auth path
  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent(AGENT_ID, 'Context Agent', 'ctx-proj', hash, '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// ---- helpers ----

function asAdmin(req) {
  return req.set('X-Admin-Key', ADMIN_KEY)
}

function putKey(ns, key, data, extra) {
  return asAdmin(
    request(app)
      .put(`/api/mycelium/context/keys/${ns}/${key}`)
      .send(Object.assign({ data }, extra || {}))
  )
}

function getKey(ns, key) {
  return asAdmin(request(app).get(`/api/mycelium/context/keys/${ns}/${key}`))
}

function getHistory(ns, key, limit) {
  const q = limit === undefined ? '' : `?limit=${limit}`
  return asAdmin(request(app).get(`/api/mycelium/context/keys/${ns}/${key}/history${q}`))
}

// ======== auth & attribution ========

describe('auth & attribution', () => {
  test('unauthenticated read → 401 with the AGENT-flavored message', async () => {
    // checkAgentOrAdmin falls through JWT → admin key → checkAgent, so the
    // no-credentials error names X-Agent-Key even for operator callers.
    const res = await request(app).get('/api/mycelium/context/keys/anyns')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('admin write without X-Acting-As is attributed to __system__', async () => {
    await putKey('attrns', 'sys', 'plainval')
    const res = await getKey('attrns', 'sys')
    expect(res.status).toBe(200)
    expect(res.body.updated_by).toBe('__system__')
  })

  test('admin write with X-Acting-As is attributed to that identity', async () => {
    await putKey('attrns', 'acting', 'plainval').set('X-Acting-As', 'm5Max')
    const res = await getKey('attrns', 'acting')
    expect(res.body.updated_by).toBe('m5Max')
  })

  test('agent write is attributed to the agent id — and agents can write ANY namespace (no ACL)', async () => {
    // BUG SMELL (scope): there is NO namespace authorization on context —
    // any valid agent may read/write any namespace, including other agents'
    // and admin-looking namespaces. checkProjectScope is never consulted.
    const res = await request(app)
      .put('/api/mycelium/context/keys/somebody-elses-namespace/trespass')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ data: 'agent was here' })
    expect(res.status).toBe(200)
    const read = await getKey('somebody-elses-namespace', 'trespass')
    expect(read.body.updated_by).toBe(AGENT_ID)
    expect(read.body.data).toBe('agent was here')
  })
})

// ======== PUT / GET basics ========

describe('PUT + GET single key', () => {
  test('first write: 200 {ok, namespace, key} — the merged/stored data is NOT echoed back', async () => {
    const res = await putKey('basicns', 'k1', { hello: 'world' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, namespace: 'basicns', key: 'k1' })
  })

  test('GET returns the stored row: JSON data stringified, default category durable, no expiry', async () => {
    const res = await getKey('basicns', 'k1')
    expect(res.status).toBe(200)
    expect(res.body.namespace).toBe('basicns')
    expect(res.body.key).toBe('k1')
    expect(res.body.data).toBe('{"hello":"world"}') // data is a STRING column
    expect(res.body.category).toBe('durable')
    expect(res.body.expires_at).toBeNull()
    expect(res.body.updated_by).toBe('__system__')
    expect(typeof res.body.id).toBe('number')
  })

  test('GET missing key → 404 {error: Context key not found}', async () => {
    const res = await getKey('basicns', 'nope')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Context key not found')
  })

  test('PUT without data field → 400', async () => {
    const res = await asAdmin(
      request(app).put('/api/mycelium/context/keys/basicns/k2').send({ category: 'durable' })
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('data field is required')
  })

  test('GET /context/keys/:namespace lists only that namespace, ordered by key', async () => {
    await putKey('basicns', 'a-key', 'v')
    await putKey('basicns', 'zzqx-marker', 'v')
    const res = await asAdmin(request(app).get('/api/mycelium/context/keys/basicns'))
    expect(res.status).toBe(200)
    const keys = res.body.map((r) => r.key)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toContain('k1')
    expect(keys).toContain('zzqx-marker')
    expect(res.body.every((r) => r.namespace === 'basicns')).toBe(true)
  })

  test('GET /context/keys?search= filters by key OR data substring across namespaces', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/context/keys?search=zzqx'))
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
    expect(res.body[0].key).toBe('zzqx-marker')
  })
})

// ======== merge semantics — the big one ========

describe('PUT merge semantics (CURRENT behavior: shallow JSON merge, NOT replace)', () => {
  test('object over object SHALLOW-MERGES — old keys survive a PUT', async () => {
    // A PUT can never remove a JSON field; the only way to drop one is to
    // DELETE the whole key. Clients expecting replace semantics will
    // accumulate stale fields forever. LOCKED as current behavior.
    await putKey('mergens', 'mkey', { a: 1, b: 2 })
    await putKey('mergens', 'mkey', { b: 3, c: 4 })
    const res = await getKey('mergens', 'mkey')
    expect(res.body.data).toBe('{"a":1,"b":3,"c":4}')
  })

  test('history records the PRE-merge image of the overwritten value', async () => {
    const res = await getHistory('mergens', 'mkey')
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
    expect(res.body[0].data).toBe('{"a":1,"b":2}')
  })

  test('merge is SHALLOW: nested objects are replaced wholesale, not deep-merged', async () => {
    await putKey('mergens', 'nkey', { nest: { x: 1, y: 2 }, top: 1 })
    await putKey('mergens', 'nkey', { nest: { y: 9 } })
    const res = await getKey('mergens', 'nkey')
    expect(res.body.data).toBe('{"nest":{"y":9},"top":1}') // nest.x is gone
  })

  test('BUG SMELL: scalar over object is SILENTLY SWALLOWED — ok:true but nothing written', async () => {
    // upsertContextKey does Object.assign({}, existingObj, 5) → scalars have
    // no enumerable own props, so the "write" produces the OLD value again.
    // The client gets ok:true, and a no-op version still lands in history.
    await putKey('mergens', 'swallow', { a: 1 })
    const put = await putKey('mergens', 'swallow', 5)
    expect(put.status).toBe(200)
    expect(put.body.ok).toBe(true)
    const res = await getKey('mergens', 'swallow')
    expect(res.body.data).toBe('{"a":1}') // the 5 is gone without a trace
    const hist = await getHistory('mergens', 'swallow')
    expect(hist.body.length).toBe(1) // …except this phantom history entry
    expect(hist.body[0].data).toBe('{"a":1}') // identical to current value
  })

  test('non-JSON string data REPLACES (merge only when the existing value parses as JSON)', async () => {
    await putKey('mergens', 'plain', 'hello world')
    let res = await getKey('mergens', 'plain')
    expect(res.body.data).toBe('hello world') // stored raw, not JSON-wrapped
    await putKey('mergens', 'plain', 'goodbye')
    res = await getKey('mergens', 'plain')
    expect(res.body.data).toBe('goodbye')
  })

  test('a STRING containing JSON merges exactly like object data', async () => {
    await putKey('mergens', 'skey', '{"x":1}')
    await putKey('mergens', 'skey', { y: 2 })
    const res = await getKey('mergens', 'skey')
    expect(res.body.data).toBe('{"x":1,"y":2}')
  })

  test('__proto__/constructor are stripped from the INCOMING side on merge writes', async () => {
    await putKey('mergens', 'pkey', { safe: 1 })
    await putKey('mergens', 'pkey', '{"__proto__":{"polluted":1},"constructor":"x","b":2}')
    const res = await getKey('mergens', 'pkey')
    expect(res.body.data).toBe('{"safe":1,"b":2}')
  })

  test('FIXED (findings §8): FIRST write strips __proto__ keys — sanitize now runs on ALL write paths, not just merge', async () => {
    const raw = '{"__proto__":{"polluted":1},"a":1}'
    await putKey('mergens', 'praw', raw)
    const res = await getKey('mergens', 'praw')
    // Was (S8 locks-bug): `raw` stored verbatim, because the __proto__/
    // constructor/prototype sanitizer ran ONLY on the merge path. Now
    // (S8 proves-fix): the same sanitizer is applied to first writes too, so
    // the prototype-pollution keys are stripped before the value is stored.
    expect(res.body.data).toBe('{"a":1}')
  })
})

// ======== auto-versioning & history ========

describe('auto-versioning + GET history', () => {
  test('first write creates NO history; each overwrite saves the prior value, newest first', async () => {
    await putKey('histns', 'trio', 'one')
    let hist = await getHistory('histns', 'trio')
    expect(hist.status).toBe(200)
    expect(hist.body).toEqual([]) // creation is not a "version"

    await putKey('histns', 'trio', 'two')
    await putKey('histns', 'trio', 'three')
    hist = await getHistory('histns', 'trio')
    expect(hist.body.length).toBe(2)
    // Ordered by id DESC — most recently displaced value first
    expect(hist.body[0].data).toBe('two')
    expect(hist.body[1].data).toBe('one')
    expect(hist.body[0]).toMatchObject({ namespace: 'histns', key: 'trio', changed_by: '__system__' })
    expect(typeof hist.body[0].id).toBe('number')
    expect(typeof hist.body[0].changed_at).toBe('string')
  })

  test('history of a nonexistent key → 200 [] (no 404)', async () => {
    const res = await getHistory('histns', 'never-written')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  describe('retention + limit behavior (56 writes → 50-version cap)', () => {
    beforeAll(async () => {
      for (let i = 1; i <= 56; i++) {
        const res = await putKey('histns', 'vk', 'v' + i) // 'vN' is not JSON → replace path
        expect(res.status).toBe(200)
      }
    })

    test('retention: only the last 50 versions are kept per key', async () => {
      // 56 writes displace v1..v55 into history; the per-key cap trims to the
      // newest 50 → v6..v55 survive, v1..v5 are gone.
      const res = await getHistory('histns', 'vk', 100)
      expect(res.body.length).toBe(50)
      expect(res.body[0].data).toBe('v55') // newest displaced value
      expect(res.body[49].data).toBe('v6') // oldest surviving version
    })

    test('default limit is 20', async () => {
      const res = await getHistory('histns', 'vk')
      expect(res.body.length).toBe(20)
      expect(res.body[0].data).toBe('v55')
      expect(res.body[19].data).toBe('v36')
    })

    test('?limit=5 honored', async () => {
      const res = await getHistory('histns', 'vk', 5)
      expect(res.body.length).toBe(5)
    })

    test('?limit>100 is clamped to 100 — no error (unobservable past the 50-version retention)', async () => {
      // The clamp exists in the route but retention (50) < clamp (100), so
      // over-limit requests behave exactly like limit=50. Locked: no 400.
      const res = await getHistory('histns', 'vk', 5000)
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(50)
    })

    test('non-numeric ?limit falls back to the default 20', async () => {
      const res = await getHistory('histns', 'vk', 'abc')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(20)
    })

    test('?limit=0 falls back to the default 20 (0 is falsy)', async () => {
      const res = await getHistory('histns', 'vk', 0)
      expect(res.body.length).toBe(20)
    })

    test('BUG SMELL: NEGATIVE ?limit bypasses the cap — SQLite treats LIMIT -1 as "no limit"', async () => {
      // parseInt('-1') = -1 passes both the falsy check and the >100 clamp,
      // reaching SQL as LIMIT -1 → ALL rows. Only the 50-version retention
      // keeps this bounded today; if retention grows, this becomes a real
      // unbounded read.
      const res = await getHistory('histns', 'vk', -1)
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(50)
    })
  })
})

// ======== rollback ========

describe('POST /context/keys/rollback/:historyId', () => {
  test('rollback restores the historical value RAW (no merge) and pushes current value onto history', async () => {
    await putKey('rbns', 'rb', '{"phase":"alpha"}')
    await putKey('rbns', 'rb', 'beta') // non-JSON → replace
    await putKey('rbns', 'rb', 'gamma')
    const hist = await getHistory('rbns', 'rb')
    expect(hist.body.map((h) => h.data)).toEqual(['beta', '{"phase":"alpha"}'])
    const alphaId = hist.body[1].id

    const res = await asAdmin(
      request(app).post(`/api/mycelium/context/keys/rollback/${alphaId}`)
    ).set('X-Acting-As', 'roller')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, namespace: 'rbns', key: 'rb', restored_from: alphaId })

    // Restored value replaces outright — rollback does NOT go through the
    // merge path even though the restored value is a JSON object.
    const read = await getKey('rbns', 'rb')
    expect(read.body.data).toBe('{"phase":"alpha"}')
    expect(read.body.updated_by).toBe('roller')

    // The displaced current value ('gamma') was itself versioned first.
    const hist2 = await getHistory('rbns', 'rb')
    expect(hist2.body.map((h) => h.data)).toEqual(['gamma', 'beta', '{"phase":"alpha"}'])
  })

  test('non-numeric or zero history id → 400 Invalid history ID', async () => {
    const bad = await asAdmin(request(app).post('/api/mycelium/context/keys/rollback/abc'))
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('Invalid history ID')
    const zero = await asAdmin(request(app).post('/api/mycelium/context/keys/rollback/0'))
    expect(zero.status).toBe(400)
  })

  test('unknown numeric history id → 404 History entry not found', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/context/keys/rollback/999999'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('History entry not found')
  })

  test('BUG SMELL: rollback of a DELETED key returns ok:true but restores NOTHING', async () => {
    // rollbackContextKey UPDATEs context_keys — if the key row was deleted,
    // the UPDATE matches 0 rows, yet the function still returns the history
    // row → route replies 200 ok. The key is NOT recreated.
    await putKey('rbns', 'rbdel', 'one')
    await putKey('rbns', 'rbdel', 'two')
    const hist = await getHistory('rbns', 'rbdel')
    const oneId = hist.body[0].id
    await asAdmin(request(app).delete('/api/mycelium/context/keys/rbns/rbdel'))

    const res = await asAdmin(request(app).post(`/api/mycelium/context/keys/rollback/${oneId}`))
    expect(res.status).toBe(200) // claims success…
    expect(res.body).toMatchObject({ ok: true, namespace: 'rbns', key: 'rbdel' })
    const read = await getKey('rbns', 'rbdel')
    expect(read.status).toBe(404) // …but the key still does not exist
  })
})

// ======== delete ========

describe('DELETE /context/keys/:namespace/:key', () => {
  test('admin delete removes the key; response names it', async () => {
    await putKey('delns', 'gone', 'x')
    const res = await asAdmin(request(app).delete('/api/mycelium/context/keys/delns/gone'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deleted: 'delns:gone' })
    expect((await getKey('delns', 'gone')).status).toBe(404)
  })

  test('history SURVIVES deletion of the key', async () => {
    await putKey('delns', 'hkeep', 'v1')
    await putKey('delns', 'hkeep', 'v2')
    await asAdmin(request(app).delete('/api/mycelium/context/keys/delns/hkeep'))
    const hist = await getHistory('delns', 'hkeep')
    expect(hist.body.length).toBe(1)
    expect(hist.body[0].data).toBe('v1')
  })

  test('deleting a nonexistent key is a 200 no-op (idempotent, no 404)', async () => {
    const res = await asAdmin(request(app).delete('/api/mycelium/context/keys/delns/never-existed'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deleted: 'delns:never-existed' })
  })

  test('FIXED (findings §1): a valid AGENT gets 403 "Admin role required" on delete — authenticated, not authorized', async () => {
    // The agent IS authenticated; checkAdmin now recognizes the valid
    // X-Agent-Key (classification only, grants nothing) and answers an honest
    // role-based 403 instead of the old as-if-anonymous 401.
    await putKey('delns', 'agent-target', 'x')
    const res = await request(app)
      .delete('/api/mycelium/context/keys/delns/agent-target')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
    expect((await getKey('delns', 'agent-target')).status).toBe(200) // untouched
  })
})

// ======== ttl / category ========

describe('ttl, expires_at, category', () => {
  test('ttl (seconds) sets expires_at ≈ now + ttl', async () => {
    const before = Date.now()
    await putKey('ttlns', 'fresh', 'x', { ttl: 3600 })
    const res = await getKey('ttlns', 'fresh')
    expect(res.status).toBe(200)
    const expiresMs = new Date(res.body.expires_at).getTime()
    expect(expiresMs).toBeGreaterThan(before + 3590 * 1000)
    expect(expiresMs).toBeLessThan(before + 3620 * 1000)
  })

  test('expired keys are filtered from LIST and 404 (+ lazily deleted) on GET', async () => {
    await putKey('ttlns', 'stale', 'x', { expires_at: '2000-01-01T00:00:00.000Z' })
    // LIST filters on expiry without deleting
    const list = await asAdmin(request(app).get('/api/mycelium/context/keys/ttlns'))
    expect(list.body.map((r) => r.key)).not.toContain('stale')
    // GET deletes the expired row and reports not-found
    const res = await getKey('ttlns', 'stale')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Context key not found')
  })

  test('BUG SMELL: a later write WITHOUT ttl CLEARS the expiry', async () => {
    // upsert always writes expires_at (null when neither ttl nor expires_at
    // given) — so refreshing a key's value silently makes it immortal.
    await putKey('ttlns', 'clearme', 'x', { ttl: 3600 })
    await putKey('ttlns', 'clearme', 'y')
    const res = await getKey('ttlns', 'clearme')
    expect(res.body.expires_at).toBeNull()
  })

  test('category is stored — and BUG SMELL: reset to durable by a later write that omits it', async () => {
    await putKey('ttlns', 'eph', 'x', { category: 'ephemeral' })
    let res = await getKey('ttlns', 'eph')
    expect(res.body.category).toBe('ephemeral')
    await putKey('ttlns', 'eph', 'y') // no category → default 'durable' overwrites
    res = await getKey('ttlns', 'eph')
    expect(res.body.category).toBe('durable')
  })
})

// ======== bulk ========

describe('POST /context/keys/bulk', () => {
  function bulk(keys) {
    return asAdmin(request(app).post('/api/mycelium/context/keys/bulk').send({ keys }))
  }

  test('exactly 50 keys in one call succeeds (the cap is inclusive)', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => ({
      namespace: 'bulkns', key: 'k' + i, data: { i }
    }))
    const res = await bulk(keys)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.results.length).toBe(50)
    expect(res.body.results.every((r) => r.ok === true)).toBe(true)
    const list = await asAdmin(request(app).get('/api/mycelium/context/keys/bulkns'))
    expect(list.body.length).toBe(50)
  })

  test('51 keys → 400 Maximum 50 keys per batch (nothing written)', async () => {
    const keys = Array.from({ length: 51 }, (_, i) => ({
      namespace: 'bulkns51', key: 'k' + i, data: 'x'
    }))
    const res = await bulk(keys)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Maximum 50 keys per batch')
    const list = await asAdmin(request(app).get('/api/mycelium/context/keys/bulkns51'))
    expect(list.body).toEqual([])
  })

  test('empty array and non-array both → 400 keys array is required', async () => {
    expect((await bulk([])).status).toBe(400)
    expect((await bulk([])).body.error).toBe('keys array is required')
    const notArray = await asAdmin(
      request(app).post('/api/mycelium/context/keys/bulk').send({ keys: 'nope' })
    )
    expect(notArray.status).toBe(400)
    const noBody = await asAdmin(request(app).post('/api/mycelium/context/keys/bulk').send({}))
    expect(noBody.status).toBe(400)
  })

  test('partial failure: invalid entries error per-entry, valid ones land, overall still 200 ok:true', async () => {
    const res = await bulk([
      { namespace: 'bulkns2', key: 'good', data: { v: 1 } },
      { namespace: 'bulkns2', key: 'nodata' }, // data missing
      { key: 'nons', data: 'x' } // namespace missing
    ])
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true) // top-level ok even with failures inside
    expect(res.body.results[0]).toEqual({ namespace: 'bulkns2', key: 'good', ok: true })
    expect(res.body.results[1]).toEqual({
      namespace: 'bulkns2', key: 'nodata', error: 'namespace, key, and data are required'
    })
    expect(res.body.results[2]).toEqual({
      namespace: undefined, key: 'nons', error: 'namespace, key, and data are required'
    })
    expect((await getKey('bulkns2', 'good')).status).toBe(200)
    expect((await getKey('bulkns2', 'nodata')).status).toBe(404)
  })

  test('bulk writes auto-version exactly like PUT (prior value → history, merge semantics apply)', async () => {
    await bulk([{ namespace: 'bulkns2', key: 'bk', data: { a: 1 } }])
    await bulk([{ namespace: 'bulkns2', key: 'bk', data: { b: 2 } }])
    const hist = await getHistory('bulkns2', 'bk')
    expect(hist.body.length).toBe(1)
    expect(hist.body[0].data).toBe('{"a":1}')
    expect((await getKey('bulkns2', 'bk')).body.data).toBe('{"a":1,"b":2}') // merged
  })
})

// ======== namespace size cap ========

describe('namespace cap (db-level, observable through the API)', () => {
  test('BUG SMELL: a namespace silently evicts down to 200 keys — no error, no signal to the writer', async () => {
    // enforceNamespaceCap deletes (ephemeral-first, then oldest) once a
    // namespace exceeds 200 keys. The 201st write succeeds with ok:true and
    // some other key quietly disappears.
    for (let batch = 0; batch < 4; batch++) {
      const keys = Array.from({ length: 50 }, (_, i) => ({
        namespace: 'capns', key: `k${batch * 50 + i}`, data: 'x'
      }))
      const res = await asAdmin(
        request(app).post('/api/mycelium/context/keys/bulk').send({ keys })
      )
      expect(res.status).toBe(200)
    }
    const overflow = await putKey('capns', 'overflow-201st', 'x')
    expect(overflow.status).toBe(200) // no pushback
    const list = await asAdmin(request(app).get('/api/mycelium/context/keys/capns'))
    expect(list.body.length).toBe(200) // one of the 201 is gone
    expect(list.body.map((r) => r.key)).toContain('overflow-201st') // newest survives
  })
})

// ======== stats (admin only) ========

describe('GET /context/stats', () => {
  test('admin sees per-namespace/per-category counts and byte totals', async () => {
    await putKey('statns', 'd1', 'aaaa') // 4 bytes, durable
    await putKey('statns', 'd2', { a: 1 }) // '{"a":1}' → 7 bytes, durable
    await putKey('statns', 'e1', 'bb', { category: 'ephemeral' }) // 2 bytes
    const res = await asAdmin(request(app).get('/api/mycelium/context/stats'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const durable = res.body.find((r) => r.namespace === 'statns' && r.category === 'durable')
    const ephemeral = res.body.find((r) => r.namespace === 'statns' && r.category === 'ephemeral')
    expect(durable).toEqual({ namespace: 'statns', category: 'durable', count: 2, total_bytes: 11 })
    expect(ephemeral).toEqual({ namespace: 'statns', category: 'ephemeral', count: 1, total_bytes: 2 })
  })

  test('FIXED (findings §1): a valid AGENT gets 403 — same checkAdmin fix as DELETE', async () => {
    const res = await request(app)
      .get('/api/mycelium/context/stats')
      .set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  test('wrong admin key → 403 Invalid admin key', async () => {
    const res = await request(app)
      .get('/api/mycelium/context/stats')
      .set('X-Admin-Key', 'definitely-wrong')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid admin key')
  })
})

// ======== access tracking quirk ========

describe('access_count read tracking', () => {
  test('QUIRK: GET returns the PRE-increment access_count — the reported value lags reads by one', async () => {
    // getContextKey selects the row, THEN bumps access_count, and returns the
    // stale row — so the first read reports 0, the second 1, etc.
    await putKey('accessns', 'ac', 'x')
    expect((await getKey('accessns', 'ac')).body.access_count).toBe(0)
    expect((await getKey('accessns', 'ac')).body.access_count).toBe(1)
    expect((await getKey('accessns', 'ac')).body.access_count).toBe(2)
  })
})
