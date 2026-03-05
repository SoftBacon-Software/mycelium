-- Daily Digest plugin schema
-- Stores generated digest reports and time-series metrics snapshots.

CREATE TABLE IF NOT EXISTS dv_digest_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start    TEXT NOT NULL,                          -- ISO date start of period
  period_end      TEXT NOT NULL,                          -- ISO date end of period
  digest_type     TEXT NOT NULL DEFAULT 'daily',          -- 'daily' or 'weekly'
  content         TEXT NOT NULL DEFAULT '{}',             -- JSON: full digest data
  summary         TEXT NOT NULL DEFAULT '',               -- human-readable summary text
  delivered_to    TEXT NOT NULL DEFAULT '[]',             -- JSON array of delivery targets
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dv_digest_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_type     TEXT NOT NULL,                          -- 'tasks_completed', 'bugs_fixed', etc.
  metric_key      TEXT NOT NULL DEFAULT '',               -- e.g. agent id or 'total'
  value           REAL NOT NULL DEFAULT 0,
  period          TEXT NOT NULL,                          -- date string for the period
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_digest_reports_type ON dv_digest_reports(digest_type);
CREATE INDEX IF NOT EXISTS idx_dv_digest_reports_period ON dv_digest_reports(period_start);
CREATE INDEX IF NOT EXISTS idx_dv_digest_metrics_type_period ON dv_digest_metrics(metric_type, period);
