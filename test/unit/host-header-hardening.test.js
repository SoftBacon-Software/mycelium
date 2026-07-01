import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

const JWT_SECRET = 'test-jwt-secret'
const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'a'.repeat(48)

let tmpDataDir
let db
let app

function jwtFor(role, displayName) {
  return jwt.sign(
    { studioUser: true, userId: 999, username: displayName.toLowerCase(), displayName, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-host-hardening-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-test', 'Lucy Test', 'host-proj', hash, '["code"]')
})

afterAll(() => {
  // Clean up env vars so other test files aren't affected
  delete process.env.PUBLIC_BASE_URL
  delete process.env.ALLOWED_HOSTS
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('getInstanceUrl — host-header hardening', { timeout: 10000 }, () => {
  // Helper: pull the resolved instance URL out of the mcp-config response body.
  function instanceUrlFrom(res) {
    return res.body.mcp_config.mcpServers.mycelium.env.MYCELIUM_URL
  }

  // (a) PUBLIC_BASE_URL set + evil Host -> returns PUBLIC_BASE_URL (trailing slash normalized)
  test('PUBLIC_BASE_URL overrides any Host header, trailing slash normalized', async () => {
    process.env.PUBLIC_BASE_URL = 'https://mycelium.example.com/'
    delete process.env.ALLOWED_HOSTS
    const res = await request(app)
      .get('/api/mycelium/agents/lucy-test/mcp-config')
      .set('Authorization', 'Bearer ' + jwtFor('admin', 'Greatness'))
      .set('Host', 'evil.attacker.com')
    expect(res.status).toBe(200)
    const url = instanceUrlFrom(res)
    expect(url).toContain('https://mycelium.example.com')
    expect(url).not.toContain('evil.attacker.com')
  })

  // (b) ALLOWED_HOSTS set + allowed Host -> returns it
  test('ALLOWED_HOSTS accepts a permitted Host header', async () => {
    delete process.env.PUBLIC_BASE_URL
    process.env.ALLOWED_HOSTS = 'mycelium.example.com,localhost:3002'
    const res = await request(app)
      .get('/api/mycelium/agents/lucy-test/mcp-config')
      .set('Authorization', 'Bearer ' + jwtFor('admin', 'Greatness'))
      .set('Host', 'mycelium.example.com')
    expect(res.status).toBe(200)
    expect(instanceUrlFrom(res)).toContain('mycelium.example.com')
  })

  // (c) ALLOWED_HOSTS set + evil Host -> throws (never reflects the evil host)
  test('ALLOWED_HOSTS rejects an unauthorized Host header with 400', async () => {
    delete process.env.PUBLIC_BASE_URL
    process.env.ALLOWED_HOSTS = 'mycelium.example.com'
    const res = await request(app)
      .get('/api/mycelium/agents/lucy-test/mcp-config')
      .set('Authorization', 'Bearer ' + jwtFor('admin', 'Greatness'))
      .set('Host', 'evil.attacker.com')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Host not allowed/i)
  })

  // (d) neither set -> current behavior (legacy fallback trusts the Host header)
  test('no PUBLIC_BASE_URL or ALLOWED_HOSTS: falls back to Host header (legacy)', async () => {
    delete process.env.PUBLIC_BASE_URL
    delete process.env.ALLOWED_HOSTS
    const res = await request(app)
      .get('/api/mycelium/agents/lucy-test/mcp-config')
      .set('Authorization', 'Bearer ' + jwtFor('admin', 'Greatness'))
      .set('Host', 'localhost:3002')
    expect(res.status).toBe(200)
    expect(instanceUrlFrom(res)).toContain('localhost:3002')
  })
})
