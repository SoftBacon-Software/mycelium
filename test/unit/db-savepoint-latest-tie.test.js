import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// REVIEW A minor 3 (PR #199): getLatestSavepoint ordered by heartbeat_at DESC
// alone. heartbeat_at is second-granularity, so a heartbeat auto-savepoint and
// an explicit savepoint written in the same second TIED and the pick was
// arbitrary — observed live on the review's spawned server: the GET returned
// the heartbeat's notes-less row instead of the just-written notes row (both
// at 16:51:57), so the fenced handoff silently showed the wrong savepoint.
// The rowid tiebreaker makes the later INSERT win deterministically.
//
// Same fresh-temp-DATA_DIR pattern as db-agent-heartbeat.test.js: db.js reads
// DATA_DIR at module-eval time, so set it before the dynamic import;
// pool:'forks' isolates this file's module state.

let tmpDataDir
let db
let raw

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-sp-tie-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
  raw = new Database(join(tmpDataDir, 'mycelium.db'))
})

afterAll(() => {
  if (raw) raw.close()
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Insert a savepoint row with a FORCED heartbeat_at so two rows can share the
// same second exactly (createSavepoint stamps datetime('now') and could straddle).
function seedSavepoint(agentId, { heartbeatAt, workingOn = '', notes = null, sessionId = 's1' }) {
  return raw.prepare(
    'INSERT INTO agent_savepoints (agent_id, session_id, heartbeat_at, working_on, state_snapshot, messages_acked, context_versions, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(agentId, sessionId, heartbeatAt, workingOn, '{}', '[]', '{}', notes)
}

describe('getLatestSavepoint second-granularity tie', () => {
  test('same-second rows: the later insert (the notes savepoint) wins', () => {
    db.createAgent('sp-tie', 'sp-tie', 'p-sp', 'hash-sp-tie', '[]')
    const stamp = '2026-10-06 16:51:57'
    // Insert order mirrors the live observation: the heartbeat auto-savepoint
    // (notes-less) lands FIRST, the explicit notes savepoint lands after it.
    seedSavepoint('sp-tie', { heartbeatAt: stamp, workingOn: 'wiring the harness', notes: null })
    seedSavepoint('sp-tie', { heartbeatAt: stamp, workingOn: 'wiring the harness', notes: 'handoff: run the gate before merging', sessionId: 's2' })

    const latest = db.getLatestSavepoint('sp-tie')
    expect(latest.notes).toBe('handoff: run the gate before merging')
    expect(latest.session_id).toBe('s2')
  })

  test('untied rows still resolve by heartbeat_at alone', () => {
    db.createAgent('sp-untied', 'sp-untied', 'p-sp', 'hash-sp-untied', '[]')
    seedSavepoint('sp-untied', { heartbeatAt: '2026-10-06 10:00:00', workingOn: 'older', notes: 'old' })
    seedSavepoint('sp-untied', { heartbeatAt: '2026-10-06 11:00:00', workingOn: 'newer', notes: null })
    const latest = db.getLatestSavepoint('sp-untied')
    expect(latest.working_on).toBe('newer')
    expect(latest.notes).toBeNull()
  })
})
