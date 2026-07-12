import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// POST /studio/login is the operator auth front door — it mints the JWTs that
// checkAdmin / checkAdminOrOperator / checkAgentOrAdmin trust everywhere else.
// It previously had ZERO direct test coverage (it only appeared in the route
// manifest snapshot). Contracts pinned here:
//
//   1. Success returns { token, user } — token verifies under JWT_SECRET with
//      studioUser:true + role (the exact claims getStudioUser() requires).
//   2. Wrong-password and unknown-username both return 401 with the SAME
//      generic message (no username-enumeration via response body)...
//   3. ...and the unknown-username path pays a real bcrypt compare (dummy-hash
//      timing equalization) so response time isn't an enumeration oracle either.
//   4. Username is trimmed + case-insensitive (normalization at registration
//      and login must agree, or operators get locked out by cosmetics).
//   5. loginLimiter returns 429 + Retry-After under brute force. This test
//      MUST stay last in the file — the limiter store is module-global and
//      every earlier login attempt in this file spends its budget.
//
// Same harness as auth-roles.test.js: real router, fresh temp DB, env set
// before the dynamic import. pool:'forks' isolates the module-global limiter.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const PASSWORD = 'correct-horse-battery'

let tmpDataDir
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-studio-login-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Register the operator through the real admin route so the stored hash and
  // username normalization are exactly what production writes.
  const reg = await request(app)
    .post('/api/mycelium/studio/users')
    .set('X-Admin-Key', ADMIN_KEY)
    .send({ username: 'Gilbert', password: PASSWORD, display_name: 'Gilbert', role: 'admin' })
  if (reg.status !== 200) throw new Error('test setup: user registration failed: ' + JSON.stringify(reg.body))
})

afterAll(() => {
  rmSync(tmpDataDir, { recursive: true, force: true })
})

function login(body) {
  return request(app).post('/api/mycelium/studio/login').send(body)
}

describe('POST /studio/login', () => {
  test('valid credentials → token + user; token carries the claims getStudioUser requires', async () => {
    const res = await login({ username: 'gilbert', password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ username: 'gilbert', role: 'admin' })
    const decoded = jwt.verify(res.body.token, JWT_SECRET, { algorithms: ['HS256'] })
    expect(decoded.studioUser).toBe(true)
    expect(decoded.role).toBe('admin')
    expect(decoded.username).toBe('gilbert')
    expect(decoded.userId).toBe(res.body.user.id)
    // 7-day expiry (STUDIO_JWT_EXPIRY) — generous bounds, not exact seconds
    const ttl = decoded.exp - decoded.iat
    expect(ttl).toBeGreaterThan(6 * 24 * 3600)
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600)
  })

  test('minted token round-trips: GET /studio/me authenticates with it', async () => {
    const res = await login({ username: 'gilbert', password: PASSWORD })
    const me = await request(app)
      .get('/api/mycelium/studio/me')
      .set('Authorization', 'Bearer ' + res.body.token)
    expect(me.status).toBe(200)
    expect(me.body.username).toBe('gilbert')
    expect(me.body.role).toBe('admin')
  })

  test('username is trimmed + case-insensitive at login', async () => {
    const res = await login({ username: '  GILBERT  ', password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe('gilbert')
  })

  test('missing fields → 400', async () => {
    expect((await login({ username: 'gilbert' })).status).toBe(400)
    expect((await login({ password: PASSWORD })).status).toBe(400)
  })

  test('wrong password and unknown user: both 401 with IDENTICAL generic message', async () => {
    const wrongPw = await login({ username: 'gilbert', password: 'wrong-password-123' })
    const noUser = await login({ username: 'no-such-user', password: 'wrong-password-123' })
    expect(wrongPw.status).toBe(401)
    expect(noUser.status).toBe(401)
    // The two failure modes must be indistinguishable in the body
    expect(noUser.body.error).toBe(wrongPw.body.error)
    expect(wrongPw.body.error).toBe('Invalid username or password')
  })

  test('unknown-user path pays a real bcrypt compare (timing-oracle equalization)', async () => {
    // Coarse floor, not a precision timing test: bcryptjs at 10 rounds costs
    // tens of ms even on fast hardware. Before the dummy-hash fix the unknown-
    // user path returned in ~0ms (no bcrypt), which was the enumeration oracle.
    const t0 = Date.now()
    await login({ username: 'definitely-not-a-user', password: 'x'.repeat(20) })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(15)
  })

  // KEEP LAST: exhausts the shared per-IP login budget (10 per 15 min).
  test('brute force → 429 with Retry-After (loginLimiter)', async () => {
    let limited = null
    for (let i = 0; i < 15; i++) {
      const res = await login({ username: 'gilbert', password: 'brute-force-guess' })
      if (res.status === 429) { limited = res; break }
      expect(res.status).toBe(401) // until the limiter trips, still generic 401
    }
    expect(limited, 'limiter never returned 429 within 15 attempts').not.toBeNull()
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(limited.body.error).toMatch(/Too many attempts/)
  })
})
