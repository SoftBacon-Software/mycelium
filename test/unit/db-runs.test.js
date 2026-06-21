import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// Exercise the REAL db.js runs functions — the run-log contract + its drone-aligned
// claim queue — against a fresh temp DB. db.js reads DATA_DIR at module-eval time, so
// set it before the dynamic import. A raw connection backdates started_at for the
// stale-recovery test (db.js exposes no time control). pool:'forks' isolates this file.

let tmpDataDir
let db
let raw

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-runs-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
  raw = new Database(join(tmpDataDir, 'mycelium.db'))
})

afterAll(() => {
  if (raw) raw.close()
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('runs contract — record + telemetry', () => {
  test('createRun (running) sets started_at; energy/claimed_by/error NULL; created_at always set', () => {
    const run = db.createRun({ id: 'r1', agent_id: 'scout', model: 'QUEST', brief: 'audit X' })
    expect(run.status).toBe('running')
    expect(run.started_at).toBeTruthy()   // running -> execution started now
    expect(run.created_at).toBeTruthy()
    expect(run.claimed_by).toBeNull()
    expect(run.energy_joules).toBeNull()  // a backend that doesn't measure power leaves it null
    expect(run.error).toBeNull()
    expect(run.finished_at).toBeNull()
    expect(run.rerun_of).toBeNull()
  })

  test('a pending run leaves started_at NULL (it starts on claim, not at queue time)', () => {
    const p = db.createRun({ id: 'rp', agent_id: 'qa-pending', brief: 'queued', status: 'pending' })
    expect(p.status).toBe('pending')
    expect(p.started_at).toBeNull()
    expect(p.created_at).toBeTruthy()     // queue time still recorded
  })

  test('updateRun records telemetry incl. error; only provided fields change', () => {
    db.createRun({ id: 'r2', agent_id: 'lucy', model: 'Qwen3-Coder', brief: 'fix bug' })
    const u = db.updateRun('r2', {
      status: 'completed', turns: 12, tokens_in: 4000, tokens_out: 900, energy_joules: 0.236,
      tool_calls: '[{"name":"edit_file","count":3}]', artifacts: '[{"name":"Foo.swift","kind":"file"}]',
      result: 'done', finished_at: '2026-06-21 10:00:00', duration_ms: 42000,
    })
    expect(u.status).toBe('completed')
    expect(u.turns).toBe(12)
    expect(u.energy_joules).toBeCloseTo(0.236)
    expect(u.result).toBe('done')
    expect(u.model).toBe('Qwen3-Coder')   // a field NOT passed stays unchanged
    // error is its own column, settable on failure without clobbering result
    const f = db.updateRun('r2', { error: 'boom' })
    expect(f.error).toBe('boom')
    expect(f.result).toBe('done')
  })

  test('listRuns: newest-first (created_at), filtered, SLIM (no result/tool_calls/error), claimed_by present', () => {
    db.createRun({ id: 'r3', agent_id: 'echo', brief: 'verify' })
    const list = db.listRuns({})
    const ids = list.map((r) => r.id)
    expect(ids.indexOf('r3')).toBeLessThan(ids.indexOf('r1'))   // deterministic via rowid tiebreak
    expect(db.listRuns({ agent_id: 'lucy' }).every((r) => r.agent_id === 'lucy')).toBe(true)
    expect(db.listRuns({ status: 'completed' }).every((r) => r.status === 'completed')).toBe(true)
    expect(db.listRuns({ limit: 1 }).length).toBe(1)
    const row = list.find((r) => r.id === 'r2')
    expect(row.result).toBeUndefined()        // heavy fields dropped from the list
    expect(row.tool_calls).toBeUndefined()
    expect(row.error).toBeUndefined()
    expect('claimed_by' in row).toBe(true)    // light claim/timing fields ARE in the list
    expect('created_at' in row).toBe(true)
    expect(db.getRun('r2').result).toBe('done')   // detail endpoint carries the full body
  })
})

describe('runs contract — drone-style claim queue', () => {
  test('claimRun atomically claims a pending run: pending -> claimed, sets claimed_by + started_at', () => {
    db.createRun({ id: 'c1', agent_id: 'cq-a', brief: 'queued A', status: 'pending' })
    const claimed = db.claimRun('worker-1', { agent_id: 'cq-a' })
    expect(claimed.id).toBe('c1')
    expect(claimed.status).toBe('claimed')
    expect(claimed.claimed_by).toBe('worker-1')
    expect(claimed.started_at).toBeTruthy()   // execution start is set on claim
  })

  test('the same pending run cannot be claimed twice (the WHERE status=pending guard)', () => {
    db.createRun({ id: 'c2', agent_id: 'cq-b', brief: 'only once', status: 'pending' })
    expect(db.claimRun('w-a', { agent_id: 'cq-b' }).id).toBe('c2')
    expect(db.claimRun('w-b', { agent_id: 'cq-b' })).toBeNull()   // nothing pending for cq-b now
    expect(db.getRun('c2').claimed_by).toBe('w-a')               // still the first claimer
  })

  test('claimRun returns null when nothing is pending', () => {
    expect(db.claimRun('w-x', { agent_id: 'nobody-pending' })).toBeNull()
  })

  test('releaseStaleClaimedRuns auto-fails a claim that has run too long', () => {
    db.createRun({ id: 's1', agent_id: 'sq-a', brief: 'stuck', status: 'pending' })
    db.claimRun('dead-worker', { agent_id: 'sq-a' })
    raw.prepare("UPDATE runs SET started_at = datetime('now','-120 minutes') WHERE id = 's1'").run()
    expect(db.releaseStaleClaimedRuns(60)).toBeGreaterThanOrEqual(1)
    const s = db.getRun('s1')
    expect(s.status).toBe('failed')
    expect(s.error).toMatch(/stale_timeout/)
    expect(s.finished_at).toBeTruthy()
  })

  test('releaseStaleClaimedRuns does NOT reap a fresh claim', () => {
    db.createRun({ id: 's2', agent_id: 'sq-b', brief: 'fresh', status: 'pending' })
    db.claimRun('live-worker', { agent_id: 'sq-b' })   // started_at = now
    db.releaseStaleClaimedRuns(60)
    expect(db.getRun('s2').status).toBe('claimed')     // still claimed, not failed
  })

  test('a rerun is a NEW pending row (started_at NULL) linked via rerun_of; original untouched', () => {
    const fresh = db.createRun({
      id: 'r2-rerun', agent_id: 'lucy', model: 'Qwen3-Coder', brief: 'fix bug',
      status: 'pending', rerun_of: 'r2',
    })
    expect(fresh.rerun_of).toBe('r2')
    expect(fresh.status).toBe('pending')
    expect(fresh.started_at).toBeNull()
    expect(db.getRun('r2').rerun_of).toBeNull()
  })

  test('getRun returns nothing for a missing id', () => {
    expect(db.getRun('does-not-exist')).toBeFalsy()
  })
})
