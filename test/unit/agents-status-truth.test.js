import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Roster-truth (2026-08-17): Velum showed the operator's own agent as dormant
// mid-conversation. Root cause: the health-patrol sweepers wrote offline
// through updateAgentHeartbeat(), which re-stamps last_heartbeat = now — so
// the column meant "when the platform last wrote the row", not "when the
// agent last spoke", and status never derived from heartbeat age anywhere.
// These tests pin the three repairs: a stamp-free sweeper writer, read-time
// presence derivation (demote-only), and 'retired' as the labelled state for
// ghost records. Same harness as agents-list-telemetry: temp DATA_DIR, then
// dynamic import.

let tmpDataDir
let db

const T0 = Date.parse('2026-08-17T18:00:00Z')
const hb = (ageS) => new Date(T0 - ageS * 1000).toISOString().replace('T', ' ').slice(0, 19)

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-status-truth-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = 'test-admin-key'
  process.env.JWT_SECRET = 'test-jwt-secret'
  db = await import('../../server/db.js')
  db.initDB()
  db.createAgent('hb-test', 'HB Test', 'proj', 'secret-hash', '[]')
})

afterAll(() => { if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true }) })

describe('the sweeper does not stamp heartbeats', () => {
  test('markAgentOffline preserves last_heartbeat and clears working_on', () => {
    db.updateAgentHeartbeat('hb-test', 'online', 'doing things')
    const before = db.getAgent('hb-test').last_heartbeat
    expect(before).toBeTruthy()
    db.markAgentOffline('hb-test')
    const row = db.getAgent('hb-test')
    expect(row.status).toBe('offline')
    expect(row.working_on).toBe('')
    // THE point: the timestamp still records when the agent last spoke.
    expect(row.last_heartbeat).toBe(before)
  })
})

describe('presence derives from heartbeat age (demote-only)', () => {
  const row = (status, ageS) => ({ id: 'x', status, last_heartbeat: ageS === null ? null : hb(ageS) })

  test('fresh online/idle/busy pass through', () => {
    expect(db.deriveAgentPresence(row('online', 60), T0).status).toBe('online')
    expect(db.deriveAgentPresence(row('idle', 60), T0).status).toBe('idle')
    expect(db.deriveAgentPresence(row('busy', 60), T0).status).toBe('busy')
  })

  test('a stale present-claim reads offline', () => {
    expect(db.deriveAgentPresence(row('online', 2 * 3600), T0).status).toBe('offline')
    expect(db.deriveAgentPresence(row('busy', 16 * 60), T0).status).toBe('offline')
  })

  test('a present-claim with no heartbeat at all reads offline', () => {
    expect(db.deriveAgentPresence(row('online', null), T0).status).toBe('offline')
  })

  test('never promotes: a deliberate offline under a fresh heartbeat stays offline', () => {
    expect(db.deriveAgentPresence(row('offline', 60), T0).status).toBe('offline')
  })

  test('operator states stick regardless of heartbeat age', () => {
    expect(db.deriveAgentPresence(row('retired', 60), T0).status).toBe('retired')
    expect(db.deriveAgentPresence(row('retired', 90 * 86400), T0).status).toBe('retired')
    expect(db.deriveAgentPresence(row('paused', 2 * 3600), T0).status).toBe('paused')
  })

  test('does not mutate its input', () => {
    const r = row('online', 2 * 3600)
    db.deriveAgentPresence(r, T0)
    expect(r.status).toBe('online')
  })
})

describe("'retired' is storable and sticky", () => {
  test('updateAgent persists status=retired and listAgents serves it', () => {
    db.createAgent('ghost-test', 'Ghost', 'proj', 'ghost-hash', '[]')
    db.updateAgent('ghost-test', { status: 'retired' })
    const row = db.listAgents().find((a) => a.id === 'ghost-test')
    expect(row.status).toBe('retired')
    expect(db.deriveAgentPresence(row, T0).status).toBe('retired')
  })

  test('a heartbeat resurrects a retired agent (retirement is falsifiable)', () => {
    db.updateAgentHeartbeat('ghost-test', 'online', 'back from the dead')
    expect(db.getAgent('ghost-test').status).toBe('online')
  })
})
