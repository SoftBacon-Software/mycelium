import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// H2 — liveness-write debounce. getStudioUser() runs on (nearly) every
// authenticated request and used to fire a `last_seen` UPDATE per request
// (2-3/req under dashboard polling). touchStudioUserSeenDebounce() caps that
// at ~one write per 30s per userId via an in-memory last-seen map.
//
// These tests exercise the debounce gating directly: the first call records a
// timestamp, rapid re-calls within the 30s window are skipped, and once the
// window elapses the cache refreshes again. Harness mirrors
// test/unit/registry-commit-pin.test.js: fresh temp DB, env set before the
// dynamic import; pool:'forks' isolates us.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let mod

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-liveness-debounce-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB()

  mod = await import('../../server/routes/mycelium.js')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('studio liveness-write debounce (H2)', () => {
  test('exports the debounce cache + wrapper for testability', () => {
    expect(mod._studioSeenCache).toBeDefined()
    expect(typeof mod.touchStudioUserSeenDebounce).toBe('function')
  })

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

  test('getStudioUser routes liveness through the debounced writer (source contract)', () => {
    const src = readFileSync(join(process.cwd(), 'server/routes/mycelium.js'), 'utf8')
    // the hot path must call the debounce wrapper, not the raw writer
    expect(src).toContain('touchStudioUserSeenDebounce(decoded.userId)')
    // the debounce wrapper must still call the raw writer underneath
    expect(src).toMatch(/function touchStudioUserSeenDebounce[\s\S]*touchStudioUserSeen\(userId\)/)
    // the raw immediate write must NOT be called directly from getStudioUser
    expect(src).not.toContain('touchStudioUserSeen(decoded.userId)')
  })
})
