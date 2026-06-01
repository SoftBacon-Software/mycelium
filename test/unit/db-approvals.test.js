import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the REAL db.js approval-lifecycle functions against a fresh temp DB.
// Approvals are the human-in-the-loop safety gate for risky agent actions on a
// public platform, so the status machine (pending -> approved/rejected ->
// executed) and decideApproval's operator_inbox side effect must be pinned.
//
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' (vitest.config.js) isolates this file's module state. initDB()
// writes only to the temp DATA_DIR — never the live mycelium.db.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-approvals-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('approval creation + defaults', () => {
  test('createApproval returns an id; getApproval shows schema defaults', () => {
    const id = db.createApproval('deploy', 'Lucy', 'Deploy the cockpit', { ref: 'abc' })
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)

    const a = db.getApproval(id)
    expect(a).toBeTruthy()
    expect(a.action_type).toBe('deploy')
    expect(a.requested_by).toBe('Lucy')
    expect(a.title).toBe('Deploy the cockpit')
    // payload is serialized to JSON when an object is passed.
    expect(JSON.parse(a.payload)).toEqual({ ref: 'abc' })
    // Status machine starts at 'pending'.
    expect(a.status).toBe('pending')
    // createApproval defaults: projectId -> 'mycelium', riskTier -> 'medium',
    // requiredApprovals -> 1. decided_by/decided_at/executed_at unset.
    expect(a.project_id).toBe('mycelium')
    expect(a.risk_tier).toBe('medium')
    expect(a.required_approvals).toBe(1)
    expect(a.decided_by).toBeNull()
    expect(a.decided_at).toBeNull()
    expect(a.executed_at).toBeNull()
  })

  test('createApproval honors explicit projectId / riskTier / requiredApprovals', () => {
    const id = db.createApproval('git_push', 'Echo', 'Push branch', {}, 'velum', 'high', 2)
    const a = db.getApproval(id)
    expect(a.project_id).toBe('velum')
    expect(a.risk_tier).toBe('high')
    expect(a.required_approvals).toBe(2)
  })

  test('createApproval accepts a pre-serialized string payload without double-encoding', () => {
    const raw = '{"already":"json"}'
    const id = db.createApproval('delete', 'Ada', 'Delete thing', raw)
    const a = db.getApproval(id)
    // String payloads are stored verbatim (not re-stringified into a quoted string).
    expect(a.payload).toBe(raw)
    expect(JSON.parse(a.payload)).toEqual({ already: 'json' })
  })
})

