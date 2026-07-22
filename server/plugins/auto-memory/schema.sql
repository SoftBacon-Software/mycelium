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
