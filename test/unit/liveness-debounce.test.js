import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// H2 — liveness-write debounce. getStudioUser() runs on (nearly) every
// authenticated request and used to fire a `last_seen` UPDATE per request
// (2-3/req under dashboard polling). touchStudioUserSeenDebounce() caps that
// at ~one write per 30s per userId via an in-memory last-seen map.
//
// Tests 1-3 exercise the debounce gating directly: the first call records a
// timestamp, rapid re-calls within the 30s window are skipped, and once the
// window elapses the cache refreshes again. Test 4 drives the REAL
// getStudioUser hot path through a mounted request and asserts BOTH that the
// wrapper is wired in (cache set) AND that it delegates to the raw DB writer
// (last_seen advances) — replacing a brittle source-text scan of call-site
// strings that would stay green through any behavior-preserving rename. (The
// raw writer touchStudioUserSeen() never touches the cache, so only the
// wrapper path sets it; and only a real DB write advances last_seen, which the
// cache-only tests above cannot see.) Harness mirrors
// test/unit/registry-commit-pin.test.js: fresh temp DB, env set before the
// dynamic import; pool:'forks' isolates us.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let db
let mod
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-liveness-debounce-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  mod = await import('../../server/routes/mycelium.js')
  app = express()
  app.use('/api/mycelium', mod.default)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('studio liveness-write debounce (H2)', () => {
  test('first call records a seen timestamp in the cache', () => {
    const cache = mod._studioSeenCache
    const uid = 'debounce-first-' + Date.now()
    delete cache[uid]
    mod.touchStudioUserSeenDebounce(uid)
    expect(typeof cache[uid]).toBe('number')
    expect(cache[uid]).toBeGreaterThan(0)
  })

  test('rapid re-calls within the 30s window are debounced (timestamp frozen)', () => {
    const cache = mod._studioSeenCache
    const uid = 'debounce-rapid-' + Date.now()
    delete cache[uid]
    mod.touchStudioUserSeenDebounce(uid)
    const first = cache[uid]
    // hammer it — none of these should advance the timestamp (window is 30s)
    for (let i = 0; i < 25; i++) mod.touchStudioUserSeenDebounce(uid)
    expect(cache[uid]).toBe(first)
  })

  test('after the 30s window elapses the cache refreshes again', () => {
    const cache = mod._studioSeenCache
    const uid = 'debounce-expired-' + Date.now()
    delete cache[uid]
    mod.touchStudioUserSeenDebounce(uid)
    // simulate the 30s window having elapsed by back-dating the cached stamp
    const backdated = cache[uid] - 31000
    cache[uid] = backdated
    mod.touchStudioUserSeenDebounce(uid)
    // the wrapper wrote again → cache holds a fresh stamp, not the back-dated one
    expect(cache[uid]).not.toBe(backdated)
    expect(cache[uid]).toBeGreaterThan(backdated)
  })

  test('the authenticated request hot path writes liveness through the debounce wrapper', async () => {
    // Drives the REAL getStudioUser hot path (invoked by checkAdmin /
    // checkAgentOrAdmin on (nearly) every authenticated request) end-to-end
    // via a mounted request — not the wrapper directly, and not a source scan.
    // getStudioUser is not exported, so a live request is the only way to
    // exercise it. Two behavioral signals cover what the old source-text mirror
    // could only approximate by grepping call-site strings:
    //   (1) _studioSeenCache[userId] is set  → getStudioUser ran the debounce
    //       WRAPPER. The raw writer touchStudioUserSeen() never touches the
    //       cache, so a bypass to the raw writer (or a dropped call) leaves the
    //       cache empty and this fails.
    //   (2) studio_users.last_seen advanced   → the wrapper delegated to the
    //       raw DB writer. Tests 1-3 observe only the in-memory cache, so a
    //       wrapper that stops writing to the DB would slip past them; this
    //       catches it.
    const username = 'liveness-hot-' + Date.now()
    const userId = db.createStudioUser(username, 'Hot Path', 'x', 'admin')
    const token = jwt.sign({ studioUser: true, userId, role: 'admin', displayName: 'Hot Path' }, JWT_SECRET, { expiresIn: '1h' })

    delete mod._studioSeenCache[userId]
    expect(db.listStudioUsers().find(u => u.id === userId).last_seen).toBeNull()

    // one authenticated request through the real router → getStudioUser fires
    const res = await request(app).get('/api/mycelium/agents').set('Authorization', 'Bearer ' + token)
    expect(res.status).toBe(200)

    // (1) wiring: the debounce wrapper ran on the hot path
    expect(mod._studioSeenCache[userId]).toBeGreaterThan(0)
    // (2) delegation: the wrapper wrote through to the DB
    expect(db.listStudioUsers().find(u => u.id === userId).last_seen).not.toBeNull()
  })
})
