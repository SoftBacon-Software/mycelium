import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION TESTS — messages + channels + inbox + events + team-chat.
//
// This file pins the CURRENT behavior of the communication surface of
// server/routes/mycelium.js (+ the already-extracted server/routes/channels.js)
// ahead of the god-file decomposition. It asserts what the code DOES today,
// bugs included — comments flag the smells, the assertions still lock them.
// Fix nothing here; if a refactor changes any of these outcomes, that change
// must be deliberate and this file updated in the same commit.
//
// Harness: same as studio-login.test.js — real router, fresh temp DB, env set
// before the dynamic import, supertest against the mounted express app.
// Fixtures (operators, agents, channels) are created through the REAL routes so
// the DB state is exactly what production writes.
//
// Rate-limiter budget note: POST /messages sits behind agentWriteLimiter
// (30/min keyed on X-Agent-Key, falling back to IP). All admin-key requests
// share ONE IP bucket; agent-key requests each get their own. This file keeps
// admin-key POST /messages calls well under 30 — mind that if you add tests.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const PASSWORD = 'correct-horse-battery'

let tmpDataDir
let app

// Fixture handles filled in beforeAll
let gilbertToken // studio ADMIN user, linked to operator 'greatness'
let hanaToken // studio OPERATOR user, NOT linked to any operator
let lucyKey, echoKey, adaKey // agent API keys
let generalChannelId

function admin(req) { return req.set('X-Admin-Key', ADMIN_KEY) }

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-msg-chan-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  const db = await import('../../server/db.js')
  db.initDB() // seeds #general + #admin channels (ensureDefaultChannels)

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // -- Studio users (real registration + login so JWTs carry production claims)
  const regGil = await admin(request(app).post('/api/mycelium/studio/users'))
    .send({ username: 'gilbert', password: PASSWORD, display_name: 'Gilbert', role: 'admin' })
  if (regGil.status !== 200) throw new Error('setup: gilbert registration failed: ' + JSON.stringify(regGil.body))
  const regHana = await admin(request(app).post('/api/mycelium/studio/users'))
    .send({ username: 'hana', password: PASSWORD, display_name: 'Hana', role: 'operator' })
  if (regHana.status !== 200) throw new Error('setup: hana registration failed: ' + JSON.stringify(regHana.body))

  const loginGil = await request(app).post('/api/mycelium/studio/login').send({ username: 'gilbert', password: PASSWORD })
  gilbertToken = loginGil.body.token
  const gilbertUserId = loginGil.body.user.id
  const loginHana = await request(app).post('/api/mycelium/studio/login').send({ username: 'hana', password: PASSWORD })
  hanaToken = loginHana.body.token

  // -- Operators: greatness is linked to gilbert's studio account, hijack is not
  const opG = await admin(request(app).post('/api/mycelium/operators'))
    .send({ id: 'greatness', display_name: 'Greatness', role: 'owner', studio_user_id: gilbertUserId })
  if (opG.status !== 200) throw new Error('setup: operator greatness failed: ' + JSON.stringify(opG.body))
  const opH = await admin(request(app).post('/api/mycelium/operators'))
    .send({ id: 'hijack', display_name: 'Hijack', role: 'ui_lead' })
  if (opH.status !== 200) throw new Error('setup: operator hijack failed: ' + JSON.stringify(opH.body))

  // -- Agents (registration returns the plaintext key once; auto-joins #general)
  async function registerAgent(id) {
    const res = await admin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id, name: id, project_id: 'proj-test' })
    if (res.status !== 200) throw new Error('setup: agent ' + id + ' failed: ' + JSON.stringify(res.body))
    return res.body.api_key
  }
  lucyKey = await registerAgent('lucy')
  echoKey = await registerAgent('echo')
  adaKey = await registerAgent('ada')

  // echo belongs to operator hijack (routes echo-bound requests to hijack's inbox)
  const upEcho = await admin(request(app).put('/api/mycelium/agents/echo')).send({ operator_id: 'hijack' })
  if (upEcho.status !== 200) throw new Error('setup: echo operator_id failed')
  // ada is an operator-role agent (may send directives)
  const upAda = await admin(request(app).put('/api/mycelium/agents/ada')).send({ role: 'operator' })
  if (upAda.status !== 200) throw new Error('setup: ada role failed')

  const chans = await admin(request(app).get('/api/mycelium/channels'))
  generalChannelId = chans.body.find(c => c.slug === 'general').id
})

