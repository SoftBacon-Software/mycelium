-- Plugin: cost-tracker
-- Tracks AI API token usage and costs per agent, project, and task.

CREATE TABLE IF NOT EXISTS dv_cost_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id          TEXT NOT NULL DEFAULT '',
  project_id        TEXT NOT NULL DEFAULT '',
  task_id           INTEGER,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  session_id        TEXT NOT NULL DEFAULT '',
  recorded_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON dv_cost_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_entries_project ON dv_cost_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_cost_entries_recorded ON dv_cost_entries(recorded_at);

CREATE TABLE IF NOT EXISTS dv_cost_daily (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL DEFAULT '',
  agent_id          TEXT NOT NULL DEFAULT '',
  project_id        TEXT NOT NULL DEFAULT '',
  total_input       INTEGER NOT NULL DEFAULT 0,
  total_output      INTEGER NOT NULL DEFAULT 0,
  total_cache       INTEGER NOT NULL DEFAULT 0,
  total_cost        REAL NOT NULL DEFAULT 0,
  entry_count       INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, agent_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_cost_daily_date ON dv_cost_daily(date);
CREATE INDEX IF NOT EXISTS idx_cost_daily_agent ON dv_cost_daily(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_daily_project ON dv_cost_daily(project_id);

CREATE TABLE IF NOT EXISTS dv_cost_alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type        TEXT NOT NULL DEFAULT '',
  threshold_pct     REAL NOT NULL DEFAULT 0,
  current_spend     REAL NOT NULL DEFAULT 0,
  budget_limit      REAL NOT NULL DEFAULT 0,
  triggered_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
