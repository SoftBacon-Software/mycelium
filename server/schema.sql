-- =============== MYCELIUM — Platform Schema ===============
-- Distributed development platform. The printing press of ideas.

-- Registered agents (Claude instances, bots, etc.)
CREATE TABLE IF NOT EXISTS dv_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  game            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'offline',
  working_on      TEXT NOT NULL DEFAULT '',
  last_heartbeat  TEXT,
  capabilities    TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects registry (was "games")
CREATE TABLE IF NOT EXISTS dv_games (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  repo_url        TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cross-project tasks
CREATE TABLE IF NOT EXISTS dv_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  game            TEXT NOT NULL DEFAULT 'dioverse',
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
  game            TEXT PRIMARY KEY,
  data            TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT NOT NULL DEFAULT ''
);

-- Cross-project asset registry
CREATE TABLE IF NOT EXISTS dv_assets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'sprite',
  game            TEXT NOT NULL DEFAULT 'shared',
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
  game            TEXT,
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
  game            TEXT,
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
  game            TEXT NOT NULL DEFAULT 'dioverse',
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
  game         TEXT NOT NULL DEFAULT 'dioverse',
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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  command        TEXT NOT NULL DEFAULT '',
  input_data     TEXT NOT NULL DEFAULT '{}',
  requires       TEXT NOT NULL DEFAULT '["cpu"]',
  requester      TEXT NOT NULL,
  drone_id       TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  priority       INTEGER NOT NULL DEFAULT 0,
  result_url     TEXT,
  result_data    TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dv_tasks_status ON dv_tasks(status);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_game ON dv_tasks(game);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_assignee ON dv_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_dv_tasks_updated ON dv_tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dv_assets_game ON dv_assets(game);
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
CREATE INDEX IF NOT EXISTS idx_dv_bugs_game ON dv_bugs(game);
CREATE INDEX IF NOT EXISTS idx_dv_plans_status ON dv_plans(status);
CREATE INDEX IF NOT EXISTS idx_dv_plans_game ON dv_plans(game);
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
