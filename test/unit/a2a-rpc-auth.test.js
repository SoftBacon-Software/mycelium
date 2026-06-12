import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// The A2A gateway's JSON-RPC endpoint (POST /api/mycelium/a2a/rpc) was
// UNAUTHENTICATED while enabled by default — tasks/send inserts real task
// rows and creates a `directive` message to a live agent, and those tasks
// are consumed by runners that execute shell commands. Anyone reachable
// could inject work. The Agent Card even advertises apiKey auth while the
// handler enforced none. This pins: /rpc requires a valid agent/admin key.
//
// Same harness shape as auth-roles.test.js — real router + real plugin
// loader against a fresh temp DB, env set before dynamic import.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY = 'dvk_' + 'b'.repeat(48)

let tmpDataDir
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-a2a-auth-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB()

  // a2a-gateway ships disabled-by-default now; model an operator who turned
  // it ON, then assert /rpc is STILL authenticated. Pre-seed the record as
  // enabled so loadPlugins' existing-record path preserves the override.
  db.ensurePluginRecord({
    name: 'a2a-gateway', displayName: 'A2A Gateway', description: '',
    version: '1.0.0', author: '', routePrefix: '/a2a', enabled: true,
  })

  const mycelium = await import('../../server/routes/mycelium.js')
  await mycelium.initPlugins() // mounts the a2a-gateway plugin under /a2a
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', mycelium.default)

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-test', 'Lucy Test', 'a2a-proj', hash, '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const rpcSend = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tasks/send',
  params: { message: { parts: [{ type: 'text', text: 'do a thing' }] } },
}

describe('A2A /rpc authentication', () => {
  test('unauthenticated tasks/send is rejected with 401 (no task injected)', async () => {
    const res = await request(app).post('/api/mycelium/a2a/rpc').send(rpcSend)
    expect(res.status).toBe(401)
  })

  test('invalid agent key is rejected (401 missing / 403 forbidden)', async () => {
    const res = await request(app)
      .post('/api/mycelium/a2a/rpc')
      .set('X-Agent-Key', 'dvk_' + 'z'.repeat(48))
      .send(rpcSend)
    expect([401, 403]).toContain(res.status)
  })

  test('valid agent key is accepted (request is processed, not auth-rejected)', async () => {
    const res = await request(app)
      .post('/api/mycelium/a2a/rpc')
      .set('X-Agent-Key', AGENT_KEY)
      .send(rpcSend)
    expect(res.status).not.toBe(401)
    // JSON-RPC envelope comes back (a result or a protocol error), not an auth wall
    expect(res.body).toHaveProperty('jsonrpc', '2.0')
  })

  test('admin key is accepted', async () => {
    const res = await request(app)
      .post('/api/mycelium/a2a/rpc')
      .set('X-Admin-Key', ADMIN_KEY)
      .send(rpcSend)
    expect(res.status).not.toBe(401)
  })

  test('malformed JSON-RPC from an authed caller still gets the -32600 envelope', async () => {
    const res = await request(app)
      .post('/api/mycelium/a2a/rpc')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ not: 'jsonrpc' })
    expect(res.status).not.toBe(401)
    expect(res.body.error).toMatchObject({ code: -32600 })
  })
})
