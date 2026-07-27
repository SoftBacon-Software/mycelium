import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// F1 (red-team) — context keys must be project-scoped.
//
// Reproduces the red-team scenario: two agents in two different projects
// (rt-alpha/project alpha, rt-bravo/project bravo). Before the fix a bravo key
// could READ, OVERWRITE (poison), dump plaintext HISTORY, and ROLL BACK alpha's
// secret context key. After the fix every one of those is a 403, while the
// owning agent (alpha) and admins still have full access and shared/global keys
// (NULL project_id) remain readable swarm-wide.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY_ALPHA = 'dvk_test_ctx_alpha_key_0123456789abcdef0123456'
const AGENT_KEY_BRAVO = 'dvk_test_ctx_bravo_key_0123456789abcdef01234567'
const AGENT_HASH_ALPHA = crypto.createHash('sha256').update(AGENT_KEY_ALPHA).digest('hex')
const AGENT_HASH_BRAVO = crypto.createHash('sha256').update(AGENT_KEY_BRAVO).digest('hex')

const NS = 'alpha_secrets'
const KEY = 'prod'

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-ctx-scope-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  db.createProject('alpha', 'Alpha', '', '', null, 'product')
  db.createProject('bravo', 'Bravo', '', '', null, 'product')
  db.createAgent('rt-alpha', 'RT Alpha', 'alpha', AGENT_HASH_ALPHA, '["code"]')
  db.createAgent('rt-bravo', 'RT Bravo', 'bravo', AGENT_HASH_BRAVO, '["code"]')

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function adminHeaders() {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'tester' }
}

const BASE = '/api/mycelium/context/keys'

