import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// Regression pinned: an unguarded `async` route handler in a PLUGIN router
// that throws/rejects became an unhandledRejection — and index.js exits the
// process on unhandledRejection (crash diagnostics), so one missing try/catch
// in one plugin route killed the whole daemon. This shipped twice
// (semantic-memory /reindex + /backfill, fixed per-instance in 92b6873) and
// was still live on semantic-memory /search when the seam guard landed. Proven
// end-to-end against master 6d1d630 in STEP 0: POST to a rejecting async plugin
// route -> [FATAL] unhandledRejection -> exit(1) -> /health refuses connection.
//
// The fix: plugins.js guardPluginRouter() wraps every handler of a plugin
// router at mount time, forwarding sync throws AND rejected promises to
// next(err) so they reach the app-level error handler (500) instead of
// crashing the process. These tests exercise the guard exactly the way
// loadPlugins() applies it: build a plugin-style router, guard it, mount it,
// and hit it with supertest. Any rejection that escapes the guard fails the
// test run itself (vitest treats unhandled rejections as errors), so a
// regression here is loud.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'

let tmpDataDir
let guardPluginRouter

// Track rejections that escape Express — the exact class that kills the daemon.
const escapedRejections = []
function onRejection(reason) { escapedRejections.push(reason) }

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-plugin-guard-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  // plugins.js imports db.js — set DATA_DIR before the dynamic import (same
  // harness discipline as the other route tests; pool:'forks' isolates us).
  const plugins = await import('../../server/plugins.js')
  guardPluginRouter = plugins.guardPluginRouter

  process.on('unhandledRejection', onRejection)
})

afterAll(() => {
  process.removeListener('unhandledRejection', onRejection)
  rmSync(tmpDataDir, { recursive: true, force: true })
})

// Build an app the way loadPlugins mounts plugin routers: guarded sub-router
// under a prefix, with the same shape of app-level error handler index.js has.
function appWith(pluginRouter) {
  const app = express()
  app.use(express.json())
  app.use('/api/mycelium/testplugin', guardPluginRouter(pluginRouter, 'testplugin'))
  app.use(function (err, req, res, _next) {
    if (res.headersSent) return
    res.status(500).json({ error: 'Internal server error', _from: 'app_error_handler', _msg: err.message })
  })
  return app
}

describe('guardPluginRouter — plugin async rejections must not escape Express', () => {
  test('rejected promise from async route handler → 500 via error handler, no escaped rejection', async () => {
    const r = express.Router()
    r.post('/search', async function (req, res) {
      throw new Error('db exploded mid-search')
    })
    const res = await request(appWith(r)).post('/api/mycelium/testplugin/search').send({ query: 'x' })
    expect(res.status).toBe(500)
    expect(res.body._from).toBe('app_error_handler')
    expect(res.body._msg).toBe('db exploded mid-search')
    expect(escapedRejections).toHaveLength(0)
  })

  test('sync throw inside async handler (no await) → 500, not a crash', async () => {
    const r = express.Router()
    r.get('/captions', async function (req, res) {
      // Gratuitous `async` turns this throw into a rejection on Express 4
      JSON.parse('{not json')
    })
    const res = await request(appWith(r)).get('/api/mycelium/testplugin/captions')
    expect(res.status).toBe(500)
    expect(res.body._from).toBe('app_error_handler')
    expect(escapedRejections).toHaveLength(0)
  })

  test('async plain middleware (router.use) rejection → 500, not a crash', async () => {
    const r = express.Router()
    r.use(async function (req, res, next) {
      throw new Error('middleware rejected')
    })
    r.get('/anything', function (req, res) { res.json({ ok: true }) })
    const res = await request(appWith(r)).get('/api/mycelium/testplugin/anything')
    expect(res.status).toBe(500)
    expect(escapedRejections).toHaveLength(0)
  })

  test('nested sub-router async rejection → 500 (guard recurses)', async () => {
    const sub = express.Router()
    sub.get('/deep', async function (req, res) {
      throw new Error('nested rejection')
    })
    const r = express.Router()
    r.use('/sub', sub)
    const res = await request(appWith(r)).get('/api/mycelium/testplugin/sub/deep')
    expect(res.status).toBe(500)
    expect(res.body._msg).toBe('nested rejection')
    expect(escapedRejections).toHaveLength(0)
  })

  test('healthy handlers still work through the guard (happy path untouched)', async () => {
    const r = express.Router()
    r.get('/ok-sync', function (req, res) { res.json({ ok: 'sync' }) })
    r.post('/ok-async', async function (req, res) { res.json({ ok: 'async', echo: req.body.v }) })
    const app = appWith(r)
    const a = await request(app).get('/api/mycelium/testplugin/ok-sync')
    expect(a.status).toBe(200)
    expect(a.body.ok).toBe('sync')
    const b = await request(app).post('/api/mycelium/testplugin/ok-async').send({ v: 42 })
    expect(b.status).toBe(200)
    expect(b.body).toEqual({ ok: 'async', echo: 42 })
  })

  test("plugin's own error middleware (arity 4) is left intact and still fires first", async () => {
    const r = express.Router()
    r.get('/handled', async function (req, res) {
      throw new Error('caught by plugin')
    })
    r.use(function (err, req, res, _next) {
      res.status(502).json({ _from: 'plugin_error_handler', _msg: err.message })
    })
    const res = await request(appWith(r)).get('/api/mycelium/testplugin/handled')
    expect(res.status).toBe(502)
    expect(res.body._from).toBe('plugin_error_handler')
    expect(res.body._msg).toBe('caught by plugin')
    expect(escapedRejections).toHaveLength(0)
  })

  test('unrecognizable router shape is returned untouched (fail-open, no throw)', () => {
    expect(guardPluginRouter(null, 'x')).toBe(null)
    const notARouter = { stack: 'nope' }
    expect(guardPluginRouter(notARouter, 'x')).toBe(notARouter)
    const fn = function (req, res) {}
    expect(guardPluginRouter(fn, 'x')).toBe(fn)
  })
})
