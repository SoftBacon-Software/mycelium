import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

// THE BITE, caught live and pinned: on master (before guardPluginRouter), a
// plugin route whose async handler rejects becomes an unhandledRejection, and
// index.js's process-global backstop does `process.exit(1)` — killing the whole
// daemon (every connected agent, every in-flight task, dropped). Proven in STEP
// 0 against master 6d1d630: GET /health 200 -> POST /boom (process dies
// mid-request) -> GET /health 000 (connection refused), child exit code 1.
//
// This gate boots the REAL server as a child process with MYCELIUM_PLUGINS_DIR
// pointed at a temp dir carrying a rejecting-route plugin, then proves the
// fixed contract end-to-end:
//   GET /health (200) -> POST /boom (500) -> GET /health (200)
// The SECOND /health is the real bite — a 500 that still killed the daemon on
// the next tick would pass a status-only assertion. The child must still be
// alive (exitCode null, not killed) and no [FATAL] may reach the backstop.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')
const NODE = process.execPath

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'crash-gate-jwt-secret'
const PLUGIN_PREFIX = '/crash-gate'

// The test plugin: an unguarded async route that rejects (the bite), plus a
// reporting route that exposes whether the loader handed it core.asyncHandler
// (tracks-reality — removing the export from pluginCore reds that assertion).
const PLUGIN_ROUTES = `
import { Router } from 'express';
export default function (core) {
  var router = Router();
  router.get('/core-shape', function (req, res) {
    res.json({ hasAsyncHandler: typeof core.asyncHandler === 'function' });
  });
  router.post('/boom', async function (req, res) {
    throw new Error('crash-gate-boom');
  });
  return router;
}
`

let child
let port
let pluginsDir
let dataDir
let ioBuffer = '' // combined stdout+stderr — index.js writes [FATAL] to stdout

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
// failure (server dead), so callers can distinguish 500 (handled) from dead.
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
  pluginsDir = mkdtempSync(join(tmpdir(), 'myc-crash-plugins-'))
  // The temp plugins dir is outside the repo, so its .js files would default to
  // CommonJS. Ship a type:module stub so the child imports routes.js as ESM,
  // exactly as shipped plugins get ESM via the repo-root package.json.
  writeFileSync(join(pluginsDir, 'package.json'), '{"type":"module"}')
  // The temp plugins dir lives outside the repo, so the plugin's routes.js
  // can't resolve `express` from the repo's node_modules, and its .js would
  // default to CommonJS. The package.json above fixes ESM; this symlink gives
  // it the same dependency view a shipped plugin has. Read-only use.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(pluginsDir, 'node_modules'), 'dir')
  var pluginDir = join(pluginsDir, 'crash-gate')
  mkdirSync(pluginDir)
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'crash-gate', version: '0.0.1', routePrefix: PLUGIN_PREFIX, enabled: true
  }))
  writeFileSync(join(pluginDir, 'routes.js'), PLUGIN_ROUTES)

  dataDir = mkdtempSync(join(tmpdir(), 'myc-crash-data-'))
  port = await freePort()

  child = spawn(NODE, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      MYCELIUM_PLUGINS_DIR: pluginsDir,
      DATA_DIR: dataDir,
      ADMIN_KEY: ADMIN_KEY,
      JWT_SECRET: JWT_SECRET,
      PORT: String(port),
      // Quiet the boot chatter that isn't part of this contract.
      TURN_SECRET: 'crash-gate-turn-secret'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', function (d) { ioBuffer += d.toString() })
  child.stderr.on('data', function (d) { ioBuffer += d.toString() })

  var healthy = await waitForHealth(25000)
  if (!healthy) {
    throw new Error('server did not become healthy within 25s. IO:\n' + ioBuffer)
  }
}, 30000)

afterAll(function () {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM') } catch (e) { /* process may have exited */ }
  }
  if (pluginsDir) rmSync(pluginsDir, { recursive: true, force: true })
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('plugin route crash-isolation (live server, child process)', () => {
  test('the loader exports asyncHandler to plugins via core (tracks-reality)', async () => {
    // Observed through the REAL initPlugins -> loadPlugins -> routeModule.default(core)
    // pipeline (not hardcoded): removing the asyncHandler export from pluginCore
    // makes hasAsyncHandler false -> this reds.
    var shape = await request('GET', '/api/mycelium' + PLUGIN_PREFIX + '/core-shape', {
      headers: { 'X-Admin-Key': ADMIN_KEY }
    })
    expect(shape.status).toBe(200)
    expect(shape.body && shape.body.hasAsyncHandler).toBe(true)
  })

  test('rejecting async plugin route -> 500 AND daemon still serves /health', async () => {
    // 1. daemon is up
    var h1 = await request('GET', '/health')
    expect(h1.status).toBe(200)

    // 2. the bite — rejecting async plugin route must 500, not kill the process
    var boom = await request('POST', '/api/mycelium' + PLUGIN_PREFIX + '/boom', {
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(boom.status).toBe(500)

    // 3. the REAL bite — daemon still answers after the rejecting route was hit.
    // (A 500 that killed the daemon on the next tick would pass step 2 alone.)
    var h2 = await request('GET', '/health')
    expect(h2.status).toBe(200)

    // 4. the child process did not exit
    expect(child.exitCode).toBe(null)
    expect(child.killed).toBe(false)
  })

  test('no rejection reached the process-global [FATAL] backstop', () => {
    // index.js writes "[FATAL] unhandledRejection" to stdout right before
    // process.exit(1). After the fix, the guard routes the rejection to
    // next(err) -> app 500 handler, so neither token may appear.
    expect(ioBuffer).not.toContain('unhandledRejection')
    expect(ioBuffer).not.toContain('[FATAL]')
  })
})