afterAll(() => {
  rmSync(tmpDataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AUTH — who can reach each surface, and the exact rejection each one gives
// ---------------------------------------------------------------------------

describe('auth boundaries', () => {
  test('GET /messages with no credentials → 401 Missing X-Agent-Key (checkAgent is the last fallback)', async () => {
    const res = await request(app).get('/api/mycelium/messages')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('GET /messages with a bogus agent key → 403 Invalid agent key', async () => {
    const res = await request(app).get('/api/mycelium/messages').set('X-Agent-Key', 'dvk_not_a_real_key')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('any studio JWT (operator role, not just admin) can read messages', async () => {
    const res = await request(app).get('/api/mycelium/messages')
      .set('Authorization', 'Bearer ' + hanaToken)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  test('GET /channels, /events with no credentials → 401', async () => {
    expect((await request(app).get('/api/mycelium/channels')).status).toBe(401)
    expect((await request(app).get('/api/mycelium/events')).status).toBe(401)
  })

  test('GET /inbox with no credentials → 401 Authentication required', async () => {
    const res = await request(app).get('/api/mycelium/inbox')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })

  // QUIRK (locked): team-chat rejects missing auth with 403, not 401 like the
  // rest of the API. Inconsistent but current.
  test('GET /team-chat with no credentials → 403 Studio login required', async () => {
    const res = await request(app).get('/api/mycelium/team-chat')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Studio login required')
  })

  test('DELETE /messages/bulk is admin-only: an agent key gets 403 "Admin role required" (findings-§1 fix)', async () => {
    const res = await request(app).delete('/api/mycelium/messages/bulk?from=lucy')
      .set('X-Agent-Key', lucyKey)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  test('GET /events/stream with no credentials → 401 JSON (auth rejects before SSE headers)', async () => {
    const res = await request(app).get('/api/mycelium/events/stream')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// MESSAGES — POST variants, routing, ack/resolve, threads, bulk delete
// ---------------------------------------------------------------------------

describe('messages', () => {
  let directedId // lucy→echo plain message (later ack'd)
  let resolveMeId // lucy→echo (later resolved by echo with a response)
  let sysResolveId // lucy→echo (later resolved via bare admin key → __system__ substitution)
  let broadcastId // echo broadcast (no recipient)
  let requestId // lucy→echo request
  let responseId // echo's reply created by the resolve

  test('POST /messages directed agent→agent → 200 {id} only; row defaults msg_type=message status=sent priority=normal', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: 'hello echo', thread_id: 't-alpha', project_id: 'proj-test', metadata: { k: 1 } })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['id']) // no ok:true — {id} is the whole contract
    directedId = res.body.id

    const list = await admin(request(app).get('/api/mycelium/messages?from=lucy&thread=t-alpha'))
    const row = list.body.find(m => m.id === directedId)
    expect(row).toBeTruthy()
    expect(row.msg_type).toBe('message')
    expect(row.status).toBe('sent')
    expect(row.priority).toBe('normal')
    expect(row.to_agent).toBe('echo')
    expect(row.project_id).toBe('proj-test')
    expect(row.metadata).toBe('{"k":1}') // metadata comes back as the raw JSON string, not an object
    expect(row.channel_id).not.toBeNull() // DM auto-routed into a channel
  })

  test('a directed message auto-creates the canonical DM channel (dm-<a>-<b>, case-insensitive sorted)', async () => {
    const res = await request(app).get('/api/mycelium/channels?member=lucy').set('X-Agent-Key', lucyKey)
    expect(res.status).toBe(200)
    const dm = res.body.find(c => c.type === 'dm' && c.slug === 'dm-echo-lucy')
    expect(dm).toBeTruthy()
    expect(dm.name).toBe('DM: echo & lucy')
  })

  // SMELL (locked): message content is stored RAW — no escapeHtml — while
  // events summaries and team-chat content ARE escaped on write. Inconsistent
  // write-side sanitization; renderers must escape message content themselves.
  test('message content is NOT html-escaped on write (unlike events/team-chat)', async () => {
    const raw = '<b>bold</b> & "quotes"'
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: raw })
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/messages?from=lucy'))
    expect(list.body.find(m => m.id === res.body.id).content).toBe(raw)
  })

  test('broadcast (no recipient) → to_agent null, routed to the #general channel', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', echoKey)
      .send({ content: 'broadcast from echo' })
    expect(res.status).toBe(200)
    broadcastId = res.body.id
    const list = await admin(request(app).get('/api/mycelium/messages?from=echo'))
    const row = list.body.find(m => m.id === broadcastId)
    expect(row.to_agent).toBeNull()
    expect(row.channel_id).toBe(generalChannelId)
  })

  // SMELL (locked): the ?to= filter is "directed to X OR broadcast" — asking
  // for one agent's mail also returns every broadcast. Deliberate in db.js
  // (to_agent = ? OR to_agent IS NULL) but surprising at the API surface.
  test('GET /messages?to=lucy also returns broadcasts (to_agent IS NULL rows)', async () => {
    const res = await admin(request(app).get('/api/mycelium/messages?to=lucy&from=echo'))
    expect(res.status).toBe(200)
    expect(res.body.some(m => m.id === broadcastId)).toBe(true)
  })

  test('POST /messages without content → 400; content over 100k chars → 400 max length', async () => {
    const noContent = await admin(request(app).post('/api/mycelium/messages')).send({ to: 'echo' })
    expect(noContent.status).toBe(400)
    expect(noContent.body.error).toBe('content is required')

    const tooLong = await admin(request(app).post('/api/mycelium/messages'))
      .send({ content: 'x'.repeat(100001) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toMatch(/exceeds max length/)
  })

  // SMELL (locked): msg_type is NOT validated — any string is stored verbatim.
  test('msg_type accepts arbitrary strings (no enum validation)', async () => {
    const res = await admin(request(app).post('/api/mycelium/messages'))
      .set('X-Acting-As', 'm5max')
      .send({ to: 'echo', content: 'weird type', msg_type: 'banana' })
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/messages?msg_type=banana'))
    expect(list.body.some(m => m.id === res.body.id)).toBe(true)
  })

  test('invalid priority is silently coerced to normal (no 400)', async () => {
    const res = await admin(request(app).post('/api/mycelium/messages'))
      .set('X-Acting-As', 'm5max')
      .send({ to: 'echo', content: 'prio check', priority: 'apocalyptic' })
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/messages?from=m5max'))
    expect(list.body.find(m => m.id === res.body.id).priority).toBe('normal')
  })

  test('msg_type=info round-trips via the msg_type filter', async () => {
    const res = await admin(request(app).post('/api/mycelium/messages'))
      .set('X-Acting-As', 'm5max')
      .send({ content: 'fyi everyone', msg_type: 'info' })
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/messages?msg_type=info'))
    expect(list.body.some(m => m.id === res.body.id)).toBe(true)
  })

  // SMELL (locked): the recipient is never validated — messaging a non-existent
  // agent succeeds AND mints a DM channel for the ghost.
  test('messaging a non-existent agent succeeds and auto-creates a ghost DM channel', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'ghost', content: 'anyone there?' })
    expect(res.status).toBe(200)
    const chans = await admin(request(app).get('/api/mycelium/channels?member=ghost'))
    expect(chans.body.some(c => c.slug === 'dm-ghost-lucy')).toBe(true)
  })

  test('msg_type=request lucy→echo lands in echo\'s operator (hijack) inbox as urgent', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: 'please verify the build output for me', msg_type: 'request' })
    expect(res.status).toBe(200)
    requestId = res.body.id

    const inbox = await admin(request(app).get('/api/mycelium/inbox?operator_id=hijack'))
    const item = inbox.body.find(i => i.data && i.data.message_id === requestId)
    expect(item).toBeTruthy()
    expect(item.type).toBe('message')
    expect(item.entity_type).toBe('message')
    expect(item.priority).toBe('urgent')
    expect(item.title).toBe('Request from lucy')
    expect(item.data.msg_type).toBe('request')
  })

  // SMELL (locked): a request sent through POST /messages keeps the schema
  // default status 'sent', while POST /requests (createRequest) explicitly
  // writes status 'pending'. Same msg_type, two different initial statuses —
  // consumers filtering on status=pending will MISS requests sent this way
  // (db.js listPendingRequests tolerates both; API status filters don't).
  test('a request via POST /messages has status sent, NOT pending', async () => {
    const pending = await admin(request(app).get('/api/mycelium/messages?msg_type=request&status=pending'))
    expect(pending.body.some(m => m.id === requestId)).toBe(false)
    const sent = await admin(request(app).get('/api/mycelium/messages?msg_type=request&status=sent'))
    expect(sent.body.some(m => m.id === requestId)).toBe(true)
  })

  test('plain agents cannot send directives → 403 (privilege from auth, not body)', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: 'do it now', msg_type: 'directive', from: '__admin__' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only admin or operators can send directives')
  })

  test('admin-key directive → 200 and fans out to EVERY active operator inbox', async () => {
    const res = await admin(request(app).post('/api/mycelium/messages'))
      .set('X-Acting-As', 'm5max')
      .send({ to: 'lucy', content: 'ship the release branch', msg_type: 'directive' })
    expect(res.status).toBe(200)
    for (const op of ['greatness', 'hijack']) {
      const inbox = await admin(request(app).get(`/api/mycelium/inbox?operator_id=${op}`))
      expect(inbox.body.some(i => i.title === 'Directive from m5max' && i.priority === 'urgent')).toBe(true)
    }
  })

  test('operator-ROLE agents may send directives', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', adaKey)
      .send({ to: 'lucy', content: 'planning directive', msg_type: 'directive' })
    expect(res.status).toBe(200)
  })

  // SMELL (locked): the @mention regex (@[a-z0-9_-]+) has no word-boundary or
  // existence check: (a) inbox rows are written for operators that don't exist
  // (operator_inbox.operator_id has NO foreign key, so the "operator may not
  // exist" try/catch never actually fires), and (b) email addresses in the
  // content false-positive — foo@example.com mints a mention for "example".
  test('@mentions create inbox items — including for NON-EXISTENT operators and email-address false positives', async () => {
    const res = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: 'hey @hijack and @hijack again — mail foo@example.com' })
    expect(res.status).toBe(200)
    const msgId = res.body.id

    // Real operator: exactly ONE mention row despite two @hijack (de-duped per message)
    const hijackInbox = await admin(request(app).get('/api/mycelium/inbox?operator_id=hijack&type=mention'))
    const mentions = hijackInbox.body.filter(i => i.data && i.data.message_id === msgId)
    expect(mentions.length).toBe(1)
    expect(mentions[0].title).toBe('lucy mentioned you')

    // Email false positive: orphan inbox row for operator "example" (does not exist)
    const ghostInbox = await admin(request(app).get('/api/mycelium/inbox?operator_id=example&type=mention'))
    expect(ghostInbox.body.some(i => i.data && i.data.message_id === msgId)).toBe(true)
  })

  // SMELL (locked): ack has no msg_type check (PUT /requests/:id validates
  // msg_type === 'request'; this route doesn't) and no ownership check — any
  // authenticated party can ack anyone's plain message.
  test('PUT /messages/:id/ack works on a PLAIN message from an unrelated agent', async () => {
    const res = await request(app).put(`/api/mycelium/messages/${directedId}/ack`)
      .set('X-Agent-Key', adaKey) // ada is neither sender nor recipient
      .send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: directedId, status: 'acknowledged' })
    const list = await admin(request(app).get('/api/mycelium/messages?from=lucy&status=acknowledged'))
    expect(list.body.some(m => m.id === directedId)).toBe(true)
  })

  test('ack/resolve on unknown or non-numeric id → 404', async () => {
    expect((await admin(request(app).put('/api/mycelium/messages/999999/ack')).send({})).status).toBe(404)
    expect((await admin(request(app).put('/api/mycelium/messages/abc/resolve')).send({})).status).toBe(404)
  })

  test('PUT /messages/:id/resolve by the recipient with a response → resolved + reply message created', async () => {
    const send = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: 'resolve me with an answer', thread_id: 't-beta' })
    resolveMeId = send.body.id

    const res = await request(app).put(`/api/mycelium/messages/${resolveMeId}/resolve`)
      .set('X-Agent-Key', echoKey)
      .send({ response: 'done, all green' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe('resolved')
    expect(res.body.response_id).toBeGreaterThan(resolveMeId)
    responseId = res.body.response_id

    const resolved = await admin(request(app).get('/api/mycelium/messages?from=lucy&status=resolved'))
    const row = resolved.body.find(m => m.id === resolveMeId)
    expect(row.resolved_by).toBe('echo')
    expect(row.resolved_at).toBeTruthy()

    // The reply inherits the original's thread and flows echo→lucy
    const replies = await admin(request(app).get('/api/mycelium/messages?from=echo&thread=t-beta'))
    const reply = replies.body.find(m => m.id === responseId)
    expect(reply).toBeTruthy()
    expect(reply.to_agent).toBe('lucy')
    expect(reply.content).toBe('done, all green')
  })

  test('resolve via bare admin key (no X-Acting-As) substitutes the message\'s to_agent as resolver', async () => {
    const send = await request(app).post('/api/mycelium/messages')
      .set('X-Agent-Key', lucyKey)
      .send({ to: 'echo', content: 'system will resolve this' })
    sysResolveId = send.body.id

    const res = await admin(request(app).put(`/api/mycelium/messages/${sysResolveId}/resolve`)).send({})
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/messages?from=lucy&status=resolved'))
    expect(list.body.find(m => m.id === sysResolveId).resolved_by).toBe('echo') // NOT '__system__'
  })

  test('GET /messages/threads aggregates by thread_id (reply counted into its thread)', async () => {
    const res = await admin(request(app).get('/api/mycelium/messages/threads'))
    expect(res.status).toBe(200)
    const tAlpha = res.body.find(t => t.thread_id === 't-alpha')
    const tBeta = res.body.find(t => t.thread_id === 't-beta')
    expect(tAlpha.message_count).toBe(1)
    expect(tBeta.message_count).toBe(2) // original + resolve-response
    expect(tBeta.last_message_at).toBeTruthy()
  })

  // LOCKED: __system__→__system__ telemetry is accepted (200) but permanently
  // invisible via GET /messages — listMessages supports include_system but the
  // route never maps it from the query string (dead filter). Same for
  // ?priority= and priority_sort: they exist in db.js listMessages but are
  // unreachable from the HTTP surface.
  test('system→system telemetry is stored but never listed (include_system is not exposed)', async () => {
    const res = await admin(request(app).post('/api/mycelium/messages'))
      .send({ to: '__system__', content: 'runner health ping' })
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/messages?from=__system__&to=__system__&limit=500'))
    expect(list.body.some(m => m.id === res.body.id)).toBe(false)
  })

  test('GET /messages?limit=1 caps the page', async () => {
    const res = await admin(request(app).get('/api/mycelium/messages?limit=1'))
    expect(res.body.length).toBe(1)
  })

  test('DELETE /messages/bulk without any filter → 400', async () => {
    const res = await admin(request(app).delete('/api/mycelium/messages/bulk'))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least one filter/)
  })

  test('DELETE /messages/bulk?from= deletes matching rows and reports the count', async () => {
    await admin(request(app).post('/api/mycelium/messages')).set('X-Acting-As', 'cleanup-bot').send({ content: 'junk 1' })
    await admin(request(app).post('/api/mycelium/messages')).set('X-Acting-As', 'cleanup-bot').send({ content: 'junk 2' })
    const res = await admin(request(app).delete('/api/mycelium/messages/bulk?from=cleanup-bot'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 2 })
  })
})

