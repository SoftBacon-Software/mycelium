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
// presence derivation, and 'retired' as the labelled state for ghost records.
//
// Task 191 (2026-09-17) tightens the read: derivation is TWO-WAY. The demote-
// only rule trusted a stored 'offline' as "a deliberate shutdown" — but the
// MCP fork's shutdown goodbye POSTs a heartbeat that stamps a FRESH
// last_heartbeat with status 'offline', and the sweepers write status-only.
// Measured on jetson01: GET /agents/m5Max returned status 'offline' beside a
// 2-minute-old heartbeat. A stored byte a writer can leave behind by accident
// is not evidence; the heartbeat age is. Same harness as
// agents-list-telemetry: temp DATA_DIR, then dynamic import.

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

describe('presence derives from heartbeat age (two-way since task 191)', () => {
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

  test('a 90-second-old heartbeat outranks a stored offline (the defect row)', () => {
    // The shutdown goodbye stamps a fresh heartbeat WITH status 'offline';
    // the sweeper writes status-only. Either way the byte is the lie and the
    // stamp is the truth — the demote-only "deliberate goodbye" carve-out
    // trusted exactly the writer that manufactured the defect.
    expect(db.deriveAgentPresence(row('offline', 90), T0).status).toBe('online')
  })

  test('a 3-day-old heartbeat reads offline regardless of the stored byte', () => {
    expect(db.deriveAgentPresence(row('offline', 3 * 86400), T0).status).toBe('offline')
    expect(db.deriveAgentPresence(row('online', 3 * 86400), T0).status).toBe('offline')
    expect(db.deriveAgentPresence(row('idle', 3 * 86400), T0).status).toBe('offline')
  })

  test('a never-heartbeated row keeps its stored value (schema default: offline)', () => {
    expect(db.deriveAgentPresence(row('offline', null), T0).status).toBe('offline')
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

// ---- Route level: the two WRITERS that manufactured offline-with-fresh-
// heartbeat rows, and the roster surfaces that must render through the
// derivation. Harness mirrors kill-switch-freezes-work: real router on a
// bare express app at /api/mycelium, admin-key auth. ----
describe('the roster renders status from the heartbeat (task 191)', () => {
  let request
  let app

  beforeAll(async () => {
    const routes = (await import('../../server/routes/mycelium.js')).default
    const express = (await import('express')).default
    request = (await import('supertest')).default
    app = express()
    app.use(express.json())
    app.use('/api/mycelium', routes)
  })

  const adminHeaders = () => ({ 'X-Admin-Key': 'test-admin-key', 'X-Acting-As': 'p191-test' })
  const beat = (id, body) =>
    request(app).post('/api/mycelium/agents/heartbeat').set(adminHeaders()).send({ agent_id: id, ...body })

  test('sweeper false-positive: stored offline under a seconds-old heartbeat renders online', async () => {
    db.createAgent('p191-a', 'P191 A', 'proj', 'hash-191-a', '[]')
    await beat('p191-a', { status: 'online', working_on: 'measuring' }).expect(200)
    db.markAgentOffline('p191-a') // the sweeper's writer: status only, never a stamp
    const stored = db.getAgent('p191-a')
    expect(stored.status).toBe('offline') // the lie is stored…
    expect(stored.last_heartbeat).toBeTruthy() // …but the agent spoke seconds ago
    const res = await request(app).get('/api/mycelium/agents/p191-a').set(adminHeaders()).expect(200)
    expect(res.body.status).toBe('online') // the roster renders the truth
  })

  test('shutdown goodbye: a heartbeat carrying status offline stores online and renders online', async () => {
    db.createAgent('p191-b', 'P191 B', 'proj', 'hash-191-b', '[]')
    await beat('p191-b', { status: 'online', working_on: 'session' }).expect(200)
    await beat('p191-b', { status: 'offline', working_on: '' }).expect(200)
    // A liveness write never stores 'offline' — going quiet (staleness) is
    // how an agent goes offline, not a status byte under a fresh stamp.
    expect(db.getAgent('p191-b').status).toBe('online')
    const res = await request(app).get('/api/mycelium/agents/p191-b').set(adminHeaders()).expect(200)
    expect(res.body.status).toBe('online')
  })

  test('the agent list renders the same derivation as the single-agent row', async () => {
    const list = await request(app).get('/api/mycelium/agents').set(adminHeaders()).expect(200)
    const a = list.body.find((x) => x.id === 'p191-a')
    expect(a).toBeTruthy()
    expect(a.status).toBe('online')
  })

  test('a never-heartbeated agent keeps its stored value (schema default: offline)', async () => {
    db.createAgent('p191-c', 'P191 C', 'proj', 'hash-191-c', '[]')
    const res = await request(app).get('/api/mycelium/agents/p191-c').set(adminHeaders()).expect(200)
    expect(res.body.status).toBe('offline')
  })
})
