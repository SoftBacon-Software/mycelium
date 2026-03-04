// =============== MYCELIUM — Database Layer ===============
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
var DB_PATH = path.join(DATA_DIR, 'mycelium.db');

var db;

export function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Migration: rename game -> project_id columns BEFORE schema (which references project_id)
  migrateGameToProjectId();

  // Migrations: add columns that may not exist yet on the LIVE database.
  // MUST run BEFORE schema.sql because schema has CREATE INDEX on these columns.
  var migrations = [
    ["dv_tasks", "blocked_by", "TEXT NOT NULL DEFAULT '[]'"],
    ["dv_tasks", "blocks", "TEXT NOT NULL DEFAULT '[]'"],
    ["dv_tasks", "needs_approval", "INTEGER NOT NULL DEFAULT 0"],
    ["dv_tasks", "approved_by", "TEXT"],
    ["dv_tasks", "approved_at", "TEXT"],
    ["dv_tasks", "linked_asset_id", "INTEGER"],
    ["dv_tasks", "request_id", "INTEGER"],
    ["dv_tasks", "branch", "TEXT"],
    ["dv_tasks", "pr_url", "TEXT"],
    ["dv_tasks", "repo", "TEXT"],
    ["dv_messages", "msg_type", "TEXT NOT NULL DEFAULT 'message'"],
    ["dv_messages", "status", "TEXT NOT NULL DEFAULT 'sent'"],
    ["dv_messages", "resolved_at", "TEXT"],
    ["dv_messages", "resolved_by", "TEXT"],
    ["dv_agents", "avatar_url", "TEXT NOT NULL DEFAULT ''"],
    ["dv_agents", "role", "TEXT NOT NULL DEFAULT 'agent'"],
    ["dv_agents", "operator_id", "TEXT NOT NULL DEFAULT ''"],
    ["dv_agents", "project", "TEXT NOT NULL DEFAULT ''"],
    ["dv_approvals", "risk_tier", "TEXT NOT NULL DEFAULT 'medium'"],
    ["dv_approvals", "required_approvals", "INTEGER NOT NULL DEFAULT 1"],
    ["dv_approvals", "current_approvals", "INTEGER NOT NULL DEFAULT 0"],
    ["dv_assets", "file_path", "TEXT NOT NULL DEFAULT ''"],
    ["dv_assets", "download_url", "TEXT NOT NULL DEFAULT ''"],
    ["dv_assets", "requested_by", "TEXT NOT NULL DEFAULT ''"],
    ["dv_assets", "assigned_to", "TEXT NOT NULL DEFAULT ''"],
    ["dv_messages", "channel_id", "INTEGER"],
    ["dv_drone_jobs", "workspace_repo", "TEXT"],
    ["dv_drone_jobs", "workspace_branch", "TEXT NOT NULL DEFAULT 'main'"],
    ["dv_assets", "drone_job_id", "INTEGER"],
    ["dv_assets", "prompt", "TEXT NOT NULL DEFAULT ''"],
    ["dv_agents", "llm_backend", "TEXT NOT NULL DEFAULT ''"],
    ["dv_agents", "llm_model", "TEXT NOT NULL DEFAULT ''"],
    ["dv_agents", "agent_type", "TEXT NOT NULL DEFAULT 'agent'"],
    ["dv_projects", "org_id", "TEXT NOT NULL DEFAULT ''"],
    ["dv_projects", "type", "TEXT NOT NULL DEFAULT 'software'"],
    ["dv_projects", "status", "TEXT NOT NULL DEFAULT 'active'"],
    ["dv_operators", "availability", "TEXT NOT NULL DEFAULT 'available'"],
    ["dv_operators", "last_seen_at", "TEXT"],
    ["dv_operators", "away_message", "TEXT NOT NULL DEFAULT ''"],
    // Step #197 — message priority tiers (urgent/normal/fyi)
    ["dv_messages", "priority", "TEXT NOT NULL DEFAULT 'normal'"],
    // Operator presence tracking — who's currently in the dashboard
    ["dv_studio_users", "last_seen", "TEXT"],
  ];

  for (var [table, col, def] of migrations) {
    try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def); } catch (e) { /* already exists */ }
  }

  // Run platform schema AFTER migrations (schema has CREATE INDEX on migrated columns)
  var schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Indexes on migrated columns
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_tasks_blocked ON dv_tasks(blocked_by)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_tasks_approval ON dv_tasks(needs_approval)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_type ON dv_messages(msg_type)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_status ON dv_messages(status)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_channel ON dv_messages(channel_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_priority ON dv_messages(priority)'); } catch (e) {}

  // Bug #43: drop dead columns from dv_messages (is_stale, rerouted_from, rerouted_at)
  // These were added in a prior branch but never used. SQLite 3.35+ supports DROP COLUMN.
  var deadCols = ['is_stale', 'rerouted_from', 'rerouted_at'];
  for (var dc of deadCols) {
    try { db.exec('ALTER TABLE dv_messages DROP COLUMN ' + dc); } catch (e) { /* doesn't exist or older SQLite — skip */ }
  }

  // Seed operators (if table is empty)
  var opCount = db.prepare('SELECT COUNT(*) as c FROM dv_operators').get();
  if (opCount.c === 0) {
    db.prepare("INSERT INTO dv_operators (id, display_name, role, responsibilities, email) VALUES (?, ?, ?, ?, ?)").run(
      'greatness', 'Greatness', 'owner', 'Platform dev, WS game, asset generation, coordination', 'grbarajas@gmail.com'
    );
    db.prepare("INSERT INTO dv_operators (id, display_name, role, responsibilities) VALUES (?, ?, ?, ?)").run(
      'hijack', 'Hijack', 'ui_lead', 'UI/UX, King City development, visual design'
    );
    db.prepare("INSERT INTO dv_operators (id, display_name, role, responsibilities) VALUES (?, ?, ?, ?)").run(
      'unakron', 'Unakron', 'member', 'Legal, security, penetration testing, breaking things on purpose. GPU compute.'
    );
    console.log('Seeded dv_operators with 3 team members');
  }

  // Seed instance config (if table is empty)
  var cfgCount = db.prepare('SELECT COUNT(*) as c FROM dv_instance_config').get();
  if (cfgCount.c === 0) {
    var riskTiers = JSON.stringify({
      plan_create: 'low', context_change: 'low',
      deploy: 'medium', git_push: 'medium', delete: 'medium',
      external_comm: 'high',
      money_action: 'critical', delete_agent: 'critical', instance_config: 'critical'
    });
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('instance_mode', 'developer', 'system');
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_agent_id', 'greatness-claude', 'system');
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_status', 'coordinator', 'system');
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('risk_tiers', riskTiers, 'system');
    console.log('Seeded dv_instance_config with 4 keys');
  }

  // Update agent roles (agents may not exist yet, so wrap in try/catch)
  try {
    db.prepare("UPDATE dv_agents SET role = ?, operator_id = ?, project = ? WHERE id = ?").run('admin', 'greatness', 'willing-sacrifice', 'greatness-claude');
  } catch (e) { /* agent may not exist */ }
  try {
    db.prepare("UPDATE dv_agents SET role = ?, operator_id = ?, project = ? WHERE id = ?").run('agent', 'hijack', 'king-city', 'hijack-claude');
  } catch (e) { /* agent may not exist */ }
  try {
    db.prepare("UPDATE dv_agents SET role = ?, operator_id = ?, project = ? WHERE id = ?").run('drone', 'unakron', 'drone', 'unakron-gpu');
  } catch (e) { /* agent may not exist */ }

  ensureDefaultChannels();

  console.log('Mycelium DB initialized at ' + DB_PATH);
}

// Migration: rename game -> project_id columns for enterprise-ready schema
function migrateGameToProjectId() {
  var tables = [
    ['dv_agents', 'game', 'project_id'],
    ['dv_tasks', 'game', 'project_id'],
    ['dv_context', 'game', 'project_id'],
    ['dv_assets', 'game', 'project_id'],
    ['dv_events', 'game', 'project_id'],
    ['dv_messages', 'game', 'project_id'],
    ['dv_bugs', 'game', 'project_id'],
    ['dv_plans', 'game', 'project_id'],
    ['dv_approvals', 'project', 'project_id'],
  ];
  for (var [table, oldCol, newCol] of tables) {
    try {
      var info = db.prepare("PRAGMA table_info(" + table + ")").all();
      var hasOld = info.some(function(c) { return c.name === oldCol; });
      var hasNew = info.some(function(c) { return c.name === newCol; });
      if (hasOld && !hasNew) {
        db.prepare("ALTER TABLE " + table + " RENAME COLUMN " + oldCol + " TO " + newCol).run();
        console.log('[migration] Renamed ' + table + '.' + oldCol + ' -> ' + newCol);
      }
    } catch (e) {
      console.error('[migration] Error renaming ' + table + '.' + oldCol + ':', e.message);
    }
  }
  // Rename dv_games table to dv_projects
  try {
    var gamesTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dv_games'").all();
    if (gamesTables.length > 0) {
      db.prepare("ALTER TABLE dv_games RENAME TO dv_projects").run();
      console.log('[migration] Renamed table dv_games -> dv_projects');
    }
  } catch (e) {
    console.error('[migration] Error renaming dv_games:', e.message);
  }
}

