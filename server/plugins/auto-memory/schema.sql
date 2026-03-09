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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_am_facts_agent ON am_facts(agent_id);
CREATE INDEX IF NOT EXISTS idx_am_facts_project ON am_facts(project_id);
CREATE INDEX IF NOT EXISTS idx_am_facts_category ON am_facts(category);
CREATE INDEX IF NOT EXISTS idx_am_facts_confidence ON am_facts(confidence DESC);

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
