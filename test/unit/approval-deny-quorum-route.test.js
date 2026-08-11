import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// Route-level gate for PUT /approvals/:id/vote — the platform's human-in-the-loop
// safety control. The README markets this as risk-tiered approval where "any
// single deny rejects" (README.md:22) with a per-tier quorum (README.md:159-166:
// medium=1 human, high=2+ humans, critical=all humans).
//
// The existing test/unit/db-approvals*.test.js files import server/db.js and
// exercise the DB FUNCTIONS (createApproval / castApprovalVote / decideApproval).
// They never touch the HTTP route a stranger integrates against — so the
// README's headline safety promise was unverified at the route layer. This file
// drives the REAL Express app (server/routes/mycelium.js, which mounts the
// approval routes via registerApprovalRoutes at mycelium.js:1764) against a
// fresh temp DB and pins the route contract:
//
//   (1) a single deny flips a pending approval to the 'denied' terminal state
//       instantly  — README's "any single deny rejects"
//   (2) deny is FINAL: a later approve does NOT resurrect it
//   (3) the tier quorum holds on approve: required_approvals:2 stays pending
//       after one distinct approver, grants on a second DISTINCT approver, and
//       a duplicate vote from the SAME approver does not double-count
//   (4) the vote is admin-gated: unauthenticated -> 401, non-admin -> 403, and
//       neither mutates the approval
//
// How two DISTINCT approvers are reached through the route: the handler derives
// the recorded voter identity from the auth mode (routes/approvals.js:154):
//     X-Admin-Key header  -> voter '__admin__'
//     admin JWT (no key)  -> voter 'studio_user'
// The duplicate-dedup test relies on approval_votes UNIQUE(approval_id, voter)
// (schema.sql:565) + castApprovalVote's upsert on that key (db/approvals.js:63-68).
//
// Same harness as auth-roles.test.js / project-scope-rerun-approval.test.js:
// fresh temp DB, env set before the dynamic import. vitest pool:'forks' gives
// this file its own process, so the env mutations below don't leak.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let db
let app

// Voter recorded by the route for an X-Admin-Key request is '__admin__'.
function adminKeyHeaders() {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': 'tester' }
}

