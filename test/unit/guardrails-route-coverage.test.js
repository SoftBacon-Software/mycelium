import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Verifies the 8 POST routes newly wired to checkGuardrails each call it with
// the correct event kind, return-on-block (403), and do NOT over-block on the
// happy path. Mirrors the directive-and-upload-auth harness: real router, fresh
// temp DB, env set before the dynamic import so db.js / routes pick up DATA_DIR
// + ADMIN_KEY. The guardrails check is stubbed on the app (req.app._guardrailsCheck)
// — exactly the field the guardrails plugin attaches in production — so this
// exercises the real route wiring without needing the guardrail_rules DB table.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const BLOCKED_KEY = 'dvk_' + 'b'.repeat(48)
const ALLOWED_KEY = 'dvk_' + 'c'.repeat(48)

const BLOCKED_AGENT = 'blocked-test'
const ALLOWED_AGENT = 'allowed-test'

// The 8 newly-covered routes and the event kind each must pass to checkGuardrails.
const COVERED = [
  { path: '/spend', kind: 'spend_logged' },
  { path: '/runs', kind: 'run_started' },
  { path: '/assets', kind: 'asset_registered' },
  { path: '/events', kind: 'event_emitted' },
  { path: '/requests', kind: 'request_created' },
  { path: '/plans', kind: 'plan_created' },
  { path: '/bugs', kind: 'bug_created' },
  { path: '/feedback', kind: 'feedback_submitted' }
]
const NEW_KINDS = new Set(COVERED.map((c) => c.kind))

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-guardrails-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Stub the guardrails check exactly as the guardrails plugin attaches it
  // (req.app._guardrailsCheck). Blocks any of the new event kinds coming from
  // BLOCKED_AGENT; allows everything else. Returning rule_name = 'block-<kind>'
  // lets the 403 assertion confirm the EXACT event kind each route passed.
  app._guardrailsCheck = function (eventType, eventData) {
    if (eventData && eventData.agent === BLOCKED_AGENT && NEW_KINDS.has(eventType)) {
      return { allowed: false, violations: [{ rule_name: 'block-' + eventType }] }
    }
    return { allowed: true, violations: [] }
  }

  const mkHash = (k) => crypto.createHash('sha256').update(k).digest('hex')
  db.createAgent(BLOCKED_AGENT, 'Blocked Test', 'proj', mkHash(BLOCKED_KEY), '["code"]')
  db.createAgent(ALLOWED_AGENT, 'Allowed Test', 'proj', mkHash(ALLOWED_KEY), '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('newly-covered POST routes call checkGuardrails with the correct event kind', () => {
  test.each(COVERED)(
    'POST $path is blocked (403) with the $kind guardrail rule for a blocked agent',
    async ({ path, kind }) => {
      // Guardrail fires immediately after auth, before any payload validation,
      // so an empty body is enough to prove the wiring.
      const res = await request(app)
        .post('/api/mycelium' + path)
        .set('X-Agent-Key', BLOCKED_KEY)
        .send({})
      expect(res.status).toBe(403)
      // rule_name carries the exact event kind the route passed -> confirms mapping.
      expect(res.body.error).toBe('Blocked by guardrail: block-' + kind)
    }
  )

  test('happy path is NOT over-blocked: allowed agent POST /spend -> 200', async () => {
    const res = await request(app)
      .post('/api/mycelium/spend')
      .set('X-Agent-Key', ALLOWED_KEY)
      .send({ cost_usd: 0.5, source: 'test', description: 'unit test' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('happy path is NOT over-blocked: allowed agent POST /events -> 200', async () => {
    const res = await request(app)
      .post('/api/mycelium/events')
      .set('X-Agent-Key', ALLOWED_KEY)
      .send({ type: 'custom', summary: 'unit test' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')
  })
})
