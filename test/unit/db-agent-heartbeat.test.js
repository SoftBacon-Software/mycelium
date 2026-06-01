import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// Exercise the REAL db.js agent-heartbeat / idle-dispatch / crash-recovery logic
// against a fresh temp DB. db.js reads DATA_DIR at module-eval time, so set it
// before the dynamic import. pool:'forks' (vitest.config.js) isolates this
// file's module state. initDB() writes only to the temp DATA_DIR — never the
// live mycelium.db.
//
// Heartbeat age drives two safety-critical paths:
//   1. getIdleAgents() — the autonomous scheduler's dispatch target list.
//   2. buildCrashRecovery() — surfaced as boot_payload.crash_recovery.
// Both are date-math fragile. last_heartbeat is stored by SQLite's
// datetime('now') as "YYYY-MM-DD HH:MM:SS" (UTC, no 'Z'). To simulate
// stale/fresh agents deterministically we write last_heartbeat / status /
// working_on / role directly via a second better-sqlite3 connection to the SAME
// temp DB file (db.js exposes no raw handle and updateAgent() can't set those
// columns). SQLite supports concurrent connections to one file; this fork's
// tests run serially so there is no write contention.

let tmpDataDir
let db          // the db.js module (functions under test)
let raw         // raw connection used only to seed controlled column values

// SQLite's datetime('now') format — matches what updateAgentHeartbeat writes.
function sqliteUTC(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

// last_heartbeat value `minutesAgo` minutes in the past, in SQLite-native format.
function heartbeatMinutesAgo(minutesAgo) {
  return sqliteUTC(new Date(Date.now() - minutesAgo * 60 * 1000))
}

// Seed an agent and force its volatile columns to controlled values. createAgent
// only sets id/name/project_id/api_key_hash/capabilities; status defaults to
// 'offline' and working_on/role to ''. We then UPDATE the columns the scheduler
// and crash detector read.
function seedAgent(id, { status, workingOn = '', role = '', lastHeartbeat = null, projectId = 'p-hb' } = {}) {
  db.createAgent(id, id, projectId, 'hash-' + id, '[]')
  raw.prepare(
    'UPDATE agents SET status = ?, working_on = ?, role = ?, last_heartbeat = ? WHERE id = ?'
  ).run(status, workingOn, role, lastHeartbeat, id)
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-hb-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
  raw = new Database(join(tmpDataDir, 'mycelium.db'))
})

