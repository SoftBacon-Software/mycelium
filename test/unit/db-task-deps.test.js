import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the REAL db.js task DEPENDENCY-GRAPH functions against a fresh temp DB.
// db-tasks.test.js covers create/update/list; this file covers the graph that
// drives auto-scheduling (getNextUnassignedTask depends on it being correct):
//   - setTaskDependency      (bidirectional blocked_by/blocks JSON, idempotent)
//   - resolveTaskDependencies (unblock-on-complete)
//   - listTasksNeedingApproval
//
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' isolates this file's module state. initDB() writes only to the
// temp DATA_DIR — never the live mycelium.db.

let tmpDataDir
let db

// Helper: parse a task's blocked_by / blocks JSON columns back into arrays.
function blockedBy(id) {
  return JSON.parse(db.getTask(id).blocked_by || '[]')
}
function blocks(id) {
  return JSON.parse(db.getTask(id).blocks || '[]')
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-task-deps-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('setTaskDependency — bidirectional blocked_by/blocks graph', () => {
  test('records both sides: t2.blocked_by gets t1, t1.blocks gets t2', () => {
    const t1 = db.createTask('blocker', '', 'deps-bidir', 'm5Max', 'normal', '[]')
    const t2 = db.createTask('blocked', '', 'deps-bidir', 'm5Max', 'normal', '[]')

    // "t2 is blocked_by t1" => setTaskDependency(taskId=t2, blockedById=t1).
    const ok = db.setTaskDependency(t2, t1)
    expect(ok).toBe(true)

    expect(blockedBy(t2)).toEqual([t1])
    expect(blocks(t1)).toEqual([t2])
    // The inverse columns stay empty — the edge is directional.
    expect(blockedBy(t1)).toEqual([])
    expect(blocks(t2)).toEqual([])
  })

  test('is idempotent: re-adding the same edge does not duplicate ids', () => {
    const t1 = db.createTask('blocker', '', 'deps-idem', 'm5Max', 'normal', '[]')
    const t2 = db.createTask('blocked', '', 'deps-idem', 'm5Max', 'normal', '[]')

    expect(db.setTaskDependency(t2, t1)).toBe(true)
    expect(db.setTaskDependency(t2, t1)).toBe(true)
    expect(db.setTaskDependency(t2, t1)).toBe(true)

    expect(blockedBy(t2)).toEqual([t1])
    expect(blocks(t1)).toEqual([t2])
  })

  test('a task can accumulate multiple blockers (fan-in)', () => {
    const a = db.createTask('blocker A', '', 'deps-fanin', 'm5Max', 'normal', '[]')
    const b = db.createTask('blocker B', '', 'deps-fanin', 'm5Max', 'normal', '[]')
    const t = db.createTask('blocked', '', 'deps-fanin', 'm5Max', 'normal', '[]')

    expect(db.setTaskDependency(t, a)).toBe(true)
    expect(db.setTaskDependency(t, b)).toBe(true)

    expect(blockedBy(t).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y))
    expect(blocks(a)).toEqual([t])
    expect(blocks(b)).toEqual([t])
  })

  test('one blocker can gate multiple tasks (fan-out)', () => {
    const blocker = db.createTask('blocker', '', 'deps-fanout', 'm5Max', 'normal', '[]')
    const x = db.createTask('blocked X', '', 'deps-fanout', 'm5Max', 'normal', '[]')
    const y = db.createTask('blocked Y', '', 'deps-fanout', 'm5Max', 'normal', '[]')

    expect(db.setTaskDependency(x, blocker)).toBe(true)
    expect(db.setTaskDependency(y, blocker)).toBe(true)

    expect(blocks(blocker).sort((p, q) => p - q)).toEqual([x, y].sort((p, q) => p - q))
    expect(blockedBy(x)).toEqual([blocker])
    expect(blockedBy(y)).toEqual([blocker])
  })

  test('returns false and writes nothing when the blocked task id does not exist', () => {
    const blocker = db.createTask('real blocker', '', 'deps-bad', 'm5Max', 'normal', '[]')
    const missing = 99999999

    expect(db.setTaskDependency(missing, blocker)).toBe(false)
    // The valid blocker must NOT have been mutated by the rejected call.
    expect(blocks(blocker)).toEqual([])
  })

  test('returns false and writes nothing when the blocker id does not exist', () => {
    const blocked = db.createTask('real blocked', '', 'deps-bad', 'm5Max', 'normal', '[]')
    const missing = 99999998

    expect(db.setTaskDependency(blocked, missing)).toBe(false)
    expect(blockedBy(blocked)).toEqual([])
  })
})

