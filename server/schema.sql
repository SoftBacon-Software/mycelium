-- =============== MYCELIUM -- Platform Schema ===============
-- Distributed development platform.

-- Registered agents (AI instances, bots, etc.)
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  project         TEXT NOT NULL DEFAULT '',
  api_key_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'offline',
  working_on      TEXT NOT NULL DEFAULT '',
  last_heartbeat  TEXT,
  capabilities    TEXT NOT NULL DEFAULT '[]',
  avatar_url      TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT '',
  operator_id     TEXT NOT NULL DEFAULT '',
  system_diagnostics TEXT NOT NULL DEFAULT '{}',
  agent_type      TEXT NOT NULL DEFAULT 'agent',
  llm_backend     TEXT NOT NULL DEFAULT '',
  llm_model       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Organizations (multi-tenant)
CREATE TABLE IF NOT EXISTS organizations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  owner_id        TEXT NOT NULL DEFAULT '',
  plan            TEXT NOT NULL DEFAULT 'free',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects registry
CREATE TABLE IF NOT EXISTS projects (
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
CREATE TABLE IF NOT EXISTS tasks (
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
CREATE TABLE IF NOT EXISTS context (
  project_id      TEXT PRIMARY KEY,
  data            TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT NOT NULL DEFAULT ''
);

-- Cross-project asset registry
CREATE TABLE IF NOT EXISTS assets (
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
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,
  agent           TEXT NOT NULL DEFAULT '',
  project_id      TEXT,
  summary         TEXT NOT NULL DEFAULT '',
  data            TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inter-agent messages
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT,
  thread_id       TEXT,
  project_id      TEXT,
  content         TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',
  priority        TEXT NOT NULL DEFAULT 'normal',   -- 'urgent' | 'normal' | 'fyi'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Namespaced context storage
CREATE TABLE IF NOT EXISTS context_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  category    TEXT NOT NULL DEFAULT 'durable',
  expires_at  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT NOT NULL DEFAULT '',
  UNIQUE(namespace, key)
);

-- Bug tracking
CREATE TABLE IF NOT EXISTS bugs (
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
  linked_ticket_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plans (multi-step initiatives)
CREATE TABLE IF NOT EXISTS plans (
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

CREATE TABLE IF NOT EXISTS plan_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS plan_step_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id    INTEGER NOT NULL REFERENCES plan_steps(id) ON DELETE CASCADE,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Studio users (human operators)
CREATE TABLE IF NOT EXISTS studio_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Password reset tokens (SHA-256 hashed, single-use, 30-min expiry)
CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  url        TEXT NOT NULL,
  events     TEXT NOT NULL DEFAULT '["task_created","request_created","message_sent"]',
  secret     TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Drone compute job queue
CREATE TABLE IF NOT EXISTS drone_jobs (
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
  profile_id      TEXT,
  result_url      TEXT,
  result_data     TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shared concepts (characters, styles, rulesets, etc. that flow between projects)
CREATE TABLE IF NOT EXISTS concepts (
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
CREATE TABLE IF NOT EXISTS project_concepts (
  project_id      TEXT NOT NULL,
  concept_id      INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  linked_at       TEXT NOT NULL DEFAULT (datetime('now')),
  linked_by       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, concept_id)
);

-- Task comments
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

-- Support tickets (customer support)
CREATE TABLE IF NOT EXISTS support_tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id     TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT 'general',
  priority        TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'open',
  reporter_email  TEXT NOT NULL DEFAULT '',
  reporter_name   TEXT NOT NULL DEFAULT '',
  assignee        TEXT,
  resolution      TEXT NOT NULL DEFAULT '',
  linked_bug_id   INTEGER,
  tier            TEXT NOT NULL DEFAULT 'L2',
  assigned_agent  TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  draft_response  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_keys_ns ON context_keys(namespace);
CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status);
CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_owner ON plans(owner);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_steps_task ON plan_steps(linked_task_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_comments_step ON plan_step_comments(step_id);
CREATE INDEX IF NOT EXISTS idx_studio_users_username ON studio_users(username);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);
CREATE INDEX IF NOT EXISTS idx_drone_jobs_status ON drone_jobs(status);
CREATE INDEX IF NOT EXISTS idx_drone_jobs_drone ON drone_jobs(drone_id);
CREATE INDEX IF NOT EXISTS idx_drone_jobs_requester ON drone_jobs(requester);
CREATE INDEX IF NOT EXISTS idx_drone_jobs_priority ON drone_jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_concepts_type ON concepts(type);
CREATE INDEX IF NOT EXISTS idx_concepts_name ON concepts(name);
CREATE INDEX IF NOT EXISTS idx_project_concepts_project ON project_concepts(project_id);
CREATE INDEX IF NOT EXISTS idx_project_concepts_concept ON project_concepts(concept_id);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);

-- Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_bugs_severity ON bugs(severity);
CREATE INDEX IF NOT EXISTS idx_bugs_assignee ON bugs(assignee);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
-- Plugins (installable capability modules with routes, DB, MCP tools)
CREATE TABLE IF NOT EXISTS plugins (
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

CREATE TABLE IF NOT EXISTS plugin_migrations (
  plugin_name     TEXT NOT NULL,
  version         INTEGER NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  applied_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_name, version)
);

-- Approval gates (human-in-the-loop for agent actions)
CREATE TABLE IF NOT EXISTS approvals (
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

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_action ON approvals(action_type);
CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(requested_by);
CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);

-- Operators (human team members)
CREATE TABLE IF NOT EXISTS operators (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  responsibilities TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  studio_user_id  INTEGER REFERENCES studio_users(id),
  status          TEXT NOT NULL DEFAULT 'active',
  availability    TEXT NOT NULL DEFAULT 'available',
  last_seen_at    TEXT,
  away_message    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_operators_role ON operators(role);
CREATE INDEX IF NOT EXISTS idx_operators_status ON operators(status);

-- Instance configuration (per-deployment settings)
CREATE TABLE IF NOT EXISTS instance_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT NOT NULL DEFAULT ''
);

-- Multi-human approval voting
CREATE TABLE IF NOT EXISTS approval_votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  voter       TEXT NOT NULL,
  vote        TEXT NOT NULL DEFAULT 'approve',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(approval_id, voter)
);
CREATE INDEX IF NOT EXISTS idx_approval_votes_approval ON approval_votes(approval_id);
CREATE INDEX IF NOT EXISTS idx_approval_votes_voter ON approval_votes(voter);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_agent ON webhook_deliveries(agent_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries(event);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);

-- Chat channels
CREATE TABLE IF NOT EXISTS channels (
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

CREATE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug);
CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
CREATE INDEX IF NOT EXISTS idx_channels_linked ON channels(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

-- Channel membership
CREATE TABLE IF NOT EXISTS channel_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  user_type   TEXT NOT NULL DEFAULT 'agent',
  role        TEXT NOT NULL DEFAULT 'member',
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

-- Agent savepoints (persistent session state)
CREATE TABLE IF NOT EXISTS agent_savepoints (
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
CREATE INDEX IF NOT EXISTS idx_savepoints_agent ON agent_savepoints(agent_id, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_savepoints_session ON agent_savepoints(session_id);

-- Channel read tracking
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  last_read_at        TEXT,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel_id, user_id)
);

-- Operator inbox (human-facing messages, approvals, BIP drafts, @mentions)
CREATE TABLE IF NOT EXISTS operator_inbox (
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
CREATE INDEX IF NOT EXISTS idx_operator_inbox_operator ON operator_inbox(operator_id, status);
CREATE INDEX IF NOT EXISTS idx_operator_inbox_type ON operator_inbox(type);
CREATE INDEX IF NOT EXISTS idx_operator_inbox_entity ON operator_inbox(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_operator_inbox_created ON operator_inbox(created_at DESC);

-- Operator feedback on agent work (ratings + comments)
CREATE TABLE IF NOT EXISTS feedback (
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
CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_entity ON feedback(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);

-- Drone profiles (per-drone setup & dependency definitions)
CREATE TABLE IF NOT EXISTS drone_profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  requires    TEXT NOT NULL DEFAULT '{}',
  artifacts   TEXT NOT NULL DEFAULT '[]',
  setup_script TEXT NOT NULL DEFAULT '',
  workspace   TEXT NOT NULL DEFAULT '',
  env         TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Drone-to-profile assignments (tracks setup status per drone)
CREATE TABLE IF NOT EXISTS drone_profile_assignments (
  drone_id    TEXT NOT NULL,
  profile_id  TEXT NOT NULL REFERENCES drone_profiles(id) ON DELETE CASCADE,
  setup_done  INTEGER NOT NULL DEFAULT 0,
  setup_at    TEXT,
  checksum    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (drone_id, profile_id)
);
CREATE INDEX IF NOT EXISTS idx_drone_profile_assignments_drone ON drone_profile_assignments(drone_id);
CREATE INDEX IF NOT EXISTS idx_drone_profile_assignments_profile ON drone_profile_assignments(profile_id);

-- Job templates: reusable job type definitions for smart routing
CREATE TABLE IF NOT EXISTS job_templates (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  project_id          TEXT NOT NULL DEFAULT '',
  requires            TEXT NOT NULL DEFAULT '["cpu"]',
  min_vram_gb         REAL NOT NULL DEFAULT 0,
  min_disk_gb         REAL NOT NULL DEFAULT 5,
  python_deps         TEXT NOT NULL DEFAULT '[]',
  python_deps_install TEXT NOT NULL DEFAULT '',
  artifacts           TEXT NOT NULL DEFAULT '[]',
  setup_repo          TEXT NOT NULL DEFAULT '',
  command_template    TEXT NOT NULL DEFAULT '',
  workspace_name      TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plugin config: per-plugin key/value store (supports secrets)
CREATE TABLE IF NOT EXISTS plugin_config (
  plugin_name  TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL DEFAULT '',
  is_secret    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_name, key)
);
CREATE INDEX IF NOT EXISTS idx_plugin_config_plugin ON plugin_config(plugin_name);

-- Runner spawns (agent SDK session queue for mycelium-runner)
CREATE TABLE IF NOT EXISTS runner_spawns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tier           TEXT NOT NULL DEFAULT 'agent',
  model          TEXT NOT NULL DEFAULT '',
  cwd            TEXT NOT NULL DEFAULT '',
  max_turns      INTEGER NOT NULL DEFAULT 100,
  title          TEXT NOT NULL DEFAULT '',
  work_context   TEXT NOT NULL DEFAULT '',
  requested_by   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  runner_id      TEXT NOT NULL DEFAULT '',
  claimed_at     TEXT,
  result         TEXT NOT NULL DEFAULT '',
  done_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runner_spawns_status ON runner_spawns(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_instance ON support_tickets(instance_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);

-- Node profiles: Stand Up calibration system for agent/drone/admin behavior rules
CREATE TABLE IF NOT EXISTS node_profiles (
  id                 TEXT PRIMARY KEY,
  node_type          TEXT NOT NULL DEFAULT 'agent',
  layer              TEXT NOT NULL DEFAULT 'customer',
  parent_id          TEXT,
  rules              TEXT NOT NULL DEFAULT '{}',
  required_concepts  TEXT NOT NULL DEFAULT '[]',
  mcp_config         TEXT NOT NULL DEFAULT '{}',
  tool_whitelist     TEXT NOT NULL DEFAULT '[]',
  repo_list          TEXT NOT NULL DEFAULT '[]',
  md_checkpoints     TEXT NOT NULL DEFAULT '[]',
  md_blocklist       TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_profiles_layer ON node_profiles(layer);
CREATE INDEX IF NOT EXISTS idx_node_profiles_node_type ON node_profiles(node_type);

-- Customer instances (links billing to provisioning to deploys to churn)
CREATE TABLE IF NOT EXISTS customer_instances (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                TEXT NOT NULL,
  railway_project_id    TEXT,
  railway_service_id    TEXT,
  railway_environment_id TEXT,
  domain                TEXT,
  cloudflare_record_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'provisioning',
  version               TEXT,
  health_status         TEXT DEFAULT 'unknown',
  last_health_check     TEXT,
  admin_username        TEXT,
  customer_email        TEXT,
  suspended_at          TEXT,
  archived_at           TEXT,
  snapshot_url          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_instances_org ON customer_instances(org_id);
CREATE INDEX IF NOT EXISTS idx_instances_status ON customer_instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_domain ON customer_instances(domain);

-- Message read tracking (agent ↔ message acknowledgment)
CREATE TABLE IF NOT EXISTS message_reads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL,
  agent_id    TEXT NOT NULL,
  read_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_reads_agent ON message_reads(agent_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_message ON message_reads(message_id);

-- Team settings (customer-facing configuration that syncs to node profiles)
CREATE TABLE IF NOT EXISTS team_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT '',
  UNIQUE(section, key)
);
CREATE INDEX IF NOT EXISTS idx_team_settings_section ON team_settings(section);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_type TEXT NOT NULL DEFAULT 'operator',
  role TEXT NOT NULL DEFAULT 'member',
  is_primary INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_primary ON team_members(is_primary) WHERE is_primary = 1;
