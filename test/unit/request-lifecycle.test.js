// Gate for the blocking-request HTTP lifecycle — POST/GET/PUT /requests.
//
// This is a shipped, DOCUMENTED public API that until now had ZERO route-level
// tests. README:21 markets "blocking requests that force a response"; the
// agent onboarding guide (docs/getting-started-agent.md) tells every new agent
// to rely on `mycelium_send_request` / `mycelium_respond_to_request`. A stranger
// depends on this contract: "I POST a request to an agent; it lands pending for
// them; they ack or resolve it; the message-type is enforced." This file pins
// that contract so it can't drift silently. Every assertion is load-bearing —
// it reds when the corresponding guard in server/routes/requests.js is removed
// or flipped.
//
// Harness mirrors test/unit/attribution-spoof-auth.test.js: the REAL mycelium
// router via supertest, a fresh temp DATA_DIR + ADMIN_KEY/JWT_SECRET set BEFORE
// the dynamic import (so db.js / routes pick them up at module-eval time), and
// agents with real SHA-256 key hashes. `pool: 'forks'` is the project-wide
// vitest default (vitest.config.js) — inherited, not re-declared.
//
// ---------------------------------------------------------------------------
// OWNERSHIP — PINNED OPEN (dynamically proven 2026-08-12 on master 6d1d630).
// PUT /requests/:id calls checkAgentOrAdmin but performs NO check that the
// caller is the request's to_agent (the one asked) or from_agent (the asker).
// Dynamically verified at the HTTP layer: an UNRELATED agent C can resolve
// A↔B's request (HTTP 200) AND its optional `response` lands as a message in
// the requester's thread. The sibling PUT /messages/:id/resolve (messages.js)
// is identically open, and `git log -S` shows no ownership guard was EVER
// present in this path — so the open behavior reads as consistent platform
// policy across both resolve endpoints, not a removed check.
//   Whether it SHOULD be restricted to to_agent / from_agent / admin is an
// OPEN question SURFACED to Gilbert — do NOT silently flip a public authz
// semantic. This gate pins the CURRENT (open) behavior so any future
// restriction is a conscious decision that updates the tests marked
// [OWNERSHIP-OPEN] below (they would flip from 200 to 403).
//
// ---------------------------------------------------------------------------
// auto_task request_id link — was SILENTLY BROKEN on master. The route calls
// updateTask(taskId, { assignee, request_id: id }), but the tasks update
// allowlist (server/db/tasks.js) omitted 'request_id', and buildUpdate drops
// any field not in the allowlist — so the back-link was never persisted
// (verified: request_id stayed NULL). The allowlist entry added alongside this
// test is the fix that makes the contract hold. Remove that one entry and the
// auto_task 'request_id is linked' assertion reds.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret-request-lifecycle'

// Three agents on one project. A asks B; C is UNRELATED to A↔B (ownership).
const KEY_A = 'dvk_' + 'a'.repeat(48) // 192-bit machine keys, like real agents
const KEY_B = 'dvk_' + 'b'.repeat(48)
const KEY_C = 'dvk_' + 'c'.repeat(48)
const A = 'req-agent-a', B = 'req-agent-b', C = 'req-agent-c'
const PROJECT = 'req-lifecycle-proj'