// Voter recorded by the route for an admin-JWT request (no X-Admin-Key) is
// 'studio_user'. checkAdmin trusts the JWT role claim — see auth-roles.test.js.
function adminJwt() {
  return jwt.sign(
    { studioUser: true, userId: 4242, username: 'admin', displayName: 'Admin', role: 'admin' },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

function memberJwt() {
  return jwt.sign(
    { studioUser: true, userId: 5252, username: 'member', displayName: 'Member', role: 'member' },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

function voteUrl(id) {
  return '/api/mycelium/approvals/' + id + '/vote'
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-approval-vote-route-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Create a pending approval with the requested quorum and READ IT BACK so the
// expected status / required_approvals are echoed from the created row, never
// hard-coded — a schema rename reds the test instead of silently desyncing it.
// requested_by='__admin__' makes notifyApprovalDecision early-return
// (routes/approvals.js:18-19), keeping message/inbox side effects out of these
// vote-route assertions. We use the db helper only to plant the fixture; every
// behavior assertion below goes through the HTTP route.
function createPending(required) {
  const id = db.createApproval('deploy', '__admin__', 'vote-gate fixture', { ref: 'x' }, 'vote-gate-proj', 'medium', required)
  return db.getApproval(id)
}

// ───────────────────────── (1) deny is instant + terminal ─────────────────────────

describe('(1) a single deny is an instant, terminal denial', () => {
  test('one deny vote flips a pending approval to the denied terminal state', async () => {
    const a = createPending(1)
    // Precondition echoed from the created row (not hard-coded).
    expect(a.status).toBe('pending')

    const res = await request(app)
      .put(voteUrl(a.id))
      .set(adminKeyHeaders())
      .send({ vote: 'deny' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe('denied') // README: "any single deny rejects"

    // Persisted row matches the HTTP response and is in the terminal state.
    const after = db.getApproval(a.id)
    expect(after.status).toBe('denied')
    expect(after.status).toBe(res.body.status) // row == response (tracks-reality)

    // The deny vote itself was recorded.
    const votes = db.getApprovalVotes(a.id)
    expect(votes.length).toBe(1)
    expect(votes[0].vote).toBe('deny')
  })
})

// ───────────────────────── (2) deny is FINAL ─────────────────────────

describe('(2) deny is FINAL — a later approve cannot resurrect it', () => {
  test('after a deny, an approve vote is rejected (400) and the approval stays denied', async () => {
    const a = createPending(1)

    const deny = await request(app).put(voteUrl(a.id)).set(adminKeyHeaders()).send({ vote: 'deny' })
    expect(deny.body.status).toBe('denied')

    // Attempt to approve the already-denied approval.
    const revive = await request(app).put(voteUrl(a.id)).set(adminKeyHeaders()).send({ vote: 'approve' })

    // Enforced by the `approval.status !== 'pending'` guard at
    // routes/approvals.js:157, which runs BEFORE any vote is cast — so once
    // denied, an approval can never be voted on again through this route. If a
    // future refactor moves/deletes that guard, this REDS: exactly the silent
    // safety-erosion the README's "any single deny rejects" exists to prevent.
    expect(revive.status).toBe(400)
    expect(String(revive.body.error)).toMatch(/already/i)

    // The approval was NOT resurrected.
    expect(db.getApproval(a.id).status).toBe('denied')
    // And no approve vote was recorded — only the single deny from above.
    expect(db.countApprovalVotes(a.id).approves).toBe(0)
  })
})

// ───────────────────────── (3) tier quorum holds on approve ─────────────────────────

describe('(3) the tier quorum holds on approve', () => {
  test('required_approvals:2 stays pending after one distinct approver', async () => {
    const a = createPending(2)
    const required = a.required_approvals // echoed, not hard-coded
    expect(required).toBe(2)

    // First distinct approver: X-Admin-Key -> voter '__admin__'.
    const first = await request(app).put(voteUrl(a.id)).set(adminKeyHeaders()).send({ vote: 'approve' })

    expect(first.status).toBe(200)
    expect(first.body.status).toBe('pending') // quorum NOT yet reached
    expect(first.body.votes.approves).toBe(1)
    expect(first.body.remaining).toBe(required - 1) // tracks-reality math
    expect(db.getApproval(a.id).status).toBe('pending')
  })

  test('a second DISTINCT approver grants it (quorum reached)', async () => {
    const a = createPending(2)
    const required = a.required_approvals

    // First approver via X-Admin-Key (voter '__admin__').
    await request(app).put(voteUrl(a.id)).set(adminKeyHeaders()).send({ vote: 'approve' })
    expect(db.getApproval(a.id).status).toBe('pending')

    // Second DISTINCT approver via admin JWT (voter 'studio_user') — the only
    // other voter identity the route can record, so this proves a genuinely
    // different human's sign-off is what satisfies the quorum.
    const second = await request(app)
      .put(voteUrl(a.id))
      .set('Authorization', 'Bearer ' + adminJwt())
      .send({ vote: 'approve' })

    expect(second.status).toBe(200)
    expect(second.body.status).toBe('approved') // README tier quorum satisfied
    expect(second.body.votes.approves).toBe(required) // two distinct voters counted
    expect(db.getApproval(a.id).status).toBe('approved')
  })

  test('a duplicate approve from the SAME approver does NOT double-count', async () => {
    const a = createPending(2)

    // Same approver (X-Admin-Key -> '__admin__') votes approve twice.
    const first = await request(app).put(voteUrl(a.id)).set(adminKeyHeaders()).send({ vote: 'approve' })
    const again = await request(app).put(voteUrl(a.id)).set(adminKeyHeaders()).send({ vote: 'approve' })

    // Both calls succeed (upsert), but only ONE distinct voter is on record.
    // approval_votes UNIQUE(approval_id, voter) + castApprovalVote's
    // ON CONFLICT ... DO UPDATE (db/approvals.js:63-68) mean a single human
    // cannot self-satisfy a 2-quorum by voting twice. Reds if that dedup breaks.
    expect(first.body.votes.approves).toBe(1)
    expect(again.body.votes.approves).toBe(1) // still 1, NOT 2
    expect(db.countApprovalVotes(a.id).approves).toBe(1)
    expect(db.getApproval(a.id).status).toBe('pending') // still short of quorum
  })
})

// ───────────────────────── (4) the vote is admin-gated ─────────────────────────

describe('(4) the vote route is admin-gated', () => {
  test('unauthenticated request -> 401, approval not mutated', async () => {
    const a = createPending(1)

    const res = await request(app).put(voteUrl(a.id)).send({ vote: 'approve' }) // no auth

    expect(res.status).toBe(401)
    expect(db.getApproval(a.id).status).toBe('pending')
    expect(db.countApprovalVotes(a.id).approves).toBe(0)
  })

  test('non-admin (member) JWT -> 403, approval not mutated', async () => {
    const a = createPending(1)

    const res = await request(app)
      .put(voteUrl(a.id))
      .set('Authorization', 'Bearer ' + memberJwt())
      .send({ vote: 'approve' })

    expect(res.status).toBe(403)
    expect(String(res.body.error)).toMatch(/admin/i)
    expect(db.getApproval(a.id).status).toBe('pending')
    expect(db.countApprovalVotes(a.id).approves).toBe(0)
  })

  test('an invalid admin key -> 403, approval not mutated', async () => {
    const a = createPending(1)

    const res = await request(app)
      .put(voteUrl(a.id))
      .set('X-Admin-Key', 'not-the-real-key')
      .send({ vote: 'approve' })

    expect(res.status).toBe(403)
    expect(db.getApproval(a.id).status).toBe('pending')
    expect(db.countApprovalVotes(a.id).approves).toBe(0)
  })
})