// ---------------------------------------------------------------------------
// CHANNELS — CRUD, membership, channel messages, DM privacy, read tracking
// ---------------------------------------------------------------------------

describe('channels', () => {
  let opsChannelId
  let opsMessageId
  let dmChannelId // lucy↔echo DM from the messages tests

  test('initDB seeds the protected #general and #admin channels as active', async () => {
    const res = await admin(request(app).get('/api/mycelium/channels'))
    expect(res.status).toBe(200)
    const slugs = res.body.map(c => c.slug)
    expect(slugs).toContain('general')
    expect(slugs).toContain('admin')
    expect(res.body.find(c => c.slug === 'general').status).toBe('active')
  })

  test('POST /channels without name or slug → 400', async () => {
    const res = await admin(request(app).post('/api/mycelium/channels')).send({ name: 'No Slug' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('name and slug are required')
  })

  // NOTE (locked): the creator is NOT auto-added as a member — only the
  // explicit members array is. Channel name IS html-escaped on write.
  test('POST /channels creates a channel with explicit members; name escaped, creator not a member', async () => {
    const res = await admin(request(app).post('/api/mycelium/channels'))
      .set('X-Acting-As', 'm5max')
      .send({ name: '<Ops> Room', slug: 'ops', description: 'ops chatter', members: [{ user_id: 'lucy' }] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.name).toBe('&lt;Ops&gt; Room') // escaped on write
    opsChannelId = res.body.id

    const detail = await admin(request(app).get(`/api/mycelium/channels/${opsChannelId}`))
    expect(detail.status).toBe(200)
    expect(detail.body.member_count).toBe(1)
    expect(detail.body.members[0]).toMatchObject({ user_id: 'lucy', user_type: 'agent', role: 'member' })
    expect(detail.body.created_by).toBe('m5max')
  })

  test('duplicate slug → 409 with the existing channel_id', async () => {
    const res = await admin(request(app).post('/api/mycelium/channels'))
      .send({ name: 'Ops Again', slug: 'ops' })
    expect(res.status).toBe(409)
    expect(res.body.channel_id).toBe(opsChannelId)
  })

  test('GET /channels/:id on unknown id → 404', async () => {
    const res = await admin(request(app).get('/api/mycelium/channels/999999'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Channel not found')
  })

  // NOTE (locked): re-adding an existing member is a 200 with added:false
  // (INSERT failure swallowed), not a conflict error.
  test('POST /channels/:id/members adds a member; duplicate add returns ok with added:false', async () => {
    const add = await admin(request(app).post(`/api/mycelium/channels/${opsChannelId}/members`))
      .send({ user_id: 'echo' })
    expect(add.status).toBe(200)
    expect(add.body.added).toBe(true)
    const dup = await admin(request(app).post(`/api/mycelium/channels/${opsChannelId}/members`))
      .send({ user_id: 'echo' })
    expect(dup.status).toBe(200)
    expect(dup.body.added).toBe(false)
  })

  test('POST /channels/:id/messages posts (content raw, not escaped); missing content → 400; bad channel → 404', async () => {
    const missing = await request(app).post(`/api/mycelium/channels/${opsChannelId}/messages`)
      .set('X-Agent-Key', lucyKey).send({})
    expect(missing.status).toBe(400)

    const notFound = await request(app).post('/api/mycelium/channels/999999/messages')
      .set('X-Agent-Key', lucyKey).send({ content: 'hi' })
    expect(notFound.status).toBe(404)

    const res = await request(app).post(`/api/mycelium/channels/${opsChannelId}/messages`)
      .set('X-Agent-Key', lucyKey)
      .send({ content: '<i>channel</i> post' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: res.body.id, channel_id: opsChannelId })
    opsMessageId = res.body.id

    const msgs = await request(app).get(`/api/mycelium/channels/${opsChannelId}/messages`)
      .set('X-Agent-Key', echoKey)
    const row = msgs.body.find(m => m.id === opsMessageId)
    expect(row.content).toBe('<i>channel</i> post') // raw — same no-escape smell as POST /messages
    expect(row.from_agent).toBe('lucy')
    expect(row.msg_type).toBe('message')
  })

  test('GET /channels/:id/messages?after= returns only newer messages', async () => {
    const second = await request(app).post(`/api/mycelium/channels/${opsChannelId}/messages`)
      .set('X-Agent-Key', echoKey).send({ content: 'second post' })
    const res = await request(app)
      .get(`/api/mycelium/channels/${opsChannelId}/messages?after=${opsMessageId}`)
      .set('X-Agent-Key', lucyKey)
    expect(res.body.map(m => m.id)).toEqual([second.body.id])
  })

  test('DM privacy: non-members get 403 on read AND post; __system__ (bare admin key) bypasses', async () => {
    const chans = await admin(request(app).get('/api/mycelium/channels?member=lucy'))
    dmChannelId = chans.body.find(c => c.slug === 'dm-echo-lucy').id

    const asAda = await request(app).get(`/api/mycelium/channels/${dmChannelId}/messages`)
      .set('X-Agent-Key', adaKey)
    expect(asAda.status).toBe(403)
    expect(asAda.body.error).toBe('Access denied')

    const postAsAda = await request(app).post(`/api/mycelium/channels/${dmChannelId}/messages`)
      .set('X-Agent-Key', adaKey).send({ content: 'let me in' })
    expect(postAsAda.status).toBe(403)

    const asMember = await request(app).get(`/api/mycelium/channels/${dmChannelId}/messages`)
      .set('X-Agent-Key', echoKey)
    expect(asMember.status).toBe(200)
    expect(asMember.body.length).toBeGreaterThan(0)

    // Bare admin key authenticates as '__system__', which skips the member check
    const asSystem = await admin(request(app).get(`/api/mycelium/channels/${dmChannelId}/messages`))
    expect(asSystem.status).toBe(200)
  })

  // NOTE (locked): DM hiding in the LIST depends on the caller's display
  // identity: an admin key WITH X-Acting-As is subject to membership filtering,
  // while the bare admin key (__system__) sees every DM.
  test('GET /channels hides other people\'s DMs from named callers but not from __system__', async () => {
    // ada sees her OWN DM (dm-ada-lucy, auto-created by her directive to lucy)
    // but not lucy↔echo's
    const asAda = await request(app).get('/api/mycelium/channels').set('X-Agent-Key', adaKey)
    expect(asAda.body.some(c => c.slug === 'dm-ada-lucy')).toBe(true)
    expect(asAda.body.some(c => c.slug === 'dm-echo-lucy')).toBe(false)
    // an admin key WITH X-Acting-As is subject to the same membership filter
    const asNamedAdmin = await admin(request(app).get('/api/mycelium/channels')).set('X-Acting-As', 'stranger')
    expect(asNamedAdmin.body.some(c => c.type === 'dm')).toBe(false)
    // the bare admin key (__system__) sees every DM
    const asSystem = await admin(request(app).get('/api/mycelium/channels'))
    expect(asSystem.body.some(c => c.slug === 'dm-echo-lucy')).toBe(true)
  })

  test('POST /channels/dm is idempotent — same pair returns the same channel', async () => {
    const first = await request(app).post('/api/mycelium/channels/dm')
      .set('X-Agent-Key', lucyKey)
      .send({ user_id: 'greatness', user_type: 'operator' })
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.channel.type).toBe('dm')
    const again = await request(app).post('/api/mycelium/channels/dm')
      .set('X-Agent-Key', lucyKey)
      .send({ user_id: 'greatness', user_type: 'operator' })
    expect(again.body.channel_id).toBe(first.body.channel_id)
  })

  test('PUT /channels/:id/read without message_id marks read up to the latest message', async () => {
    const res = await request(app).put(`/api/mycelium/channels/${opsChannelId}/read`)
      .set('X-Agent-Key', lucyKey).send({})
    expect(res.status).toBe(200)
    expect(res.body.channel_id).toBe(opsChannelId)
    // latest ops message is echo's 'second post' (id > opsMessageId)
    expect(res.body.last_read_message_id).toBeGreaterThan(opsMessageId)

    const unread = await request(app).get('/api/mycelium/channels/unread').set('X-Agent-Key', lucyKey)
    expect(unread.status).toBe(200)
    // Shape: object keyed by channel_id → { name, slug, unread }
    expect(unread.body[String(opsChannelId)]).toMatchObject({ slug: 'ops', unread: 0 })
    expect(unread.body[String(generalChannelId)].slug).toBe('general')
  })

  test('PUT /channels/:id with an invalid status → machine-readable 400 (code invalid_enum)', async () => {
    const res = await admin(request(app).put(`/api/mycelium/channels/${opsChannelId}`))
      .send({ status: 'zombie' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      code: 'invalid_enum',
      field: 'status',
      value: 'zombie',
      allowed: ['active', 'archived']
    })
  })

  test('archived channels are hidden by default, visible via ?status=all', async () => {
    const mk = await admin(request(app).post('/api/mycelium/channels'))
      .send({ name: 'Archy', slug: 'archy' })
    const archived = await admin(request(app).put(`/api/mycelium/channels/${mk.body.id}`))
      .send({ status: 'archived' })
    expect(archived.status).toBe(200)

    const def = await admin(request(app).get('/api/mycelium/channels'))
    expect(def.body.some(c => c.slug === 'archy')).toBe(false)
    const all = await admin(request(app).get('/api/mycelium/channels?status=all'))
    expect(all.body.some(c => c.slug === 'archy')).toBe(true)
  })

  test('DELETE /channels/:id: protected slugs 403; agents 403; admin deletes normal channels', async () => {
    const protectedRes = await admin(request(app).delete(`/api/mycelium/channels/${generalChannelId}`))
    expect(protectedRes.status).toBe(403)
    expect(protectedRes.body.error).toBe('Cannot delete protected channel')

    const asAgent = await request(app).delete(`/api/mycelium/channels/${opsChannelId}`)
      .set('X-Agent-Key', lucyKey)
    expect(asAgent.status).toBe(403) // findings-§1 fix: authenticated agent, not authorized

    const ok = await admin(request(app).delete(`/api/mycelium/channels/${opsChannelId}`))
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true, deleted: opsChannelId })
    expect((await admin(request(app).get(`/api/mycelium/channels/${opsChannelId}`))).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// INBOX — operator notification aggregation
// ---------------------------------------------------------------------------

describe('operator inbox', () => {
  let itemId // normal-priority item for greatness

  test('POST /inbox (admin) creates an item; GET /inbox/:id returns it with data PARSED to an object', async () => {
    const res = await admin(request(app).post('/api/mycelium/inbox'))
      .send({ operator_id: 'greatness', type: 'message', entity_type: 'task', entity_id: '42', title: 'Check task 42', summary: 'needs eyes', data: { task_id: 42 } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    itemId = res.body.id

    const item = await admin(request(app).get(`/api/mycelium/inbox/${itemId}`))
    expect(item.status).toBe(200)
    expect(item.body.status).toBe('unread')
    expect(item.body.priority).toBe('normal')
    expect(item.body.data).toEqual({ task_id: 42 }) // parsed, not the raw JSON string
  })

  test('POST /inbox with all_operators:true fans out to every active operator', async () => {
    const res = await admin(request(app).post('/api/mycelium/inbox'))
      .send({ all_operators: true, title: 'Fan out', summary: 'to everyone' })
    expect(res.status).toBe(200)
    expect(res.body.ids.length).toBe(2) // greatness + hijack
  })

  test('POST /inbox with neither operator_id nor all_operators → 400', async () => {
    const res = await admin(request(app).post('/api/mycelium/inbox')).send({ title: 'nobody' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('operator_id or all_operators required')
  })

  test('GET /inbox?operator_id= lists items urgent-first with parsed data', async () => {
    const res = await admin(request(app).get('/api/mycelium/inbox?operator_id=greatness'))
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(1)
    expect(res.body.every(i => typeof i.data === 'object')).toBe(true)
    // Directive items from the messages tests are urgent → they sort before our normal item
    expect(res.body[0].priority).toBe('urgent')
    const urgentIdx = res.body.findIndex(i => i.priority === 'urgent')
    const normalIdx = res.body.findIndex(i => i.id === itemId)
    expect(urgentIdx).toBeLessThan(normalIdx)
  })

  test('a studio JWT resolves to its linked operator (no operator_id needed)', async () => {
    const viaJwt = await request(app).get('/api/mycelium/inbox')
      .set('Authorization', 'Bearer ' + gilbertToken)
    const viaQuery = await admin(request(app).get('/api/mycelium/inbox?operator_id=greatness'))
    expect(viaJwt.status).toBe(200)
    expect(viaJwt.body.map(i => i.id)).toEqual(viaQuery.body.map(i => i.id))
  })

  test('a studio JWT with NO linked operator → 404', async () => {
    const res = await request(app).get('/api/mycelium/inbox')
      .set('Authorization', 'Bearer ' + hanaToken)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('No operator linked to this account')
  })

  test('admin key without operator_id → 400 (admin has no implicit inbox)', async () => {
    const res = await admin(request(app).get('/api/mycelium/inbox'))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('operator_id is required')
  })

  // NOTE (locked): the count endpoint is shape-polymorphic — an object for one
  // operator, an ARRAY of {operator_id, count} rows when unscoped.
  test('GET /inbox/count: per-operator object vs unscoped array (different shapes)', async () => {
    const one = await admin(request(app).get('/api/mycelium/inbox/count?operator_id=greatness'))
    expect(one.body.operator_id).toBe('greatness')
    expect(one.body.unread).toBeGreaterThan(0)
    expect(one.body.count).toBe(one.body.unread)

    const all = await admin(request(app).get('/api/mycelium/inbox/count'))
    expect(Array.isArray(all.body)).toBe(true)
    expect(all.body.find(r => r.operator_id === 'greatness').count).toBeGreaterThan(0)
  })

  // NOTE (locked): read only transitions unread→read; once actioned, marking
  // read is a silent no-op (status stays actioned). All three return bare {ok:true}.
  test('read/action lifecycle: unread→read→actioned; read-after-actioned is a no-op', async () => {
    const read = await admin(request(app).put(`/api/mycelium/inbox/${itemId}/read`)).send({})
    expect(read.body).toEqual({ ok: true })
    let item = await admin(request(app).get(`/api/mycelium/inbox/${itemId}`))
    expect(item.body.status).toBe('read')
    expect(item.body.read_at).toBeTruthy()

    await admin(request(app).put(`/api/mycelium/inbox/${itemId}/action`)).send({})
    item = await admin(request(app).get(`/api/mycelium/inbox/${itemId}`))
    expect(item.body.status).toBe('actioned')

    await admin(request(app).put(`/api/mycelium/inbox/${itemId}/read`)).send({})
    item = await admin(request(app).get(`/api/mycelium/inbox/${itemId}`))
    expect(item.body.status).toBe('actioned') // unchanged
  })

  test('DELETE /inbox/:id dismisses: hidden from the default list, visible via ?status=dismissed', async () => {
    const del = await admin(request(app).delete(`/api/mycelium/inbox/${itemId}`))
    expect(del.body).toEqual({ ok: true })
    const def = await admin(request(app).get('/api/mycelium/inbox?operator_id=greatness'))
    expect(def.body.some(i => i.id === itemId)).toBe(false)
    const dismissed = await admin(request(app).get('/api/mycelium/inbox?operator_id=greatness&status=dismissed'))
    expect(dismissed.body.some(i => i.id === itemId)).toBe(true)
  })

  test('inbox 404s: unknown id on GET / PUT read / DELETE', async () => {
    expect((await admin(request(app).get('/api/mycelium/inbox/999999'))).status).toBe(404)
    expect((await admin(request(app).put('/api/mycelium/inbox/999999/read')).send({})).status).toBe(404)
    expect((await admin(request(app).delete('/api/mycelium/inbox/999999'))).status).toBe(404)
  })

  test('POST /inbox/bulk-dismiss: ids array; neither ids nor all → 400', async () => {
    const a = await admin(request(app).post('/api/mycelium/inbox')).send({ operator_id: 'hijack', title: 'bulk-a' })
    const b = await admin(request(app).post('/api/mycelium/inbox')).send({ operator_id: 'hijack', title: 'bulk-b' })
    const res = await admin(request(app).post('/api/mycelium/inbox/bulk-dismiss'))
      .send({ ids: [a.body.id, b.body.id] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, dismissed: 2 })

    const bad = await admin(request(app).post('/api/mycelium/inbox/bulk-dismiss')).send({})
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('ids array or all=true required')
  })

  test('POST /inbox/bulk-dismiss all:true clears an operator\'s remaining items', async () => {
    const res = await admin(request(app).post('/api/mycelium/inbox/bulk-dismiss'))
      .send({ all: true, operator_id: 'hijack' })
    expect(res.status).toBe(200)
    expect(res.body.dismissed).toBeGreaterThan(0)
    const count = await admin(request(app).get('/api/mycelium/inbox/count?operator_id=hijack'))
    expect(count.body.unread).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EVENTS — emit + list (the SSE happy path is not exercisable under supertest)
// ---------------------------------------------------------------------------

describe('events', () => {
  test('POST /events → {id}; summary IS html-escaped on write; data round-trips as a JSON string', async () => {
    const res = await request(app).post('/api/mycelium/events')
      .set('X-Agent-Key', lucyKey)
      .send({ type: 'demo_event', summary: '<b>demo</b> summary', data: { x: 1 }, project_id: 'proj-test' })
    expect(res.status).toBe(200)
    expect(typeof res.body.id).toBe('number')

    const list = await admin(request(app).get('/api/mycelium/events?type=demo_event'))
    const row = list.body.find(e => e.id === res.body.id)
    expect(row.summary).toBe('&lt;b&gt;demo&lt;/b&gt; summary')
    expect(row.agent).toBe('lucy')
    expect(row.project_id).toBe('proj-test')
    expect(row.data).toBe('{"x":1}') // string, not parsed
  })

  test('POST /events with no type defaults to custom', async () => {
    const res = await request(app).post('/api/mycelium/events')
      .set('X-Agent-Key', echoKey)
      .send({ summary: 'typeless' })
    expect(res.status).toBe(200)
    const list = await admin(request(app).get('/api/mycelium/events?type=custom&agent=echo'))
    expect(list.body.some(e => e.id === res.body.id)).toBe(true)
  })

  test('message activity emitted message_sent events as a side effect', async () => {
    const res = await admin(request(app).get('/api/mycelium/events?type=message_sent'))
    expect(res.body.length).toBeGreaterThan(0)
    expect(res.body.some(e => e.summary.includes('(broadcast)'))).toBe(true)
  })

  test('GET /events filters: ?agent=, ?search=, ?limit=', async () => {
    const byAgent = await admin(request(app).get('/api/mycelium/events?agent=lucy'))
    expect(byAgent.body.length).toBeGreaterThan(0)
    expect(byAgent.body.every(e => e.agent === 'lucy')).toBe(true)

    const bySearch = await admin(request(app).get('/api/mycelium/events?search=demo_event'))
    expect(bySearch.body.some(e => e.type === 'demo_event')).toBe(true)

    const limited = await admin(request(app).get('/api/mycelium/events?limit=1'))
    expect(limited.body.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// TEAM CHAT — human-only layer stored in the same messages table (msg_type=chat)
// ---------------------------------------------------------------------------

describe('team chat', () => {
  // ASYMMETRY (locked): the admin KEY may read team chat but may NOT post —
  // posting demands a studio JWT specifically.
  test('admin key can GET but not POST', async () => {
    const get = await admin(request(app).get('/api/mycelium/team-chat'))
    expect(get.status).toBe(200)
    expect(Array.isArray(get.body)).toBe(true)

    const post = await admin(request(app).post('/api/mycelium/team-chat')).send({ content: 'hi from key' })
    expect(post.status).toBe(403)
    expect(post.body.error).toBe('Studio login required')
  })

  test('POST with a studio JWT: content trimmed + escaped, sender prefixed __user:<displayName>', async () => {
    const res = await request(app).post('/api/mycelium/team-chat')
      .set('Authorization', 'Bearer ' + hanaToken)
      .send({ content: '  <i>hello team</i>  ' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const list = await request(app).get('/api/mycelium/team-chat')
      .set('Authorization', 'Bearer ' + hanaToken)
    const row = list.body.find(m => m.id === res.body.id)
    expect(row.from_agent).toBe('__user:Hana')
    expect(row.content).toBe('&lt;i&gt;hello team&lt;/i&gt;') // trimmed then escaped
    expect(row.msg_type).toBe('chat')
    expect(row.to_agent).toBeNull()
  })

  test('whitespace-only content → 400', async () => {
    const res = await request(app).post('/api/mycelium/team-chat')
      .set('Authorization', 'Bearer ' + hanaToken)
      .send({ content: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('content is required')
  })

  test('chat rows never leak into GET /messages (msg_type=chat is excluded there)', async () => {
    const msgs = await admin(request(app).get('/api/mycelium/messages?limit=500'))
    expect(msgs.body.some(m => m.msg_type === 'chat')).toBe(false)
    // and asking for them explicitly by filter ALSO returns nothing — the
    // base WHERE clause excludes chat before the msg_type filter applies
    const filtered = await admin(request(app).get('/api/mycelium/messages?msg_type=chat'))
    expect(filtered.body).toEqual([])
  })
})
