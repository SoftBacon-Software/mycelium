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
//      hit /safety/events — a route this server NEVER shipped (live 404). The
//      tools lived only in the m5Max MCP fork; this repo's own MCP surface
//      (mcp/) never declared them. Their absence is pinned here so any
//      revived client tool gets the honest "not here" from the server, and so
//      a future route named /safety/* is a deliberate decision, not an
//      accident that re-arms dead clients.
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

// Production source roots scanned for references to the removed seam and the
// never-existed safety route. test/ is excluded (this file names both).
const SCAN_ROOTS = ['server', 'mcp', 'sdk', 'runner']

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

describe('P0.3: the /safety/* routes the dead client tools called do not exist', () => {
  test('GET /safety/events answers 404 (the live-404 the audit caught, pinned)', async () => {
    const res = await request(app).get('/api/mycelium/safety/events').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404)
  })

  test('GET /safety/events/stats answers 404', async () => {
    const res = await request(app).get('/api/mycelium/safety/events/stats').set('X-Agent-Key', AGENT_KEY)
    expect(res.status).toBe(404)
  })

  test('POST /safety/events answers 404 too (no write side either)', async () => {
    const res = await request(app)
      .post('/api/mycelium/safety/events')
      .set('X-Agent-Key', AGENT_KEY)
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

  test('the dead MCP tool names appear nowhere in this repo\'s source', () => {
    var deadNames = ['list_safety_events', 'safety_stats', '/safety/events']
    for (var root of SCAN_ROOTS) {
      for (var file of walkJsFiles(join(REPO_ROOT, root))) {
        var src = readFileSync(file, 'utf8')
        for (var name of deadNames) {
          expect(src.includes(name), file + ' names ' + name).toBe(false)
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
