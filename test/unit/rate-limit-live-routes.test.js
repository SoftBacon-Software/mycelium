// Task 240 — the six rate-limited routes, LIVE: one real cold boot, then the
// limiter is read off the wire. The tightest bucket gets the full hammer
// (max+1 requests -> 429 with Retry-After); the five machine-cadence routes
// get a wiring probe — one request each, asserting the RateLimit-Limit header
// carries the MEASURED ceiling from the PR body (probe requests are 404s on
// nonexistent ids, which proves the limiter sits BEFORE the handler's reads).
//
// Ceilings under test (jetson01 route_usage, 2026-09-09..09-18):
//   voice/turn-credentials 60 (own tighter bucket; the hammer),
//   auto-memory reverify 900 (10x the ~90-call daily sweep),
//   auto-memory supersede/stats 120 and marketing x publish + bip
//   approve/reject 120 (the floor — supersede <=4/day, stats ~1/day,
//   marketing: zero rows ever).
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'rate-limit-live-jwt-secret'
const TURN_SECRET = 'rate-limit-live-turn-secret'

var child
var port
var dataDir
var ioBuffer = ''

function freePort() {
  return new Promise(function (resolve, reject) {
    var srv = http.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', function () {
      var p = srv.address().port
      srv.close(function () { resolve(p) })
    })
  })
}

function request(method, path, opts) {
  opts = opts || {}
  return new Promise(function (resolve) {
    var req = http.request(
      { hostname: '127.0.0.1', port: port, method: method, path: path, headers: opts.headers || {} },
      function (res) {
        var chunks = []
        res.on('data', function (c) { chunks.push(c) })
        res.on('end', function () {
          var raw = Buffer.concat(chunks).toString('utf8')
          var body = raw
          try { body = JSON.parse(raw) } catch (e) { /* non-JSON bodies stay raw */ }
          resolve({ status: res.statusCode, headers: res.headers, body: body })
        })
      }
    )
    req.on('error', function () { resolve({ status: 0, headers: {}, body: null }) })
    req.setTimeout(8000, function () { req.destroy(); resolve({ status: 0, headers: {}, body: null }) })
    if (opts.body !== undefined && !opts.headers['content-type']) {
      req.setHeader('content-type', 'application/json')
    }
    req.end(opts.body || '')
  })
}

async function waitForHealth(timeoutMs) {
  var deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    var r = await request('GET', '/health')
    if (r.status === 200) return true
    await new Promise(function (r) { setTimeout(r, 250) })
  }
  return false
}

beforeAll(async function () {
  dataDir = mkdtempSync(join(tmpdir(), 'myc-rl-live-'))
  port = await freePort()
  var env = Object.assign({}, process.env, {
    DATA_DIR: dataDir,
    ADMIN_KEY: ADMIN_KEY,
    JWT_SECRET: JWT_SECRET,
    TURN_SECRET: TURN_SECRET,
    PORT: String(port),
  })
  delete env.MYCELIUM_RATE_LIMIT // the kill-switch must be OFF (enforcement on)
  child = spawn(process.execPath, [SERVER_ENTRY], { env: env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', function (d) { ioBuffer += d.toString() })
  child.stderr.on('data', function (d) { ioBuffer += d.toString() })
  var healthy = await waitForHealth(30000)
  if (!healthy) throw new Error('server did not become healthy. IO:\n' + ioBuffer)
}, 40000)

afterAll(function () {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM') } catch (e) { /* already gone */ }
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

var AUTH = { 'X-Admin-Key': ADMIN_KEY }

describe('rate-limited routes, live boot (task 240)', () => {
  test('voice/turn-credentials: 60 requests pass, the 61st is a 429 with Retry-After', async function () {
    var last200 = null
    for (var i = 0; i < 60; i++) {
      last200 = await request('GET', '/api/voice/turn-credentials', { headers: AUTH })
      expect(last200.status).toBe(200)
      expect(last200.body.iceServers.length).toBeGreaterThan(0)
    }
    expect(last200.headers['ratelimit-remaining']).toBe('0')
    var blocked = await request('GET', '/api/voice/turn-credentials', { headers: AUTH })
    expect(blocked.status).toBe(429)
    expect(blocked.headers['retry-after']).toBeDefined()
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(blocked.body.error).toContain('voice/turn-credentials')
  }, 30000)

  test('auto-memory/facts/:id/reverify ceiling is the measured 900/min', async function () {
    var r = await request('POST', '/api/mycelium/auto-memory/facts/999999999/reverify', { headers: AUTH, body: '{}' })
    expect(r.status).toBe(404) // past the limiter, before facts exist — wiring proven
    expect(r.headers['ratelimit-limit']).toBe('900')
  })

  test('auto-memory/facts/:id/supersede ceiling is the floor 120/min', async function () {
    var r = await request('POST', '/api/mycelium/auto-memory/facts/999999999/supersede', { headers: AUTH, body: '{"new_id":1}' })
    expect(r.status).toBe(404)
    expect(r.headers['ratelimit-limit']).toBe('120')
  })

  test('auto-memory/stats ceiling is the floor 120/min', async function () {
    var r = await request('GET', '/api/mycelium/auto-memory/stats', { headers: AUTH })
    expect(r.status).toBe(200)
    expect(r.headers['ratelimit-limit']).toBe('120')
  })

  test('marketing publish/approve/reject ceilings are the floor 120/min', async function () {
    var pub = await request('POST', '/api/mycelium/marketing/x/posts/999999999/publish', { headers: AUTH, body: '{}' })
    expect(pub.status).toBe(404)
    expect(pub.headers['ratelimit-limit']).toBe('120')
    var approve = await request('POST', '/api/mycelium/marketing/bip/drafts/999999999/approve', { headers: AUTH, body: '{}' })
    expect(approve.status).toBe(404)
    expect(approve.headers['ratelimit-limit']).toBe('120')
    var reject = await request('POST', '/api/mycelium/marketing/bip/drafts/999999999/reject', { headers: AUTH, body: '{}' })
    expect(reject.status).toBe(404)
    expect(reject.headers['ratelimit-limit']).toBe('120')
  })
})