describe('resolveTaskDependencies — unblock-on-complete', () => {
  test('strips the completed id and returns tasks that became fully unblocked', () => {
    const t1 = db.createTask('blocker', '', 'deps-resolve', 'm5Max', 'normal', '[]')
    const t2 = db.createTask('blocked', '', 'deps-resolve', 'm5Max', 'normal', '[]')
    expect(db.setTaskDependency(t2, t1)).toBe(true)
    expect(blockedBy(t2)).toEqual([t1])

    // Completing t1 should release t2 (its only blocker), returning [t2].
    const unblocked = db.resolveTaskDependencies(t1)
    expect(unblocked).toEqual([t2])
    // t2's blocked_by must now be empty so getNextUnassignedTask can release it.
    expect(blockedBy(t2)).toEqual([])
  })

  test('does NOT release a task that still has other blockers', () => {
    const a = db.createTask('blocker A', '', 'deps-partial', 'm5Max', 'normal', '[]')
    const b = db.createTask('blocker B', '', 'deps-partial', 'm5Max', 'normal', '[]')
    const t = db.createTask('blocked', '', 'deps-partial', 'm5Max', 'normal', '[]')
    expect(db.setTaskDependency(t, a)).toBe(true)
    expect(db.setTaskDependency(t, b)).toBe(true)

    // Completing only A: t still blocked by B, so nothing is unblocked yet.
    const afterA = db.resolveTaskDependencies(a)
    expect(afterA).toEqual([])
    expect(blockedBy(t)).toEqual([b])

    // Completing B too: now t is fully unblocked and is returned.
    const afterB = db.resolveTaskDependencies(b)
    expect(afterB).toEqual([t])
    expect(blockedBy(t)).toEqual([])
  })

  test('releases every dependent in a fan-out when the shared blocker completes', () => {
    const blocker = db.createTask('blocker', '', 'deps-resolve-fanout', 'm5Max', 'normal', '[]')
    const x = db.createTask('blocked X', '', 'deps-resolve-fanout', 'm5Max', 'normal', '[]')
    const y = db.createTask('blocked Y', '', 'deps-resolve-fanout', 'm5Max', 'normal', '[]')
    expect(db.setTaskDependency(x, blocker)).toBe(true)
    expect(db.setTaskDependency(y, blocker)).toBe(true)

    const unblocked = db.resolveTaskDependencies(blocker).sort((p, q) => p - q)
    expect(unblocked).toEqual([x, y].sort((p, q) => p - q))
    expect(blockedBy(x)).toEqual([])
    expect(blockedBy(y)).toEqual([])
  })

  test('returns [] for a task that blocks nothing', () => {
    const lonely = db.createTask('blocks nobody', '', 'deps-resolve-none', 'm5Max', 'normal', '[]')
    expect(db.resolveTaskDependencies(lonely)).toEqual([])
  })

  test('returns [] for a non-existent completed task id', () => {
    expect(db.resolveTaskDependencies(99999990)).toEqual([])
  })
})

describe('listTasksNeedingApproval', () => {
  test('returns only tasks with needs_approval=1, no approver, and status != done', () => {
    // pending: flagged, unapproved, not done -> should appear.
    const pending = db.createTask('needs approval', '', 'deps-approval', 'm5Max', 'normal', '[]')
    db.updateTask(pending, { needs_approval: true })

    // notFlagged: needs_approval stays 0 -> excluded.
    const notFlagged = db.createTask('no approval needed', '', 'deps-approval', 'm5Max', 'normal', '[]')

    // approved: flagged but already approved -> excluded.
    const approved = db.createTask('already approved', '', 'deps-approval', 'm5Max', 'normal', '[]')
    db.updateTask(approved, { needs_approval: true })
    db.approveTask(approved, 'Gilbert')

    // done: flagged + unapproved but status done -> excluded.
    const done = db.createTask('approval but done', '', 'deps-approval', 'm5Max', 'normal', '[]')
    db.updateTask(done, { needs_approval: true, status: 'done' })

    const ids = db.listTasksNeedingApproval().map((t) => t.id)
    expect(ids).toContain(pending)
    expect(ids).not.toContain(notFlagged)
    expect(ids).not.toContain(approved)
    expect(ids).not.toContain(done)
  })

  test('a flagged task drops off the queue once it is approved', () => {
    const t = db.createTask('approve me', '', 'deps-approval-2', 'm5Max', 'normal', '[]')
    db.updateTask(t, { needs_approval: true })
    expect(db.listTasksNeedingApproval().map((x) => x.id)).toContain(t)

    db.approveTask(t, 'Gilbert')
    expect(db.listTasksNeedingApproval().map((x) => x.id)).not.toContain(t)
  })
})