// Prepared statement cache
var _stmts = {};
function stmt(key, sql) {
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

// =============== DIOVERSE HUB ===============

// -- Agents --

export function createAgent(id, name, projectId, apiKeyHash, capabilities) {
  stmt('dvCreateAgent', `INSERT INTO dv_agents (id, name, project_id, api_key_hash, capabilities)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, projectId, apiKeyHash, capabilities || '[]');
}

export function getAgent(id) {
  return stmt('dvGetAgent', 'SELECT * FROM dv_agents WHERE id = ?').get(id);
}

export function getAgentByKeyHash(apiKeyHash) {
  return stmt('dvGetAgentByKey', 'SELECT * FROM dv_agents WHERE api_key_hash = ?').get(apiKeyHash);
}

export function listAgents() {
  return stmt('dvListAgents3', "SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, created_at FROM dv_agents WHERE project_id != 'drone' ORDER BY created_at").all();
}

export function listAllAgentsIncludingDrones() {
  return stmt('dvListAllAgents', 'SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, created_at FROM dv_agents ORDER BY created_at').all();
}

export function updateAgentHeartbeat(id, status, workingOn) {
  stmt('dvHeartbeat', `UPDATE dv_agents SET status = ?, working_on = ?, last_heartbeat = datetime('now')
    WHERE id = ?`).run(status || 'online', workingOn || '', id);
}

export function updateAgentKey(id, apiKeyHash) {
  stmt('dvUpdateAgentKey', 'UPDATE dv_agents SET api_key_hash = ? WHERE id = ?').run(apiKeyHash, id);
}

export function deleteAgent(id) {
  stmt('dvDeleteAgent', 'DELETE FROM dv_agents WHERE id = ?').run(id);
}

export function updateAgent(id, fields) {
  var sets = []; var values = [];
  if (fields.avatar_url !== undefined) { sets.push('avatar_url = ?'); values.push(fields.avatar_url); }
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.operator_id !== undefined) { sets.push('operator_id = ?'); values.push(fields.operator_id); }
  if (fields.project !== undefined) { sets.push('project = ?'); values.push(fields.project); }
  if (fields.project_id !== undefined) { sets.push('project_id = ?'); values.push(fields.project_id); }
  if (fields.llm_backend !== undefined) { sets.push('llm_backend = ?'); values.push(fields.llm_backend); }
  if (fields.llm_model !== undefined) { sets.push('llm_model = ?'); values.push(fields.llm_model); }
  if (fields.agent_type !== undefined) { sets.push('agent_type = ?'); values.push(fields.agent_type); }
  if (fields.capabilities !== undefined) { sets.push('capabilities = ?'); values.push(fields.capabilities); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_agents SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Operators --

export function createOperator(id, displayName, role, responsibilities, email, studioUserId) {
  stmt('dvCreateOperator', `INSERT INTO dv_operators (id, display_name, role, responsibilities, email, studio_user_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, displayName, role || 'member', responsibilities || '', email || '', studioUserId || null);
}

export function getOperator(id) {
  return stmt('dvGetOperator', 'SELECT * FROM dv_operators WHERE id = ?').get(id);
}

export function listOperators() {
  return stmt('dvListOperators', 'SELECT * FROM dv_operators ORDER BY created_at').all();
}

export function updateOperator(id, fields) {
  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (fields.display_name !== undefined) { sets.push('display_name = ?'); values.push(fields.display_name); }
  if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.responsibilities !== undefined) { sets.push('responsibilities = ?'); values.push(fields.responsibilities); }
  if (fields.email !== undefined) { sets.push('email = ?'); values.push(fields.email); }
  if (fields.studio_user_id !== undefined) { sets.push('studio_user_id = ?'); values.push(fields.studio_user_id); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.availability !== undefined) { sets.push('availability = ?'); values.push(fields.availability); }
  if (fields.away_message !== undefined) { sets.push('away_message = ?'); values.push(fields.away_message); }
  values.push(id);
  db.prepare('UPDATE dv_operators SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function setOperatorAvailability(id, availability, awayMessage) {
  db.prepare(`UPDATE dv_operators SET availability = ?, away_message = ?, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(availability, awayMessage || '', id);
}

export function getAvailableOperators() {
  return db.prepare("SELECT * FROM dv_operators WHERE status = 'active' AND availability = 'available'").all();
}

export function isNetworkAutonomous() {
  var count = db.prepare("SELECT COUNT(*) as c FROM dv_operators WHERE status = 'active' AND availability = 'available'").get();
  return count.c === 0;
}

export function deleteOperator(id) {
  stmt('dvDeleteOperator', 'DELETE FROM dv_operators WHERE id = ?').run(id);
}

// -- Instance Config --

export function getInstanceConfig(key) {
  var row = stmt('dvGetConfig', 'SELECT value FROM dv_instance_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setInstanceConfig(key, value, updatedBy) {
  stmt('dvSetConfig', `INSERT INTO dv_instance_config (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(key, value, updatedBy || '');
}

export function listInstanceConfig() {
  return stmt('dvListConfig', 'SELECT * FROM dv_instance_config ORDER BY key').all();
}

export function deleteInstanceConfig(key) {
  stmt('dvDeleteConfig', 'DELETE FROM dv_instance_config WHERE key = ?').run(key);
}

// -- Sleep Mode --

export function getSleepMode() {
  var val = getInstanceConfig('sleep_mode');
  if (!val) return { active: false };
  try { return JSON.parse(val); } catch (e) { return { active: false }; }
}

export function appendSleepLog(field, item) {
  var val = getInstanceConfig('sleep_mode_log');
  var log;
  try { log = val ? JSON.parse(val) : {}; } catch (e) { log = {}; }
  if (!log[field]) log[field] = [];
  if (Array.isArray(log[field])) {
    log[field].push(item);
  }
  setInstanceConfig('sleep_mode_log', JSON.stringify(log), '__system__');
}

// -- Projects --

// -- Organizations --

export function createOrg(id, name, description, ownerId) {
  stmt('dvCreateOrg', `INSERT OR IGNORE INTO dv_organizations (id, name, description, owner_id)
    VALUES (?, ?, ?, ?)`).run(id, name, description || '', ownerId || '');
}

export function listOrgs() {
  return stmt('dvListOrgs', 'SELECT * FROM dv_organizations ORDER BY created_at').all();
}

export function getOrg(id) {
  return stmt('dvGetOrg', 'SELECT * FROM dv_organizations WHERE id = ?').get(id);
}

export function updateOrg(id, fields) {
  var sets = []; var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.plan !== undefined) { sets.push('plan = ?'); values.push(fields.plan); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_organizations SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteOrg(id) {
  db.prepare('DELETE FROM dv_organizations WHERE id = ?').run(id);
}

// -- Projects --

export function createProject(id, name, description, repoUrl, orgId, type) {
  stmt('dvCreateProject', `INSERT OR IGNORE INTO dv_projects (id, name, description, repo_url, org_id, type)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, description || '', repoUrl || '', orgId || '', type || 'software');
}

export function listProjects(orgId) {
  if (orgId) return db.prepare('SELECT * FROM dv_projects WHERE org_id = ? ORDER BY created_at').all(orgId);
  return stmt('dvListProjects', 'SELECT * FROM dv_projects ORDER BY created_at').all();
}

export function getProject(id) {
  return stmt('dvGetProject', 'SELECT * FROM dv_projects WHERE id = ?').get(id);
}

export function updateProject(id, fields) {
  var sets = []; var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.repo_url !== undefined) { sets.push('repo_url = ?'); values.push(fields.repo_url); }
  if (fields.org_id !== undefined) { sets.push('org_id = ?'); values.push(fields.org_id); }
  if (fields.type !== undefined) { sets.push('type = ?'); values.push(fields.type); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_projects SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Tasks --

export function createDvTask(title, description, projectId, requester, priority, tags) {
  var result = stmt('dvCreateTask', `INSERT INTO dv_tasks (title, description, project_id, requester, priority, tags)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(title, description || '', projectId || '', requester, priority || 'normal', tags || '[]');
  return result.id;
}

export function getDvTask(id) {
  return stmt('dvGetTask', 'SELECT * FROM dv_tasks WHERE id = ?').get(id);
}

export function listDvTasks(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.requester) { where.push('requester = ?'); params.push(filters.requester); }
  if (filters.priority) { where.push('priority = ?'); params.push(filters.priority); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_tasks WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateDvTask(id, fields) {
  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.assignee !== undefined) { sets.push('assignee = ?'); values.push(fields.assignee); }
  if (fields.priority !== undefined) { sets.push('priority = ?'); values.push(fields.priority); }
  if (fields.tags !== undefined) { sets.push('tags = ?'); values.push(fields.tags); }
  if (fields.needs_approval !== undefined) { sets.push('needs_approval = ?'); values.push(fields.needs_approval ? 1 : 0); }
  if (fields.blocked_by !== undefined) { sets.push('blocked_by = ?'); values.push(JSON.stringify(fields.blocked_by)); }
  if (fields.blocks !== undefined) { sets.push('blocks = ?'); values.push(JSON.stringify(fields.blocks)); }
  if (fields.branch !== undefined) { sets.push('branch = ?'); values.push(fields.branch); }
  if (fields.pr_url !== undefined) { sets.push('pr_url = ?'); values.push(fields.pr_url); }
  if (fields.repo !== undefined) { sets.push('repo = ?'); values.push(fields.repo); }
  values.push(id);
  return db.prepare('UPDATE dv_tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Task dependencies --

export function setTaskDependency(taskId, blockedById) {
  var task = getDvTask(taskId);
  var blocker = getDvTask(blockedById);
  if (!task || !blocker) return false;

  var blockedBy = [];
  try { blockedBy = JSON.parse(task.blocked_by || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocked_by (task: ' + taskId + '):', e.message); }
  if (blockedBy.indexOf(blockedById) === -1) {
    blockedBy.push(blockedById);
    db.prepare("UPDATE dv_tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(blockedBy), taskId);
  }

  var blocks = [];
  try { blocks = JSON.parse(blocker.blocks || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocks (task: ' + blockedById + '):', e.message); }
  if (blocks.indexOf(taskId) === -1) {
    blocks.push(taskId);
    db.prepare("UPDATE dv_tasks SET blocks = ? WHERE id = ?").run(JSON.stringify(blocks), blockedById);
  }
  return true;
}

export function resolveTaskDependencies(completedTaskId) {
  var task = getDvTask(completedTaskId);
  if (!task) return [];
  var blocks = [];
  try { blocks = JSON.parse(task.blocks || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocks (task: ' + completedTaskId + '):', e.message); }

  var unblocked = [];
  for (var blockedId of blocks) {
    var blocked = getDvTask(blockedId);
    if (!blocked) continue;
    var deps = [];
    try { deps = JSON.parse(blocked.blocked_by || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocked_by (task: ' + blockedId + '):', e.message); }
    deps = deps.filter(function (d) { return d !== completedTaskId; });
    db.prepare("UPDATE dv_tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(deps), blockedId);
    if (deps.length === 0) unblocked.push(blockedId);
  }
  return unblocked;
}

// -- Task approval --

export function approveDvTask(taskId, approvedBy) {
  db.prepare("UPDATE dv_tasks SET approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(approvedBy, taskId);
}

export function listTasksNeedingApproval() {
  return db.prepare("SELECT * FROM dv_tasks WHERE needs_approval = 1 AND approved_by IS NULL AND status != 'done' ORDER BY updated_at DESC").all();
}

// -- Task Comments --

export function addTaskComment(taskId, author, content) {
  var result = db.prepare(
    "INSERT INTO dv_task_comments (task_id, author, content) VALUES (?, ?, ?) RETURNING *"
  ).get(taskId, author, content);
  return result;
}

export function getTaskComments(taskId) {
  return db.prepare(
    "SELECT * FROM dv_task_comments WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId);
}

export function deleteTaskComment(commentId) {
  var result = db.prepare("DELETE FROM dv_task_comments WHERE id = ?").run(commentId);
  return result.changes > 0;
}

// -- Plan Step Comments --

export function addPlanStepComment(stepId, planId, author, content) {
  var result = db.prepare(
    "INSERT INTO dv_plan_step_comments (step_id, plan_id, author, content) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(stepId, planId, author, content);
  return result;
}

export function getPlanStepComments(stepId) {
  return db.prepare(
    "SELECT * FROM dv_plan_step_comments WHERE step_id = ? ORDER BY created_at ASC"
  ).all(stepId);
}

// -- Context --

export function getDvContext(projectId) {
  return stmt('dvGetContext', 'SELECT * FROM dv_context WHERE project_id = ?').get(projectId);
}

export function getAllDvContext() {
  return stmt('dvGetAllContext', 'SELECT * FROM dv_context ORDER BY updated_at DESC').all();
}

export function upsertDvContext(projectId, data, agentId) {
  stmt('dvUpsertContext', `INSERT INTO dv_context (project_id, data, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(projectId, data, agentId);
}

// -- Assets --

export function createDvAsset(name, type, projectId, status, assetPath, metadata, requester) {
  var result = stmt('dvCreateAsset', `INSERT INTO dv_assets (name, type, project_id, status, path, metadata, requester)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(name, type || 'sprite', projectId || 'shared', status || 'requested', assetPath || '', metadata || '{}', requester || '');
  return result.id;
}

export function getDvAsset(id) {
  return stmt('dvGetAsset', 'SELECT * FROM dv_assets WHERE id = ?').get(id);
}

export function listDvAssets(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_assets WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateDvAsset(id, fields) {
  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.path !== undefined) { sets.push('path = ?'); values.push(fields.path); }
  if (fields.metadata !== undefined) { sets.push('metadata = ?'); values.push(fields.metadata); }
  if (fields.file_path !== undefined) { sets.push('file_path = ?'); values.push(fields.file_path); }
  if (fields.download_url !== undefined) { sets.push('download_url = ?'); values.push(fields.download_url); }
  if (fields.requested_by !== undefined) { sets.push('requested_by = ?'); values.push(fields.requested_by); }
  if (fields.assigned_to !== undefined) { sets.push('assigned_to = ?'); values.push(fields.assigned_to); }
  if (fields.drone_job_id !== undefined) { sets.push('drone_job_id = ?'); values.push(fields.drone_job_id); }
  if (fields.prompt !== undefined) { sets.push('prompt = ?'); values.push(fields.prompt); }
  values.push(id);
  return db.prepare('UPDATE dv_assets SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteDvAsset(id) {
  return db.prepare('DELETE FROM dv_assets WHERE id = ?').run(id);
}

export function listAssetsByDroneJob(droneJobId) {
  return db.prepare('SELECT * FROM dv_assets WHERE drone_job_id = ?').all(droneJobId);
}

// -- Events --

export function createDvEvent(type, agent, projectId, summary, data) {
  var result = stmt('dvCreateEvent', `INSERT INTO dv_events (type, agent, project_id, summary, data)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).get(type, agent || '', projectId || null, summary || '', data || '{}');
  return result.id;
}

export function listDvEvents(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.agent) { where.push('agent = ?'); params.push(filters.agent); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_events WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

// -- Messages --

var VALID_MSG_PRIORITIES = ['urgent', 'normal', 'fyi'];

export function createDvMessage(fromAgent, toAgent, threadId, projectId, content, metadata, msgType, channelId, priority) {
  var prio = VALID_MSG_PRIORITIES.includes(priority) ? priority : 'normal';
  if (msgType && msgType !== 'message') {
    var result = db.prepare(
      "INSERT INTO dv_messages (from_agent, to_agent, thread_id, project_id, content, metadata, msg_type, channel_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}', msgType, channelId || null, prio);
    return result.id;
  }
  var result = db.prepare(
    "INSERT INTO dv_messages (from_agent, to_agent, thread_id, project_id, content, metadata, channel_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}', channelId || null, prio);
  return result.id;
}

export function createDvRequest(fromAgent, toAgent, threadId, projectId, content, metadata) {
  var result = db.prepare(
    "INSERT INTO dv_messages (from_agent, to_agent, thread_id, project_id, content, metadata, msg_type, status, priority) VALUES (?, ?, ?, ?, ?, ?, 'request', 'pending', 'urgent') RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}');
  return result.id;
}

export function acknowledgeDvMessage(id) {
  db.prepare("UPDATE dv_messages SET status = 'acknowledged' WHERE id = ?").run(id);
}

export function resolveDvMessage(id, resolvedBy) {
  db.prepare("UPDATE dv_messages SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").run(resolvedBy, id);
}

export function listPendingRequests(agentId) {
  return db.prepare(
    "SELECT * FROM dv_messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
}

export function countPendingForAgent(agentId) {
  var row = db.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM dv_messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent')) as requests, " +
    "(SELECT COUNT(*) FROM dv_messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent')) as directives, " +
    "(SELECT COUNT(*) FROM dv_messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND status = 'sent') as unread"
  ).get(agentId, agentId, agentId);
  return row;
}

export function getDvMessage(id) {
  return db.prepare("SELECT * FROM dv_messages WHERE id = ?").get(id);
}

export function listDvMessages(filters) {
  var where = ["msg_type != 'chat'"];
  var params = [];
  // Exclude system-to-system telemetry (runner health, etc) unless explicitly requested
  if (!filters.include_system) {
    where.push("NOT (from_agent = '__system__' AND to_agent = '__system__')");
  }
  if (filters.from_agent) { where.push('from_agent = ?'); params.push(filters.from_agent); }
  if (filters.to_agent) { where.push('(to_agent = ? OR to_agent IS NULL)'); params.push(filters.to_agent); }
  if (filters.thread_id) { where.push('thread_id = ?'); params.push(filters.thread_id); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  if (filters.channel_id) { where.push('channel_id = ?'); params.push(filters.channel_id); }
  if (filters.msg_type) { where.push('msg_type = ?'); params.push(filters.msg_type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.priority) { where.push('priority = ?'); params.push(filters.priority); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  // Sort: urgent messages first (within same time window), then by created_at DESC
  var orderBy = filters.priority_sort
    ? "CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at DESC"
    : 'created_at DESC';
  return db.prepare('SELECT * FROM dv_messages WHERE ' + where.join(' AND ') + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?').all(...params);
}

export function listDvThreads(limit) {
  return db.prepare(`SELECT thread_id, COUNT(*) as message_count,
    MAX(created_at) as last_message_at,
    (SELECT from_agent FROM dv_messages m2 WHERE m2.thread_id = dv_messages.thread_id ORDER BY created_at DESC LIMIT 1) as last_sender
    FROM dv_messages WHERE thread_id IS NOT NULL
    GROUP BY thread_id ORDER BY last_message_at DESC LIMIT ?`).all(Math.min(limit || 20, 500));
}

export function bulkDeleteMessages(filters) {
  var conditions = [];
  var params = [];
  if (filters.from) { conditions.push('from_agent = ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('to_agent = ?'); params.push(filters.to); }
  if (filters.content_like) { conditions.push('content LIKE ?'); params.push('%' + filters.content_like + '%'); }
  if (conditions.length === 0) return 0;
  var sql = 'DELETE FROM dv_messages WHERE ' + conditions.join(' AND ');
  return db.prepare(sql).run(...params).changes;
}

// -- Namespaced context --

export function upsertDvContextKey(namespace, key, data, agentId) {
  var existing = db.prepare("SELECT data FROM dv_context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
  var merged = data;
  if (existing) {
    try {
      var existingData = JSON.parse(existing.data);
      var newData = typeof data === 'string' ? JSON.parse(data) : data;
      merged = JSON.stringify(Object.assign({}, existingData, newData));
    } catch (e) {
      merged = typeof data === 'string' ? data : JSON.stringify(data);
    }
  } else {
    merged = typeof data === 'string' ? data : JSON.stringify(data);
  }
  db.prepare(
    "INSERT INTO dv_context_keys (namespace, key, data, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(namespace, key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).run(namespace, key, merged, agentId);
}

export function getDvContextKey(namespace, key) {
  return db.prepare("SELECT * FROM dv_context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
}

export function listDvContextKeys(namespace) {
  if (namespace) {
    return db.prepare("SELECT * FROM dv_context_keys WHERE namespace = ? ORDER BY key").all(namespace);
  }
  return db.prepare("SELECT * FROM dv_context_keys ORDER BY namespace, key").all();
}

export function deleteDvContextKey(namespace, key) {
  db.prepare("DELETE FROM dv_context_keys WHERE namespace = ? AND key = ?").run(namespace, key);
}

// -- Bugs --

export function createDvBug(projectId, title, description, category, severity, reporter, assignee, diagnosticData) {
  var result = db.prepare(
    "INSERT INTO dv_bugs (project_id, title, description, category, severity, reporter, assignee, diagnostic_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(projectId || '', title, description, category || 'other', severity || 'normal', reporter || 'admin', assignee || null, diagnosticData || null);
  return result.id;
}

export function getDvBug(id) {
  return db.prepare("SELECT * FROM dv_bugs WHERE id = ?").get(id);
}

export function listDvBugs(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.reporter) { where.push('reporter = ?'); params.push(filters.reporter); }
  if (filters.severity) { where.push('severity = ?'); params.push(filters.severity); }
  if (filters.category) { where.push('category = ?'); params.push(filters.category); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_bugs WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateDvBug(id, updates) {
  var sets = ["updated_at = datetime('now')"];
  var params = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.assignee !== undefined) { sets.push('assignee = ?'); params.push(updates.assignee); }
  if (updates.admin_notes !== undefined) { sets.push('admin_notes = ?'); params.push(updates.admin_notes); }
  if (updates.severity !== undefined) { sets.push('severity = ?'); params.push(updates.severity); }
  params.push(id);
  db.prepare('UPDATE dv_bugs SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
}

export function deleteDvBug(id) {
  return db.prepare('DELETE FROM dv_bugs WHERE id = ?').run(id);
}

export function countDvBugs() {
  return db.prepare("SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress, SUM(CASE WHEN status = 'fixed' THEN 1 ELSE 0 END) as fixed, COUNT(*) as total FROM dv_bugs").get();
}

// -- Boot payload --

export function getBootPayload(agentId) {
  var agent = getAgent(agentId);
  if (!agent) return null;
  var { api_key_hash, ...safeAgent } = agent;

  var myTasks = db.prepare(
    "SELECT * FROM dv_tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC"
  ).all(agentId);

  var pendingRequests = listPendingRequests(agentId);

  var since = agent.last_heartbeat || '2000-01-01';
  var newMessages = db.prepare(
    "SELECT * FROM dv_messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND created_at > ? ORDER BY created_at DESC LIMIT 50"
  ).all(agentId, since);

  var pendingDirectives = db.prepare(
    "SELECT * FROM dv_messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
  ).all(agentId);

  var capabilities = [];
  try { capabilities = JSON.parse(agent.capabilities || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for agent.capabilities (agent: ' + agentId + '):', e.message); }
  var assetRequests = [];
  if (capabilities.indexOf('assets') !== -1) {
    assetRequests = db.prepare(
      "SELECT * FROM dv_assets WHERE status = 'requested' ORDER BY created_at DESC LIMIT 50"
    ).all();
  }

  // Only include agents active in last 7 days or in the same project
  var otherAgents = db.prepare(
    "SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project FROM dv_agents WHERE id != ? AND (project_id = ? OR last_heartbeat > datetime('now', '-7 days')) ORDER BY created_at"
  ).all(agentId, agent.project_id);

  var projectContext = getDvContext(agent.project_id);
  var contextKeys = listDvContextKeys(agent.project_id);
  // Include platform-wide context (mycelium namespace) so agents get conventions on boot
  var platformKeys = agent.project_id !== 'mycelium' ? listDvContextKeys('mycelium') : [];
  // Also include agent-specific context
  var agentKeys = listDvContextKeys(agentId);

  var approvalQueue = listTasksNeedingApproval();
  var recentEvents = listDvEvents({ limit: 20 });
  var openBugs = listDvBugs({ status: 'open', limit: 20 });

  // Active/draft plans for agent's project — summaries only in boot (agents use check_plans for full steps)
  var myPlans = listDvPlans({ project_id: agent.project_id, limit: 20 });

  // Auto-heartbeat on boot
  updateAgentHeartbeat(agentId, 'online', agent.working_on);

  var myChannels = getChannelsByUser(agentId);
  var unreadCounts = getUnreadCounts(agentId);
  var unreadMap = {};
  for (var uc of unreadCounts) {
    unreadMap[uc.channel_id] = uc.unread;
  }
  for (var ch of myChannels) {
    ch.unread = unreadMap[ch.id] || 0;
  }

  // --- Role contract: compiled from agent fields + context keys ---
  var roleContract = buildRoleContract(agent, agentId);

  // --- Prioritized work queue ---
  var workQueue = buildWorkQueue(agentId, agent.project_id, pendingDirectives, pendingRequests, myTasks, openBugs, myPlans);

  // --- Project record ---
  var project = getProject(agent.project_id);

  // --- Project concepts: cross-project creative DNA ---
  var concepts = [];
  if (agent.project_id) {
    concepts = getProjectConcepts(agent.project_id);
    for (var con of concepts) {
      try { con.data = JSON.parse(con.data); } catch (e) { /* keep as string */ }
    }
  }

  return {
    agent: safeAgent,
    project: project || null,
    role_contract: roleContract,
    work_queue: workQueue,
    tasks: myTasks,
    pending_requests: pendingRequests,
    new_messages: newMessages,
    pending_directives: pendingDirectives,
    asset_requests: assetRequests,
    other_agents: otherAgents,
    project_context: projectContext,
    context_keys: contextKeys,
    platform_context: platformKeys,
    agent_context: agentKeys,
    approval_queue: approvalQueue,
    my_approvals: listPendingApprovalsByAgent(agentId),
    recent_events: recentEvents,
    open_bugs: openBugs,
    plans: myPlans,
    channels: myChannels,
    unread_counts: unreadMap,
    concepts: concepts,
    plugins: listPluginRecords().filter(function (p) { return p.enabled; }),
    team_agents: otherAgents.filter(function (a) { return a.project_id === agent.project_id; }),
    server_time: new Date().toISOString()
  };
}

// Build a role contract from agent fields + context keys
function buildRoleContract(agent, agentId) {
  var capabilities = [];
  try { capabilities = JSON.parse(agent.capabilities || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for agent.capabilities (agent: ' + agentId + '):', e.message); }

  var contract = {
    agent_id: agentId,
    role: agent.role || 'agent',
    project_id: agent.project_id,
    capabilities: capabilities,
    llm_backend: agent.llm_backend || null,
    llm_model: agent.llm_model || null,
    // Role-specific fields populated from context keys
    description: null,
    responsibilities: [],
    constraints: [],
    guidelines: null,
  };

  // Check for agent-specific role contract in context: namespace "roles", key = agentId
  var agentRole = getDvContextKey('roles', agentId);
  if (agentRole) {
    try {
      var roleData = typeof agentRole.data === 'string' ? JSON.parse(agentRole.data) : agentRole.data;
      if (roleData.description) contract.description = roleData.description;
      if (roleData.responsibilities) contract.responsibilities = roleData.responsibilities;
      if (roleData.constraints) contract.constraints = roleData.constraints;
      if (roleData.guidelines) contract.guidelines = roleData.guidelines;
    } catch (e) { console.warn('[mycelium] JSON parse failed for role_contract.data (agent: ' + agentId + '):', e.message); }
  }

  // Check for project-level guidelines: namespace = project_id, key = "guidelines"
  var projGuidelines = getDvContextKey(agent.project_id, 'guidelines');
  if (projGuidelines && !contract.guidelines) {
    try {
      var gData = typeof projGuidelines.data === 'string' ? JSON.parse(projGuidelines.data) : projGuidelines.data;
      contract.guidelines = typeof gData === 'string' ? gData : (gData.text || gData.guidelines || JSON.stringify(gData));
    } catch (e) {
      console.warn('[mycelium] JSON parse failed for project_guidelines.data (project: ' + agent.project_id + '):', e.message);
      contract.guidelines = projGuidelines.data;
    }
  }

  return contract;
}

// Build a prioritized work queue: what should this agent do next?
function buildWorkQueue(agentId, projectId, directives, requests, tasks, bugs, plans) {
  var queue = [];

  // Priority 1: Blocking directives (MUST respond first)
  for (var d of directives) {
    queue.push({ priority: 0, type: 'directive', id: d.id, title: 'DIRECTIVE from ' + d.from_agent, summary: (d.content || '').substring(0, 200), status: d.status });
  }

  // Priority 2: Pending requests (respond before new work)
  for (var r of requests) {
    queue.push({ priority: 1, type: 'request', id: r.id, title: 'Request from ' + r.from_agent, summary: (r.content || '').substring(0, 200), status: r.status });
  }

  // Priority 3: In-progress plan steps assigned to this agent
  // Priority 4: Pending plan steps assigned to this agent
  for (var plan of plans) {
    if (!plan.steps) continue;
    for (var step of plan.steps) {
      if (step.assignee === agentId && step.status === 'in_progress') {
        queue.push({ priority: 2, type: 'plan_step', id: step.id, plan_id: plan.id, plan_title: plan.title, title: step.title, status: step.status });
      }
    }
    for (var step of plan.steps) {
      if (step.assignee === agentId && step.status === 'pending') {
        queue.push({ priority: 3, type: 'plan_step', id: step.id, plan_id: plan.id, plan_title: plan.title, title: step.title, status: step.status });
      }
    }
  }

  // Priority 5: In-progress tasks
  for (var t of tasks) {
    if (t.status === 'in_progress') {
      queue.push({ priority: 4, type: 'task', id: t.id, title: t.title, status: t.status, project_id: t.project_id });
    }
  }

  // Priority 6: Open tasks assigned to this agent
  for (var t of tasks) {
    if (t.status === 'open') {
      queue.push({ priority: 5, type: 'task', id: t.id, title: t.title, status: t.status, project_id: t.project_id });
    }
  }

  // Priority 7: Bugs assigned to this agent
  var myBugs = bugs.filter(function (b) { return b.assignee === agentId; });
  for (var b of myBugs) {
    queue.push({ priority: 6, type: 'bug', id: b.id, title: b.title, severity: b.severity, status: b.status, project_id: b.project_id });
  }

  // Priority 8: Unassigned plan steps for this agent's project
  for (var plan of plans) {
    if (!plan.steps) continue;
    for (var step of plan.steps) {
      if (!step.assignee && step.status === 'pending') {
        queue.push({ priority: 7, type: 'plan_step_unassigned', id: step.id, plan_id: plan.id, plan_title: plan.title, title: step.title, status: step.status });
      }
    }
  }

  // Priority 9: Unassigned bugs for this agent's project
  var unassignedBugs = bugs.filter(function (b) { return !b.assignee && (b.project_id === projectId || !b.project_id); });
  for (var b of unassignedBugs) {
    queue.push({ priority: 8, type: 'bug_unassigned', id: b.id, title: b.title, severity: b.severity, status: b.status, project_id: b.project_id });
  }

  // Sort by priority (already mostly sorted but ensure it)
  queue.sort(function (a, b) { return a.priority - b.priority; });

  return queue;
}

// -- Auto-dispatch: find idle agents and assign them work --

export function getIdleAgents() {
  // Agents that are online/idle, not drones, heartbeat within last 30 minutes
  return db.prepare(`
    SELECT id, name, project_id, status, working_on, capabilities, role
    FROM dv_agents
    WHERE status IN ('online', 'idle')
      AND role != 'drone'
      AND last_heartbeat > datetime('now', '-30 minutes')
    ORDER BY last_heartbeat DESC
  `).all();
}

export function getNextUnassignedTask(excludeIds) {
  // Find highest priority open task not assigned to anyone
  var exclude = excludeIds && excludeIds.length > 0
    ? ' AND id NOT IN (' + excludeIds.map(() => '?').join(',') + ')'
    : '';
  var params = excludeIds && excludeIds.length > 0 ? [...excludeIds] : [];
  return db.prepare(
    `SELECT * FROM dv_tasks
     WHERE status = 'open' AND (assignee IS NULL OR assignee = '')
     ${exclude}
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`
  ).get(...params) || null;
}

export function getNextUnassignedPlanStep() {
  // Find next unassigned pending plan step from an active plan
  return db.prepare(
    `SELECT s.*, p.title as plan_title
     FROM dv_plan_steps s
     JOIN dv_plans p ON p.id = s.plan_id
     WHERE p.status = 'active'
       AND s.status = 'pending'
       AND (s.assignee IS NULL OR s.assignee = '')
     ORDER BY s.step_order ASC
     LIMIT 1`
  ).get() || null;
}

// -- Auto-task from asset request --

var _autoTaskFromAsset = null;

export function initDioverseTransactions() {
  _autoTaskFromAsset = db.transaction(function (assetId, projectId, requester) {
    var agents = db.prepare("SELECT id FROM dv_agents WHERE capabilities LIKE '%assets%'").all();
    var assignee = agents.length > 0 ? agents[0].id : null;

    var asset = getDvAsset(assetId);
    if (!asset) return null;

    var taskId = createDvTask(
      'Generate asset: ' + asset.name,
      'Auto-created from asset request #' + assetId + '. Type: ' + asset.type + '. Project: ' + projectId,
      projectId,
      requester,
      'normal',
      JSON.stringify(['auto', 'assets'])
    );

    db.prepare("UPDATE dv_tasks SET assignee = ?, linked_asset_id = ? WHERE id = ?").run(assignee, assetId, taskId);

    return { task_id: taskId, assignee: assignee };
  });
}

export function autoTaskFromAsset(assetId, projectId, requester) {
  if (!_autoTaskFromAsset) return null;
  return _autoTaskFromAsset(assetId, projectId, requester);
}

// -- Plans --

export function createDvPlan(title, description, projectId, owner, priority, tags, createdBy) {
  var result = db.prepare(
    "INSERT INTO dv_plans (title, description, project_id, owner, priority, tags, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(title, description || '', projectId || '', owner || '', priority || 'normal', tags || '[]', createdBy || '');
  return result.id;
}

export function getDvPlan(id) {
  var plan = db.prepare("SELECT * FROM dv_plans WHERE id = ?").get(id);
  if (!plan) return null;
  var steps = db.prepare("SELECT * FROM dv_plan_steps WHERE plan_id = ? ORDER BY step_order, id").all(id);
  // Batch-fetch all comments for this plan and group by step
  var allComments = db.prepare("SELECT * FROM dv_plan_step_comments WHERE plan_id = ? ORDER BY created_at ASC").all(id);
  var commentsByStep = {};
  for (var c of allComments) {
    if (!commentsByStep[c.step_id]) commentsByStep[c.step_id] = [];
    commentsByStep[c.step_id].push(c);
  }
  for (var s of steps) {
    s.comments = commentsByStep[s.id] || [];
  }
  var total = steps.length;
  var completed = steps.filter(function (s) { return s.status === 'completed'; }).length;
  plan.steps = steps;
  plan.progress = { total: total, completed: completed, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
  return plan;
}

export function listDvPlans(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.owner) { where.push('owner = ?'); params.push(filters.owner); }
  if (filters.exclude_status) { where.push('status != ?'); params.push(filters.exclude_status); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  var plans = db.prepare('SELECT * FROM dv_plans WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
  for (var p of plans) {
    var steps = db.prepare("SELECT status, title FROM dv_plan_steps WHERE plan_id = ? ORDER BY step_order ASC").all(p.id);
    var total = steps.length;
    var completed = steps.filter(function (s) { return s.status === 'completed'; }).length;
    p.step_count = total;
    p.progress = { total: total, completed: completed, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
    // Current step: first in_progress, or first pending if none in_progress
    var current = steps.find(function (s) { return s.status === 'in_progress'; }) ||
                  steps.find(function (s) { return s.status === 'pending'; });
    p.current_step = current ? current.title : null;
  }
  return plans;
}

export function updateDvPlan(id, fields) {
  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.owner !== undefined) { sets.push('owner = ?'); values.push(fields.owner); }
  if (fields.priority !== undefined) { sets.push('priority = ?'); values.push(fields.priority); }
  if (fields.tags !== undefined) { sets.push('tags = ?'); values.push(typeof fields.tags === 'string' ? fields.tags : JSON.stringify(fields.tags)); }
  if (fields.project_id !== undefined) { sets.push('project_id = ?'); values.push(fields.project_id); }
  values.push(id);
  return db.prepare('UPDATE dv_plans SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteDvPlan(id) {
  db.prepare("DELETE FROM dv_plan_steps WHERE plan_id = ?").run(id);
  db.prepare("DELETE FROM dv_plans WHERE id = ?").run(id);
}

export function createDvPlanStep(planId, title, description, assignee, phase) {
  var maxOrder = db.prepare("SELECT MAX(step_order) as m FROM dv_plan_steps WHERE plan_id = ?").get(planId);
  var order = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 0;
  var result = db.prepare(
    "INSERT INTO dv_plan_steps (plan_id, step_order, title, description, assignee, phase) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(planId, order, title, description || '', assignee || null, phase || '');
  db.prepare("UPDATE dv_plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  return result.id;
}

export function updateDvPlanStep(stepId, fields) {
  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.assignee !== undefined) { sets.push('assignee = ?'); values.push(fields.assignee); }
  if (fields.linked_task_id !== undefined) { sets.push('linked_task_id = ?'); values.push(fields.linked_task_id); }
  if (fields.linked_branch !== undefined) { sets.push('linked_branch = ?'); values.push(fields.linked_branch); }
  if (fields.linked_pr_url !== undefined) { sets.push('linked_pr_url = ?'); values.push(fields.linked_pr_url); }
  if (fields.phase !== undefined) { sets.push('phase = ?'); values.push(fields.phase); }
  if (fields.step_order !== undefined) { sets.push('step_order = ?'); values.push(fields.step_order); }
  if (fields.status === 'completed') { sets.push("completed_at = datetime('now')"); }
  values.push(stepId);
  db.prepare('UPDATE dv_plan_steps SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  // Update parent plan's updated_at
  var step = db.prepare("SELECT plan_id FROM dv_plan_steps WHERE id = ?").get(stepId);
  if (step) db.prepare("UPDATE dv_plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

export function deleteDvPlanStep(stepId) {
  var step = db.prepare("SELECT plan_id FROM dv_plan_steps WHERE id = ?").get(stepId);
  db.prepare("DELETE FROM dv_plan_steps WHERE id = ?").run(stepId);
  if (step) db.prepare("UPDATE dv_plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

export function reorderDvPlanSteps(planId, stepIds) {
  var reorder = db.transaction(function () {
    for (var i = 0; i < stepIds.length; i++) {
      db.prepare("UPDATE dv_plan_steps SET step_order = ? WHERE id = ? AND plan_id = ?").run(i, stepIds[i], planId);
    }
    db.prepare("UPDATE dv_plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  });
  reorder();
}

// -- Plan Step Comments --

export function createPlanStepComment(stepId, planId, author, content) {
  var result = db.prepare(
    "INSERT INTO dv_plan_step_comments (step_id, plan_id, author, content) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(stepId, planId, author, content);
  db.prepare("UPDATE dv_plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  return result.id;
}

export function listPlanStepComments(stepId) {
  return db.prepare("SELECT * FROM dv_plan_step_comments WHERE step_id = ? ORDER BY created_at ASC").all(stepId);
}

export function listPlanComments(planId) {
  return db.prepare("SELECT * FROM dv_plan_step_comments WHERE plan_id = ? ORDER BY created_at ASC").all(planId);
}

export function completeLinkedPlanSteps(taskId) {
  var steps = db.prepare("SELECT id, plan_id FROM dv_plan_steps WHERE linked_task_id = ? AND status != 'completed'").all(taskId);
  var affectedPlanIds = [];
  for (var step of steps) {
    db.prepare("UPDATE dv_plan_steps SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(step.id);
    if (affectedPlanIds.indexOf(step.plan_id) === -1) affectedPlanIds.push(step.plan_id);
  }
  // Check if any affected plans are now fully complete
  var completedPlans = [];
  for (var planId of affectedPlanIds) {
    var remaining = db.prepare("SELECT COUNT(*) as c FROM dv_plan_steps WHERE plan_id = ? AND status NOT IN ('completed', 'skipped')").get(planId);
    if (remaining.c === 0) {
      db.prepare("UPDATE dv_plans SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'active'").run(planId);
      completedPlans.push(planId);
    } else {
      db.prepare("UPDATE dv_plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
    }
  }
  return { steps_completed: steps.length, plans_completed: completedPlans };
}

// -- Studio Users --

export function createStudioUser(username, displayName, passwordHash, role) {
  var result = db.prepare(
    "INSERT INTO dv_studio_users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(username, displayName, passwordHash, role || 'admin');
  return result.id;
}

export function getStudioUserByUsername(username) {
  return db.prepare("SELECT * FROM dv_studio_users WHERE username = ?").get(username);
}

export function getStudioUserById(id) {
  return db.prepare("SELECT id, username, display_name, role, created_at FROM dv_studio_users WHERE id = ?").get(id);
}

export function listStudioUsers() {
  return db.prepare("SELECT id, username, display_name, role, created_at, last_seen FROM dv_studio_users ORDER BY created_at").all();
}

export function touchStudioUserSeen(id) {
  db.prepare("UPDATE dv_studio_users SET last_seen = datetime('now') WHERE id = ?").run(id);
}

export function getActiveStudioUsers(withinMinutes) {
  var mins = withinMinutes || 5;
  return db.prepare(
    "SELECT id, username, display_name, role, last_seen FROM dv_studio_users WHERE last_seen >= datetime('now', '-' || ? || ' minutes') ORDER BY last_seen DESC"
  ).all(mins);
}

export function deleteStudioUser(id) {
  db.prepare("DELETE FROM dv_studio_users WHERE id = ?").run(id);
}

export function updateStudioUser(id, fields) {
  var sets = [];
  var values = [];
  if (fields.display_name !== undefined) { sets.push('display_name = ?'); values.push(fields.display_name); }
  if (fields.password_hash !== undefined) { sets.push('password_hash = ?'); values.push(fields.password_hash); }
  if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_studio_users SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Dioverse Webhooks --

export function createDvWebhook(agentId, url, events, secret) {
  var eventsJson = Array.isArray(events) ? JSON.stringify(events) : (events || '["task_created","request_created","message_sent"]');
  var result = db.prepare(
    "INSERT INTO dv_webhooks (agent_id, url, events, secret) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(agentId, url, eventsJson, secret || '');
  return result.id;
}

export function listDvWebhooks(agentId) {
  if (agentId) {
    return db.prepare("SELECT * FROM dv_webhooks WHERE agent_id = ? AND active = 1").all(agentId);
  }
  return db.prepare("SELECT * FROM dv_webhooks WHERE active = 1").all();
}

export function deleteDvWebhook(id) {
  db.prepare("DELETE FROM dv_webhooks WHERE id = ?").run(id);
}

export function dispatchWebhook(event, agentId, data) {
  // Query webhooks for the target agent AND __global__ (admin-claude receives all events)
  var webhooks = db.prepare(
    "SELECT * FROM dv_webhooks WHERE active = 1 AND (agent_id = ? OR agent_id = '__global__')"
  ).all(agentId);

  for (var wh of webhooks) {
    var events = [];
    try { events = JSON.parse(wh.events); } catch (e) { console.warn('[mycelium] JSON parse failed for webhook.events (webhook: ' + wh.id + '):', e.message); continue; }
    if (events.indexOf(event) === -1 && events.indexOf('*') === -1) continue;

    var payload = JSON.stringify({
      event: event,
      agent_id: agentId,
      data: data,
      timestamp: new Date().toISOString()
    });

    var headers = { 'Content-Type': 'application/json' };
    if (wh.secret) {
      var sig = crypto.createHmac('sha256', wh.secret).update(payload).digest('hex');
      headers['X-Webhook-Signature'] = sig;
    }

    var whId = wh.id;
    var startTime = Date.now();

    // Non-blocking fetch with 5s timeout and retry (up to 3 attempts)
    (function deliverWithRetry(url, opts, attempt) {
      fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(5000) }))
        .then(function (resp) {
          var duration = Date.now() - startTime;
          return resp.text().then(function (body) {
            logWebhookDelivery(whId, event, agentId, payload, resp.status, body.substring(0, 1000), null, duration);
          });
        }).catch(function (err) {
          var duration = Date.now() - startTime;
          if (attempt < 3) {
            var delay = Math.pow(2, attempt) * 1000; // 2s, 4s backoff
            setTimeout(function () { deliverWithRetry(url, opts, attempt + 1); }, delay);
          } else {
            logWebhookDelivery(whId, event, agentId, payload, null, null, err.message + ' (after 3 attempts)', duration);
            console.error('[webhook] Failed after 3 attempts to', url, ':', err.message);
          }
        });
    })(wh.url, { method: 'POST', headers: headers, body: payload }, 1);
  }
}

function logWebhookDelivery(webhookId, event, agentId, payload, statusCode, responseBody, error, durationMs) {
  try {
    db.prepare(
      "INSERT INTO dv_webhook_deliveries (webhook_id, event, agent_id, payload, status_code, response_body, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(webhookId, event, agentId, payload, statusCode, responseBody, error, durationMs);
  } catch (e) {
    console.error('[webhook-log] Failed to log delivery:', e.message);
  }
}

export function listWebhookDeliveries(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.event) { where.push('event = ?'); params.push(filters.event); }
  if (filters.webhook_id) { where.push('webhook_id = ?'); params.push(filters.webhook_id); }
  if (filters.error_only) { where.push('error IS NOT NULL'); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_webhook_deliveries WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function pruneWebhookDeliveries(keepDays) {
  var days = keepDays || 7;
  var result = db.prepare("DELETE FROM dv_webhook_deliveries WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
  return result.changes;
}

// -- Team Chat (human-only messages) --

export function createDvTeamChat(fromUser, content) {
  var result = db.prepare(
    "INSERT INTO dv_messages (from_agent, content, msg_type) VALUES (?, ?, 'chat') RETURNING id"
  ).get(fromUser, content);
  return result.id;
}

export function listDvTeamChat(limit) {
  return db.prepare(
    "SELECT * FROM dv_messages WHERE msg_type = 'chat' ORDER BY created_at DESC LIMIT ?"
  ).all(limit || 50);
}

// -- Channels --

export function createChannel(name, slug, type, linkedType, linkedId, description, createdBy) {
  var result = db.prepare(
    "INSERT INTO dv_channels (name, slug, type, linked_type, linked_id, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, slug, type || 'general', linkedType || null, linkedId || null, description || '', createdBy);
  return result.id;
}

export function getChannel(id) {
  return db.prepare("SELECT * FROM dv_channels WHERE id = ?").get(id);
}

export function getChannelBySlug(slug) {
  return db.prepare("SELECT * FROM dv_channels WHERE slug = ?").get(slug);
}

export function getChannelByLink(linkedType, linkedId) {
  return db.prepare("SELECT * FROM dv_channels WHERE linked_type = ? AND linked_id = ?").get(linkedType, linkedId);
}

export function listChannels(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status && filters.status !== 'all') { where.push('status = ?'); params.push(filters.status); }
  else if (!filters.status) { where.push("status = 'active'"); }
  if (filters.member) {
    where.push('id IN (SELECT channel_id FROM dv_channel_members WHERE user_id = ?)');
    params.push(filters.member);
  }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_channels WHERE ' + where.join(' AND ') + ' ORDER BY created_at ASC LIMIT ? OFFSET ?').all(...params);
}

export function updateChannel(id, fields) {
  var sets = [];
  var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_channels SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteChannel(id) {
  db.prepare("DELETE FROM dv_channels WHERE id = ?").run(id);
}

// -- Channel Members --

export function addChannelMember(channelId, userId, userType, role) {
  try {
    db.prepare(
      "INSERT INTO dv_channel_members (channel_id, user_id, user_type, role) VALUES (?, ?, ?, ?)"
    ).run(channelId, userId, userType || 'agent', role || 'member');
    return true;
  } catch (e) {
    return false;
  }
}

export function removeChannelMember(channelId, userId) {
  var result = db.prepare("DELETE FROM dv_channel_members WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
  return result.changes > 0;
}

export function listChannelMembers(channelId) {
  return db.prepare("SELECT * FROM dv_channel_members WHERE channel_id = ? ORDER BY joined_at ASC").all(channelId);
}

export function isChannelMember(channelId, userId) {
  var row = db.prepare("SELECT 1 FROM dv_channel_members WHERE channel_id = ? AND user_id = ?").get(channelId, userId);
  return !!row;
}

export function getChannelsByUser(userId) {
  return db.prepare(
    "SELECT c.*, cm.role as member_role FROM dv_channels c JOIN dv_channel_members cm ON c.id = cm.channel_id WHERE cm.user_id = ? AND c.status = 'active' ORDER BY c.created_at ASC"
  ).all(userId);
}

// -- Channel Read Tracking --

export function markChannelRead(channelId, userId, messageId) {
  db.prepare(
    "INSERT INTO dv_channel_reads (channel_id, user_id, last_read_at, last_read_message_id) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = datetime('now'), last_read_message_id = excluded.last_read_message_id"
  ).run(channelId, userId, messageId || 0);
}

export function getUnreadCounts(userId) {
  return db.prepare(
    "SELECT c.id as channel_id, c.name, c.slug, COUNT(m.id) as unread FROM dv_channels c JOIN dv_channel_members cm ON c.id = cm.channel_id LEFT JOIN dv_messages m ON m.channel_id = c.id AND m.id > COALESCE((SELECT last_read_message_id FROM dv_channel_reads WHERE channel_id = c.id AND user_id = ?), 0) WHERE cm.user_id = ? AND c.status = 'active' GROUP BY c.id"
  ).all(userId, userId);
}

export function getLatestChannelMessageId(channelId) {
  var row = db.prepare("SELECT MAX(id) as max_id FROM dv_messages WHERE channel_id = ?").get(channelId);
  return row ? (row.max_id || 0) : 0;
}

// -- Channel Messages --

export function listChannelMessages(channelId, filters) {
  var where = ['channel_id = ?'];
  var params = [channelId];
  if (filters.before) { where.push('id < ?'); params.push(filters.before); }
  if (filters.after) { where.push('id > ?'); params.push(filters.after); }
  var limit = Math.min(filters.limit || 50, 500);
  params.push(limit);
  return db.prepare(
    'SELECT * FROM dv_messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function createChannelMessage(channelId, fromAgent, content, metadata) {
  var result = db.prepare(
    "INSERT INTO dv_messages (channel_id, from_agent, content, metadata, msg_type) VALUES (?, ?, ?, ?, 'message') RETURNING id"
  ).get(channelId, fromAgent, content, metadata || '{}');
  return result.id;
}

// -- Channel Seeding + Auto-Creation --

export function ensureDefaultChannels() {
  var defaults = [
    { name: '#general', slug: 'general', type: 'general', description: 'General discussion' },
    { name: '#admin', slug: 'admin', type: 'announcement', description: 'Admin coordination' }
  ];
  for (var def of defaults) {
    var existing = getChannelBySlug(def.slug);
    if (!existing) {
      var id = createChannel(def.name, def.slug, def.type, null, null, def.description, 'system');
      var operators = listOperators();
      for (var op of operators) {
        addChannelMember(id, op.id, 'operator', 'admin');
      }
      if (def.slug === 'general') {
        var agents = listAgents();
        for (var agent of agents) {
          addChannelMember(id, agent.id, 'agent', 'member');
        }
      }
    }
  }
}

export function autoCreateEntityChannel(linkedType, linkedId, name, createdBy, memberIds) {
  var slug = linkedType + '-' + linkedId;
  var existing = getChannelBySlug(slug);
  if (existing) return existing.id;
  var channelName = name || '#' + slug;
  var id = createChannel(channelName, slug, linkedType, linkedType, linkedId, '', createdBy);
  var operators = listOperators();
  for (var op of operators) {
    addChannelMember(id, op.id, 'operator', 'admin');
  }
  if (memberIds) {
    for (var mid of memberIds) {
      if (mid) addChannelMember(id, mid, 'agent', 'member');
    }
  }
  return id;
}

export function getOrCreateDmChannel(userA, userB, userAType, userBType) {
  // Find any existing active DM channel that has exactly these two participants (case-insensitive).
  // This prevents duplicate channels when usernames differ by case or creation order.
  var existing = db.prepare(`
    SELECT c.id FROM dv_channels c
    WHERE c.type = 'dm' AND c.status = 'active'
      AND (SELECT COUNT(*) FROM dv_channel_members m
           WHERE m.channel_id = c.id AND LOWER(m.user_id) IN (LOWER(?), LOWER(?))) = 2
      AND (SELECT COUNT(*) FROM dv_channel_members m WHERE m.channel_id = c.id) = 2
    ORDER BY c.id ASC
    LIMIT 1
  `).get(userA, userB);
  if (existing) {
    // Ensure both users are members (handles legacy channels missing a member row)
    addChannelMember(existing.id, userA, userAType || 'agent', 'member');
    addChannelMember(existing.id, userB, userBType || 'agent', 'member');
    return existing.id;
  }
  // Create new DM channel — use case-insensitive sort for canonical slug
  var sorted = [userA, userB].sort(function (a, b) {
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  });
  var slug = 'dm-' + sorted[0].toLowerCase() + '-' + sorted[1].toLowerCase();
  // Check slug in case a channel exists that our member query didn't catch (e.g. single-member DM)
  var bySlug = getChannelBySlug(slug);
  if (bySlug) {
    addChannelMember(bySlug.id, userA, userAType || 'agent', 'member');
    addChannelMember(bySlug.id, userB, userBType || 'agent', 'member');
    return bySlug.id;
  }
  var id = createChannel('DM: ' + sorted[0] + ' & ' + sorted[1], slug, 'dm', null, null, '', userA);
  addChannelMember(id, userA, userAType || 'agent', 'member');
  addChannelMember(id, userB, userBType || 'agent', 'member');
  return id;
}

// -- Drone Jobs --

export function createDroneJob(title, command, inputData, requires, requester, priority, workspaceRepo, workspaceBranch) {
  var result = db.prepare(
    "INSERT INTO dv_drone_jobs (title, command, input_data, requires, requester, priority, workspace_repo, workspace_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(
    title,
    command || '',
    typeof inputData === 'string' ? inputData : JSON.stringify(inputData || {}),
    typeof requires === 'string' ? requires : JSON.stringify(requires || ['cpu']),
    requester,
    priority || 0,
    workspaceRepo || null,
    workspaceBranch || 'main'
  );
  return result.id;
}

export function getDroneJob(id) {
  return db.prepare("SELECT * FROM dv_drone_jobs WHERE id = ?").get(id);
}

export function claimDroneJob(droneId, capabilities) {
  // Atomic: find oldest pending job where requires is a subset of capabilities
  var caps = Array.isArray(capabilities) ? capabilities : [];
  var pending = db.prepare(
    "SELECT * FROM dv_drone_jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC"
  ).all();
  for (var job of pending) {
    var reqs = [];
    try { reqs = JSON.parse(job.requires || '["cpu"]'); } catch (e) { console.warn('[mycelium] JSON parse failed for job.requires (job: ' + job.id + '):', e.message); reqs = ['cpu']; }
    var matched = reqs.every(function (r) { return caps.indexOf(r) !== -1; });
    if (matched) {
      var result = db.prepare(
        "UPDATE dv_drone_jobs SET status = 'claimed', drone_id = ?, started_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(droneId, job.id);
      if (result.changes > 0) return getDroneJob(job.id);
      // Another drone claimed it first, try next candidate
    }
  }
  return null;
}

export function updateDroneJob(id, fields) {
  var sets = [];
  var values = [];
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.result_url !== undefined) { sets.push('result_url = ?'); values.push(fields.result_url); }
  if (fields.result_data !== undefined) { sets.push('result_data = ?'); values.push(typeof fields.result_data === 'string' ? fields.result_data : JSON.stringify(fields.result_data)); }
  if (fields.error !== undefined) { sets.push('error = ?'); values.push(fields.error); }
  if (fields.completed_at !== undefined) { sets.push('completed_at = ?'); values.push(fields.completed_at); }
  if (sets.length === 0) return;
  values.push(id);
  return db.prepare('UPDATE dv_drone_jobs SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function listDroneJobs(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.drone_id) { where.push('drone_id = ?'); params.push(filters.drone_id); }
  if (filters.requester) { where.push('requester = ?'); params.push(filters.requester); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_drone_jobs WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function listDrones() {
  return db.prepare("SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, created_at FROM dv_agents WHERE project_id = 'drone' ORDER BY created_at").all();
}

export function bulkCancelDroneJobs(statuses, olderThanDays) {
  var where = "status IN ('" + statuses.join("','") + "')";
  if (olderThanDays > 0) {
    where += " AND completed_at < datetime('now', '-" + olderThanDays + " days')";
  }
  var jobs = db.prepare('SELECT id, title, status FROM dv_drone_jobs WHERE ' + where).all();
  if (jobs.length > 0) {
    var ids = jobs.map(function (j) { return j.id; });
    db.prepare("UPDATE dv_drone_jobs SET status = 'cancelled' WHERE id IN (" + ids.join(',') + ")").run();
  }
  return jobs;
}

// -- Shared Concepts --

export function createConcept(name, type, description, data, createdBy) {
  var r = stmt('dvCreateConcept', `INSERT INTO dv_concepts (name, type, description, data, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(name, type || 'custom', description || '', JSON.stringify(data || {}), createdBy || '');
  return r.lastInsertRowid;
}

export function getConcept(id) {
  return stmt('dvGetConcept', 'SELECT * FROM dv_concepts WHERE id = ?').get(id);
}

export function listConcepts(filters) {
  var where = []; var params = [];
  if (filters && filters.type) { where.push('type = ?'); params.push(filters.type); }
  var sql = 'SELECT * FROM dv_concepts' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC';
  if (filters && filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
  return stmt('dvListConcepts_' + where.join('_') + (filters && filters.limit || ''), sql).all(...params);
}

export function updateConcept(id, fields) {
  var sets = []; var params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.type !== undefined) { sets.push('type = ?'); params.push(fields.type); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.data !== undefined) { sets.push('data = ?'); params.push(typeof fields.data === 'string' ? fields.data : JSON.stringify(fields.data)); }
  if (sets.length === 0) return;
  sets.push("version = version + 1");
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare('UPDATE dv_concepts SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
}

export function deleteConcept(id) {
  db.prepare('DELETE FROM dv_concepts WHERE id = ?').run(id);
}

export function linkConceptToProject(projectId, conceptId, linkedBy) {
  stmt('dvLinkConcept', `INSERT OR IGNORE INTO dv_project_concepts (project_id, concept_id, linked_by)
    VALUES (?, ?, ?)`).run(projectId, conceptId, linkedBy || '');
}

export function unlinkConceptFromProject(projectId, conceptId) {
  stmt('dvUnlinkConcept', 'DELETE FROM dv_project_concepts WHERE project_id = ? AND concept_id = ?').run(projectId, conceptId);
}

export function getProjectConcepts(projectId) {
  return stmt('dvGetProjectConcepts', `SELECT c.*, pc.linked_at, pc.linked_by
    FROM dv_concepts c JOIN dv_project_concepts pc ON c.id = pc.concept_id
    WHERE pc.project_id = ? ORDER BY c.name`).all(projectId);
}

export function getConceptProjects(conceptId) {
  return stmt('dvGetConceptProjects', `SELECT p.*, pc.linked_at, pc.linked_by
    FROM dv_projects p JOIN dv_project_concepts pc ON p.id = pc.project_id
    WHERE pc.concept_id = ? ORDER BY p.name`).all(conceptId);
}

// -- Dioverse Hub init (seed default projects + admin user) --

export function initDioverse() {
  createProject('willing-sacrifice', 'Willing Sacrifice', 'Autobattler RPG where Dio is the arena master');
  createProject('king-city', 'King City', 'Zombie survival town builder where Dio appears as a chibi narrator');
}

// -- Dioverse Hub admin overview --

// =============== APPROVALS ===============

var GATED_ACTIONS = ['deploy', 'git_push', 'plan_create', 'money_action', 'delete', 'external_comm'];
export { GATED_ACTIONS };

export function createApproval(actionType, requestedBy, title, payload, projectId, riskTier, requiredApprovals) {
  var result = stmt('dvCreateApproval2',
    "INSERT INTO dv_approvals (action_type, requested_by, title, payload, project_id, risk_tier, required_approvals) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(actionType, requestedBy, title || '', typeof payload === 'string' ? payload : JSON.stringify(payload || {}), projectId || 'mycelium', riskTier || 'medium', requiredApprovals || 1);
  return result.id;
}

export function getApproval(id) {
  return stmt('dvGetApproval', "SELECT * FROM dv_approvals WHERE id = ?").get(id);
}

export function listApprovals(filters) {
  var where = ['1=1']; var params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.action_type) { where.push('action_type = ?'); params.push(filters.action_type); }
  if (filters.requested_by) { where.push('requested_by = ?'); params.push(filters.requested_by); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  var limit = Math.min(filters.limit || 50, 500);
  params.push(limit);
  return db.prepare('SELECT * FROM dv_approvals WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
}

export function decideApproval(id, status, decidedBy, reason) {
  db.prepare(
    "UPDATE dv_approvals SET status = ?, decided_by = ?, decided_at = datetime('now'), reason = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, decidedBy, reason || '', id);
}

export function markApprovalExecuted(id) {
  db.prepare("UPDATE dv_approvals SET status = 'executed', executed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
}

export function countPendingApprovals() {
  return stmt('dvCountApprovals', "SELECT COUNT(*) as count FROM dv_approvals WHERE status = 'pending'").get();
}

export function listPendingApprovalsByAgent(agentId) {
  return db.prepare("SELECT * FROM dv_approvals WHERE requested_by = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC").all(agentId);
}

// -- Approval Votes --

export function castApprovalVote(approvalId, voter, vote, notes) {
  stmt('dvCastVote', `INSERT INTO dv_approval_votes (approval_id, voter, vote, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(approval_id, voter) DO UPDATE SET vote = excluded.vote, notes = excluded.notes, created_at = datetime('now')`
  ).run(approvalId, voter, vote || 'approve', notes || '');
}

export function getApprovalVotes(approvalId) {
  return stmt('dvGetVotes', 'SELECT * FROM dv_approval_votes WHERE approval_id = ? ORDER BY created_at').all(approvalId);
}

export function countApprovalVotes(approvalId) {
  var row = db.prepare(
    "SELECT SUM(CASE WHEN vote = 'approve' THEN 1 ELSE 0 END) as approves, SUM(CASE WHEN vote = 'deny' THEN 1 ELSE 0 END) as denies FROM dv_approval_votes WHERE approval_id = ?"
  ).get(approvalId);
  return { approves: row.approves || 0, denies: row.denies || 0 };
}

export function getAdminOps() {
  var pendingRequests = db.prepare(
    "SELECT * FROM dv_messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC LIMIT 50"
  ).all();
  var unassignedTasks = db.prepare(
    "SELECT * FROM dv_tasks WHERE assignee IS NULL AND status IN ('open', 'in_progress') ORDER BY updated_at DESC LIMIT 50"
  ).all();
  var unassignedBugs = db.prepare(
    "SELECT * FROM dv_bugs WHERE assignee IS NULL AND status = 'open' ORDER BY created_at DESC LIMIT 50"
  ).all();
  var failedDroneJobs = db.prepare(
    "SELECT * FROM dv_drone_jobs WHERE status = 'failed' ORDER BY completed_at DESC LIMIT 50"
  ).all();
  var pendingApprovals = db.prepare(
    "SELECT * FROM dv_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50"
  ).all();
  var staleRequests = db.prepare(
    "SELECT * FROM dv_messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') AND created_at < datetime('now', '-1 day') ORDER BY created_at ASC LIMIT 50"
  ).all();
  return {
    pending_requests: pendingRequests,
    unassigned_tasks: unassignedTasks,
    unassigned_bugs: unassignedBugs,
    failed_drone_jobs: failedDroneJobs,
    pending_approvals: pendingApprovals,
    stale_requests: staleRequests,
    open_prs: []
  };
}

export function resolveStaleRequests(hoursOld) {
  var hours = hoursOld || 72;
  var stale = db.prepare(
    "SELECT id FROM dv_messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') AND created_at < datetime('now', '-' || ? || ' hours')"
  ).all(hours);
  for (var req of stale) {
    db.prepare(
      "UPDATE dv_messages SET status = 'resolved', resolved_at = datetime('now'), resolved_by = 'system', content = content || '\n\n[Auto-resolved: request was pending for over ' || ? || ' hours]' WHERE id = ?"
    ).run(hours, req.id);
  }
  return stale.length;
}

export function getDvOverview(userId) {
  var agents = listAgents();
  var events = listDvEvents({ limit: 50 });
  var openTasks = listDvTasks({ status: 'open', limit: 20 });
  var inProgressTasks = listDvTasks({ status: 'in_progress', limit: 20 });
  var reviewTasks = listDvTasks({ status: 'review', limit: 20 });
  var recentDone = listDvTasks({ status: 'done', limit: 10 });
  var messages = listDvMessages({ limit: 30 });
  var context = getAllDvContext();
  var contextKeys = listDvContextKeys();
  var projects = listProjects();
  var approvalQueue = listTasksNeedingApproval();
  var pendingRequests = db.prepare(
    "SELECT * FROM dv_messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC LIMIT 20"
  ).all();
  var assets = listDvAssets({ limit: 50 });
  var bugs = listDvBugs({ limit: 50 });
  var bugCounts = countDvBugs();
  var plans = listDvPlans({ exclude_status: 'cancelled', limit: 50 });
  var teamChat = listDvTeamChat(50);
  var allChannels = listChannels({ limit: 200, status: 'all' });
  var activeChannelCount = allChannels.filter(function (c) { return c.status === 'active'; }).length;
  var archivedChannelCount = allChannels.filter(function (c) { return c.status === 'archived'; }).length;
  // DM channels are private — only show channels where the current user is a member
  var visibleChannels = allChannels;
  if (userId && userId !== '__system__') {
    visibleChannels = allChannels.filter(function (c) {
      if (c.type !== 'dm') return true;
      return isChannelMember(c.id, userId);
    });
  }
  return {
    agents: agents,
    events: events,
    tasks: { open: openTasks, in_progress: inProgressTasks, review: reviewTasks, done: recentDone },
    messages: messages,
    team_chat: teamChat,
    context: context,
    context_keys: contextKeys,
    projects: projects,
    approval_queue: approvalQueue,
    pending_approvals: listApprovals({ status: 'pending', limit: 50 }),
    pending_requests: pendingRequests,
    assets: assets,
    bugs: bugs,
    bug_counts: bugCounts,
    plans: plans,
    concepts: (function () {
      var c = listConcepts({ limit: 100 });
      c.forEach(function (con) {
        con.projects = getConceptProjects(con.id);
        try { con.data = JSON.parse(con.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + con.id + '):', e.message); }
      });
      return c;
    })(),
    channels: visibleChannels,
    channel_counts: { total: allChannels.length, active: activeChannelCount, archived: archivedChannelCount },
    organizations: listOrgs(),
    operators: listOperators(),
    instance_config: listInstanceConfig(),
    drones: listDrones(),
    drone_jobs: listDroneJobs({ limit: 50 }),
    plugins: listPluginRecords(),
    active_operators: getActiveStudioUsers(5),
  };
}

// =============== PLUGINS ===============

export function getDB() { return db; }

export function ensurePluginRecord(manifest) {
  var existing = stmt('dvGetPlugin', 'SELECT * FROM dv_plugins WHERE name = ?').get(manifest.name);
  if (existing) {
    stmt('dvUpdatePlugin', `UPDATE dv_plugins SET display_name = ?, description = ?, version = ?, author = ?, route_prefix = ?, mcp_tool_count = ?, updated_at = datetime('now')
      WHERE name = ?`).run(manifest.displayName || '', manifest.description || '', manifest.version || '1.0.0', manifest.author || '', manifest.routePrefix || '', manifest.mcpToolCount || 0, manifest.name);
    return { ...existing, updated: true };
  }
  stmt('dvInsertPlugin', `INSERT INTO dv_plugins (name, display_name, description, version, author, enabled, route_prefix, mcp_tool_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(manifest.name, manifest.displayName || '', manifest.description || '', manifest.version || '1.0.0', manifest.author || '', 0, manifest.routePrefix || '', manifest.mcpToolCount || 0);
  return { name: manifest.name, created: true };
}

export function getPluginRecord(name) {
  return stmt('dvGetPlugin', 'SELECT * FROM dv_plugins WHERE name = ?').get(name);
}

export function listPluginRecords() {
  return db.prepare('SELECT * FROM dv_plugins ORDER BY name').all();
}

export function updatePluginEnabled(name, enabled) {
  return db.prepare("UPDATE dv_plugins SET enabled = ?, updated_at = datetime('now') WHERE name = ?").run(enabled ? 1 : 0, name);
}

export function getPluginMigrationVersion(pluginName) {
  var row = db.prepare('SELECT MAX(version) as v FROM dv_plugin_migrations WHERE plugin_name = ?').get(pluginName);
  return row ? (row.v || 0) : 0;
}

export function recordPluginMigration(pluginName, version, description) {
  db.prepare('INSERT INTO dv_plugin_migrations (plugin_name, version, description) VALUES (?, ?, ?)').run(pluginName, version, description || '');
}

// ======== AGENT SAVEPOINTS ========

export function createSavepoint(agentId, data) {
  return db.prepare(
    `INSERT INTO dv_agent_savepoints (agent_id, session_id, heartbeat_at, working_on, state_snapshot, messages_acked, context_versions, notes)
     VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)`
  ).run(
    agentId,
    data.session_id || null,
    data.working_on || '',
    JSON.stringify(data.state_snapshot || {}),
    JSON.stringify(data.messages_acked || []),
    JSON.stringify(data.context_versions || {}),
    data.notes || null
  );
}

export function getLatestSavepoint(agentId) {
  return db.prepare(
    'SELECT * FROM dv_agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT 1'
  ).get(agentId);
}

export function getSavepointHistory(agentId, limit) {
  return db.prepare(
    'SELECT id, agent_id, session_id, heartbeat_at, working_on, notes, created_at FROM dv_agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT ?'
  ).all(agentId, limit || 10);
}

export function updateSavepointNotes(agentId, notes) {
  var latest = getLatestSavepoint(agentId);
  if (!latest) return null;
  db.prepare('UPDATE dv_agent_savepoints SET notes = ? WHERE id = ?').run(notes, latest.id);
  return latest.id;
}

export function computeSavepointDiff(agentId) {
  var savepoint = getLatestSavepoint(agentId);
  if (!savepoint) return { has_savepoint: false };

  var ackedIds = [];
  try { ackedIds = JSON.parse(savepoint.messages_acked || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for savepoint.messages_acked (agent: ' + agentId + '):', e.message); }

  var ctxVersions = {};
  try { ctxVersions = JSON.parse(savepoint.context_versions || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for savepoint.context_versions (agent: ' + agentId + '):', e.message); }

  var snapshot = {};
  try { snapshot = JSON.parse(savepoint.state_snapshot || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for savepoint.state_snapshot (agent: ' + agentId + '):', e.message); }

  // Messages the agent hasn't seen (not in acked list, sent after savepoint)
  var newMessages = db.prepare(
    "SELECT * FROM dv_messages WHERE (to_agent = ? OR to_agent IS NULL) AND id NOT IN (SELECT value FROM json_each(?)) AND created_at > ? ORDER BY created_at ASC LIMIT 100"
  ).all(agentId, JSON.stringify(ackedIds), savepoint.heartbeat_at);

  // Tasks that changed since savepoint
  var tasksChanged = db.prepare(
    "SELECT * FROM dv_tasks WHERE (assignee = ? OR assignee IS NULL) AND updated_at > ? ORDER BY updated_at DESC LIMIT 50"
  ).all(agentId, savepoint.heartbeat_at);

  // Context keys that changed since savepoint
  var contextChanged = db.prepare(
    "SELECT * FROM dv_context_keys WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 50"
  ).all(savepoint.heartbeat_at);

  // Plans that changed since savepoint
  var plansChanged = db.prepare(
    "SELECT p.* FROM dv_plans p WHERE p.updated_at > ? ORDER BY p.updated_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at);

  // Bugs that changed since savepoint
  var bugsChanged = db.prepare(
    "SELECT * FROM dv_bugs WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at);

  // Drone jobs that changed since savepoint
  var droneJobsChanged = db.prepare(
    "SELECT * FROM dv_drone_jobs WHERE (started_at > ? OR completed_at > ? OR created_at > ?) ORDER BY created_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at, savepoint.heartbeat_at, savepoint.heartbeat_at);

  // Events since savepoint
  var eventsSince = db.prepare(
    "SELECT * FROM dv_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 50"
  ).all(savepoint.heartbeat_at);

  return {
    has_savepoint: true,
    savepoint_id: savepoint.id,
    savepoint_at: savepoint.heartbeat_at,
    session_id: savepoint.session_id,
    was_working_on: savepoint.working_on,
    notes: savepoint.notes,
    previous_state: snapshot,
    changes: {
      new_messages: newMessages,
      tasks_changed: tasksChanged,
      context_changed: contextChanged,
      plans_changed: plansChanged,
      bugs_changed: bugsChanged,
      drone_jobs_changed: droneJobsChanged,
      events_since: eventsSince.length
    },
    summary: {
      messages: newMessages.length,
      tasks: tasksChanged.length,
      context: contextChanged.length,
      plans: plansChanged.length,
      bugs: bugsChanged.length,
      drone_jobs: droneJobsChanged.length,
      events: eventsSince.length,
      time_since: savepoint.heartbeat_at
    }
  };
}

export function pruneSavepoints(agentId, keepCount) {
  // Keep only the most recent N savepoints per agent
  var count = keepCount || 50;
  var cutoff = db.prepare(
    'SELECT heartbeat_at FROM dv_agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT 1 OFFSET ?'
  ).get(agentId, count);
  if (cutoff) {
    db.prepare('DELETE FROM dv_agent_savepoints WHERE agent_id = ? AND heartbeat_at < ?').run(agentId, cutoff.heartbeat_at);
  }
}

// -- Feedback --

export function createFeedback(entityType, entityId, subject, rating, comment, submittedBy, agentId) {
  var r = Math.max(1, Math.min(5, parseInt(rating) || 3));
  var result = db.prepare(
    'INSERT INTO dv_feedback (entity_type, entity_id, subject, rating, comment, submitted_by, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(entityType || 'general', entityId || '', subject || '', r, comment || '', submittedBy || 'operator', agentId || '');
  return result.id;
}

export function getFeedback(id) {
  return db.prepare('SELECT * FROM dv_feedback WHERE id = ?').get(id);
}

export function listFeedback(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.entity_type) { where.push('entity_type = ?'); params.push(filters.entity_type); }
  if (filters.agent_id) { where.push('agent_id = ?'); params.push(filters.agent_id); }
  if (filters.submitted_by) { where.push('submitted_by = ?'); params.push(filters.submitted_by); }
  if (filters.rating) { where.push('rating = ?'); params.push(parseInt(filters.rating)); }
  if (filters.min_rating) { where.push('rating >= ?'); params.push(parseInt(filters.min_rating)); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  var sql = 'SELECT * FROM dv_feedback WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function deleteFeedback(id) {
  db.prepare('DELETE FROM dv_feedback WHERE id = ?').run(id);
}

// -- Operator Inbox --

export function createInboxItem(operatorId, type, entityType, entityId, title, summary, data, priority) {
  var result = db.prepare(
    'INSERT INTO dv_operator_inbox (operator_id, type, entity_type, entity_id, title, summary, data, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(operatorId, type || 'message', entityType || '', entityId || '', title || '', summary || '', JSON.stringify(data || {}), priority || 'normal');
  return result.id;
}

export function createInboxItemForAllOperators(type, entityType, entityId, title, summary, data, priority) {
  var ops = db.prepare("SELECT id FROM dv_operators WHERE status = 'active'").all();
  var ids = [];
  var insertStmt = db.prepare(
    'INSERT INTO dv_operator_inbox (operator_id, type, entity_type, entity_id, title, summary, data, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  );
  for (var op of ops) {
    var row = insertStmt.get(op.id, type || 'message', entityType || '', entityId || '', title || '', summary || '', JSON.stringify(data || {}), priority || 'normal');
    ids.push(row.id);
  }
  return ids;
}

export function getInboxItem(id) {
  return db.prepare('SELECT * FROM dv_operator_inbox WHERE id = ?').get(id);
}

export function listInboxItems(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.operator_id) { where.push('operator_id = ?'); params.push(filters.operator_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.entity_type) { where.push('entity_type = ?'); params.push(filters.entity_type); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  var sql = 'SELECT * FROM dv_operator_inbox WHERE ' + where.join(' AND ') + ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'normal\' THEN 1 ELSE 2 END, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function markInboxItemRead(id) {
  db.prepare("UPDATE dv_operator_inbox SET status = 'read', read_at = datetime('now') WHERE id = ? AND status = 'unread'").run(id);
}

export function markInboxItemActioned(id) {
  db.prepare("UPDATE dv_operator_inbox SET status = 'actioned', read_at = COALESCE(read_at, datetime('now')) WHERE id = ?").run(id);
}

export function dismissInboxItem(id) {
  db.prepare("UPDATE dv_operator_inbox SET status = 'dismissed' WHERE id = ?").run(id);
}

export function countUnreadInbox(operatorId) {
  var row = db.prepare("SELECT COUNT(*) as c FROM dv_operator_inbox WHERE operator_id = ? AND status = 'unread'").get(operatorId);
  return row ? row.c : 0;
}

export function countAllUnreadInbox() {
  return db.prepare("SELECT operator_id, COUNT(*) as count FROM dv_operator_inbox WHERE status = 'unread' GROUP BY operator_id").all();
}

export function getFeedbackSummary() {
  var total = db.prepare('SELECT COUNT(*) as count FROM dv_feedback').get().count;
  var avgRating = db.prepare('SELECT ROUND(AVG(rating), 2) as avg FROM dv_feedback').get().avg || 0;
  var byAgent = db.prepare(
    "SELECT agent_id, COUNT(*) as count, ROUND(AVG(rating), 2) as avg_rating FROM dv_feedback WHERE agent_id != '' GROUP BY agent_id ORDER BY count DESC LIMIT 20"
  ).all();
  var byType = db.prepare(
    'SELECT entity_type, COUNT(*) as count, ROUND(AVG(rating), 2) as avg_rating FROM dv_feedback GROUP BY entity_type ORDER BY count DESC'
  ).all();
  var ratingDist = db.prepare(
    'SELECT rating, COUNT(*) as count FROM dv_feedback GROUP BY rating ORDER BY rating'
  ).all();
  var recent = db.prepare('SELECT * FROM dv_feedback ORDER BY created_at DESC LIMIT 5').all();
  return { total, avg_rating: avgRating, by_agent: byAgent, by_type: byType, rating_dist: ratingDist, recent };
}
