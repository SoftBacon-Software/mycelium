import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { fileURLToPath } from 'node:url'

// Trust-layer P0.3 — dead-code honesty (PROGRAM-mycelium-trust-layer
// 2026-09-26 §P0.3; safety-audit finding 1). Two artifacts died here:
//
//   1. The MCP CLIENT tools mycelium_list_safety_events / mycelium_safety_stats
//      hit /safety/events — a route this server did not ship when P0.3 was cut
//      (live 404), which is why the tools were dead and were removed
//      client-side (the m5Max MCP fork; this repo's own MCP surface (mcp/)
//      never declared them). Master has since BUILT the surface they pointed
//      at — trust layer P1.5 (#200) wired /safety/* to the append-only,
//      hash-chained memory audit log (server/routes/safety.js) — so the
//      honest pin is that route's contract (admin-only, no write side), not
//      the 404 that no longer exists, plus: this repo's client surfaces still
//      declare neither dead tool name.
//   2. The guardrails plugin's fail-open seam (checkGuardrails +
//      req.app._guardrailsCheck) outlived the plugin removed in task 186 —
//      nothing in production could install the hook field anymore, so all 12
//      fan-in sites could only ever fail open while their warning text told
//      readers to check a plugin that no longer exists. The seam and its call
//      sites are removed; this pins that no production file references them,
//      and that mutation routes behave identically with no hook installed.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'a'.repeat(48)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// Production source roots scanned for references to the removed seam. test/
// is excluded (this file names it).
const SCAN_ROOTS = ['server', 'mcp', 'sdk', 'runner']
// The client surfaces a revived safety tool would be declared in. server/ is
// deliberately NOT scanned for the tool names since P1.5 (#200): the names
// legitimately appear there now (the /safety/* routes and the memory-audit
// projection that feeds them name the dead tools they replaced).
const CLIENT_ROOTS = ['mcp', 'sdk', 'runner']

function walkJsFiles(dir) {
  var out = []
  for (var entry of readdirSync(dir)) {
    var full = join(dir, entry)
    var st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data' || entry === 'dist') continue
      out = out.concat(walkJsFiles(full))
    } else if (entry.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

var dataDir
var app

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'myc-p03-'))
  process.env.DATA_DIR = dataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  const db = await import('../../server/db.js')
  db.initDB()
  const mkHash = (k) => crypto.createHash('sha256').update(k).digest('hex')
  db.createAgent('p03-agent', 'P0.3 honesty test agent', 'proj', mkHash(AGENT_KEY), '[]')

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('P0.3: the /safety/* surface (built by trust layer P1.5) is admin-only with no write side', () => {
  test('GET /safety/events is admin-only — no credential answers 401', async () => {
    const res = await request(app).get('/api/mycelium/safety/events')
    expect(res.status).toBe(401)
  })

  test('GET /safety/events is admin-only — an agent key answers 401 too (checkAdmin never reads agent keys)', async () => {
    const res = await request(app).get('/api/mycelium/safety/events').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(401)
  })

  test('GET /safety/events answers 200 for the admin key (the audit projection)', async () => {
    const res = await request(app).get('/api/mycelium/safety/events').set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  test('GET /safety/events/stats answers 200 for the admin key ({total, breakdown})', async () => {
    const res = await request(app).get('/api/mycelium/safety/events/stats').set('X-Admin-Key', ADMIN_KEY)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('total')
    expect(res.body).toHaveProperty('breakdown')
  })

  test('POST /safety/events answers 404 even for admin (no write side — the audit log is written by its own writers only)', async () => {
    const res = await request(app)
      .post('/api/mycelium/safety/events')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ action: 'blocked', command: 'rm -rf /' })
    expect(res.status).toBe(404)
  })
})

describe('P0.3: the removed guardrails seam is gone from production source', () => {
  test('no production file references checkGuardrails or _guardrailsCheck', () => {
    for (var root of SCAN_ROOTS) {
      for (var file of walkJsFiles(join(REPO_ROOT, root))) {
        var src = readFileSync(file, 'utf8')
        expect(src.includes('checkGuardrails'), file).toBe(false)
        expect(src.includes('_guardrailsCheck'), file).toBe(false)
      }
    }
  })

  test('the repo\'s own client surfaces declare neither dead MCP tool name', () => {
    var deadToolNames = ['mycelium_list_safety_events', 'mycelium_safety_stats']
    for (var root of CLIENT_ROOTS) {
      for (var file of walkJsFiles(join(REPO_ROOT, root))) {
        var src = readFileSync(file, 'utf8')
        for (var name of deadToolNames) {
          expect(src.includes(name), file + ' declares ' + name).toBe(false)
        }
      }
    }
  })
})

describe('P0.3: removal changed no behavior — mutation routes work with no hook installed', () => {
  test('POST /spend succeeds on a plain app (was a guarded route)', async () => {
    const res = await request(app)
      .post('/api/mycelium/spend')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ cost_usd: 0.25, source: 'p03-test', description: 'dead code honesty' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('POST /tasks succeeds on a plain app (was a guarded route, x2 sites)', async () => {
    const res = await request(app)
      .post('/api/mycelium/tasks')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'P0.3 honesty probe' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')

    const upd = await request(app)
      .put('/api/mycelium/tasks/' + res.body.id)
      .set('X-Agent-Key', AGENT_KEY)
      .send({ status: 'in_progress' })
    expect(upd.status).toBe(200)
  })

  test('no route answers 403 "Blocked by guardrail" anymore', async () => {
    const res = await request(app)
      .post('/api/mycelium/bugs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'guardrail probe', description: 'must not be guardrail-blocked' })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('Blocked by guardrail')
  })
})