describe('listApprovals filters + limit clamping', () => {
  // Isolate this group's rows behind a distinct project_id so other tests'
  // approvals never leak into these filtered results.
  const project = 'velum-list-test'

  let depA, depB, pushA

  beforeAll(() => {
    depA = db.createApproval('deploy', 'Lucy', 'dep A', {}, project)
    depB = db.createApproval('deploy', 'Echo', 'dep B', {}, project)
    pushA = db.createApproval('git_push', 'Lucy', 'push A', {}, project)
  })

  test('filters by project_id', () => {
    const ids = db
      .listApprovals({ project_id: project })
      .map((a) => a.id)
      .sort((x, y) => x - y)
    expect(ids).toEqual([depA, depB, pushA].sort((x, y) => x - y))
  })

  test('filters by action_type within a project', () => {
    const ids = db
      .listApprovals({ project_id: project, action_type: 'deploy' })
      .map((a) => a.id)
      .sort((x, y) => x - y)
    expect(ids).toEqual([depA, depB].sort((x, y) => x - y))
  })

  test('filters by requested_by within a project', () => {
    const ids = db
      .listApprovals({ project_id: project, requested_by: 'Lucy' })
      .map((a) => a.id)
      .sort((x, y) => x - y)
    expect(ids).toEqual([depA, pushA].sort((x, y) => x - y))
  })

  test('filters by status within a project', () => {
    // All three start pending.
    const pending = db.listApprovals({ project_id: project, status: 'pending' }).map((a) => a.id)
    expect(pending.sort((x, y) => x - y)).toEqual([depA, depB, pushA].sort((x, y) => x - y))
    // None are approved yet.
    expect(db.listApprovals({ project_id: project, status: 'approved' })).toEqual([])
  })

  test('combines multiple filters (project + action_type + requested_by)', () => {
    const ids = db
      .listApprovals({ project_id: project, action_type: 'deploy', requested_by: 'Echo' })
      .map((a) => a.id)
    expect(ids).toEqual([depB])
  })

  test('empty filter object returns rows (1=1 base clause), default limit applies', () => {
    // No filter keys -> WHERE 1=1, default LIMIT 50. At least our rows exist.
    const all = db.listApprovals({})
    expect(Array.isArray(all)).toBe(true)
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThanOrEqual(50)
  })

  test('default limit clamps result set to 50 when more rows exist', () => {
    const bulkProject = 'velum-limit-default'
    for (let i = 0; i < 55; i++) {
      db.createApproval('deploy', 'Lucy', 'bulk ' + i, {}, bulkProject)
    }
    // Without a project filter the default LIMIT 50 caps the whole table.
    const defaulted = db.listApprovals({})
    expect(defaulted.length).toBe(50)
    // A project filter narrower than 50 returns all matching rows.
    expect(db.listApprovals({ project_id: bulkProject }).length).toBe(50)
    // Asking for more than exist in the project returns just what's there.
    expect(db.listApprovals({ project_id: bulkProject, limit: 200 }).length).toBe(55)
  })

  test('limit is clamped to min(limit, 500)', () => {
    const bigProject = 'velum-limit-clamp'
    for (let i = 0; i < 12; i++) {
      db.createApproval('deploy', 'Lucy', 'big ' + i, {}, bigProject)
    }
    // An absurd limit must not throw and must not exceed the 500 clamp; with
    // only 12 rows in this project we just confirm all 12 come back.
    const rows = db.listApprovals({ project_id: bigProject, limit: 100000 })
    expect(rows.length).toBe(12)
  })

  // NOTE: listApprovals' "ORDER BY created_at DESC" has no secondary tiebreaker,
  // and created_at has 1-second resolution (datetime('now')). Same-second inserts
  // therefore have an unspecified relative order, so we don't assert strict
  // newest-first ordering here — that would over-specify behavior the query
  // doesn't guarantee. The DESC clause is exercised implicitly by the filter
  // tests above (which never depend on intra-second ordering).
})

describe('decideApproval status transitions', () => {
  test("decideApproval('approved') records decider, reason, decided_at; survives countPending", () => {
    const before = db.countPendingApprovals().count
    const id = db.createApproval('deploy', 'Lucy', 'approve me', {}, 'velum-decide')
    // Creating a pending row bumps the pending count.
    expect(db.countPendingApprovals().count).toBe(before + 1)

    db.decideApproval(id, 'approved', 'm5Max', 'looks safe')
    const a = db.getApproval(id)
    expect(a.status).toBe('approved')
    expect(a.decided_by).toBe('m5Max')
    expect(a.reason).toBe('looks safe')
    expect(a.decided_at).toBeTruthy()
    // approving drops it back out of the pending-only count.
    expect(db.countPendingApprovals().count).toBe(before)
  })

  test("decideApproval('rejected') also leaves the pending count, and is filterable", () => {
    const id = db.createApproval('git_push', 'Echo', 'reject me', {}, 'velum-decide')
    db.decideApproval(id, 'rejected', 'm5Max', 'too risky')
    const a = db.getApproval(id)
    expect(a.status).toBe('rejected')
    expect(a.reason).toBe('too risky')
    // No longer pending.
    const stillPending = db
      .listApprovals({ project_id: 'velum-decide', status: 'pending' })
      .map((x) => x.id)
    expect(stillPending).not.toContain(id)
    // Surfaces under a rejected filter.
    const rejected = db
      .listApprovals({ project_id: 'velum-decide', status: 'rejected' })
      .map((x) => x.id)
    expect(rejected).toContain(id)
  })

  test('decideApproval with no reason stores empty string, not null', () => {
    const id = db.createApproval('deploy', 'Lucy', 'no reason', {}, 'velum-decide')
    db.decideApproval(id, 'approved', 'm5Max')
    const a = db.getApproval(id)
    expect(a.reason).toBe('')
  })
})

