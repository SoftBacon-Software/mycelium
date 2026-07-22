import { describe, test, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js'

// Slice 1 of the memory rework: bi-temporal validity + provenance-scoped trust on am_facts.
// We build the ORIGINAL (pre-temporal) table and let createAutoMemoryDB run its MIGRATION,
// so these tests pin the ALTER/backfill path (the risky part), not just a fresh schema.
//
// source_authority = how a fact was VALIDATED, not who spoke it:
//   verified  — ground-truth-checked (verified_at stamped)
//   directive — operator's stated intent/preference (authoritative; does NOT decay)
//   inferred  — extracted OR operator-RECOLLECTED but unverified (decays; re-verify queue)
// Invariant: valid_to IS NULL <=> superseded_by IS NULL <=> currently valid.

const BASE_SCHEMA = `
CREATE TABLE am_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  project_id TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  fact_text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  source_type TEXT,
  source_id TEXT,
  superseded_by INTEGER REFERENCES am_facts(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);`

function cols(raw) {
  return raw.prepare('PRAGMA table_info(am_facts)').all().map((c) => c.name)
}

describe('auto-memory: bi-temporal validity + provenance-scoped trust (slice 1)', () => {
  let raw, db
  beforeEach(() => {
    raw = new Database(':memory:')
    raw.exec(BASE_SCHEMA)
    db = createAutoMemoryDB(raw) // runs the migration on the pre-temporal table
  })

  test('migration adds temporal + provenance columns to an existing table', () => {
    const c = cols(raw)
    for (const col of ['valid_from', 'valid_to', 'verified_at', 'source_authority', 'access_count', 'last_accessed_at']) {
      expect(c).toContain(col)
    }
  })

  test('schema.sql is safe to run on a DB that predates the temporal columns (plugin load-order)', () => {
    // The plugin loader execs schema.sql BEFORE db.js runs its ALTERs. On an existing am_facts,
    // CREATE TABLE IF NOT EXISTS is a no-op, so any CREATE INDEX in schema.sql must NOT reference a
    // not-yet-added column — that threw "no such column: valid_to" and failed the whole plugin load.
    const r = new Database(':memory:')
    r.exec(BASE_SCHEMA) // pre-temporal table
    const schema = readFileSync(new URL('../../server/plugins/auto-memory/schema.sql', import.meta.url), 'utf8')
    expect(() => r.exec(schema)).not.toThrow()
  })

  test('backfill: a pre-existing row gets valid_from = created_at, valid_to NULL (current)', () => {
    const r2 = new Database(':memory:')
    r2.exec(BASE_SCHEMA)
    r2.prepare("INSERT INTO am_facts (category, fact_text, confidence, created_at) VALUES ('general','old fact',0.8,'2026-01-01 00:00:00')").run()
    createAutoMemoryDB(r2) // migrate AFTER the row exists
    const row = r2.prepare('SELECT valid_from, valid_to FROM am_facts WHERE fact_text = ?').get('old fact')
    expect(row.valid_from).toBe('2026-01-01 00:00:00')
    expect(row.valid_to).toBeNull()
  })

  test('createFact defaults source_authority=inferred, stamps valid_from, valid_to NULL', () => {
    const id = db.createFact('m5max', null, 'decision', 'am_facts is the canonical store', 0.9, 'test', null)
    const f = raw.prepare('SELECT * FROM am_facts WHERE id = ?').get(id)
    expect(f.source_authority).toBe('inferred')
    expect(f.valid_from).toBeTruthy()
    expect(f.valid_to).toBeNull()
  })

  test('createFact accepts explicit source_authority (directive) + valid_from (backward-compatible extra args)', () => {
    const id = db.createFact('gilbert', null, 'preference', 'call me cloood', 1.0, 'operator', null, 'directive', '2026-03-01 00:00:00')
    const f = raw.prepare('SELECT * FROM am_facts WHERE id = ?').get(id)
    expect(f.source_authority).toBe('directive')
    expect(f.valid_from).toBe('2026-03-01 00:00:00')
  })

  test('supersedeFact closes valid_to and holds the invariant (valid_to NULL <=> current)', () => {
    const oldId = db.createFact(null, null, 'pattern', 'MTP is a dead-end for GLM', 0.6, 'test', null)
    const newId = db.createFact(null, null, 'pattern', 'MTP built: 77% acceptance, the unlock', 0.8, 'test', null)
    db.supersedeFact(oldId, newId)
    const oldF = raw.prepare('SELECT superseded_by, valid_to FROM am_facts WHERE id = ?').get(oldId)
    const newF = raw.prepare('SELECT superseded_by, valid_to FROM am_facts WHERE id = ?').get(newId)
    expect(oldF.superseded_by).toBe(newId)
    expect(oldF.valid_to).toBeTruthy() // interval closed
    expect(newF.superseded_by).toBeNull()
    expect(newF.valid_to).toBeNull() // still current
  })

  test('reverifyFact stamps verified_at and refreshes confidence', () => {
    const id = db.createFact(null, null, 'insight', 'GLM decode is compute-bound', 0.5, 'test', null)
    db.reverifyFact(id, 0.85)
    const f = raw.prepare('SELECT verified_at, confidence FROM am_facts WHERE id = ?').get(id)
    expect(f.verified_at).toBeTruthy()
    expect(f.confidence).toBeCloseTo(0.85)
  })

  test('reverifyFact(id) with no confidence keeps the existing confidence', () => {
    const id = db.createFact(null, null, 'insight', 'keep my confidence', 0.42, 'test', null)
    db.reverifyFact(id)
    const f = raw.prepare('SELECT verified_at, confidence FROM am_facts WHERE id = ?').get(id)
    expect(f.verified_at).toBeTruthy()
    expect(f.confidence).toBeCloseTo(0.42)
  })

  test('factsDueForReverification returns unverified inferred facts, EXCLUDES directive', () => {
    const inferredId = db.createFact(null, null, 'insight', 'benchmark showed X', 0.7, 'test', null)
    db.createFact(null, null, 'preference', 'Aria first', 1.0, 'operator', null, 'directive')
    const due = db.factsDueForReverification({ older_than_days: 30, limit: 50 })
    expect(due.map((f) => f.id)).toContain(inferredId)
    expect(due.every((f) => f.source_authority === 'inferred')).toBe(true)
  })

  test('factsDueForReverification EXCLUDES a recently reverified fact', () => {
    const id = db.createFact(null, null, 'insight', 'freshly checked', 0.7, 'test', null)
    db.reverifyFact(id, 0.7) // verified_at = now
    const due = db.factsDueForReverification({ older_than_days: 30 })
    expect(due.map((f) => f.id)).not.toContain(id)
  })

  test('factsAsOf returns the fact whose validity interval contains the timestamp', () => {
    const oldId = db.createFact(null, null, 'pattern', 'belief A', 0.6, 'test', null)
    const newId = db.createFact(null, null, 'pattern', 'belief B', 0.8, 'test', null)
    // deterministic intervals: A valid [01-01, 06-01), B valid [06-01, open)
    raw.prepare("UPDATE am_facts SET valid_from='2026-01-01 00:00:00', valid_to='2026-06-01 00:00:00', superseded_by=? WHERE id=?").run(newId, oldId)
    raw.prepare("UPDATE am_facts SET valid_from='2026-06-01 00:00:00', valid_to=NULL WHERE id=?").run(newId)

    const asMar = db.factsAsOf('2026-03-15 00:00:00').map((f) => f.fact_text)
    expect(asMar).toContain('belief A')
    expect(asMar).not.toContain('belief B')

    const asJul = db.factsAsOf('2026-07-15 00:00:00').map((f) => f.fact_text)
    expect(asJul).toContain('belief B')
    expect(asJul).not.toContain('belief A')
  })

  test('getDecayableFacts EXCLUDES directive facts (operator intent does not decay)', () => {
    const inf = db.createFact(null, null, 'insight', 'decays normally', 0.7, 'test', null)
    const dir = db.createFact('gilbert', null, 'preference', 'does not decay', 1.0, 'operator', null, 'directive')
    raw.prepare("UPDATE am_facts SET last_accessed_at='2020-01-01 00:00:00'").run() // both old enough to be candidates
    const ids = db.getDecayableFacts().map((f) => f.id)
    expect(ids).toContain(inf)
    expect(ids).not.toContain(dir)
  })

  test('pruneLowConfidence is FK-safe (self-supersede) and closes valid_to', () => {
    // Regression: the old superseded_by=-1 sentinel violated the FK under foreign_keys=ON and
    // silently pruned NOTHING in prod. Decay-prune now self-supersedes (superseded_by = own id).
    const id = db.createFact(null, null, 'general', 'weak stale fact', 0.05, 'test', null)
    raw.prepare("UPDATE am_facts SET updated_at='2020-01-01 00:00:00' WHERE id=?").run(id) // older than 7d guard
    expect(() => db.pruneLowConfidence(0.15)).not.toThrow() // was: FOREIGN KEY constraint failed
    const f = raw.prepare('SELECT superseded_by, valid_to FROM am_facts WHERE id = ?').get(id)
    expect(f.superseded_by).toBe(id) // decay-pruned = self-supersede (FK-safe)
    expect(f.valid_to).toBeTruthy() // interval closed too
  })
})
