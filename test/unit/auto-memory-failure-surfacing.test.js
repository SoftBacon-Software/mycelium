import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import express from 'express'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js'
import createRoutes, { extractFacts } from '../../server/plugins/auto-memory/routes.js'

// Failure-state surfacing for auto-memory (MEMORY-FAILURE-STATES.md §F4–§F5):
//  §F4 — POST /facts must say whether the fact actually reached the searchable
//        index (and that it is keyword-only until a backfill, since the write
//        path stores a NULL embedding and there is no auto-memory embed worker).
//  §F5 — extractFacts must LOG LLM-outage failures to am_extraction_errors.
//        The /stats extraction_errors surface already existed but had a hole:
//        extractFacts swallowed the error and resolved with [], so the event
//        handlers' .catch + logExtractionError never fired → during a full
//        ollama outage, every extraction silently yielded 0 facts AND /stats
//        reported 0 errors.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AM_SCHEMA = readFileSync(path.join(__dirname, '../../server/plugins/auto-memory/schema.sql'), 'utf8')
const SM_SCHEMA = readFileSync(path.join(__dirname, '../../server/plugins/semantic-memory/schema.sql'), 'utf8')

// The LLM/embedding calls hit localhost:11434. Mocks must intercept ONLY those —
// otherwise they swallow the test's own HTTP calls to the server under test.
// (Same pattern as plugins/semantic-memory/test.js.) call() always uses realFetch.
const realFetch = global.fetch
const OLLAMA = '11434'
function mockOllama(responder) {
  return function (url, opts) {
    if (String(url).indexOf(OLLAMA) !== -1) return Promise.resolve(responder())
    return realFetch(url, opts)
  }
}

// Faithful-enough pluginCore for the auto-memory routes (same helper shapes the
// routes destructure). auth always passes — these tests aren't about auth.
function makeCore(raw) {
  return {
    db: raw,
    auth: {
      checkAgentOrAdmin: (_req, _res) => 'tester',
      checkAdmin: (_req, _res) => 'tester',
      getAdminDisplayName: () => 'tester'
    },
    apiError: (res, status, message, extra) => res.status(status).json(Object.assign({ error: message }, extra || {})),
    parseIntParam: (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n },
    emitEvent: () => {},
    onEvent: () => {},
    gatedActions: [],
    inbox: {}
  }
}

async function bootApp(raw) {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  // Mount the router at root so call paths match the route paths directly
  // (/facts, /extract) — the /auto-memory prefix is added by the plugin loader
  // in production, not by the routes themselves.
  app.use(createRoutes(makeCore(raw)))
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  return { base, close: () => server.close() }
}

async function call(base, method, p, body) {
  const res = await realFetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch (_) {}
  return { status: res.status, body: json }
}

function errCount(raw) {
  return raw.prepare('SELECT COUNT(*) AS c FROM am_extraction_errors').get().c
}

