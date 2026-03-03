-- =============== MYCELIUM -- Platform Schema ===============
-- Distributed development platform. The printing press of ideas.

-- Registered agents (AI instances, bots, etc.)
CREATE TABLE IF NOT EXISTS dv_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'offline',
  working_on      TEXT NOT NULL DEFAULT '',
  last_heartbeat  TEXT,
  capabilities    TEXT NOT NULL DEFAULT '[]',
  agent_type      TEXT NOT NULL DEFAULT 'agent',
  llm_backend     TEXT NOT NULL DEFAULT '',
  llm_model       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Organizations (multi-tenant)
CREATE TABLE IF NOT EXISTS dv_organizations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  owner_id        TEXT NOT NULL DEFAULT '',
  plan            TEXT NOT NULL DEFAULT 'free',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects registry
CREATE TABLE IF NOT EXISTS dv_projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  org_id          TEXT NOT NULL DEFAULT '',
  repo_url        TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'software',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cross-project tasks
CREATE TABLE IF NOT EXISTS dv_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  project_id      TEXT NOT NULL DEFAULT '',
  requester       TEXT NOT NULL,
  assignee        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  priority        TEXT NOT NULL DEFAULT 'normal',
  tags            TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-project context snapshots (legacy)
CREATE TABLE IF NOT EXISTS dv_context (
  project_id      TEXT PRIMARY KEY,
  data            TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT NOT NULL DEFAULT ''
);

-- Cross-project asset registry
CREATE TABLE IF NOT EXISTS dv_assets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'asset',
  project_id      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'requested',
  path            TEXT NOT NULL DEFAULT '',
  metadata        TEXT NOT NULL DEFAULT '{}',
  requester       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Activity feed
CREATE TABLE IF NOT EXISTS dv_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,
  agent           TEXT NOT NULL DEFAULT '',
  project_id      TEXT,
  summary         TEXT NOT NULL DEFAULT '',
  data            TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inter-agent messages
CREATE TABLE IF NOT EXISTS dv_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT,
  thread_id       TEXT,
  project_id      TEXT,
  content         TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Namespaced context storage
CREATE TABLE IF NOT EXISTS dv_context_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT NOT NULL DEFAULT '',
  UNIQUE(namespace, key)
);

-- Bug tracking
CREATE TABLE IF NOT EXISTS dv_bugs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'other',
  severity        TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'open',
  reporter        TEXT NOT NULL DEFAULT 'admin',
  assignee        TEXT,
  admin_notes     TEXT NOT NULL DEFAULT '',
  diagnostic_data TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plans (multi-step initiatives)
CREATE TABLE IF NOT EXISTS dv_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  project_id   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft',
  owner        TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT 'normal',
  tags         TEXT NOT NULL DEFAULT '[]',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dv_plan_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        INTEGER NOT NULL REFERENCES dv_plans(id) ON DELETE CASCADE,
  step_order     INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  phase          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  assignee       TEXT,
  linked_task_id INTEGER,
  linked_branch  TEXT,
  linked_pr_url  TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Studio users (human operators)
CREATE TABLE IF NOT EXISTS dv_studio_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent webhooks
CREATE TABLE IF NOT EXISTS dv_webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  url        TEXT NOT NULL,
  events     TEXT NOT NULL DEFAULT '["task_created","request_created","message_sent"]',
  secret     TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Drone compute job queue
CREATE TABLE IF NOT EXISTS dv_drone_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  command         TEXT NOT NULL DEFAULT '',
  input_data      TEXT NOT NULL DEFAULT '{}',
  requires        TEXT NOT NULL DEFAULT '["cpu"]',
  requester       TEXT NOT NULL,
  drone_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  priority        INTEGER NOT NULL DEFAULT 0,
  workspace_repo  TEXT,
  workspace_branch TEXT NOT NULL DEFAULT 'main',
  result_url      TEXT,
  result_data     TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shared concepts (characters, styles, rulesets, etc. that flow between projects)
CREATE TABLE IF NOT EXISTS dv_concepts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'custom',
  description     TEXT NOT NULL DEFAULT '',
  data            TEXT NOT NULL DEFAULT '{}',
  version         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project-concept links (many-to-many)
CREATE TABLE IF NOT EXISTS dv_project_concepts (
  project_id      TEXT NOT NULL,
  concept_id      INTEGER NOT NULL REFERENCES dv_concepts(id) ON DELETE CASCADE,
  linked_at       TEXT NOT NULL DEFAULT (datetime('now')),
  linked_by       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, concept_id)
);