// Accepted status synonyms, read FROM server/routes/requests.js:75/81 — NOT
// re-typed from memory. Asserting each one means the gate reds if a synonym is
// dropped from the dispatch, rather than silently desynchronizing.
//   requests.js:75  acknowledged | ack      -> acknowledgeMessage
//   requests.js:81  resolved | completed | done -> resolveMessage
const ACK_SYNONYMS = ['acknowledged', 'ack']
const RESOLVE_SYNONYMS = ['resolved', 'completed', 'done']

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-request-lifecycle-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const hashOf = (k) => crypto.createHash('sha256').update(k).digest('hex')
  db.createAgent(A, 'Agent A', PROJECT, hashOf(KEY_A), '["code"]')
  db.createAgent(B, 'Agent B', PROJECT, hashOf(KEY_B), '["code"]')
  db.createAgent(C, 'Agent C', PROJECT, hashOf(KEY_C), '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Create a pending request A->B and return its id. Extra body fields merge in.
async function postRequest (extra = {}) {
  const res = await request(app)
    .post('/api/mycelium/requests')
    .set('X-Agent-Key', KEY_A)
    .send({ content: 'need the /users spec', to_agent: B, ...extra })
  return res
}

describe('(1) POST /requests creates a pending request, readable back by the recipient', () => {
  test('A posts a request to B; B sees it pending as a request-typed message', async () => {
    const created = await postRequest()
    expect(created.status).toBe(200)
    expect(typeof created.body.id).toBe('number')
    const id = created.body.id

    const pending = await request(app)
      .get('/api/mycelium/requests/pending')
      .set('X-Agent-Key', KEY_B)
    expect(pending.status).toBe(200)
    const mine = pending.body.find((m) => m.id === id)
    expect(mine).toBeDefined()
    expect(mine.msg_type).toBe('request')
    expect(mine.status).toBe('pending')
    expect(mine.from_agent).toBe(A)
    expect(mine.to_agent).toBe(B)
  })
})

describe('(2) required-field 400s', () => {
  test('missing content -> 400 "content is required" (requests.js:34)', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set('X-Agent-Key', KEY_A)
      .send({ to_agent: B })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/content is required/)
  })

  test('missing to_agent -> 400 (requests.js:36)', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set('X-Agent-Key', KEY_A)
      .send({ content: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/to_agent is required/)
  })
})

