import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// C3: bcrypt-fallback DoS protection.
//
// checkAgent() guards its O(N_agents) bcrypt fallback sweep with
// hasLegacyBcryptAgents(). When NO agent carries a legacy $2b$/$2a$ key hash,
// the gate is `false` and a forged X-Agent-Key header can never trigger a full
// bcrypt.compareSync pass (each comparison is intentionally ~100-300ms, so an
// unguarded sweep is a CPU-DoS). The flag is lazily computed once, cached, and
// reset by clearAgentKeyCache() (key rotation / auto-migrate).
//
// These tests pin the gate's accuracy + caching against a real temp DB so a
// regression that re-enables the unguarded sweep fails the suite. db.js reads
// DATA_DIR at module-eval time, so it MUST be set before importing mycelium.js.

let tmpDataDir
let db
let mycelium

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-bcrypt-dos-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  mycelium = await import('../../server/routes/mycelium.js')
  db.initDB()
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
