-- Plugin: guardrails
-- Pre-action quality checks and rule enforcement.

CREATE TABLE IF NOT EXISTS dv_guardrail_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  trigger_event   TEXT NOT NULL,
  conditions      TEXT NOT NULL DEFAULT '{}',
  enforcement     TEXT NOT NULL DEFAULT 'warn',
  project_id      TEXT,
  enabled         INTEGER DEFAULT 1,
  created_by      TEXT DEFAULT '',
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guardrail_rules_trigger ON dv_guardrail_rules(trigger_event);

CREATE TABLE IF NOT EXISTS dv_guardrail_violations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id           INTEGER NOT NULL,
  rule_name         TEXT NOT NULL,
  trigger_event     TEXT NOT NULL,
  agent_id          TEXT DEFAULT '',
  project_id        TEXT DEFAULT '',
  enforcement       TEXT NOT NULL,
  event_data        TEXT DEFAULT '{}',
  violation_detail  TEXT DEFAULT '',
  overridden        INTEGER DEFAULT 0,
  overridden_by     TEXT DEFAULT '',
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guardrail_violations_rule ON dv_guardrail_violations(rule_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_violations_agent ON dv_guardrail_violations(agent_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_violations_project ON dv_guardrail_violations(project_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_violations_created ON dv_guardrail_violations(created_at DESC);
