import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the REAL approval-voting functions in db.js against a fresh temp DB:
//   castApprovalVote  — INSERT ... ON CONFLICT(approval_id, voter) DO UPDATE (upsert)
//   getApprovalVotes  — SELECT * ... ORDER BY created_at
//   countApprovalVotes — SUM(CASE WHEN vote='approve'...) tally, nulls -> 0
//
// Why this matters: multi-human approval (required_approvals > 1) uses the vote
// tally as the quorum signal. The UNIQUE(approval_id, voter) constraint + upsert
// is the ONLY thing stopping one voter from manufacturing quorum by voting twice.
// If the upsert ever regressed to a plain INSERT (or the UNIQUE index were lost),
// a single voter could stack rows and forge a quorum. These tests pin that down.
//
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' isolates this file's module state. initDB() writes only to the
// temp DATA_DIR — never the live mycelium.db.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-approval-votes-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Each test makes its own approval row so votes never cross-contaminate.
function newApproval(title) {
  // required_approvals:2 mirrors the multi-human quorum case the tally feeds.
  return db.createApproval('deploy', 'lucy', title, {}, 'mycelium', 'high', 2)
}

describe('approval voting: cast / get / count', () => {
  test('empty approval: count is {approves:0, denies:0} (COALESCE nulls -> 0)', () => {
    const id = newApproval('no votes yet')
    // SUM over zero rows is SQL NULL; countApprovalVotes must coalesce to 0,0.
    expect(db.countApprovalVotes(id)).toEqual({ approves: 0, denies: 0 })
    expect(db.getApprovalVotes(id)).toEqual([])
  })

  test('a single approve vote tallies and is retrievable', () => {
    const id = newApproval('one approve')
    db.castApprovalVote(id, 'gilbert', 'approve', 'ship it')

    const votes = db.getApprovalVotes(id)
    expect(votes).toHaveLength(1)
    expect(votes[0].voter).toBe('gilbert')
    expect(votes[0].vote).toBe('approve')
    expect(votes[0].notes).toBe('ship it')
    expect(votes[0].approval_id).toBe(id)

    expect(db.countApprovalVotes(id)).toEqual({ approves: 1, denies: 0 })
  })

  test('distinct voters accumulate toward quorum (approves and denies tallied separately)', () => {
    const id = newApproval('mixed voters')
    db.castApprovalVote(id, 'gilbert', 'approve', '')
    db.castApprovalVote(id, 'jessie', 'approve', '')
    db.castApprovalVote(id, 'michael', 'deny', 'needs more review')

    expect(db.getApprovalVotes(id)).toHaveLength(3)
    expect(db.countApprovalVotes(id)).toEqual({ approves: 2, denies: 1 })
  })

  test('UPSERT: a voter changing approve -> deny OVERWRITES, never duplicates', () => {
    // This is the regression that lets one voter forge quorum. The same voter
    // casting twice must leave exactly ONE row and the LATEST vote wins.
    const id = newApproval('voter flips their mind')
    db.castApprovalVote(id, 'gilbert', 'approve', 'lgtm')
    db.castApprovalVote(id, 'gilbert', 'deny', 'wait, found a bug')

    const votes = db.getApprovalVotes(id)
    expect(votes).toHaveLength(1) // upsert, NOT a second row
    expect(votes[0].voter).toBe('gilbert')
    expect(votes[0].vote).toBe('deny') // latest vote wins
    expect(votes[0].notes).toBe('wait, found a bug') // notes overwritten too

    // The exact spec assertion: approve-then-deny by one voter yields 0 / 1.
    expect(db.countApprovalVotes(id)).toEqual({ approves: 0, denies: 1 })
  })

  test('UPSERT: deny -> approve flips back, still one row', () => {
    const id = newApproval('flip the other direction')
    db.castApprovalVote(id, 'gilbert', 'deny', '')
    db.castApprovalVote(id, 'gilbert', 'approve', '')

    expect(db.getApprovalVotes(id)).toHaveLength(1)
    expect(db.countApprovalVotes(id)).toEqual({ approves: 1, denies: 0 })
  })

  test('UPSERT is per (approval_id, voter): same voter votes once per approval', () => {
    // The unique key is the PAIR — the same person voting on two different
    // approvals must produce two independent rows, not collide.
    const a = newApproval('approval A')
    const b = newApproval('approval B')
    db.castApprovalVote(a, 'gilbert', 'approve', '')
    db.castApprovalVote(b, 'gilbert', 'deny', '')

    expect(db.getApprovalVotes(a)).toHaveLength(1)
    expect(db.getApprovalVotes(b)).toHaveLength(1)
    expect(db.countApprovalVotes(a)).toEqual({ approves: 1, denies: 0 })
    expect(db.countApprovalVotes(b)).toEqual({ approves: 0, denies: 1 })
  })

  test('vote defaults to "approve" when omitted; notes default to ""', () => {
    // castApprovalVote(approvalId, voter) with no vote/notes -> vote='approve'.
    const id = newApproval('defaulted vote')
    db.castApprovalVote(id, 'gilbert')

    const votes = db.getApprovalVotes(id)
    expect(votes).toHaveLength(1)
    expect(votes[0].vote).toBe('approve')
    expect(votes[0].notes).toBe('')
    expect(db.countApprovalVotes(id)).toEqual({ approves: 1, denies: 0 })
  })

  test('many distinct voters: tally scales (quorum signal for required_approvals > 1)', () => {
    const id = newApproval('big vote')
    const approvers = ['a1', 'a2', 'a3']
    const deniers = ['d1', 'd2']
    approvers.forEach((v) => db.castApprovalVote(id, v, 'approve', ''))
    deniers.forEach((v) => db.castApprovalVote(id, v, 'deny', ''))

    expect(db.getApprovalVotes(id)).toHaveLength(5)
    expect(db.countApprovalVotes(id)).toEqual({ approves: 3, denies: 2 })

    // And one of them flipping does not inflate the row count or double-count.
    db.castApprovalVote(id, 'd1', 'approve', 'convinced')
    expect(db.getApprovalVotes(id)).toHaveLength(5) // still 5 rows
    expect(db.countApprovalVotes(id)).toEqual({ approves: 4, denies: 1 })
  })

  test('getApprovalVotes scopes strictly to its approval_id', () => {
    const a = newApproval('scope A')
    const b = newApproval('scope B')
    db.castApprovalVote(a, 'gilbert', 'approve', '')
    db.castApprovalVote(a, 'jessie', 'deny', '')
    db.castApprovalVote(b, 'michael', 'approve', '')

    const aVotes = db.getApprovalVotes(a)
    expect(aVotes).toHaveLength(2)
    expect(aVotes.every((v) => v.approval_id === a)).toBe(true)
    expect(aVotes.map((v) => v.voter).sort()).toEqual(['gilbert', 'jessie'])

    const bVotes = db.getApprovalVotes(b)
    expect(bVotes).toHaveLength(1)
    expect(bVotes[0].voter).toBe('michael')
  })
})
