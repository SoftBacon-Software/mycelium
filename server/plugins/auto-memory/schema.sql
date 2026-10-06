-- Plugin: auto-memory
-- Automated knowledge extraction from agent activity

CREATE TABLE IF NOT EXISTS am_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  project_id TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  fact_text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  source_type TEXT,
  source_id TEXT,
  superseded_by INTEGER REFERENCES am_facts(id),
  valid_from TEXT,                                    -- world-time the fact became true
  valid_to TEXT,                                      -- world-time it stopped (NULL = currently valid)
  verified_at TEXT,                                   -- last ground-truth re-check
  source_authority TEXT NOT NULL DEFAULT 'inferred',  -- how-validated: verified | directive | inferred
  -- TRUST LAYER P1.1 (F-mycelium/265): same columns, same law as sm_embeddings
  -- (semantic-memory/schema.sql) — origin = WHO the content came from
  -- (server/lib/trust-origins.js is the one definition), trust 0..4 with NULL
  -- read as the LOWEST, derived_from = JSON array of input refs on derived
  -- rows ("am:<id>" for consolidation inputs). The guarded ALTERs in db.js
  -- carry all three to existing databases.
  -- TRUST LAYER P1.4 (F-mycelium/267): the forget cascade WALKS derived_from —
  -- a forgotten fact falls through every row derived from it. Extraction's
  -- source entity is NOT provenance here (it lives on the row's own
  -- source_type/source_id columns; a non-row ref would floor the trust
  -- min-law at 0).
  origin TEXT,
  trust INTEGER DEFAULT 0,
  derived_from TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_am_facts_agent ON am_facts(agent_id);
CREATE INDEX IF NOT EXISTS idx_am_facts_project ON am_facts(project_id);
CREATE INDEX IF NOT EXISTS idx_am_facts_category ON am_facts(category);
CREATE INDEX IF NOT EXISTS idx_am_facts_confidence ON am_facts(confidence DESC);
-- NOTE: indexes on the temporal/provenance columns are created in db.js's migration block,
-- AFTER the ALTER TABLE ADD COLUMN calls. They must NOT live here: on an existing DB, the
-- CREATE TABLE above is a no-op, so a CREATE INDEX on a not-yet-added column would throw and
-- fail the whole plugin load (caught live 2026-07-22).

-- TRUST LAYER P1.4 (F-mycelium/267): the fact-store half of the tombstone
-- law — the mirror of semantic-memory's sm_tombstones. Every true delete of
-- a fact (forget, cascade, namespace purge, and the housekeeping prunes)
-- leaves one: the fact's id, when, the authenticated actor (NULL = internal
-- writer), why. NO content column, ever. Append-only.
CREATE TABLE IF NOT EXISTS am_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id INTEGER NOT NULL,
  deleted_at TEXT DEFAULT (datetime('now')),
  deleted_by TEXT,
  reason TEXT NOT NULL DEFAULT 'delete'
);
CREATE INDEX IF NOT EXISTS idx_am_tombstones_fact ON am_tombstones(fact_id);

-- Consolidation log
CREATE TABLE IF NOT EXISTS am_consolidation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facts_processed INTEGER NOT NULL DEFAULT 0,
  facts_merged INTEGER NOT NULL DEFAULT 0,
  facts_superseded INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  run_at TEXT DEFAULT (datetime('now'))
);

-- Auto-memory config
CREATE TABLE IF NOT EXISTS am_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Extraction error log
CREATE TABLE IF NOT EXISTS am_extraction_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  project_id TEXT,
  source_event TEXT,
  error_message TEXT NOT NULL,
  input_text_preview TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_am_errors_created ON am_extraction_errors(created_at DESC);
