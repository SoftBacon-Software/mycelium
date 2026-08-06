import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// Two pass-through spies back the consult-the-gate proof below.
//
// listAllAgentsIncludingDrones has EXACTLY ONE callsite in the whole codebase: the
// first line of checkAgent's legacy sweep. So whether it was called is a faithful,
// unambiguous signal that the sweep BLOCK was entered (it fires even on an empty
// DB). That is what must flip with the gate: a dropped `if (hasLegacyBcryptAgents())`
// guard makes checkAgent call it on every forged request regardless of the gate, so
// asserting it is NOT called under a false gate is what catches the regression.
//
// bcrypt.compareSync is the ~100-300ms-per-call operation the sweep runs against any
// legacy $2b$/$2a$ hash. It is mocked (not real) so the gate-true case is instant and
// a deliberately-malformed seeded hash can't throw; every other bcryptjs surface
// (hash/compare on the studio-login path) stays real via importOriginal. NOTE:
// compareSync alone canNOT prove the guard — when the gate is false there are, by
// definition, no legacy hashes, so the sweep's inner startsWith('$2b$') short-
// circuits before compareSync either way. The listAll spy is the load-bearing one.
const spies = vi.hoisted(() => ({ compareSync: null, listAll: null }))

vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal()
  const real = actual.default || actual
  spies.compareSync = vi.fn(() => false)
  return { ...actual, default: { ...real, compareSync: spies.compareSync } }
})

vi.mock('../../server/db.js', async (importOriginal) => {
  const actual = await importOriginal()
  // Pass-through: real behavior, observed. listAllAgentsIncludingDrones has a single
  // callsite (checkAgent's sweep), so only the sweep can move this counter.
  spies.listAll = vi.fn((...args) => actual.listAllAgentsIncludingDrones(...args))
  return { ...actual, listAllAgentsIncludingDrones: spies.listAll }
})

// Assigned in beforeAll after the dynamic imports have run the mock factories above.
let compareSyncSpy
let listAllSpy

// C3: bcrypt-fallback DoS protection.
//
// checkAgent() guards its O(N_agents) bcrypt fallback sweep with
// hasLegacyBcryptAgents(). When NO agent carries a legacy $2b$/$2a$ key hash,
// the gate is `false` and a forged X-Agent-Key header can never trigger the sweep
// (each comparison is intentionally ~100-300ms, so an unguarded sweep is a CPU-DoS).
// The flag is lazily computed once, cached, and reset by clearAgentKeyCache().
//
// These tests pin the gate's accuracy + caching against a real temp DB so a
// regression that re-enables the unguarded sweep fails the suite. db.js reads
// DATA_DIR at module-eval time, so it MUST be set before importing mycelium.js.
//
// The FIRST describe pins the gate function itself. The SECOND describe (added per
// SUITE-HEALTH-2026-07 §1.4 "coverage seam") proves what the accuracy tests cannot:
// that checkAgent actually CONSULTS the gate before its sweep. It spies on
// listAllAgentsIncludingDrones (the sweep's single callsite) and asserts the
// sweep-entry call-count flips with the gate — so dropping
// `if (hasLegacyBcryptAgents())` from checkAgent now FAILS the suite. checkAgent is
// not exported, so those tests mount the real router (no server/port, same temp
// DATA_DIR) and forge an X-Agent-Key through it.

const SYNTHETIC_ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'

let tmpDataDir
let db
let mycelium
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-bcrypt-dos-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = SYNTHETIC_ADMIN_KEY
  db = await import('../../server/db.js')
  mycelium = await import('../../server/routes/mycelium.js')
  // The dynamic imports above are what first run the vi.mock factories, populating
  // the spies. Capture them now so the tests below read live call-counts.
  compareSyncSpy = spies.compareSync
  listAllSpy = spies.listAll
  db.initDB()
  // Mount the real router against this temp DB so the consult-the-gate tests can
  // drive checkAgent via supertest. This is NOT starting a server: no app.listen,
  // no port bound, same temp DATA_DIR, no second DB harness. checkAgent is not
  // exported, so the mounted route is the behavioral way to run it (same mount
  // pattern as the *-characterization suites).
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', mycelium.default)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Seed an agent whose api_key_hash is a legacy bcrypt hash (prefix $2b$).
function seedLegacyAgent(id) {
  db.createAgent(id, 'Legacy-' + id, 'proj-legacy',
    '$2b$12$abcdefghijklmnopqrstuv1234567890abcdefghijklmnopqrstuv', '[]')
}

