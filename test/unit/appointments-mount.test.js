import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

// The appointments mount gate.
//
// appointments/ shipped routes.js + db.js + schema.sql for months with NO
// plugin.json — the loader (server/plugins.js) skips any dir without a
// manifest, so the routes never mounted and GET /api/mycelium/appointments
// 404'd. That mattered because a LIVE caller exists outside the server tree:
// jarvis/squad/role_keying.py dials this exact URL to resolve per-role model
// appointments, and squad_loop.py's dispatch loop consumes it — every cycle
// was degrading to the static fallback map because the route wasn't there.
//
// This gate boots the REAL server (server/index.js, the same cold boot a
// deploy runs — default plugins dir, fresh DATA_DIR) and proves the chain
// end-to-end:
//   1. the loader picked the manifest up ('[plugins] Loaded appointments' in
//      the boot log — tracks-reality, not hardcoded),
//   2. GET /api/mycelium/appointments -> 200 with the EMPTY-table shape
//      { appointments: [] } — the exact body role_keying.py parses
//      (data.get("appointments")), so an empty table is a clean no-op, not
//      an error path,
//   3. GET /api/mycelium/plugins lists it enabled (the DB record seeded
//     'enabled: true' from the manifest on first insert),
//   4. PUT + GET round-trip proves schema.sql ran through the loader (the
//      appointments table exists) and the write path works.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')
const NODE = process.execPath

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'appointments-mount-jwt-secret'

let child
let port
let dataDir
let ioBuffer = '' // combined stdout+stderr — the boot log is assertion material

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

// One HTTP round-trip. Resolves { status, body } — status 0 on connection
// failure, so callers can distinguish 404 (mounted router says no) from dead.
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
          try { body = JSON.parse(raw) } catch (e) { /* keep raw text */ }
          resolve({ status: res.statusCode, body: body })
        })
      }
    )
    req.on('error', function () { resolve({ status: 0, body: null }) })
    req.setTimeout(5000, function () { req.destroy(); resolve({ status: 0, body: null }) })
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
  dataDir = mkdtempSync(join(tmpdir(), 'myc-appt-data-'))
  port = await freePort()

  child = spawn(NODE, [SERVER_ENTRY], {
    // Deliberately NO MYCELIUM_PLUGINS_DIR override: the shipped plugins dir
    // is the surface under test (no shipped plugin is type:'worker', so the
    // cold boot spawns nothing external).
    env: Object.assign({}, process.env, {
      DATA_DIR: dataDir,
      ADMIN_KEY: ADMIN_KEY,
      JWT_SECRET: JWT_SECRET,
      PORT: String(port),
      TURN_SECRET: 'appointments-mount-turn-secret'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', function (d) { ioBuffer += d.toString() })
  child.stderr.on('data', function (d) { ioBuffer += d.toString() })

  var healthy = await waitForHealth(45000)
  if (!healthy) {
    throw new Error('server did not become healthy within 45s. IO:\n' + ioBuffer)
  }
}, 60000)

afterAll(function () {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM') } catch (e) { /* process may have exited */ }
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('appointments plugin mount (live cold boot)', () => {
  test('the loader loaded it from the manifest (boot log, tracks-reality)', () => {
    // The loader logs '[plugins] Loaded <name> v<version> (N MCP tools)' per
    // discovered plugin. If the manifest is removed or renamed wrong, the
    // boot falls back to silently skipping the dir and this reds.
    expect(ioBuffer).toContain('[plugins] Loaded appointments')
  })

  test('GET /api/mycelium/appointments -> 200 { appointments: [] } (the empty-table shape)', async () => {
    var r = await request('GET', '/api/mycelium/appointments', {
      headers: { 'X-Admin-Key': ADMIN_KEY }
    })
    expect(r.status).toBe(200)
    // The shape contract: role_keying.py does data.get("appointments") and
    // iterates it — a wrapped empty array. A bare [] would throw AttributeError
    // into its fail-soft except; the wrapped shape is the honest empty state.
    expect(r.body).toEqual({ appointments: [] })
  })

  test('GET /api/mycelium/plugins lists appointments enabled (record seeded from manifest)', async () => {
    var r = await request('GET', '/api/mycelium/plugins', {
      headers: { 'X-Admin-Key': ADMIN_KEY }
    })
    expect(r.status).toBe(200)
    var rows = Array.isArray(r.body) ? r.body : (r.body && r.body.plugins) || []
    var appt = rows.find(function (p) { return p && p.name === 'appointments' })
    expect(appt, 'appointments record missing from /plugins').toBeTruthy()
    expect(appt.enabled).toBe(1)
  })

  test('PUT then GET: schema.sql ran and the write path works', async () => {
    var put = await request('PUT', '/api/mycelium/appointments/coder', {
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: 'test-model', engine: 'test-engine', host: '127.0.0.1' })
    })
    expect(put.status).toBe(200)
    expect(put.body && put.body.appointment && put.body.appointment.role).toBe('coder')

    var get = await request('GET', '/api/mycelium/appointments', {
      headers: { 'X-Admin-Key': ADMIN_KEY }
    })
    expect(get.status).toBe(200)
    expect(get.body.appointments).toHaveLength(1)
    expect(get.body.appointments[0]).toMatchObject({
      role: 'coder', model_id: 'test-model', engine: 'test-engine', host: '127.0.0.1'
    })
  })
})
