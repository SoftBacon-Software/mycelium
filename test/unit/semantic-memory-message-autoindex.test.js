import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import createMemoryDB from '../../server/plugins/semantic-memory/db.js'
import { registerHooks } from '../../server/plugins/semantic-memory/handlers.js'
import { stopBootDrain } from '../../server/plugins/semantic-memory/boot-drain.js'

// F-mycelium 252 — agent messages were never auto-indexed.
//
// Defect (review B, observed live on a fresh DATA_DIR): this handler listened
// for 'message_created', but the server emits 'message_sent'
// (server/routes/messages.js — and that name is the platform's canonical one:
// schema.sql's default webhook events and dispatchWebhook both use it). Every
// agent message went unindexed. Worse, the event payload carries ONLY
// { message_id } — no content, no to_agent — so re-pointing the name alone
// would have indexed the summary display line ("X sent message to Y"), not
// the message.
//
// Trust guard (TRUST LAYER P1.3): agent-message auto-indexing is the widest
// memory-poisoning path the audit named — anything that can POST /messages
// would write straight into the recall corpus every agent's /memory/search
// reads. So the handler is gated behind auto_index_messages, which DEFAULTS
// OFF, and when opted in, rows land as LOW-TRUST CANDIDATES
// (metadata.candidate = true, sender custody) — visible, flagged, never
// silently trusted (the companion view already keeps candidate rows out of
// fact-of-record recall).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SM_SCHEMA = readFileSync(path.join(__dirname, '../../server/plugins/semantic-memory/schema.sql'), 'utf8')

// Only what the handler reads (same columns as server/schema.sql).
const MESSAGES_TABLE = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  thread_id TEXT,
  project_id TEXT,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  msg_type TEXT NOT NULL DEFAULT 'message',
  status TEXT NOT NULL DEFAULT 'sent',
  channel_id INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

const CONTENT = 'Qurio rollout decision: the memory grid reruns nightly and the winner takes the seat at noon'

function messageEvent(messageId) {
  // The exact shape emitEvent() broadcasts (server/routes/mycelium.js): the
  // payload data carries ONLY message_id — content lives on the messages row.
  return {
    id: messageId, type: 'message_sent', agent: 'lucy', project_id: null,
    summary: 'lucy sent message to echo', data: { message_id: messageId },
    created_at: new Date().toISOString()
  }
}

function indexedRow(raw, messageId) {
  return raw.prepare(
    "SELECT * FROM sm_embeddings WHERE source_type = 'message' AND source_id = ?"
  ).get(String(messageId))
}

describe('semantic-memory: agent messages auto-index (F-mycelium 252)', () => {
  let raw, mem, hooks, core

  beforeEach(() => {
    raw = new Database(':memory:')
    raw.exec(SM_SCHEMA)
    raw.exec(MESSAGES_TABLE)
    mem = createMemoryDB(raw)
    hooks = {}
    core = {
      db: raw,
      onEvent: function (type, fn) { (hooks[type] = hooks[type] || []).push(fn); },
      emitEvent: function () {}
    }
    registerHooks(core)
  })

  afterEach(() => {
    stopBootDrain()
    raw.close()
  })

  function insertMessage(from, to, content) {
    return raw.prepare(
      'INSERT INTO messages (from_agent, to_agent, project_id, content, msg_type) VALUES (?, ?, NULL, ?, ?) RETURNING id'
    ).get(from, to, content, 'message').id
  }

  test('with auto_index_messages=true, a message_sent event indexes the message CONTENT (not the summary line)', () => {
    mem.setConfig('auto_index_messages', 'true')
    const id = insertMessage('lucy', 'echo', CONTENT)

    expect(Array.isArray(hooks.message_sent) && hooks.message_sent.length > 0,
      "handler must subscribe to 'message_sent' — the name the server emits").toBe(true)
    for (const fn of hooks.message_sent) fn(messageEvent(id))

    const row = indexedRow(raw, id)
    expect(row, 'the message must reach sm_embeddings').toBeTruthy()
    expect(row.content_text).toBe(CONTENT)
    expect(row.content_text).not.toContain('sent message to')
  })

  test('DEFAULT IS OFF — without the opt-in, message events index nothing (the poisoning path stays closed)', () => {
    // auto_index_messages unset: the trust guard. On master this passed for
    // the wrong reason (the handler listened to a name nothing emits); the
    // test pins the DEFAULT, so re-opening the path needs a deliberate flag.
    const id = insertMessage('lucy', 'echo', CONTENT)
    for (const fn of (hooks.message_sent || [])) fn(messageEvent(id))
    expect(indexedRow(raw, id)).toBeUndefined()
  })

  test('when indexed, the row is a low-trust CANDIDATE owned by the sender', () => {
    mem.setConfig('auto_index_messages', 'true')
    const id = insertMessage('lucy', 'echo', CONTENT)
    for (const fn of hooks.message_sent) fn(messageEvent(id))

    const row = indexedRow(raw, id)
    expect(row).toBeTruthy()
    const meta = JSON.parse(row.metadata)
    expect(meta.candidate, 'auto-indexed speech is a candidate, never a fact of record').toBe(true)
    expect(meta.auto_indexed).toBe(true)
    expect(meta.from_agent).toBe('lucy')
    expect(row.written_by).toBe('lucy') // sender custody, server-forced
  })

  test('short messages and AUTO-DISPATCH system messages stay unindexed', () => {
    mem.setConfig('auto_index_messages', 'true')
    const shortId = insertMessage('lucy', 'echo', 'ok')
    const dispatchId = insertMessage('lucy', 'echo', 'AUTO-DISPATCH: workflow wave 3 claimed by lane K-kira and running now with gates')
    for (const fn of hooks.message_sent) { fn(messageEvent(shortId)); fn(messageEvent(dispatchId)) }
    expect(indexedRow(raw, shortId)).toBeUndefined()
    expect(indexedRow(raw, dispatchId)).toBeUndefined()
  })
})
