import { describe, test, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Task 186 §3 (AUDIT-lab-clockwork-2026-09-12): the rate-limit prune
// setInterval was created INSIDE the rateLimit() factory, which module scope
// calls 3× (login/admin-write/agent-write limiters) — three identical 5-minute
// prune timers for one store. The prune is hoisted to ONE module-level timer.
//
// The spy goes up after db.js is imported+initialised (its own timers, if any,
// are not this contract) and before routes/mycelium.js loads — so the count is
// exactly the intervals the routes module itself schedules.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'myc-rl-hoist-'))
process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
// JWT_SECRET: mycelium.js reads it at module scope; unset it trips boot-env
// warnings that pollute this count.
process.env.JWT_SECRET = 'rl-hoist-jwt-secret'

var intervalCalls = []

beforeAll(async () => {
  var db = await import('../../server/db.js')
  db.initDB()

  var orig = globalThis.setInterval
  globalThis.setInterval = function (fn, ms) {
    intervalCalls.push(ms)
    return orig(fn, ms)
  }

  await import('../../server/routes/mycelium.js')
})

describe('rate-limit prune timer hoist (task 186 §3)', () => {
  // Inventory, stack-traced on the uncut tree (2026-09-12): SEVEN 300000ms
  // timers at module load — FIVE of them identical rate-limit prunes (the
  // factory is called at mycelium.js :60/:63/:65 AND studio.js :136/:137 —
  // the audit's "3×" undercounted), plus the studio-seen cache prune
  // (mycelium.js :480) and the health patrol (:2046), which are separate
  // legitimate timers. After the hoist: 5 − 5 + 1 = 3.
  test('module load schedules exactly THREE 5-minute timers (one prune + cache + patrol)', () => {
    var fives = intervalCalls.filter((ms) => ms === 5 * 60 * 1000)
    expect(fives, 'expected 3× 300000ms at module load (1 hoisted prune + studio-seen cache + patrol); got ' + intervalCalls.join(',')).toHaveLength(3)
  })

  test('calling the rateLimit() factory schedules no additional timers', async () => {
    var mod = await import('../../server/routes/mycelium.js')
    var before = intervalCalls.length
    var keyFn = function (req) { return 'k' }
    mod.rateLimit(keyFn, 10, 60000)
    mod.rateLimit(keyFn, 10, 60000)
    mod.rateLimit(keyFn, 10, 60000)
    expect(intervalCalls.length).toBe(before) // zero new timers
  })
})