afterAll(() => {
  if (raw) raw.close()
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('updateAgentHeartbeat', () => {
  test('sets status, working_on and a fresh last_heartbeat', () => {
    db.createAgent('hb-basic', 'hb-basic', 'p-hb', 'hash-hb-basic', '[]')
    // Created agent starts offline with no heartbeat.
    let agent = db.getAgent('hb-basic')
    expect(agent.status).toBe('offline')
    expect(agent.last_heartbeat).toBeFalsy()

    const before = sqliteUTC(new Date(Date.now() - 1000)) // 1s slack for clock skew
    db.updateAgentHeartbeat('hb-basic', 'online', 'wiring the cockpit')
    const after = sqliteUTC(new Date(Date.now() + 1000))

    agent = db.getAgent('hb-basic')
    expect(agent.status).toBe('online')
    expect(agent.working_on).toBe('wiring the cockpit')
    // last_heartbeat is ~now, in SQLite UTC format, within the slack window.
    expect(agent.last_heartbeat).toBeTruthy()
    expect(agent.last_heartbeat >= before).toBe(true)
    expect(agent.last_heartbeat <= after).toBe(true)
  })

  test('defaults status to online and working_on to empty string when omitted', () => {
    db.createAgent('hb-defaults', 'hb-defaults', 'p-hb', 'hash-hb-defaults', '[]')
    db.updateAgentHeartbeat('hb-defaults')
    const agent = db.getAgent('hb-defaults')
    expect(agent.status).toBe('online')
    // working_on column is NOT NULL DEFAULT '' — heartbeat with no arg writes ''.
    expect(agent.working_on).toBe('')
  })

  test('clears a previously-set working_on when called with empty working_on', () => {
    seedAgent('hb-clear', { status: 'online', workingOn: 'old task', lastHeartbeat: heartbeatMinutesAgo(5) })
    expect(db.getAgent('hb-clear').working_on).toBe('old task')
    db.updateAgentHeartbeat('hb-clear', 'idle', '')
    const agent = db.getAgent('hb-clear')
    expect(agent.status).toBe('idle')
    expect(agent.working_on).toBe('')
  })
})

describe('getIdleAgents', () => {
  // Use a dedicated project so these rows don't collide with other describe blocks.
  const PROJ = 'p-idle'

  test('returns online/idle agents with fresh heartbeat and no working_on', () => {
    seedAgent('idle-online', { status: 'online', lastHeartbeat: heartbeatMinutesAgo(1), projectId: PROJ })
    seedAgent('idle-idle', { status: 'idle', lastHeartbeat: heartbeatMinutesAgo(10), projectId: PROJ })

    const ids = db.getIdleAgents().map((a) => a.id)
    expect(ids).toContain('idle-online')
    expect(ids).toContain('idle-idle')
  })

  test('excludes role=drone even when online with a fresh heartbeat', () => {
    seedAgent('idle-drone', { status: 'online', role: 'drone', lastHeartbeat: heartbeatMinutesAgo(1), projectId: PROJ })
    const ids = db.getIdleAgents().map((a) => a.id)
    expect(ids).not.toContain('idle-drone')
  })

  test('excludes agents that have working_on set (runner is busy)', () => {
    seedAgent('idle-busy', { status: 'online', workingOn: 'task-42', lastHeartbeat: heartbeatMinutesAgo(1), projectId: PROJ })
    const ids = db.getIdleAgents().map((a) => a.id)
    expect(ids).not.toContain('idle-busy')
  })

  test('excludes agents whose heartbeat is older than the 30-minute window', () => {
    // 31 min old -> outside the window -> excluded.
    seedAgent('idle-stale', { status: 'online', lastHeartbeat: heartbeatMinutesAgo(31), projectId: PROJ })
    // 29 min old -> inside the window -> included (boundary sanity).
    seedAgent('idle-fresh-edge', { status: 'idle', lastHeartbeat: heartbeatMinutesAgo(29), projectId: PROJ })

    const ids = db.getIdleAgents().map((a) => a.id)
    expect(ids).not.toContain('idle-stale')
    expect(ids).toContain('idle-fresh-edge')
  })

  test('excludes offline agents and agents with NULL heartbeat', () => {
    seedAgent('idle-offline', { status: 'offline', lastHeartbeat: heartbeatMinutesAgo(1), projectId: PROJ })
    seedAgent('idle-null-hb', { status: 'online', lastHeartbeat: null, projectId: PROJ })

    const ids = db.getIdleAgents().map((a) => a.id)
    // status not in ('online','idle') -> excluded.
    expect(ids).not.toContain('idle-offline')
    // NULL last_heartbeat fails the `> datetime(...)` comparison -> excluded.
    expect(ids).not.toContain('idle-null-hb')
  })
})

// buildCrashRecovery is not exported; it is reachable through getBootPayload,
// which returns its result as boot_payload.crash_recovery. getBootPayload reads
// the agent row ONCE up front, then auto-heartbeats; crash detection runs against
// that original (possibly stale) snapshot, so seeding last_heartbeat before the
// call is what exercises the date math.
describe('crash recovery (buildCrashRecovery via getBootPayload)', () => {
  const PROJ = 'p-crash'

  test('no crash when heartbeat is fresh (inside the 15-min threshold)', () => {
    seedAgent('crash-fresh', { status: 'online', workingOn: 'big refactor', lastHeartbeat: heartbeatMinutesAgo(5), projectId: PROJ })
    const payload = db.getBootPayload('crash-fresh')
    expect(payload).toBeTruthy()
    // 5 min staleness <= 15 min threshold -> null (no crash).
    expect(payload.crash_recovery).toBeNull()
  })

  test('crash detected when heartbeat is older than the 15-min threshold', () => {
    seedAgent('crash-stale', { status: 'online', workingOn: 'compiling the index', lastHeartbeat: heartbeatMinutesAgo(20), projectId: PROJ })
    const payload = db.getBootPayload('crash-stale')
    expect(payload.crash_recovery).toBeTruthy()
    expect(payload.crash_recovery.detected).toBe(true)
    expect(payload.crash_recovery.was_working_on).toBe('compiling the index')
    // 20 min stale rounds to ~20; allow a little slack for test wall-clock drift.
    expect(payload.crash_recovery.stale_minutes).toBeGreaterThanOrEqual(19)
    expect(payload.crash_recovery.stale_minutes).toBeLessThanOrEqual(21)
  })

  test('no crash when working_on is empty even if heartbeat is very stale', () => {
    // A crashed-but-idle agent has nothing to recover; buildCrashRecovery bails
    // when working_on is empty.
    seedAgent('crash-no-work', { status: 'online', workingOn: '', lastHeartbeat: heartbeatMinutesAgo(120), projectId: PROJ })
    const payload = db.getBootPayload('crash-no-work')
    expect(payload.crash_recovery).toBeNull()
  })

  test('no crash when last_heartbeat is NULL', () => {
    seedAgent('crash-null-hb', { status: 'online', workingOn: 'something', lastHeartbeat: null, projectId: PROJ })
    const payload = db.getBootPayload('crash-null-hb')
    expect(payload.crash_recovery).toBeNull()
  })

  // THE failure mode that matters: the 'Z'-append UTC normalization. SQLite
  // stores last_heartbeat WITHOUT a trailing 'Z'. buildCrashRecovery appends 'Z'
  // so new Date() parses it as UTC, not local time. If that normalization broke,
  // a heartbeat written in a negative-UTC-offset zone (e.g. US/Central) would be
  // parsed as local and look HOURS in the future or past, mis-staleness-ing every
  // agent. We assert the math is offset-stable: a value just over the threshold
  // is a crash; a value just under it is not — regardless of the runner's TZ.
  test("UTC-normalizes last_heartbeat: 16 min ago is a crash, 14 min ago is not", () => {
    seedAgent('crash-tz-over', { status: 'online', workingOn: 'task A', lastHeartbeat: heartbeatMinutesAgo(16), projectId: PROJ })
    seedAgent('crash-tz-under', { status: 'online', workingOn: 'task B', lastHeartbeat: heartbeatMinutesAgo(14), projectId: PROJ })

    const over = db.getBootPayload('crash-tz-over')
    const under = db.getBootPayload('crash-tz-under')

    expect(over.crash_recovery).toBeTruthy()
    expect(over.crash_recovery.detected).toBe(true)
    expect(under.crash_recovery).toBeNull()
  })

  test('an already-Z-suffixed heartbeat is not double-suffixed (parses identically)', () => {
    // Defensive: some writers store ISO-8601 with a trailing 'Z'. The
    // endsWith('Z') guard must NOT append a second 'Z' (which would make
    // new Date() return Invalid Date -> NaN staleness -> never-crash).
    const isoZ = new Date(Date.now() - 25 * 60 * 1000).toISOString() // e.g. ...:00.000Z
    seedAgent('crash-z-suffixed', { status: 'online', workingOn: 'task Z', lastHeartbeat: isoZ, projectId: PROJ })
    const payload = db.getBootPayload('crash-z-suffixed')
    expect(payload.crash_recovery).toBeTruthy()
    expect(payload.crash_recovery.detected).toBe(true)
    // ~25 min stale, parsed correctly (not NaN) -> sane stale_minutes.
    expect(payload.crash_recovery.stale_minutes).toBeGreaterThanOrEqual(24)
    expect(payload.crash_recovery.stale_minutes).toBeLessThanOrEqual(26)
  })

  test('crash_recovery carries savepoint state/notes when a savepoint exists', () => {
    seedAgent('crash-with-sp', { status: 'online', workingOn: 'mid-flight work', lastHeartbeat: heartbeatMinutesAgo(30), projectId: PROJ })
    // Seed a savepoint so buildCrashRecovery can attach recovery_state/notes.
    const cols = raw.prepare("PRAGMA table_info(agent_savepoints)").all().map((c) => c.name)
    expect(cols).toContain('state_snapshot')
    expect(cols).toContain('notes')
    raw.prepare(
      'INSERT INTO agent_savepoints (agent_id, session_id, heartbeat_at, working_on, state_snapshot, notes) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('crash-with-sp', 'sess-1', heartbeatMinutesAgo(30), 'mid-flight work', '{"step":3}', 'paused at step 3')

    const payload = db.getBootPayload('crash-with-sp')
    expect(payload.crash_recovery).toBeTruthy()
    expect(payload.crash_recovery.detected).toBe(true)
    expect(payload.crash_recovery.recovery_state).toBe('{"step":3}')
    expect(payload.crash_recovery.recovery_notes).toBe('paused at step 3')
  })
})
