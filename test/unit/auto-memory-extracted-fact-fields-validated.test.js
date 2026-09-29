import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js'
import { extractFacts } from '../../server/plugins/auto-memory/routes.js'

// F-mycelium 254 — extracted fact fields are VALIDATED, not trusted.
//
// Defect (review B, PR #192 follow-up): extractFacts hands the model's fact
// objects straight into createFact and indexFactInMemory. `category` and
// `confidence` are RAW MODEL OUTPUT — the extraction prompt asks for one of
// (preference|decision|pattern|architecture|convention|insight) but nothing
// enforces it, confidence lands unclamped, and fact_text has no upper cap —
// yet all three ride into the am_facts row AND the sm_embeddings metadata
// that trust-weighted ranking (P1.6) will read. A model self-assessing
// confidence 1.0 (or 42, or −3) outranks verified facts; a hallucinated
// category pollutes every category-filtered view; an unbounded fact_text is
// an unbounded index row. Same family as PR #192's authority blocker: the
// row of record, not the model object, is what the index mirrors.

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
function llmBody(facts) {
  return JSON.stringify({ response: JSON.stringify({ facts }) })
}
const T = 'the deploy pipeline gates on two frontier reviews that converge before any merge' // >= 10 chars

function metaFor(raw, factId) {
  return JSON.parse(raw.prepare(
    "SELECT metadata FROM sm_embeddings WHERE source_type = 'memory' AND source_id = ?"
  ).get(String(factId)).metadata)
}