-- Task comments
CREATE TABLE IF NOT EXISTS dv_task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES dv_tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON dv_task_comments(task_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dv_tasks_status ON dv_tasks(status);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_project ON dv_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_assignee ON dv_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_updated ON dv_tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dv_assets_project ON dv_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_assets_status ON dv_assets(status);
CREATE INDEX IF NOT EXISTS idx_dv_events_created ON dv_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dv_events_type ON dv_events(type);
CREATE INDEX IF NOT EXISTS idx_dv_events_agent ON dv_events(agent);
CREATE INDEX IF NOT EXISTS idx_dv_messages_from ON dv_messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_dv_messages_to ON dv_messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_dv_messages_thread ON dv_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_dv_messages_created ON dv_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dv_context_keys_ns ON dv_context_keys(namespace);
CREATE INDEX IF NOT EXISTS idx_dv_bugs_status ON dv_bugs(status);
CREATE INDEX IF NOT EXISTS idx_dv_bugs_project ON dv_bugs(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_plans_status ON dv_plans(status);
CREATE INDEX IF NOT EXISTS idx_dv_plans_project ON dv_plans(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_plans_owner ON dv_plans(owner);
CREATE INDEX IF NOT EXISTS idx_dv_plan_steps_plan ON dv_plan_steps(plan_id);
CREATE INDEX IF NOT EXISTS idx_dv_plan_steps_task ON dv_plan_steps(linked_task_id);
CREATE INDEX IF NOT EXISTS idx_dv_studio_users_username ON dv_studio_users(username);
CREATE INDEX IF NOT EXISTS idx_dv_webhooks_agent ON dv_webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_dv_webhooks_active ON dv_webhooks(active);
CREATE INDEX IF NOT EXISTS idx_dv_drone_jobs_status ON dv_drone_jobs(status);
CREATE INDEX IF NOT EXISTS idx_dv_drone_jobs_drone ON dv_drone_jobs(drone_id);
CREATE INDEX IF NOT EXISTS idx_dv_drone_jobs_requester ON dv_drone_jobs(requester);
CREATE INDEX IF NOT EXISTS idx_dv_drone_jobs_priority ON dv_drone_jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_dv_concepts_type ON dv_concepts(type);
CREATE INDEX IF NOT EXISTS idx_dv_concepts_name ON dv_concepts(name);
CREATE INDEX IF NOT EXISTS idx_dv_project_concepts_project ON dv_project_concepts(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_project_concepts_concept ON dv_project_concepts(concept_id);
CREATE INDEX IF NOT EXISTS idx_dv_organizations_status ON dv_organizations(status);
CREATE INDEX IF NOT EXISTS idx_dv_projects_org ON dv_projects(org_id);
CREATE INDEX IF NOT EXISTS idx_dv_projects_status ON dv_projects(status);
CREATE INDEX IF NOT EXISTS idx_dv_projects_type ON dv_projects(type);

-- Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_dv_agents_project ON dv_agents(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_requester ON dv_tasks(requester);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_project_status ON dv_tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_dv_bugs_severity ON dv_bugs(severity);
CREATE INDEX IF NOT EXISTS idx_dv_bugs_assignee ON dv_bugs(assignee);
CREATE INDEX IF NOT EXISTS idx_dv_messages_project ON dv_messages(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_webhook_deliveries_agent ON dv_webhook_deliveries(agent_id);
-- Plugins (installable capability modules with routes, DB, MCP tools)
CREATE TABLE IF NOT EXISTS dv_plugins (
  name            TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  version         TEXT NOT NULL DEFAULT '1.0.0',
  author          TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  route_prefix    TEXT NOT NULL DEFAULT '',
  mcp_tool_count  INTEGER NOT NULL DEFAULT 0,
  installed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dv_plugin_migrations (
  plugin_name     TEXT NOT NULL,
  version         INTEGER NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  applied_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_name, version)
);

-- Approval gates (human-in-the-loop for agent actions)
CREATE TABLE IF NOT EXISTS dv_approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type     TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  payload         TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  reason          TEXT NOT NULL DEFAULT '',
  admin_notes     TEXT NOT NULL DEFAULT '',
  decided_by      TEXT,
  decided_at      TEXT,
  executed_at     TEXT,
  project_id      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_approvals_status ON dv_approvals(status);
CREATE INDEX IF NOT EXISTS idx_dv_approvals_action ON dv_approvals(action_type);
CREATE INDEX IF NOT EXISTS idx_dv_approvals_agent ON dv_approvals(requested_by);
CREATE INDEX IF NOT EXISTS idx_dv_approvals_project ON dv_approvals(project_id);

-- Operators (human team members)
CREATE TABLE IF NOT EXISTS dv_operators (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  responsibilities TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  studio_user_id  INTEGER REFERENCES dv_studio_users(id),
  status          TEXT NOT NULL DEFAULT 'active',
  availability    TEXT NOT NULL DEFAULT 'available',
  last_seen_at    TEXT,
  away_message    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dv_operators_role ON dv_operators(role);
CREATE INDEX IF NOT EXISTS idx_dv_operators_status ON dv_operators(status);

-- Instance configuration (per-deployment settings)
CREATE TABLE IF NOT EXISTS dv_instance_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT NOT NULL DEFAULT ''
);

-- Multi-human approval voting
CREATE TABLE IF NOT EXISTS dv_approval_votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES dv_approvals(id),
  voter       TEXT NOT NULL,
  vote        TEXT NOT NULL DEFAULT 'approve',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(approval_id, voter)
);
CREATE INDEX IF NOT EXISTS idx_dv_approval_votes_approval ON dv_approval_votes(approval_id);
CREATE INDEX IF NOT EXISTS idx_dv_approval_votes_voter ON dv_approval_votes(voter);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS dv_webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id      INTEGER NOT NULL,
  event           TEXT NOT NULL,
  agent_id        TEXT NOT NULL DEFAULT '',
  payload         TEXT NOT NULL DEFAULT '{}',
  status_code     INTEGER,
  response_body   TEXT,
  error           TEXT,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dv_webhook_deliveries_event ON dv_webhook_deliveries(event);
CREATE INDEX IF NOT EXISTS idx_dv_webhook_deliveries_webhook ON dv_webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_dv_webhook_deliveries_created ON dv_webhook_deliveries(created_at DESC);

-- Chat channels
CREATE TABLE IF NOT EXISTS dv_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL DEFAULT 'general',
  linked_type TEXT,
  linked_id   INTEGER,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_channels_slug ON dv_channels(slug);
CREATE INDEX IF NOT EXISTS idx_dv_channels_type ON dv_channels(type);
CREATE INDEX IF NOT EXISTS idx_dv_channels_linked ON dv_channels(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_dv_channels_status ON dv_channels(status);

-- Channel membership
CREATE TABLE IF NOT EXISTS dv_channel_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES dv_channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  user_type   TEXT NOT NULL DEFAULT 'agent',
  role        TEXT NOT NULL DEFAULT 'member',
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dv_channel_members_channel ON dv_channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_dv_channel_members_user ON dv_channel_members(user_id);

-- Agent savepoints (persistent session state)
CREATE TABLE IF NOT EXISTS dv_agent_savepoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  session_id      TEXT,
  heartbeat_at    TEXT NOT NULL,
  working_on      TEXT NOT NULL DEFAULT '',
  state_snapshot  TEXT NOT NULL DEFAULT '{}',
  messages_acked  TEXT NOT NULL DEFAULT '[]',
  context_versions TEXT NOT NULL DEFAULT '{}',
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_savepoints_agent ON dv_agent_savepoints(agent_id, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_savepoints_session ON dv_agent_savepoints(session_id);

-- Channel read tracking
CREATE TABLE IF NOT EXISTS dv_channel_reads (
  channel_id          INTEGER NOT NULL REFERENCES dv_channels(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  last_read_at        TEXT,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel_id, user_id)
);

-- Operator inbox (human-facing messages, approvals, BIP drafts, @mentions)
CREATE TABLE IF NOT EXISTS dv_operator_inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id   TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'message',    -- 'message','approval','bip_draft','mention','feedback_request'
  entity_type   TEXT NOT NULL DEFAULT '',           -- 'message','approval','plan_step','task','bip_draft'
  entity_id     TEXT NOT NULL DEFAULT '',           -- id of the referenced entity
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  data          TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'unread',     -- 'unread','read','actioned','dismissed'
  priority      TEXT NOT NULL DEFAULT 'normal',     -- 'urgent','normal','low'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  read_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_dv_operator_inbox_operator ON dv_operator_inbox(operator_id, status);
CREATE INDEX IF NOT EXISTS idx_dv_operator_inbox_type ON dv_operator_inbox(type);
CREATE INDEX IF NOT EXISTS idx_dv_operator_inbox_entity ON dv_operator_inbox(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_dv_operator_inbox_created ON dv_operator_inbox(created_at DESC);

-- Operator feedback on agent work (ratings + comments)
CREATE TABLE IF NOT EXISTS dv_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL DEFAULT 'general',  -- 'task', 'plan_step', 'bug', 'general'
  entity_id    TEXT NOT NULL DEFAULT '',          -- ID of the referenced entity
  subject      TEXT NOT NULL DEFAULT '',          -- human-readable label
  rating       INTEGER NOT NULL DEFAULT 3,        -- 1-5 stars
  comment      TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL DEFAULT 'operator',  -- who gave the feedback
  agent_id     TEXT NOT NULL DEFAULT '',          -- which agent's work is rated
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dv_feedback_agent ON dv_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_dv_feedback_entity ON dv_feedback(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_dv_feedback_created ON dv_feedback(created_at DESC);