describe('(3) msg_type enforcement on PUT /requests/:id', () => {
  test('PUT on a plain (non-request) message -> 400 "is not a request" (requests.js:70)', async () => {
    const msg = await request(app)
      .post('/api/mycelium/messages')
      .set('X-Agent-Key', KEY_A)
      .send({ content: 'just a plain message', to: B })
    expect(msg.status).toBe(200)
    const plainId = msg.body.id

    const res = await request(app)
      .put('/api/mycelium/requests/' + plainId)
      .set('X-Agent-Key', KEY_B)
      .send({ status: 'resolved' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/is not a request/)
  })

  test('PUT on an absent id -> 404 (requests.js:69)', async () => {
    const res = await request(app)
      .put('/api/mycelium/requests/999999')
      .set('X-Agent-Key', KEY_B)
      .send({ status: 'resolved' })
    expect(res.status).toBe(404)
  })
})

describe('(4) transitions — ack/resolve synonyms + invalid status', () => {
  test('acknowledge synonyms (requests.js:75) all succeed', async () => {
    for (const status of ACK_SYNONYMS) {
      const created = await postRequest()
      const res = await request(app)
        .put('/api/mycelium/requests/' + created.body.id)
        .set('X-Agent-Key', KEY_B)
        .send({ status })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('acknowledged')
      expect(db.getMessage(created.body.id).status).toBe('acknowledged')
    }
  })

  test('resolve synonyms (requests.js:81) all succeed', async () => {
    for (const status of RESOLVE_SYNONYMS) {
      const created = await postRequest()
      const res = await request(app)
        .put('/api/mycelium/requests/' + created.body.id)
        .set('X-Agent-Key', KEY_B)
        .send({ status })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('resolved')
      expect(db.getMessage(created.body.id).status).toBe('resolved')
    }
  })

  test('ack then resolve on the same request both succeed (no state guard)', async () => {
    const created = await postRequest()
    const ack = await request(app).put('/api/mycelium/requests/' + created.body.id)
      .set('X-Agent-Key', KEY_B).send({ status: 'acknowledged' })
    expect(ack.status).toBe(200)
    const resolved = await request(app).put('/api/mycelium/requests/' + created.body.id)
      .set('X-Agent-Key', KEY_B).send({ status: 'resolved' })
    expect(resolved.status).toBe(200)
    expect(db.getMessage(created.body.id).status).toBe('resolved')
  })

  test('invalid status -> 400 "Invalid status" (requests.js:94)', async () => {
    const created = await postRequest()
    const res = await request(app)
      .put('/api/mycelium/requests/' + created.body.id)
      .set('X-Agent-Key', KEY_B)
      .send({ status: 'frobnicate' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid status/)
  })

  test('optional response body creates a reply message to the requester (requests.js:88)', async () => {
    const created = await postRequest()
    const res = await request(app)
      .put('/api/mycelium/requests/' + created.body.id)
      .set('X-Agent-Key', KEY_B)
      .send({ status: 'resolved', response: 'here is the spec you asked for' })
    expect(res.status).toBe(200)
    expect(typeof res.body.response_id).toBe('number')

    const reply = db.getMessage(res.body.response_id)
    expect(reply).toBeTruthy()
    expect(reply.from_agent).toBe(B) // responder
    expect(reply.to_agent).toBe(A) // back to the asker
    expect(reply.content).toBe('here is the spec you asked for')
  })
})

// [OWNERSHIP-OPEN] See file header. These assert the CURRENT open behavior. If
// resolution is ever restricted to to_agent/from_agent/admin, flip 200 -> 403
// here AND document the policy change.
describe('resolver ownership — PINNED OPEN [OWNERSHIP-OPEN]', () => {
  test('an UNRELATED agent C can resolve A<->B request -> 200 (no to_agent/from_agent guard)', async () => {
    const created = await postRequest() // A -> B
    const res = await request(app)
      .put('/api/mycelium/requests/' + created.body.id)
      .set('X-Agent-Key', KEY_C) // C is neither to_agent nor from_agent
      .send({ status: 'resolved' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('resolved')

    const row = db.getMessage(created.body.id)
    expect(row.status).toBe('resolved')
    expect(row.resolved_by).toBe(C) // recorded as the unrelated caller
  })

  test('the unrelated agent C can ALSO post a response into the requester thread', async () => {
    const created = await postRequest() // A -> B
    const res = await request(app)
      .put('/api/mycelium/requests/' + created.body.id)
      .set('X-Agent-Key', KEY_C)
      .send({ status: 'resolved', response: 'C answered on a shared network' })
    expect(res.status).toBe(200)
    expect(typeof res.body.response_id).toBe('number')

    const reply = db.getMessage(res.body.response_id)
    expect(reply.from_agent).toBe(C) // the unrelated agent
    expect(reply.to_agent).toBe(A) // landed in the asker's thread
  })
})

describe('(5) auto_task — returns a task linked to the recipient', () => {
  test('auto_task:true returns a task_id assigned to the recipient with request_id linked', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set('X-Agent-Key', KEY_A)
      .send({ content: 'please do the thing', to_agent: B, auto_task: true })
    expect(res.status).toBe(200)
    expect(typeof res.body.id).toBe('number')
    expect(typeof res.body.task_id).toBe('number')

    const task = db.getTask(res.body.task_id)
    expect(task).toBeTruthy()
    expect(task.assignee).toBe(B) // linked to the recipient (the ask)
    expect(task.request_id).toBe(res.body.id) // back-link to the request
  })
})

describe('(6) auth — X-Agent-Key enforced', () => {
  test('missing X-Agent-Key -> 401 (checkAgent, mycelium.js:571)', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .send({ content: 'x', to_agent: B })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/Missing X-Agent-Key/)
  })

  test('invalid X-Agent-Key -> 403 (checkAgent, mycelium.js:624)', async () => {
    const res = await request(app)
      .post('/api/mycelium/requests')
      .set('X-Agent-Key', 'dvk_not-a-real-key')
      .send({ content: 'x', to_agent: B })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Invalid agent key/)
  })
})

// Anchor the "blocking" marketing claim to the work queue (the queue priority
// LADDER itself is brief 26's concern — this only asserts a pending request
// shows up in the recipient's pull, not the ordering).
describe('blocking anchor — a pending request surfaces in the recipient /work pull', () => {
  test('after A asks B, B sees a request item in GET /work/B', async () => {
    const created = await postRequest()
    const work = await request(app)
      .get('/api/mycelium/work/' + B)
      .set('X-Agent-Key', KEY_B)
    expect(work.status).toBe(200)
    const reqItem = (work.body.queue || []).find((x) => x.type === 'request' && x.id === created.body.id)
    expect(reqItem).toBeDefined()
  })
})
