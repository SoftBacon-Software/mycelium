import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

// Review A round 3 BLOCKER (PR #189 @ 43b7d015): federation failed to load on
// a fresh install's FIRST boot. The loader applied each plugin's schema and
// immediately ran its routes factory in ONE pass, in readdirSync order — and
// readdir puts `federation` before `semantic-memory`, so on a fresh DB the
// store's provenance ALTER hit sm_embeddings before semantic-memory's schema
// created it, and the named error dropped the whole plugin for that boot.
// `docker compose up -d` boots ONCE — the product's own install path shipped
// without federation until a manual restart (the second boot healed).
//
// This gate is the reviewer's repro, verbatim, over the REAL plugins dir:
// a fresh DATA_DIR, ONE boot, and `GET /federation/network` answers 200 —
// not 404 — with `Loaded federation` in the boot log and no
// `Failed to load federation` line. No MYCELIUM_PLUGINS_DIR override: the
// whole point is the shipped load order.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')
const NODE = process.execPath

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'fresh-first-boot-jwt-secret'

let child
let port
let dataDir
let ioBuffer = '' // combined stdout+stderr — the boot log is part of the receipt

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
// failure (server dead).
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
  // The FRESH install: an empty data dir, exactly one boot against it.
  dataDir = mkdtempSync(join(tmpdir(), 'myc-fresh-first-boot-'))
  port = await freePort()

  child = spawn(NODE, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      DATA_DIR: dataDir,
      ADMIN_KEY: ADMIN_KEY,
      JWT_SECRET: JWT_SECRET,
      PORT: String(port),
      MYCELIUM_RATE_LIMIT: 'off'
      // deliberately NO MYCELIUM_PLUGINS_DIR — the shipped plugins, shipped order
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

afterAll(async function () {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM') } catch (e) { /* process may have exited */ }
    // A lane must not leave the server running behind it — wait for the exit,
    // escalating once, before the temp dir goes away.
    var exited = await new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(false) }, 5000)
      child.once('exit', function () { clearTimeout(t); resolve(true) })
    })
    if (!exited && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch (e) { /* already gone */ }
    }
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('federation loads on a fresh install\'s FIRST boot (review A round 3 blocker)', () => {
  test('GET /federation/network answers 200 on the first boot of a fresh DATA_DIR', async () => {
    var network = await request('GET', '/api/mycelium/federation/network', {
      headers: { 'X-Admin-Key': ADMIN_KEY }
    })
    // RED on 43b7d015: 404 — the plugin was dropped for this boot, so the
    // route was never mounted.
    expect(network.status).toBe(200)
    expect(network.body && network.body.ok).toBe(true)
    expect(typeof (network.body && network.body.network_id)).toBe('string')
  })

  test('the boot log says federation loaded — and never says it failed', () => {
    expect(ioBuffer).toContain('Loaded federation v')
    expect(ioBuffer).not.toContain('Failed to load federation')
  })
})