describe('F1: cross-project context access is DENIED', () => {
  test('alpha writes a project-scoped secret; bravo cannot READ it (403)', async () => {
    // alpha (project alpha) writes a secret — stamped with alpha's project
    const write = await request(app)
      .put(`${BASE}/${NS}/${KEY}`)
      .set('X-Agent-Key', AGENT_KEY_ALPHA)
      .send({ data: { stripe_key: 'sk_live_ALPHA_PRIVATE_1234' } })
    expect(write.status).toBe(200)
    expect(write.body.ok).toBe(true)

    // owner can read it back
    const own = await request(app).get(`${BASE}/${NS}/${KEY}`).set('X-Agent-Key', AGENT_KEY_ALPHA)
    expect(own.status).toBe(200)
    expect(own.body.project_id).toBe('alpha')
    expect(own.body.data).toContain('sk_live_ALPHA_PRIVATE_1234')

    // bravo (DIFFERENT project) is denied — this is the F1 reproduction
    const cross = await request(app).get(`${BASE}/${NS}/${KEY}`).set('X-Agent-Key', AGENT_KEY_BRAVO)
    expect(cross.status).toBe(403)
    expect(String(cross.body.error)).toMatch(/project/i)

    // admin bypasses scope
    const adm = await request(app).get(`${BASE}/${NS}/${KEY}`).set(adminHeaders())
    expect(adm.status).toBe(200)
  })

  test('bravo cannot OVERWRITE (poison) alpha\'s key (403) — value unchanged', async () => {
    const poison = await request(app)
      .put(`${BASE}/${NS}/${KEY}`)
      .set('X-Agent-Key', AGENT_KEY_BRAVO)
      .send({ data: { stripe_key: 'POISONED_BY_BRAVO' } })
    expect(poison.status).toBe(403)

    // alpha still sees the original secret — not poisoned
    const own = await request(app).get(`${BASE}/${NS}/${KEY}`).set('X-Agent-Key', AGENT_KEY_ALPHA)
    expect(own.body.data).toContain('sk_live_ALPHA_PRIVATE_1234')
    expect(own.body.data).not.toContain('POISONED')
  })

  test('bravo cannot dump alpha\'s version HISTORY (403)', async () => {
    // alpha overwrites once -> creates a history entry (carries project_id=alpha)
    const overwrite = await request(app)
      .put(`${BASE}/${NS}/${KEY}`)
      .set('X-Agent-Key', AGENT_KEY_ALPHA)
      .send({ data: { stripe_key: 'sk_live_ALPHA_ROTATED_5678' } })
    expect(overwrite.status).toBe(200)

    const cross = await request(app)
      .get(`${BASE}/${NS}/${KEY}/history`)
      .set('X-Agent-Key', AGENT_KEY_BRAVO)
    expect(cross.status).toBe(403)

    // owner can read history (the overwritten secret is visible to alpha only)
    const own = await request(app)
      .get(`${BASE}/${NS}/${KEY}/history`)
      .set('X-Agent-Key', AGENT_KEY_ALPHA)
    expect(own.status).toBe(200)
    expect(Array.isArray(own.body)).toBe(true)
    expect(own.body.length).toBeGreaterThan(0)
  })

  test('bravo cannot ROLL BACK alpha\'s key (403)', async () => {
    // find alpha's history entry id via the owner (bravo can't list it)
    const ownHist = await request(app)
      .get(`${BASE}/${NS}/${KEY}/history`)
      .set('X-Agent-Key', AGENT_KEY_ALPHA)
    const historyId = ownHist.body[0].id
    expect(historyId).toBeTruthy()

    const cross = await request(app)
      .post(`${BASE}/rollback/${historyId}`)
      .set('X-Agent-Key', AGENT_KEY_BRAVO)
    expect(cross.status).toBe(403)

    // owner can roll back
    const own = await request(app)
      .post(`${BASE}/rollback/${historyId}`)
      .set('X-Agent-Key', AGENT_KEY_ALPHA)
    expect(own.status).toBe(200)
    expect(own.body.ok).toBe(true)
  })

  test('bravo cannot bulk-overwrite alpha\'s key — that entry is rejected', async () => {
    const res = await request(app)
      .post(`${BASE}/bulk`)
      .set('X-Agent-Key', AGENT_KEY_BRAVO)
      .send({
        keys: [
          { namespace: NS, key: KEY, data: { poison: true } },                 // alpha's — denied
          { namespace: 'bravo_ns', key: 'own', data: { ok: true } }            // bravo's — allowed
        ]
      })
    expect(res.status).toBe(200)
    const alphaResult = res.body.results.find(r => r.namespace === NS && r.key === KEY)
    const bravoResult = res.body.results.find(r => r.namespace === 'bravo_ns' && r.key === 'own')
    expect(alphaResult.error).toMatch(/forbidden|cross-project/i)
    expect(bravoResult.ok).toBe(true)

    // alpha's key still not poisoned by the bulk attempt
    const own = await request(app).get(`${BASE}/${NS}/${KEY}`).set('X-Agent-Key', AGENT_KEY_ALPHA)
    expect(own.body.data).not.toContain('poison')
  })

  test('bravo cannot discover alpha\'s key via namespace LIST', async () => {
    const res = await request(app).get(`${BASE}/${NS}`).set('X-Agent-Key', AGENT_KEY_BRAVO)
    expect(res.status).toBe(200)
    // alpha's prod key must NOT appear in bravo's view of the alpha_secrets ns
    const found = (res.body || []).some(k => k.key === KEY)
    expect(found).toBe(false)
  })
})

describe('F1: no regression — shared/global keys stay swarm-readable', () => {
  test('a NULL-project (shared) key is readable by agents in any project', async () => {
    // system-written key carries no project -> shared/global (the legacy model)
    db.upsertContextKey('shared_ns', 'pub', JSON.stringify({ v: 'shared_config' }), 'system')

    const alpha = await request(app).get(`${BASE}/shared_ns/pub`).set('X-Agent-Key', AGENT_KEY_ALPHA)
    expect(alpha.status).toBe(200)
    expect(alpha.body.data).toContain('shared_config')

    const bravo = await request(app).get(`${BASE}/shared_ns/pub`).set('X-Agent-Key', AGENT_KEY_BRAVO)
    expect(bravo.status).toBe(200)
    expect(bravo.body.data).toContain('shared_config')
  })
})
