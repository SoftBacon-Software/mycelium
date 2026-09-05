import { describe, test, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

// THE BITE: a running instance could not answer "which version am I?" — the
// repo's own CONTRIBUTING "Reporting bugs" section asks reporters for
// "Mycelium version / commit hash", but /health only ever carried `version`
// (package.json's frozen "0.1.0", read once at boot). No commit identity
// existed anywhere in the server runtime, so every instance on earth —
// jetson01, Railway deploys, fresh clones — reported the same version string
// and nothing else, and both halves of the bug-report ask were guesswork.
//
// Contract pinned here:
//   case A — MYCELIUM_GIT_SHA wins over everything (the deployment seam:
//            containers and PaaS deploys have no .git to ask). Run INSIDE the
//            repo on purpose, where `git rev-parse` WOULD resolve: the env var
//            must still win.
//   case B — env unset + running inside a repo -> `git rev-parse --short HEAD`
//            resolves at boot (cached, asked once), or degrades to 'unknown'
//            when it can't (no git binary, not a repo, spawn failure). Boot
//            gains no new way to die.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')
const NODE = process.execPath
const PKG_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'runtime-identity-jwt-secret'

let port
let dataDir
let ioBuffer = '' // combined stdout+stderr of the current child

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

// One HTTP round-trip against the booted child. Resolves { status, body }.
function request(method, path) {
  return new Promise(function (resolve) {
    var req = http.request(
      { hostname: '127.0.0.1', port: port, method: method, path: path, headers: {} },
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
    req.end()
  })
}

function waitForHealth(timeoutMs) {
  var deadline = Date.now() + timeoutMs
  var poll = function () {
    return request('GET', '/health').then(function (r) {
      if (r.status === 200) return true
      if (Date.now() >= deadline) return false
      return new Promise(function (r2) { setTimeout(r2, 250) }).then(poll)
    })
  }
  return poll()
}

// Boot the REAL server as a child process with a fresh temp DATA_DIR, exactly
// like plugin-route-crash-isolation.test.js. envOverrides are applied on top
// of the inherited environment; `unset` names vars to delete (case B needs
// MYCELIUM_GIT_SHA absent even if a parent shell exported it).
let child
async function bootServer(opts) {
  dataDir = mkdtempSync(join(tmpdir(), 'myc-runtime-identity-'))
  port = await freePort()
  var env = Object.assign({}, process.env, {
    DATA_DIR: dataDir,
    ADMIN_KEY: ADMIN_KEY,
    JWT_SECRET: JWT_SECRET,
    PORT: String(port),
    TURN_SECRET: 'runtime-identity-turn-secret'
  }, opts.envOverrides || {})
  ;(opts.unset || []).forEach(function (name) { delete env[name] })

  child = spawn(NODE, [SERVER_ENTRY], { env: env, stdio: ['ignore', 'pipe', 'pipe'] })
  ioBuffer = ''
  child.stdout.on('data', function (d) { ioBuffer += d.toString() })
  child.stderr.on('data', function (d) { ioBuffer += d.toString() })

  var healthy = await waitForHealth(25000)
  if (!healthy) {
    throw new Error('server did not become healthy within 25s. IO:\n' + ioBuffer)
  }
}

afterEach(function () {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM') } catch (e) { /* process may have exited */ }
  }
  child = null
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
})

describe('runtime instance identity (live server, child process)', () => {
  test('case A: MYCELIUM_GIT_SHA wins — /health carries it as commit_sha', async () => {
    await bootServer({ envOverrides: { MYCELIUM_GIT_SHA: 'deadbeef01' } })
    var h = await request('GET', '/health')
    expect(h.status).toBe(200)
    expect(h.body && h.body.commit_sha, 'env-provided sha served verbatim').toBe('deadbeef01')
    expect(h.body && h.body.version, 'version still the package.json version (read, not hardcoded)')
      .toBe(PKG_VERSION)
  })

  test('case B: env unset + in-repo boot -> a git short sha, or honest unknown', async () => {
    await bootServer({ unset: ['MYCELIUM_GIT_SHA'] })
    var h = await request('GET', '/health')
    expect(h.status).toBe(200)
    expect(h.body && h.body.commit_sha, 'git-resolved short sha, or the degraded value')
      .toMatch(/^([0-9a-f]{7,40}|unknown)$/)
    expect(h.body && h.body.version).toBe(PKG_VERSION)
  })

  test('boot added no new crash mode — no [FATAL] on either path', () => {
    expect(ioBuffer).not.toContain('[FATAL]')
  })
})
