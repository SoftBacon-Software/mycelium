import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

// Task 186 §1 + §5 + §6 (AUDIT-lab-clockwork-2026-09-12) — one real cold boot,
// three receipts read off it (the appointments-mount idiom: the boot log is
// assertion material):
//
//   §1  the in-place SQLite backup logs its resolved config at boot
//       (D6: defaults now 1/day × 3, env/instance_config overridable),
//   §5  the registry reconcile marks seeded ghost rows orphaned and GET
//       /plugins shows the flag (the live jetson DB carries 12 such rows),
//   §6  marketing mounts at /marketing (it was the ONE plugin at "/" —
//       invisible to the route-usage counters) and the four legacy top-level
//       prefixes (/bip /social /x /outreach) 301 to the new mount for one
//       release.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')
const NODE = process.execPath

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'marketing-mount-jwt-secret'
const TURN_SECRET = 'marketing-mount-turn-secret'

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
          try { body = JSON.parse(raw) } catch (e) { /* redirect/HTML bodies stay raw */ }
          resolve({ status: res.statusCode, headers: res.headers, body: body })
        })
      }
    )
    req.on('error', function () { resolve({ status: 0, headers: {}, body: null }) })
    req.setTimeout(8000, function () { req.destroy(); resolve({ status: 0, headers: {}, body: null }) })
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
  dataDir = mkdtempSync(join(tmpdir(), 'myc-mkt-data-'))

  // Seed the ghost rows BEFORE boot — the live jetson DB shape: registry rows
  // whose plugin directories are long gone (residency still enabled, no code).
  var seed = spawn(NODE, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    import(${JSON.stringify(join(REPO_ROOT, 'server', 'db.js'))}).then(function (db) {
      db.initDB();
      var ins = db.getDB().prepare("INSERT INTO plugins (name, display_name, enabled) VALUES (?, ?, ?)");
      ins.run('billing', 'Billing', 1);
      ins.run('residency', 'Residency', 1);
      console.log('seeded');
    });
  `], { stdio: 'inherit' })
  await new Promise(function (resolve) { seed.on('exit', resolve) })

  port = await freePort()
  child = spawn(NODE, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      DATA_DIR: dataDir,
      ADMIN_KEY: ADMIN_KEY,
      JWT_SECRET: JWT_SECRET,
      TURN_SECRET: TURN_SECRET,
      PORT: String(port),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

describe('marketing mount + legacy 301s + boot receipts (task 186)', () => {
  test('§1 boot log: the backup logs its resolved interval + retention', () => {
    expect(ioBuffer).toMatch(/\[backup\] SQLite backup config: every 24h, keep 3/)
  })

  test('§5 boot log: the registry reconcile reports the seeded ghosts', () => {
    expect(ioBuffer).toMatch(/\[plugins\] Registry reconcile: 2 orphaned \(no directory\), 0 restored/)
  })

  test('§5 GET /plugins marks ghost rows orphaned (residency stays enabled=1)', async () => {
    var r = await request('GET', '/api/mycelium/plugins', { headers: { 'X-Admin-Key': ADMIN_KEY } })
    expect(r.status).toBe(200)
    var byName = {}
    for (var p of r.body) byName[p.name] = p
    expect(byName.billing.orphaned).toBe(1)
    expect(byName.billing.orphaned_at).toBeTruthy()
    expect(byName.residency.orphaned).toBe(1)
    expect(byName.residency.enabled).toBe(1) // operator state never mutated
    expect(byName.appointments.orphaned).toBe(0) // real dir → never orphaned
  })

  test('§6 marketing mounts at /marketing (loaded + route_prefix recorded)', async () => {
    expect(ioBuffer).toMatch(/\[plugins\] Loaded marketing/)
    var r = await request('GET', '/api/mycelium/plugins', { headers: { 'X-Admin-Key': ADMIN_KEY } })
    var marketing = r.body.find(function (p) { return p.name === 'marketing' })
    expect(marketing.route_prefix).toBe('/marketing')
  })

  test('§6 legacy /bip 301s to /marketing/bip (path + query preserved)', async () => {
    var r = await request('GET', '/api/mycelium/bip/posts?page=2')
    expect(r.status).toBe(301)
    expect(r.headers.location).toBe('/api/mycelium/marketing/bip/posts?page=2')
  })

  test('§6 all four legacy prefixes redirect (social, x, outreach)', async () => {
    for (var legacy of ['/social', '/x', '/outreach']) {
      var r = await request('GET', '/api/mycelium' + legacy + '/anything')
      expect(r.status, legacy).toBe(301)
      expect(r.headers.location, legacy).toBe('/api/mycelium/marketing' + legacy + '/anything')
    }
  })

  test('§6 the new mount does NOT redirect', async () => {
    var r = await request('GET', '/api/mycelium/marketing/bip/posts', { headers: { 'X-Admin-Key': ADMIN_KEY } })
    expect(r.status).not.toBe(301)
    expect(r.status).not.toBe(308)
  })

  test('§6 /x-adjacent paths that are not the legacy prefix are untouched', async () => {
    // startsWith('/x') would over-match — only /x and /x/... may redirect.
    var r = await request('GET', '/api/mycelium/xTERS-really-not-a-route')
    expect(r.status).toBe(404)
  })
})
