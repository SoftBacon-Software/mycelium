-- Plugin: error-monitor
-- Stores raw error events from Sentry, Bugsnag, and Datadog webhooks

CREATE TABLE IF NOT EXISTS dv_error_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL DEFAULT '',
  error_key   TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  stack_trace TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  payload     TEXT NOT NULL DEFAULT '{}',
  bug_id      INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_events_error_key ON dv_error_events(error_key);
CREATE INDEX IF NOT EXISTS idx_error_events_provider ON dv_error_events(provider);
CREATE INDEX IF NOT EXISTS idx_error_events_status ON dv_error_events(status);
CREATE INDEX IF NOT EXISTS idx_error_events_bug_id ON dv_error_events(bug_id);
