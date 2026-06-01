import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Backs the ApprovalsPage resolved-state-tabs fix (Studio bug #112).
//
// Symptom: the Approved / Rejected / All tabs always rendered empty. Root cause
// was a frontend data-source mismatch: the page derived every tab from
// store.pendingApprovals, which is fed by getOverview().pending_approvals =
// listApprovals({status:'pending'}) — a PENDING-ONLY array. Resolved rows were
// never in it, so the resolved tabs had no data source.
//
// The fix gives the page a real data source: it now fetches GET /approvals with
// the matching ?status (UI 'rejected' -> stored 'denied', 'all' -> no status).
// This test proves the server contract that fix relies on: a resolved approval
// is retrievable by its resolved status via listApprovals, and is correctly
// ABSENT from the pending query. There is no frontend unit-test harness in this
// repo, so the load-bearing server side is verified here; the page's
// status-string mapping ('rejected' -> 'denied') is exercised against these same
// stored values.
//
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// initDB() writes only to the temp DATA_DIR — never the live mycelium.db.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-approvals-resolved-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('listApprovals data source for resolved-state tabs', () => {
  test('a newly created approval defaults to status=pending', () => {
    const id = db.createApproval('deploy', 'lucy', 'Deploy svc A', {}, 'mycelium', 'high', 1)
    const row = db.getApproval(id)
    expect(row.status).toBe('pending')

    const pending = db.listApprovals({ status: 'pending', limit: 50 })
    expect(pending.map((a) => a.id)).toContain(id)
  })

  test("an APPROVED approval is returned by status:'approved' and absent from pending (Approved tab)", () => {
    const id = db.createApproval('deploy', 'lucy', 'Deploy svc B', {}, 'mycelium', 'high', 1)
    db.decideApproval(id, 'approved', '__admin__', 'looks good')

    const approved = db.listApprovals({ status: 'approved', limit: 50 })
    expect(approved.map((a) => a.id)).toContain(id)
    expect(approved.find((a) => a.id === id).status).toBe('approved')

    const pending = db.listApprovals({ status: 'pending', limit: 50 })
    expect(pending.map((a) => a.id)).not.toContain(id)
  })

  test("a DENIED approval is returned by status:'denied' (the UI 'rejected' tab maps to 'denied')", () => {
    const id = db.createApproval('deploy', 'echo', 'Deploy svc C', {}, 'mycelium', 'high', 1)
    db.decideApproval(id, 'denied', '__admin__', 'too risky')

    // UI 'rejected' tab -> stored status 'denied'
    const denied = db.listApprovals({ status: 'denied', limit: 50 })
    expect(denied.map((a) => a.id)).toContain(id)
    expect(denied.find((a) => a.id === id).status).toBe('denied')

    // and it must NOT leak into the pending queue the dashboard polls
    const pending = db.listApprovals({ status: 'pending', limit: 50 })
    expect(pending.map((a) => a.id)).not.toContain(id)
  })

  test("the 'all' tab (no status filter) returns rows across every status", () => {
    const all = db.listApprovals({ limit: 50 })
    const statuses = new Set(all.map((a) => a.status))
    expect(statuses.has('pending')).toBe(true)
    expect(statuses.has('approved')).toBe(true)
    expect(statuses.has('denied')).toBe(true)
  })

  test('project filter uses filters.project_id (matches GET /approvals after the param-name fix)', () => {
    const id = db.createApproval('config', 'ada', 'Config in projX', {}, 'projX', 'low', 1)
    const inProj = db.listApprovals({ project_id: 'projX', limit: 50 })
    expect(inProj.map((a) => a.id)).toContain(id)
    // a different project must not include it
    const other = db.listApprovals({ project_id: 'mycelium', limit: 50 })
    expect(other.map((a) => a.id)).not.toContain(id)
  })
})
