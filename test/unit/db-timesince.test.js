import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Reproduces the heartbeat-age-renders-negative bug in the slim admin overview.
// last_heartbeat is written via SQLite datetime('now'), which yields a
// space-separated UTC string with NO timezone suffix (e.g. "2026-06-01 14:23:05").
// Per the ECMAScript Date spec only the ISO 'T'-separated form is treated as UTC
// when the zone is omitted; the space-separated form parses as LOCAL time. On a
// host west of UTC (e.g. CST, offset 300 min) `new Date(thatStr)` lands hours in
// the FUTURE, so Date.now() - parsed is negative and timeSince() returns
// "-NNNNNs ago". timeSince is not exported, so we exercise it through the real
// getSlimOverview() path that GET /admin/overview serves.
//
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' isolates this file's module state. initDB() writes only to the
// temp DATA_DIR — never the live mycelium.db.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-timesince-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('getSlimOverview heartbeat age (timeSince)', () => {
  test('a just-now heartbeat renders a NON-negative age, not "-NNNNNs ago"', () => {
    // Register an agent and fire a heartbeat so last_heartbeat is set via the
    // real datetime('now') path — the exact UTC-without-zone string that trips
    // the naive Date parse.
    db.createAgent('hb-agent', 'Heartbeat Agent', 'velum', 'hash-hb', '[]')
    db.updateAgentHeartbeat('hb-agent', 'online', 'testing heartbeat age')

    const overview = db.getSlimOverview()
    const agent = overview.agents.find((a) => a.id === 'hb-agent')
    expect(agent).toBeTruthy()

    const hb = agent.heartbeat
    // The displayed age must never start with '-'. On a host west of UTC the
    // bug makes this "-18000s ago" (= -5h on CST); the fix keeps it >= 0.
    expect(hb.startsWith('-')).toBe(false)

    // Parse the leading number out of the "Ns ago"/"Nm ago" string and assert
    // it is a real, non-negative magnitude. A fresh heartbeat is seconds old.
    expect(hb).toMatch(/^\d+[smhd] ago$/)
    const magnitude = parseInt(hb, 10)
    expect(Number.isNaN(magnitude)).toBe(false)
    expect(magnitude).toBeGreaterThanOrEqual(0)
    // Sanity: a heartbeat fired moments ago is at most a few seconds old.
    expect(hb).toMatch(/^\d+s ago$/)
    expect(magnitude).toBeLessThan(60)
  })
})
