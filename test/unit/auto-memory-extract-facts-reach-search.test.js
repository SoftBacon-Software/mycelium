import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js'
import createMemoryDB from '../../server/plugins/semantic-memory/db.js'
import { extractFacts } from '../../server/plugins/auto-memory/routes.js'

// F-mycelium 252 — extracted facts must reach the SEARCHABLE index.
//
// Defect: extractFacts receives the auto-memory WRAPPER (createAutoMemoryDB)
// but handed it straight to indexFactInMemory, which needs the RAW core db
// (.prepare). The wrapper has no .prepare → the call threw, was swallowed as
// "non-critical", and the {indexed:false} status was discarded — every
// extracted fact landed in am_facts but NEVER in sm_embeddings: written but
// invisible to /memory/search (MEMORY-FAILURE-STATES §F4, the exact state the
// honesty surface exists to prevent, reached through the extraction path).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AM_SCHEMA = readFileSync(path.join(__dirname, '../../server/plugins/auto-memory/schema.sql'), 'utf8')
const SM_SCHEMA = readFileSync(path.join(__dirname, '../../server/plugins/semantic-memory/schema.sql'), 'utf8')

const realFetch = global.fetch
// callLLM (provider ollama) hits localhost:11434 — intercept ONLY that.
function mockOllama(responder) {
  return function (url, opts) {
    if (String(url).indexOf('11434') !== -1) return Promise.resolve(responder())
    return realFetch(url, opts)
  }
}

const LLM_CONFIG = { llm_provider: 'ollama', llm_url: 'http://localhost:11434', llm_model: 'x' }
const FACT_TEXT = 'the deploy pipeline gates on two frontier reviews that converge before any merge'
const LLM_BODY = JSON.stringify({ response: JSON.stringify({ facts: [{ category: 'convention', fact_text: FACT_TEXT, confidence: 0.9 }] }) })

describe('auto-memory: extracted facts reach the searchable index (F-mycelium 252)', () => {
  let raw, db, mem
  beforeEach(() => {
    raw = new Database(':memory:')
    raw.exec(AM_SCHEMA)
    raw.exec(SM_SCHEMA)
    db = createAutoMemoryDB(raw)
    mem = createMemoryDB(raw)
  })
  afterEach(() => { raw.close() })

  test('an extracted fact lands in sm_embeddings AND is keyword-searchable', async () => {
    const orig = global.fetch
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(LLM_BODY) }))
    try {
      const created = await extractFacts(db, LLM_CONFIG,
        'Activity log with a durable convention worth keeping: ' + FACT_TEXT, 'm5max', null)
      expect(created.length).toBe(1)

      // 1. the index row exists (review B observed: row absent, search 0 hits)
      const row = raw.prepare(
        "SELECT content_text, written_by FROM sm_embeddings WHERE source_type = 'memory' AND source_id = ?"
      ).get(String(created[0].id))
      expect(row, 'extracted fact must reach sm_embeddings').toBeTruthy()
      expect(row.content_text).toBe(FACT_TEXT)

      // 2. the defect was user-visible through SEARCH — the same probe that
      // returned 0 hits on master must now recall the fact.
      const hits = mem.searchKeyword('frontier reviews converge')
      expect(hits.some((h) => h.source_type === 'memory' && String(h.id) === String(created[0].id)),
        'the extracted fact must be keyword-searchable').toBe(true)
    } finally {
      global.fetch = orig
    }
  })

  test('when the index write fails, the fact response SAYS so (no silent swallow)', async () => {
    // No SM_SCHEMA → sm_embeddings does not exist → the index write cannot
    // land. §F4 honesty: the caller must be able to tell "indexed" from
    // "written but not searchable" — the status object used to be discarded.
    const rawNoSm = new Database(':memory:')
    rawNoSm.exec(AM_SCHEMA)
    const dbNoSm = createAutoMemoryDB(rawNoSm)
    try {
      const orig = global.fetch
      global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(LLM_BODY) }))
      try {
        const created = await extractFacts(dbNoSm, LLM_CONFIG,
          'Activity log with a durable convention worth keeping: ' + FACT_TEXT, 'm5max', null)
        expect(created.length).toBe(1)
        expect(created[0].memory_index, 'each extracted fact carries its index status').toBeTruthy()
        expect(created[0].memory_index.indexed).toBe(false)
        expect(String(created[0].memory_index.reason).length).toBeGreaterThan(0)
      } finally {
        global.fetch = orig
      }
    } finally { rawNoSm.close() }
  })
})