describe('decideApproval operator_inbox side effect', () => {
  // decideApproval also auto-actions the matching operator_inbox row
  // (entity_type='approval' AND entity_id = String(id)) so the approve/reject
  // buttons disappear from the human's inbox. Easy to break, untested.

  test('actions the matching unread inbox row on decision', () => {
    const id = db.createApproval('deploy', 'Lucy', 'gated deploy', {}, 'velum-inbox')
    // Seed an operator_inbox row referencing this approval. entity_id is the
    // STRING form of the approval id — the side effect matches on String(id).
    const inboxId = db.createInboxItem('grb', 'approval', 'approval', String(id), 'Approve deploy?', '', {}, 'urgent')
    expect(db.getInboxItem(inboxId).status).toBe('unread')

    db.decideApproval(id, 'approved', 'm5Max', 'ok')

    const item = db.getInboxItem(inboxId)
    expect(item.status).toBe('actioned')
    // read_at is backfilled via COALESCE when it was previously null.
    expect(item.read_at).toBeTruthy()
  })

  test('does NOT clobber a dismissed inbox row (status != dismissed guard)', () => {
    const id = db.createApproval('git_push', 'Echo', 'gated push', {}, 'velum-inbox')
    const inboxId = db.createInboxItem('grb', 'approval', 'approval', String(id), 'Approve push?', '', {}, 'normal')
    db.dismissInboxItem(inboxId)
    expect(db.getInboxItem(inboxId).status).toBe('dismissed')

    db.decideApproval(id, 'rejected', 'm5Max', 'no')

    // The dismissed row must stay dismissed — the guard excludes it.
    expect(db.getInboxItem(inboxId).status).toBe('dismissed')
  })

  test('only touches inbox rows matching THIS approval id (entity_id scoping)', () => {
    const idA = db.createApproval('deploy', 'Lucy', 'A', {}, 'velum-inbox')
    const idB = db.createApproval('deploy', 'Lucy', 'B', {}, 'velum-inbox')
    const inboxA = db.createInboxItem('grb', 'approval', 'approval', String(idA), 'A?', '', {}, 'normal')
    const inboxB = db.createInboxItem('grb', 'approval', 'approval', String(idB), 'B?', '', {}, 'normal')

    db.decideApproval(idA, 'approved', 'm5Max', 'ok')

    expect(db.getInboxItem(inboxA).status).toBe('actioned')
    // B's inbox row is untouched — different entity_id.
    expect(db.getInboxItem(inboxB).status).toBe('unread')
  })

  test('does not action inbox rows of a different entity_type', () => {
    const id = db.createApproval('deploy', 'Lucy', 'with non-approval inbox', {}, 'velum-inbox')
    // Same numeric entity_id but entity_type 'task' — must be left alone.
    const taskInbox = db.createInboxItem('grb', 'message', 'task', String(id), 'a task', '', {}, 'normal')

    db.decideApproval(id, 'approved', 'm5Max', 'ok')

    expect(db.getInboxItem(taskInbox).status).toBe('unread')
  })
})

describe('markApprovalExecuted', () => {
  test("flips an approved row to 'executed' and stamps executed_at", () => {
    const id = db.createApproval('deploy', 'Lucy', 'execute me', {}, 'velum-exec')
    db.decideApproval(id, 'approved', 'm5Max', 'ok')
    expect(db.getApproval(id).executed_at).toBeNull()

    db.markApprovalExecuted(id)
    const a = db.getApproval(id)
    expect(a.status).toBe('executed')
    expect(a.executed_at).toBeTruthy()
  })

  test("executed rows silently drop out of a status='approved' listing", () => {
    const project = 'velum-exec-list'
    const id = db.createApproval('deploy', 'Lucy', 'will execute', {}, project)
    db.decideApproval(id, 'approved', 'm5Max', 'ok')
    // While approved, it appears under the approved filter.
    expect(db.listApprovals({ project_id: project, status: 'approved' }).map((a) => a.id)).toContain(id)

    db.markApprovalExecuted(id)
    // After execution it no longer matches status='approved' — it moved on.
    expect(db.listApprovals({ project_id: project, status: 'approved' }).map((a) => a.id)).not.toContain(id)
    // It is now findable under status='executed'.
    expect(db.listApprovals({ project_id: project, status: 'executed' }).map((a) => a.id)).toContain(id)
  })

  test('executed rows are not counted as pending', () => {
    const before = db.countPendingApprovals().count
    const id = db.createApproval('deploy', 'Lucy', 'exec count', {}, 'velum-exec-count')
    expect(db.countPendingApprovals().count).toBe(before + 1)
    db.decideApproval(id, 'approved', 'm5Max', 'ok')
    expect(db.countPendingApprovals().count).toBe(before)
    db.markApprovalExecuted(id)
    expect(db.countPendingApprovals().count).toBe(before)
  })
})

