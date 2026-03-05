-- Plugin: workflow-automations
-- Event-driven automation rules

CREATE TABLE IF NOT EXISTS dv_automation_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  trigger_event TEXT NOT NULL,
  conditions    TEXT NOT NULL DEFAULT '{}',
  actions       TEXT NOT NULL DEFAULT '[]',
  project_id    TEXT,
  enabled       INTEGER DEFAULT 1,
  run_count     INTEGER DEFAULT 0,
  last_run      TEXT,
  created_by    TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger ON dv_automation_rules(trigger_event);
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled ON dv_automation_rules(enabled);

CREATE TABLE IF NOT EXISTS dv_automation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id       INTEGER NOT NULL,
  rule_name     TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  matched       INTEGER DEFAULT 1,
  actions_taken TEXT DEFAULT '[]',
  event_data    TEXT DEFAULT '{}',
  status        TEXT DEFAULT 'success',
  error         TEXT DEFAULT '',
  dry_run       INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_automation_log_rule ON dv_automation_log(rule_id);
CREATE INDEX IF NOT EXISTS idx_automation_log_status ON dv_automation_log(status);

CREATE TABLE IF NOT EXISTS dv_automation_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  trigger_event TEXT NOT NULL,
  conditions    TEXT DEFAULT '{}',
  actions       TEXT DEFAULT '[]',
  category      TEXT DEFAULT 'general',
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_automation_templates_category ON dv_automation_templates(category);

-- Built-in templates
INSERT OR IGNORE INTO dv_automation_templates (id, name, description, trigger_event, conditions, actions, category) VALUES
(1, 'Auto-assign critical bugs', 'Automatically assign critical bugs to a configured agent and notify operators.', 'bug_filed',
  '{"field_equals":{"severity":"critical"}}',
  '[{"type":"assign_agent","agent_id":"__configure_me__"},{"type":"inbox_notify","title":"Critical bug filed: {{title}}","summary":"A critical bug was filed and auto-assigned: {{title}}","priority":"high"}]',
  'bugs');

INSERT OR IGNORE INTO dv_automation_templates (id, name, description, trigger_event, conditions, actions, category) VALUES
(2, 'Notify on plan completion', 'Send an inbox notification when a plan step is completed.', 'plan_step_completed',
  '{}',
  '[{"type":"inbox_notify","title":"Plan step completed: {{title}}","summary":"{{agent}} completed step: {{title}}","priority":"normal"}]',
  'plans');

INSERT OR IGNORE INTO dv_automation_templates (id, name, description, trigger_event, conditions, actions, category) VALUES
(3, 'Webhook on deploy', 'Send a webhook when a deploy approval is executed.', 'approval_executed',
  '{"field_equals":{"action_type":"deploy"}}',
  '[{"type":"send_webhook","url":"__configure_me__"}]',
  'integrations');

INSERT OR IGNORE INTO dv_automation_templates (id, name, description, trigger_event, conditions, actions, category) VALUES
(4, 'Create review task on PR', 'Automatically create a review task when a GitHub PR is opened.', 'github_pr_opened',
  '{}',
  '[{"type":"create_task","title":"Review PR: {{title}}","description":"Review pull request #{{number}} by {{author}}: {{title}}"}]',
  'github');