describe('auto-memory: failure-state surfacing (§F4 write-index status, §F5 extraction logging)', () => {
  let raw, db
  beforeEach(() => {
    raw = new Database(':memory:')
    raw.exec(AM_SCHEMA) // am_facts + am_extraction_errors + am_config + am_consolidation_log
    raw.exec(SM_SCHEMA) // sm_embeddings — present, so indexFactInMemory succeeds
    db = createAutoMemoryDB(raw)
  })
  afterEach(() => { raw.close() })

  test('§F5: extractFacts LOGS an LLM outage to am_extraction_errors (was swallowed → invisible)', async () => {
    // Pre-fix: extractFacts caught the fetch failure, console.error'd, returned [].
    // The handlers' .catch + logExtractionError never fired (extractFacts resolved,
    // it did not reject) → /stats reported 0 errors during a full outage.
    const orig = global.fetch
    global.fetch = mockOllama(() => ({ ok: false, status: 500, json: async () => ({}) })) // ollama 500
    try {
      const before = errCount(raw)
      const created = await extractFacts(
        db,
        { llm_provider: 'ollama', llm_url: 'http://localhost:11434', llm_model: 'x' },
        'A durable decision worth remembering across sessions about the build pipeline.',
        'm5max', null
      )
      expect(created).toEqual([])
      expect(errCount(raw)).toBe(before + 1, 'the outage is now logged, not swallowed')
      const row = raw.prepare('SELECT source_event, error_message FROM am_extraction_errors ORDER BY id DESC LIMIT 1').get()
      expect(row.source_event).toBe('extract')
      expect(row.error_message.length).toBeGreaterThan(0)
    } finally {
      global.fetch = orig
    }
  })

  test('§F5: extractFacts does NOT log when provider is "none" (a legitimate skip, not a failure)', async () => {
    const before = errCount(raw)
    await extractFacts(db, { llm_provider: 'none' }, 'some durable activity text here for extraction', 'm5max', null)
    expect(errCount(raw)).toBe(before, 'provider=none is expected, not an outage — stay silent')
  })

  test('§F5: extractFacts does NOT log a legitimate 0-fact extraction (would drown real signals)', async () => {
    // A valid JSON response with an empty facts array is "nothing durable here",
    // not a breakage. Logging every empty extraction would spam am_extraction_errors.
    const orig = global.fetch
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => ({ response: '{"facts":[]}' }) }))
    try {
      const before = errCount(raw)
      const created = await extractFacts(
        db,
        { llm_provider: 'ollama', llm_url: 'http://localhost:11434', llm_model: 'x' },
        'routine status update with no durable knowledge to extract at all', 'm5max', null
      )
      expect(created).toEqual([])
      expect(errCount(raw)).toBe(before, 'legitimate 0-fact extraction is not an error')
    } finally {
      global.fetch = orig
    }
  })

  test('§F5: POST /extract surfaces extraction_health when 0 facts come back (breakage vs nothing-to-extract)', async () => {
    db.setConfig('llm_provider', 'ollama')
    db.setConfig('llm_url', 'http://localhost:11434')
    db.setConfig('llm_model', 'x')
    const orig = global.fetch
    global.fetch = mockOllama(() => ({ ok: false, status: 500, json: async () => ({}) }))
    const { base, close } = await bootApp(raw)
    try {
      const r = await call(base, 'POST', '/extract', { text: 'durable decision text for an extraction attempt right now' })
      expect(r.status).toBe(200)
      expect(r.body.facts_extracted).toBe(0)
      expect(r.body.extraction_health, 'health surfaced so a 0-fact result is not a silent breakage').toBeDefined()
      expect(r.body.extraction_health.last_error, 'the outage is visible in the response').toBeTruthy()
      expect(r.body.extraction_health.last_error.message.length).toBeGreaterThan(0)
    } finally {
      global.fetch = orig
      close()
    }
  })

  test('§F4: POST /facts surfaces memory_index.indexed=true, embedded=false (vector pending backfill)', async () => {
    const { base, close } = await bootApp(raw)
    try {
      const r = await call(base, 'POST', '/facts', {
        fact_text: 'a durable decision about the indexing pipeline shape and scope',
        category: 'decision'
      })
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.memory_index, 'write-side index status is surfaced, not swallowed').toBeDefined()
      expect(r.body.memory_index.indexed).toBe(true)
      // indexFactInMemory stores a NULL embedding and there is no auto-memory embed
      // worker — the fact is keyword/FTS searchable now but NOT vector-searchable
      // until an admin runs /memory/reindex. Say so honestly.
      expect(r.body.memory_index.embedded).toBe(false)
      expect(r.body.memory_index.vector_search).toMatch(/backfill/)
    } finally {
      close()
    }
  })

  test('§F4: POST /facts surfaces memory_index.indexed=false when sm_embeddings is absent (semantic-memory not loaded)', async () => {
    raw.exec('DROP TABLE sm_embeddings') // simulate the semantic-memory plugin absent / schema drift
    const { base, close } = await bootApp(raw)
    try {
      const r = await call(base, 'POST', '/facts', {
        fact_text: 'another durable decision about memory hardening that should persist',
        category: 'decision'
      })
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true) // the fact still saved to am_facts
      expect(r.body.memory_index.indexed).toBe(false)
      expect(r.body.memory_index.reason, 'the caller learns the fact is NOT searchable').toBeTruthy()
    } finally {
      close()
    }
  })
})