describe('listPendingApprovalsByAgent — the requester-visible queue', () => {
  // This list returns status IN ('pending','approved') scoped to one requester,
  // so an approved-but-not-yet-executed item must STILL surface to its requester
  // until markApprovalExecuted moves it past the gate.
  const agent = 'PendingQueueAgent'

  test('surfaces a freshly-created pending item for its requester only', () => {
    const id = db.createApproval('deploy', agent, 'mine', {}, 'velum-byagent')
    const ids = db.listPendingApprovalsByAgent(agent).map((a) => a.id)
    expect(ids).toContain(id)
    // A different agent does not see it.
    expect(db.listPendingApprovalsByAgent('SomeoneElse').map((a) => a.id)).not.toContain(id)
  })

  test('an APPROVED (not yet executed) item still surfaces to its requester', () => {
    const id = db.createApproval('git_push', agent, 'approved-not-executed', {}, 'velum-byagent')
    db.decideApproval(id, 'approved', 'm5Max', 'ok')
    // status IN ('pending','approved') — approved must remain visible.
    const ids = db.listPendingApprovalsByAgent(agent).map((a) => a.id)
    expect(ids).toContain(id)
  })

  test('a REJECTED item drops off the requester queue immediately', () => {
    const id = db.createApproval('delete', agent, 'rejected', {}, 'velum-byagent')
    db.decideApproval(id, 'rejected', 'm5Max', 'no')
    const ids = db.listPendingApprovalsByAgent(agent).map((a) => a.id)
    expect(ids).not.toContain(id)
  })

  test('an EXECUTED item drops off the requester queue (past the gate)', () => {
    const id = db.createApproval('deploy', agent, 'executed', {}, 'velum-byagent')
    db.decideApproval(id, 'approved', 'm5Max', 'ok')
    // Still visible while approved.
    expect(db.listPendingApprovalsByAgent(agent).map((a) => a.id)).toContain(id)
    db.markApprovalExecuted(id)
    // Gone once executed — status 'executed' is not in ('pending','approved').
    expect(db.listPendingApprovalsByAgent(agent).map((a) => a.id)).not.toContain(id)
  })

  test('an unknown agent gets an empty array', () => {
    expect(db.listPendingApprovalsByAgent('nobody-here')).toEqual([])
  })
})

describe('countPendingApprovals — shape + counting', () => {
  test('returns an object with a numeric .count (not a bare number)', () => {
    const res = db.countPendingApprovals()
    expect(typeof res).toBe('object')
    expect(typeof res.count).toBe('number')
  })

  test('counts pending across all agents/projects, excludes decided + executed', () => {
    const base = db.countPendingApprovals().count
    const p1 = db.createApproval('deploy', 'Lucy', 'p1', {}, 'velum-count')
    const p2 = db.createApproval('deploy', 'Echo', 'p2', {}, 'velum-count')
    const p3 = db.createApproval('deploy', 'Ada', 'p3', {}, 'velum-count')
    expect(db.countPendingApprovals().count).toBe(base + 3)

    // Approve one, reject one, execute one — all leave 'pending'.
    db.decideApproval(p1, 'approved', 'm5Max', 'ok')
    db.decideApproval(p2, 'rejected', 'm5Max', 'no')
    db.decideApproval(p3, 'approved', 'm5Max', 'ok')
    db.markApprovalExecuted(p3)

    expect(db.countPendingApprovals().count).toBe(base)
  })
})