describe('auto-memory: extracted fact fields are validated, not trusted (F-mycelium 254)', () => {
  let raw, db
  beforeEach(() => {
    raw = new Database(':memory:')
    raw.exec(AM_SCHEMA)
    raw.exec(SM_SCHEMA)
    db = createAutoMemoryDB(raw)
  })
  afterEach(() => { raw.close(); global.fetch = realFetch })

  test('category outside the extraction prompt set falls back to "general" — in the echo, the row, and the index metadata', async () => {
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(llmBody([
      { category: 'convention', fact_text: T, confidence: 0.5 },      // in the prompt's set — passes through
      { category: 'HACKING', fact_text: 'never store api keys in the repo readme file', confidence: 0.5 }, // unknown word
      { category: 'preferences', fact_text: 'the operator prefers terse morning briefs over long ones', confidence: 0.5 }, // plural drift
      { fact_text: 'deployment runs from the jetson at 192.168.50.106 port 3002', confidence: 0.5 } // missing
    ])) }))
    const created = await extractFacts(db, LLM_CONFIG, 'Activity log with durable facts: ' + T, 'm5max', null)
    expect(created.length).toBe(4)
    expect(created[0].category).toBe('convention')   // valid set passes through
    expect(created[1].category).toBe('general')      // unknown word → 'general' (the no-category default everywhere else)
    expect(created[2].category).toBe('general')      // near-miss → 'general'
    expect(created[3].category).toBe('general')      // missing → 'general'
    for (const c of created) {
      expect(db.getFact(c.id).category).toBe(c.category)  // the row of record agrees
    }
    expect(metaFor(raw, created[1].id).category).toBe('general') // index metadata mirrors the row
  })

  test('confidence is clamped to [0, 0.9]; missing/garbage keeps the 0.8 default', async () => {
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(llmBody([
      { category: 'insight', fact_text: T, confidence: 1.0 },      // self-assessed certainty → 0.9
      { category: 'insight', fact_text: 'the squad runner serializes heavy loads behind one lock', confidence: 42 }, // absurd high
      { category: 'insight', fact_text: 'lessons land as memory rows the next brief recalls', confidence: -3 }, // absurd low → 0
      { category: 'insight', fact_text: 'the meter must weight full glm at three times flash', confidence: 0 }, // floor is 0, not the default
      { category: 'insight', fact_text: 'the night driver retired when the wake loop went live' }, // missing → 0.8
      { category: 'insight', fact_text: 'work is pull-claimed from the queue, never pushed', confidence: 'garbage' } // non-numeric → 0.8
    ])) }))
    const created = await extractFacts(db, LLM_CONFIG, 'Activity log with durable facts: ' + T, 'm5max', null)
    expect(created.length).toBe(6)
    expect(created[0].confidence).toBe(0.9)
    expect(created[1].confidence).toBe(0.9)
    expect(created[2].confidence).toBe(0)
    expect(created[3].confidence).toBe(0)
    expect(created[4].confidence).toBe(0.8)
    expect(created[5].confidence).toBe(0.8)
    for (const c of created) {
      const rowConf = db.getFact(c.id).confidence
      expect(rowConf).toBe(c.confidence)
      expect(rowConf).toBeLessThanOrEqual(0.9)
      expect(rowConf).toBeGreaterThanOrEqual(0)
    }
  })

  test('fact_text over the 2000-char cap is TRUNCATED (knowledge kept, index bounded), not dropped', async () => {
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(llmBody([
      { category: 'pattern', fact_text: 'x'.repeat(3500), confidence: 0.5 },
      { category: 'pattern', fact_text: 'y'.repeat(1999), confidence: 0.5 } // under the cap — untouched
    ])) }))
    const created = await extractFacts(db, LLM_CONFIG, 'Activity log: ' + T, 'm5max', null)
    expect(created.length).toBe(2)
    expect(created[0].fact_text.length).toBe(2000)
    expect(created[0].truncated).toBe(true)
    expect(db.getFact(created[0].id).fact_text.length).toBe(2000)
    expect(created[1].fact_text.length).toBe(1999)
    expect(created[1].truncated).toBeUndefined()
    // the index row carries the capped text too
    const idx = raw.prepare(
      "SELECT content_text FROM sm_embeddings WHERE source_type = 'memory' AND source_id = ?"
    ).get(String(created[0].id))
    expect(idx.content_text.length).toBe(2000)
  })

  test('index metadata reads category/confidence/authority back from the am_facts row — a model-stamped source_authority never reaches it', async () => {
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(llmBody([
      { category: 'HACKING', fact_text: T, confidence: 1.0, source_authority: 'directive' }
    ])) }))
    const created = await extractFacts(db, LLM_CONFIG, 'Activity log: ' + T, 'm5max', null)
    expect(created.length).toBe(1)
    expect(db.getFact(created[0].id).source_authority).toBe('inferred')  // PR #192, unchanged
    const meta = metaFor(raw, created[0].id)
    expect(meta.source_authority).toBe('inferred')
    expect(meta.category).toBe('general')     // row truth, not the model's word
    expect(meta.confidence).toBe(0.9)         // row truth, not the model's 1.0
  })

  test('a failed am_facts read-back WARNS (no silent catch), stays inferred, and still indexes with clamped fallback values', async () => {
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(llmBody([
      { category: 'HACKING', fact_text: T, confidence: 1.0 }
    ])) }))
    const origPrepare = raw.prepare.bind(raw)
    raw.prepare = (sql) => {
      if (/SELECT .+ FROM am_facts WHERE id = \?/.test(String(sql))) throw new Error('injected read-back failure')
      return origPrepare(sql)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const created = await extractFacts(db, LLM_CONFIG, 'Activity log: ' + T, 'm5max', null)
      expect(created.length).toBe(1)
      expect(created[0].memory_index.indexed).toBe(true)  // fail-soft, still searchable
      expect(warn.mock.calls.some((c) => String(c[0]).indexOf('read-back') !== -1)).toBe(true)
      const meta = metaFor(raw, created[0].id)
      expect(meta.source_authority).toBe('inferred')
      expect(meta.category).toBe('general') // the fallback still validates — never raw model output
      expect(meta.confidence).toBe(0.9)     // the fallback still clamps
    } finally {
      warn.mockRestore()
      raw.prepare = origPrepare
    }
  })

  test('a non-string fact_text is skipped before the length check — one malformed fact never drops the batch', async () => {
    // Review B item 2: the old guard was `!fact.fact_text || fact.fact_text.length < 10`,
    // which reads .length off WHATEVER arrived. An ARRAY is a non-string with a .length —
    // ten elements pass the check — and createFact's bind then throws inside extractFacts'
    // outer try, so the whole rest of the batch is lost and logged as an extraction
    // outage. (A one-element array like ["aaaaaaaaaaaa"] is not the red case: it is
    // already dropped by the length check, and better-sqlite3 would spread it into a
    // plain string bind anyway. Length >= 10 is what reaches the bind.)
    global.fetch = mockOllama(() => ({ ok: true, status: 200, json: async () => JSON.parse(llmBody([
      { category: 'pattern', fact_text: ['aaaaaaaaaaaa', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], confidence: 0.5 }, // non-string, .length 10 — passes the OLD length check
      { category: 'pattern', fact_text: T, confidence: 0.5 } // the healthy fact behind the malformed one
    ])) }))
    const created = await extractFacts(db, LLM_CONFIG, 'Activity log: ' + T, 'm5max', null)
    expect(created.length).toBe(1)                       // the malformed entry is skipped, not fatal
    expect(created[0].fact_text).toBe(T)                 // the valid fact is stored
    expect(db.getFact(created[0].id).fact_text).toBe(T)  // …and is in the row of record
    const errors = raw.prepare('SELECT COUNT(*) AS c FROM am_extraction_errors').get()
    expect(errors.c).toBe(0)                             // a malformed fact is not an extraction outage
  })
})
