import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercises the REAL db.js getReconciliationCandidates against a fresh temp DB.
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' isolates this file's module state — never touches live mycelium.db.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-recon-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Helper: force a record's updated_at into the past so it crosses the staleness
// cutoff. We poke the raw DB handle (getDB) — the reconciliation read is what's
// under test, not the writer. ISO seconds in SQLite datetime() format.
function backdate(table, id, minutesAgo) {
  const raw = db.getDB()
  raw.prepare(
    `UPDATE ${table} SET updated_at = datetime('now', '-' || ? || ' minutes') WHERE id = ?`
  ).run(minutesAgo, id)
}

describe('getReconciliationCandidates — A7 state-desync read-surface', () => {
  test('returns ONLY in_progress records older than the threshold', () => {
    const project = 'recon-proj'

    // Stuck bug: in_progress, last touched 30h ago (past 24h default).
    const stuckBugId = db.createBug(project, 'Stuck bug', 'desc', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(stuckBugId, { status: 'in_progress' })
    backdate('bugs', stuckBugId, 30 * 60)

    // Fresh bug: in_progress but updated just now — must NOT appear.
    const freshBugId = db.createBug(project, 'Fresh bug', 'desc', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(freshBugId, { status: 'in_progress' })

    // Fixed bug: old but NOT in_progress — must NOT appear (status filter).
    const fixedBugId = db.createBug(project, 'Fixed bug', 'desc', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(fixedBugId, { status: 'fixed' })
    backdate('bugs', fixedBugId, 48 * 60)

    // Stuck task.
    const stuckTaskId = db.createTask('Stuck task', '', project, 'm5Max', 'normal', '[]')
    db.updateTask(stuckTaskId, { status: 'in_progress' })
    backdate('tasks', stuckTaskId, 26 * 60)

    // Stuck plan step (in_progress + old).
    const planId = db.createPlan('Recon plan', '', project, 'm5Max', 'normal', '[]', 'm5Max')
    const stepId = db.createPlanStep(planId, 'Stuck step', '', 'Lucy', '')
    db.updatePlanStep(stepId, { status: 'in_progress' })
    backdate('plan_steps', stepId, 25 * 60)

    const out = db.getReconciliationCandidates() // default 24h

    const bugIds = out.bugs.map((b) => b.id)
    expect(bugIds).toContain(stuckBugId)
    expect(bugIds).not.toContain(freshBugId)
    expect(bugIds).not.toContain(fixedBugId)

    expect(out.tasks.map((t) => t.id)).toContain(stuckTaskId)
    expect(out.plan_steps.map((s) => s.id)).toContain(stepId)

    // Counts agree with the arrays and are read-only metadata.
    expect(out.counts.bugs).toBe(out.bugs.length)
    expect(out.counts.tasks).toBe(out.tasks.length)
    expect(out.counts.plan_steps).toBe(out.plan_steps.length)
    expect(out.counts.total).toBe(out.bugs.length + out.tasks.length + out.plan_steps.length)
    expect(out.threshold_minutes).toBe(24 * 60)
  })

  test('threshold is configurable — a tighter window catches a younger record', () => {
    const project = 'recon-proj-2'
    const bugId = db.createBug(project, 'Two-hour bug', 'desc', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(bugId, { status: 'in_progress' })
    backdate('bugs', bugId, 120) // 2h ago

    // Default 24h window: not stale yet.
    expect(db.getReconciliationCandidates().bugs.map((b) => b.id)).not.toContain(bugId)
    // 60-minute window: now flagged.
    expect(db.getReconciliationCandidates(60).bugs.map((b) => b.id)).toContain(bugId)
  })

  test('is read-only — record status is unchanged after a scan', () => {
    const project = 'recon-proj-3'
    const bugId = db.createBug(project, 'Untouched bug', 'desc', 'bug', 'normal', 'm5Max', 'Lucy')
    db.updateBug(bugId, { status: 'in_progress' })
    backdate('bugs', bugId, 40 * 60)

    db.getReconciliationCandidates(60)
    expect(db.getBug(bugId).status).toBe('in_progress')
  })
})