describe('C3: bcrypt-fallback DoS protection', () => {
  test('fresh DB with no legacy hashes -> gate is false (forged key skips the sweep)', () => {
    mycelium.clearAgentKeyCache()
    // No agent in this fresh DB has a $2b$/$2a$ hash, so the gate is false and
    // checkAgent's `if (hasLegacyBcryptAgents())` block is never entered for a
    // forged key — i.e. zero bcrypt.compareSync calls.
    expect(mycelium.hasLegacyBcryptAgents()).toBe(false)
  })

  test('gate is accurate: detects a seeded legacy bcrypt agent', () => {
    mycelium.clearAgentKeyCache()
    seedLegacyAgent('legacy-dos-1')
    expect(mycelium.hasLegacyBcryptAgents()).toBe(true)
    db.deleteAgent('legacy-dos-1')
  })

  test('gate is cached until clearAgentKeyCache resets it', () => {
    mycelium.clearAgentKeyCache()
    expect(mycelium.hasLegacyBcryptAgents()).toBe(false) // prime -> cached false
    seedLegacyAgent('legacy-dos-2')                       // add legacy WITHOUT clearing
    expect(mycelium.hasLegacyBcryptAgents()).toBe(false)  // still cached, no re-query
    mycelium.clearAgentKeyCache()                         // now reset
    expect(mycelium.hasLegacyBcryptAgents()).toBe(true)   // re-query sees it
    db.deleteAgent('legacy-dos-2')
  })
})

// C3 (consultation): the describe above proves the GATE — hasLegacyBcryptAgents is
// accurate + cached. This one proves checkAgent CONSULTS it. The proof is the
// listAllAgentsIncludingDrones call-count (the sweep's single callsite) FLIPPING
// between the two cases: 0 when the gate is false (a forged header must not enter
// the sweep at all), >=1 when it is true (a seeded legacy agent). GET /tasks is
// checkAgentOrAdmin-guarded (routes/tasks.js), so an X-Agent-Key alone forces the
// checkAgent fallback — the forged key exercises the legacy-sweep path without
// touching admin auth.
describe('C3: checkAgent gates its bcrypt sweep on hasLegacyBcryptAgents', () => {
  // A key no agent owns: its SHA-256 won't O(1)-resolve, so checkAgent falls through
  // to the (gated) legacy sweep.
  const FORGED_AGENT_KEY = 'dvk_forged_bcrypt_dos_probe_' + 'z'.repeat(28)

  test('gate false (fresh DB): a forged X-Agent-Key does NOT enter the sweep', async () => {
    mycelium.clearAgentKeyCache()
    // Precondition + intent: no agent carries a $2b$/$2a$ hash, so the gate is false.
    expect(mycelium.hasLegacyBcryptAgents()).toBe(false)
    listAllSpy.mockClear()
    compareSyncSpy.mockClear()
    const res = await request(app)
      .get('/api/mycelium/tasks')
      .set('X-Agent-Key', FORGED_AGENT_KEY)
    // Forged key is rejected (no agent owns it) -> checkAgent ran end-to-end...
    expect(res.status).toBe(403)
    // ...yet the sweep block was never entered: listAllAgentsIncludingDrones (its
    // first statement, single callsite in the codebase) was NOT called. This IS the
    // DoS guard — a forged header does zero sweep work. Drop the
    // `if (hasLegacyBcryptAgents())` guard and this FAILS: the sweep calls listAll
    // on every forged request (even an empty DB), because that guard is the only
    // thing that skips the block.
    expect(listAllSpy).not.toHaveBeenCalled()
    // And therefore zero bcrypt comparisons. (Secondary: compareSync alone cannot
    // catch the dropped guard here — see the file header — so listAll is the gate.)
    expect(compareSyncSpy).not.toHaveBeenCalled()
  })

  test('gate true (seeded legacy): the same forged key DOES enter the sweep', async () => {
    mycelium.clearAgentKeyCache()
    seedLegacyAgent('legacy-dos-sweep')
    try {
      // Precondition: the seeded $2b$ agent flips the gate to true.
      expect(mycelium.hasLegacyBcryptAgents()).toBe(true)
      listAllSpy.mockClear()
      compareSyncSpy.mockClear()
      const res = await request(app)
        .get('/api/mycelium/tasks')
        .set('X-Agent-Key', FORGED_AGENT_KEY)
      // Still rejected (forged key matches nothing)...
      expect(res.status).toBe(403)
      // ...but now the sweep ran: listAllAgentsIncludingDrones was called, and the
      // forged key was compared against the legacy $2b$ hash. The listAll call-count
      // flipping 0 -> >=1 across these two tests is the proof checkAgent consults
      // the gate.
      expect(listAllSpy).toHaveBeenCalled()
      expect(compareSyncSpy).toHaveBeenCalledWith(
        FORGED_AGENT_KEY,
        expect.stringMatching(/^\$2[ab]\$/)
      )
    } finally {
      db.deleteAgent('legacy-dos-sweep')
    }
  })
})
