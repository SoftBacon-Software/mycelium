// =============== MYCELIUM — Database Layer ===============
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import migrateTableNames from './migrate-table-names.js';

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

  // Migration: rename dv_* tables to clean names BEFORE schema.sql runs
  migrateTableNames(db);

  // Migrations: add columns that may not exist yet on the LIVE database.
  // MUST run BEFORE schema.sql because schema has CREATE INDEX on these columns.
  var migrations = [
    ["tasks", "blocked_by", "TEXT NOT NULL DEFAULT '[]'"],
    ["tasks", "blocks", "TEXT NOT NULL DEFAULT '[]'"],
    ["tasks", "needs_approval", "INTEGER NOT NULL DEFAULT 0"],
    ["tasks", "approved_by", "TEXT"],
    ["tasks", "approved_at", "TEXT"],
    ["tasks", "linked_asset_id", "INTEGER"],
    ["tasks", "request_id", "INTEGER"],
    ["tasks", "branch", "TEXT"],
    ["tasks", "pr_url", "TEXT"],
    ["tasks", "repo", "TEXT"],
    ["messages", "msg_type", "TEXT NOT NULL DEFAULT 'message'"],
    ["messages", "status", "TEXT NOT NULL DEFAULT 'sent'"],
    ["messages", "resolved_at", "TEXT"],
    ["messages", "resolved_by", "TEXT"],
    ["agents", "avatar_url", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "role", "TEXT NOT NULL DEFAULT 'agent'"],
    ["agents", "operator_id", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "project", "TEXT NOT NULL DEFAULT ''"],
    ["approvals", "risk_tier", "TEXT NOT NULL DEFAULT 'medium'"],
    ["approvals", "required_approvals", "INTEGER NOT NULL DEFAULT 1"],
    ["approvals", "current_approvals", "INTEGER NOT NULL DEFAULT 0"],
    ["assets", "file_path", "TEXT NOT NULL DEFAULT ''"],
    ["assets", "download_url", "TEXT NOT NULL DEFAULT ''"],
    ["assets", "requested_by", "TEXT NOT NULL DEFAULT ''"],
    ["assets", "assigned_to", "TEXT NOT NULL DEFAULT ''"],
    ["messages", "channel_id", "INTEGER"],
    ["drone_jobs", "workspace_repo", "TEXT"],
    ["drone_jobs", "workspace_branch", "TEXT NOT NULL DEFAULT 'main'"],
    ["assets", "drone_job_id", "INTEGER"],
    ["assets", "prompt", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "llm_backend", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "llm_model", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "agent_type", "TEXT NOT NULL DEFAULT 'agent'"],
    ["projects", "org_id", "TEXT NOT NULL DEFAULT ''"],
    ["projects", "type", "TEXT NOT NULL DEFAULT 'software'"],
    ["projects", "status", "TEXT NOT NULL DEFAULT 'active'"],
    ["operators", "availability", "TEXT NOT NULL DEFAULT 'available'"],
    ["operators", "last_seen_at", "TEXT"],
    ["operators", "away_message", "TEXT NOT NULL DEFAULT ''"],
    // Step #197 — message priority tiers (urgent/normal/fyi)
    ["messages", "priority", "TEXT NOT NULL DEFAULT 'normal'"],
    // Plan #30 — dynamic bug categories per project
    ["projects", "bug_categories", "TEXT NOT NULL DEFAULT '[]'"],
    // Operator presence tracking — who's currently in the dashboard
    ["studio_users", "last_seen", "TEXT"],
    // Drone profiles — link jobs to required profiles
    ["drone_jobs", "profile_id", "TEXT"],
    // Drone system overhaul — smart job routing
    ["agents", "system_diagnostics", "TEXT NOT NULL DEFAULT '{}'"],
    ["drone_jobs", "job_type", "TEXT"],
    // Support ticket tiered routing
    ["support_tickets", "tier", "TEXT NOT NULL DEFAULT 'L2'"],
    ["support_tickets", "assigned_agent", "TEXT"],
    ["support_tickets", "requires_approval", "INTEGER NOT NULL DEFAULT 0"],
    ["support_tickets", "draft_response", "TEXT"],
    // Plan #62 — multi-runtime agent support
    ["agents", "runtime", "TEXT NOT NULL DEFAULT ''"],
  ];

  for (var [table, col, def] of migrations) {
    try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def); } catch (e) { /* already exists */ }
  }

  // Team columns migration
  var projectCols = db.pragma('table_info(projects)').map(function(c) { return c.name; });
  if (!projectCols.includes('team_id')) {
    db.prepare('ALTER TABLE projects ADD COLUMN team_id TEXT').run();
    console.log('[migration] Added team_id to projects');
  }
  var operatorCols = db.pragma('table_info(operators)').map(function(c) { return c.name; });
  if (!operatorCols.includes('primary_team_id')) {
    db.prepare('ALTER TABLE operators ADD COLUMN primary_team_id TEXT').run();
    console.log('[migration] Added primary_team_id to operators');
  }
  var agentCols = db.pragma('table_info(agents)').map(function(c) { return c.name; });
  if (!agentCols.includes('primary_team_id')) {
    db.prepare('ALTER TABLE agents ADD COLUMN primary_team_id TEXT').run();
    console.log('[migration] Added primary_team_id to agents');
  }

  // Run platform schema AFTER migrations (schema has CREATE INDEX on migrated columns)
  var schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Indexes on migrated columns
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_blocked ON tasks(blocked_by)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_approval ON tasks(needs_approval)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(msg_type)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority)'); } catch (e) {}

  // Bug #43: drop dead columns from messages (is_stale, rerouted_from, rerouted_at)
  // These were added in a prior branch but never used. SQLite 3.35+ supports DROP COLUMN.
  var deadCols = ['is_stale', 'rerouted_from', 'rerouted_at'];
  for (var dc of deadCols) {
    try { db.exec('ALTER TABLE messages DROP COLUMN ' + dc); } catch (e) { /* doesn't exist or older SQLite — skip */ }
  }

  // Seed instance config defaults (if table is empty — fresh instance)
  var cfgCount = db.prepare('SELECT COUNT(*) as c FROM instance_config').get();
  if (cfgCount.c === 0) {
    var riskTiers = JSON.stringify({
      plan_create: 'low', context_change: 'low',
      deploy: 'medium', git_push: 'medium', delete: 'medium',
      external_comm: 'high',
      money_action: 'critical', delete_agent: 'critical', instance_config: 'critical'
    });
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('instance_mode', 'developer', 'system');
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_agent_id', '', 'system');
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_status', 'coordinator', 'system');
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('risk_tiers', riskTiers, 'system');
    console.log('Seeded instance_config with defaults (set admin_agent_id via dashboard or API)');
  }

  ensureDefaultChannels();
  seedPlatformProfiles();
  seedDefaultJobTemplates();

  console.log('Mycelium DB initialized at ' + DB_PATH);
}

// Migration: rename game -> project_id columns for enterprise-ready schema
function migrateGameToProjectId() {
  var tables = [
    ['agents', 'game', 'project_id'],
    ['tasks', 'game', 'project_id'],
    ['context', 'game', 'project_id'],
    ['assets', 'game', 'project_id'],
    ['events', 'game', 'project_id'],
    ['messages', 'game', 'project_id'],
    ['bugs', 'game', 'project_id'],
    ['plans', 'game', 'project_id'],
    ['approvals', 'project', 'project_id'],
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
  // Rename games table to projects
  try {
    var gamesTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'").all();
    if (gamesTables.length > 0) {
      db.prepare("ALTER TABLE games RENAME TO projects").run();
      console.log('[migration] Renamed table games -> projects');
    }
  } catch (e) {
    console.error('[migration] Error renaming games:', e.message);
  }
}

// Prepared statement cache
var _stmts = {};
function stmt(key, sql) {
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

// =============== MYCELIUM PLATFORM ===============

// -- Agents --

export function createAgent(id, name, projectId, apiKeyHash, capabilities) {
  stmt('dvCreateAgent', `INSERT INTO agents (id, name, project_id, api_key_hash, capabilities)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, projectId, apiKeyHash, capabilities || '[]');
}

export function getAgent(id) {
  return stmt('dvGetAgent', 'SELECT * FROM agents WHERE id = ?').get(id);
}

export function getAgentByKeyHash(apiKeyHash) {
  return stmt('dvGetAgentByKey', 'SELECT * FROM agents WHERE api_key_hash = ?').get(apiKeyHash);
}

export function listAgents() {
  return stmt('dvListAgents3', "SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, created_at FROM agents WHERE project_id != 'drone' ORDER BY created_at").all();
}

export function listAllAgentsIncludingDrones() {
  return stmt('dvListAllAgents', 'SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, created_at FROM agents ORDER BY created_at').all();
}

export function updateAgentHeartbeat(id, status, workingOn) {
  stmt('dvHeartbeat', `UPDATE agents SET status = ?, working_on = ?, last_heartbeat = datetime('now')
    WHERE id = ?`).run(status || 'online', workingOn || '', id);
}

export function updateAgentKey(id, apiKeyHash) {
  stmt('dvUpdateAgentKey', 'UPDATE agents SET api_key_hash = ? WHERE id = ?').run(apiKeyHash, id);
}

export function deleteAgent(id) {
  db.prepare('DELETE FROM tasks WHERE assignee = ?').run(id);
  db.prepare('DELETE FROM messages WHERE from_agent = ? OR to_agent = ?').run(id, id);
  db.prepare('DELETE FROM bugs WHERE assignee = ?').run(id);
  db.prepare('DELETE FROM drone_jobs WHERE requester = ? OR drone_id = ?').run(id, id);
  db.prepare('DELETE FROM agent_savepoints WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM webhooks WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM message_reads WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM channel_members WHERE user_id = ? AND user_type = ?').run(id, 'agent');
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
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
  if (fields.system_diagnostics !== undefined) { sets.push('system_diagnostics = ?'); values.push(typeof fields.system_diagnostics === 'string' ? fields.system_diagnostics : JSON.stringify(fields.system_diagnostics)); }
  if (fields.runtime !== undefined) { sets.push('runtime = ?'); values.push(fields.runtime); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE agents SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Operators --

export function createOperator(id, displayName, role, responsibilities, email, studioUserId) {
  stmt('dvCreateOperator', `INSERT INTO operators (id, display_name, role, responsibilities, email, studio_user_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, displayName, role || 'member', responsibilities || '', email || '', studioUserId || null);
}

export function getOperator(id) {
  return stmt('dvGetOperator', 'SELECT * FROM operators WHERE id = ?').get(id);
}

export function listOperators() {
  return stmt('dvListOperators', 'SELECT * FROM operators ORDER BY created_at').all();
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
  db.prepare('UPDATE operators SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function setOperatorAvailability(id, availability, awayMessage) {
  db.prepare(`UPDATE operators SET availability = ?, away_message = ?, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(availability, awayMessage || '', id);
}

export function getAvailableOperators() {
  return db.prepare("SELECT * FROM operators WHERE status = 'active' AND availability = 'available'").all();
}

export function isNetworkAutonomous() {
  // An operator counts as "present" only if they are available AND their linked
  // dashboard user has been active recently. Agent heartbeats are automated and
  // do NOT indicate human presence.
  var count = db.prepare(
    "SELECT COUNT(DISTINCT o.id) as c FROM operators o " +
    "LEFT JOIN studio_users u ON u.id = o.studio_user_id " +
    "WHERE o.status = 'active' AND o.availability = 'available' AND " +
    "  u.last_seen > datetime('now', '-30 minutes')"
  ).get();
  return count.c === 0;
}

export function deleteOperator(id) {
  stmt('dvDeleteOperator', 'DELETE FROM operators WHERE id = ?').run(id);
}

// -- Instance Config --

export function getInstanceConfig(key) {
  var row = stmt('dvGetConfig', 'SELECT value FROM instance_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setInstanceConfig(key, value, updatedBy) {
  stmt('dvSetConfig', `INSERT INTO instance_config (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(key, value, updatedBy || '');
}

export function listInstanceConfig() {
  return stmt('dvListConfig', 'SELECT * FROM instance_config ORDER BY key').all();
}

export function deleteInstanceConfig(key) {
  stmt('dvDeleteConfig', 'DELETE FROM instance_config WHERE key = ?').run(key);
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
  stmt('dvCreateOrg', `INSERT OR IGNORE INTO organizations (id, name, description, owner_id)
    VALUES (?, ?, ?, ?)`).run(id, name, description || '', ownerId || '');
}

export function listOrgs() {
  return stmt('dvListOrgs', 'SELECT * FROM organizations ORDER BY created_at').all();
}

export function getOrg(id) {
  return stmt('dvGetOrg', 'SELECT * FROM organizations WHERE id = ?').get(id);
}

export function updateOrg(id, fields) {
  var sets = []; var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.plan !== undefined) { sets.push('plan = ?'); values.push(fields.plan); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE organizations SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteOrg(id) {
  db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
}

// -- Projects --

export function createProject(id, name, description, repoUrl, orgId, type) {
  stmt('dvCreateProject', `INSERT OR IGNORE INTO projects (id, name, description, repo_url, org_id, type)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, description || '', repoUrl || '', orgId || '', type || 'software');
}

export function listProjects(orgId) {
  if (orgId) return db.prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at').all(orgId);
  return stmt('dvListProjects', 'SELECT * FROM projects ORDER BY created_at').all();
}

export function getProject(id) {
  return stmt('dvGetProject', 'SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProject(id, fields) {
  var sets = []; var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.repo_url !== undefined) { sets.push('repo_url = ?'); values.push(fields.repo_url); }
  if (fields.org_id !== undefined) { sets.push('org_id = ?'); values.push(fields.org_id); }
  if (fields.type !== undefined) { sets.push('type = ?'); values.push(fields.type); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.bug_categories !== undefined) { sets.push('bug_categories = ?'); values.push(typeof fields.bug_categories === 'string' ? fields.bug_categories : JSON.stringify(fields.bug_categories)); }
  if (fields.team_id !== undefined) { sets.push('team_id = ?'); values.push(fields.team_id); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Tasks --

export function createTask(title, description, projectId, requester, priority, tags) {
  var result = stmt('dvCreateTask', `INSERT INTO tasks (title, description, project_id, requester, priority, tags)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(title, description || '', projectId || '', requester, priority || 'normal', tags || '[]');
  return result.id;
}

export function getTask(id) {
  return stmt('dvGetTask', 'SELECT * FROM tasks WHERE id = ?').get(id);
}

export function listTasks(filters) {
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
  return db.prepare('SELECT * FROM tasks WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateTask(id, fields) {
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
  return db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Task dependencies --

export function setTaskDependency(taskId, blockedById) {
  var task = getTask(taskId);
  var blocker = getTask(blockedById);
  if (!task || !blocker) return false;

  var blockedBy = [];
  try { blockedBy = JSON.parse(task.blocked_by || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocked_by (task: ' + taskId + '):', e.message); }
  if (blockedBy.indexOf(blockedById) === -1) {
    blockedBy.push(blockedById);
    db.prepare("UPDATE tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(blockedBy), taskId);
  }

  var blocks = [];
  try { blocks = JSON.parse(blocker.blocks || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocks (task: ' + blockedById + '):', e.message); }
  if (blocks.indexOf(taskId) === -1) {
    blocks.push(taskId);
    db.prepare("UPDATE tasks SET blocks = ? WHERE id = ?").run(JSON.stringify(blocks), blockedById);
  }
  return true;
}

export function resolveTaskDependencies(completedTaskId) {
  var task = getTask(completedTaskId);
  if (!task) return [];
  var blocks = [];
  try { blocks = JSON.parse(task.blocks || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocks (task: ' + completedTaskId + '):', e.message); }

  var unblocked = [];
  for (var blockedId of blocks) {
    var blocked = getTask(blockedId);
    if (!blocked) continue;
    var deps = [];
    try { deps = JSON.parse(blocked.blocked_by || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocked_by (task: ' + blockedId + '):', e.message); }
    deps = deps.filter(function (d) { return d !== completedTaskId; });
    db.prepare("UPDATE tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(deps), blockedId);
    if (deps.length === 0) unblocked.push(blockedId);
  }
  return unblocked;
}

// -- Task approval --

export function approveTask(taskId, approvedBy) {
  db.prepare("UPDATE tasks SET approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(approvedBy, taskId);
}

export function listTasksNeedingApproval() {
  return db.prepare("SELECT * FROM tasks WHERE needs_approval = 1 AND approved_by IS NULL AND status != 'done' ORDER BY updated_at DESC").all();
}

// -- Task Comments --

export function addTaskComment(taskId, author, content) {
  var result = db.prepare(
    "INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?) RETURNING *"
  ).get(taskId, author, content);
  return result;
}

export function getTaskComments(taskId) {
  return db.prepare(
    "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId);
}

export function getTaskComment(commentId) {
  return db.prepare("SELECT * FROM task_comments WHERE id = ?").get(commentId);
}

export function deleteTaskComment(commentId) {
  var result = db.prepare("DELETE FROM task_comments WHERE id = ?").run(commentId);
  return result.changes > 0;
}

export function deleteTask(id) {
  db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(id);
  var result = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return result.changes > 0;
}

// -- Plan Step Comments --

export function addPlanStepComment(stepId, planId, author, content) {
  var result = db.prepare(
    "INSERT INTO plan_step_comments (step_id, plan_id, author, content) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(stepId, planId, author, content);
  return result;
}

export function getPlanStepComments(stepId) {
  return db.prepare(
    "SELECT * FROM plan_step_comments WHERE step_id = ? ORDER BY created_at ASC"
  ).all(stepId);
}

// -- Context --

export function getContext(projectId) {
  return stmt('dvGetContext', 'SELECT * FROM context WHERE project_id = ?').get(projectId);
}

export function getAllContext() {
  return stmt('dvGetAllContext', 'SELECT * FROM context ORDER BY updated_at DESC').all();
}

export function upsertContext(projectId, data, agentId) {
  stmt('dvUpsertContext', `INSERT INTO context (project_id, data, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(projectId, data, agentId);
}

// -- Assets --

export function createAsset(name, type, projectId, status, assetPath, metadata, requester) {
  var result = stmt('dvCreateAsset', `INSERT INTO assets (name, type, project_id, status, path, metadata, requester)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(name, type || 'sprite', projectId || 'shared', status || 'requested', assetPath || '', metadata || '{}', requester || '');
  return result.id;
}

export function getAsset(id) {
  return stmt('dvGetAsset', 'SELECT * FROM assets WHERE id = ?').get(id);
}

export function listAssets(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM assets WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateAsset(id, fields) {
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
  return db.prepare('UPDATE assets SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteAsset(id) {
  return db.prepare('DELETE FROM assets WHERE id = ?').run(id);
}

export function listAssetsByDroneJob(droneJobId) {
  return db.prepare('SELECT * FROM assets WHERE drone_job_id = ?').all(droneJobId);
}

// -- Events --

export function createEvent(type, agent, projectId, summary, data) {
  var result = stmt('dvCreateEvent', `INSERT INTO events (type, agent, project_id, summary, data)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).get(type, agent || '', projectId || null, summary || '', data || '{}');
  return result.id;
}

export function listEvents(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.agent) { where.push('agent = ?'); params.push(filters.agent); }
  if (filters.search) { where.push('(summary LIKE ? OR type LIKE ? OR agent LIKE ?)'); var s = '%' + filters.search + '%'; params.push(s, s, s); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM events WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

// -- Messages --

var VALID_MSG_PRIORITIES = ['urgent', 'normal', 'fyi'];

export function createMessage(fromAgent, toAgent, threadId, projectId, content, metadata, msgType, channelId, priority) {
  var prio = VALID_MSG_PRIORITIES.includes(priority) ? priority : 'normal';
  if (msgType && msgType !== 'message') {
    var result = db.prepare(
      "INSERT INTO messages (from_agent, to_agent, thread_id, project_id, content, metadata, msg_type, channel_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}', msgType, channelId || null, prio);
    return result.id;
  }
  var result = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, thread_id, project_id, content, metadata, channel_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}', channelId || null, prio);
  return result.id;
}

export function createRequest(fromAgent, toAgent, threadId, projectId, content, metadata) {
  var result = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, thread_id, project_id, content, metadata, msg_type, status, priority) VALUES (?, ?, ?, ?, ?, ?, 'request', 'pending', 'urgent') RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}');
  return result.id;
}

export function acknowledgeMessage(id) {
  db.prepare("UPDATE messages SET status = 'acknowledged' WHERE id = ?").run(id);
}

export function resolveMessage(id, resolvedBy) {
  db.prepare("UPDATE messages SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").run(resolvedBy, id);
}

export function listPendingRequests(agentId) {
  return db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
}

export function countPendingForAgent(agentId) {
  var row = db.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent')) as requests, " +
    "(SELECT COUNT(*) FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent')) as directives, " +
    "(SELECT COUNT(*) FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND status = 'sent') as unread"
  ).get(agentId, agentId, agentId);
  return row;
}

export function getAgentInbox(agentId, limit) {
  limit = limit || 20;
  // Directives (blocking, must handle first)
  var directives = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent') ORDER BY created_at ASC"
  ).all(agentId);
  // Requests (blocking, must respond)
  var requests = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
  // Unread messages (directed to me or broadcast, status=sent)
  var messages = db.prepare(
    "SELECT id, from_agent, to_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND status = 'sent' ORDER BY created_at DESC LIMIT ?"
  ).all(agentId, limit);
  return { directives: directives, requests: requests, messages: messages };
}

export function getMessage(id) {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
}

// Mark messages as read by an agent (idempotent via UNIQUE constraint)
export function markMessagesRead(agentId, messageIds) {
  var stmt = db.prepare("INSERT OR IGNORE INTO message_reads (message_id, agent_id) VALUES (?, ?)");
  var tx = db.transaction(function (ids) {
    for (var id of ids) stmt.run(id, agentId);
  });
  tx(messageIds);
}

// Get unread messages for an agent (excludes messages they've already acked)
export function getUnreadMessages(agentId, limit) {
  limit = limit || 20;
  // Directives + requests (blocking — always unread if status is pending/sent)
  var directives = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent') ORDER BY created_at ASC"
  ).all(agentId);
  var requests = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
  // Regular messages: directed to me OR broadcast, not yet read by me
  var messages = db.prepare(
    "SELECT m.id, m.from_agent, m.to_agent, m.content, m.msg_type, m.priority, m.project_id, m.created_at " +
    "FROM messages m " +
    "LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ? " +
    "WHERE (m.to_agent = ? OR m.to_agent IS NULL) AND m.msg_type IN ('message', 'info') AND m.status = 'sent' " +
    "AND r.id IS NULL " +
    "ORDER BY m.created_at DESC LIMIT ?"
  ).all(agentId, agentId, limit);
  return { directives, requests, messages };
}

export function listMessages(filters) {
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
  return db.prepare('SELECT * FROM messages WHERE ' + where.join(' AND ') + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?').all(...params);
}

export function listThreads(limit) {
  return db.prepare(`SELECT thread_id, COUNT(*) as message_count,
    MAX(created_at) as last_message_at,
    (SELECT from_agent FROM messages m2 WHERE m2.thread_id = messages.thread_id ORDER BY created_at DESC LIMIT 1) as last_sender
    FROM messages WHERE thread_id IS NOT NULL
    GROUP BY thread_id ORDER BY last_message_at DESC LIMIT ?`).all(Math.min(limit || 20, 500));
}

// Archive resolved messages older than N days (default 90)
// Deletes from messages, returns count of rows removed
export function archiveOldMessages(daysOld) {
  daysOld = parseInt(daysOld) || 90;
  var result = db.prepare(
    "DELETE FROM messages WHERE created_at < datetime('now', '-' || ? || ' days')" +
    " AND (status = 'resolved' OR msg_type = 'info')"
  ).run(String(daysOld));
  return result.changes;
}

// Archive old events older than N days (default 60)
export function archiveOldEvents(daysOld) {
  daysOld = parseInt(daysOld) || 60;
  var result = db.prepare(
    "DELETE FROM events WHERE created_at < datetime('now', '-' || ? || ' days')"
  ).run(String(daysOld));
  return result.changes;
}

export function bulkDeleteMessages(filters) {
  var conditions = [];
  var params = [];
  if (filters.from) { conditions.push('from_agent = ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('to_agent = ?'); params.push(filters.to); }
  if (filters.content_like) { conditions.push('content LIKE ?'); params.push('%' + filters.content_like + '%'); }
  if (conditions.length === 0) return 0;
  var sql = 'DELETE FROM messages WHERE ' + conditions.join(' AND ');
  return db.prepare(sql).run(...params).changes;
}

// -- Namespaced context --

// Context key categories:
//   'durable'   - persistent config, guidelines, gen profiles (no auto-expiry)
//   'ephemeral' - session state, recovery instructions (auto-expire via TTL)
var CONTEXT_MAX_KEYS_PER_NAMESPACE = 200;

export function upsertContextKey(namespace, key, data, agentId, opts) {
  var category = (opts && opts.category) || 'durable';
  var ttl = (opts && opts.ttl) || null; // seconds
  var expiresAt = null;
  if (ttl) {
    expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  } else if (opts && opts.expires_at) {
    expiresAt = opts.expires_at;
  }

  var existing = db.prepare("SELECT data FROM context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
  var merged = data;
  if (existing) {
    // Save previous value to history before overwriting
    try {
      db.prepare("INSERT INTO context_history (namespace, key, data, changed_by) VALUES (?, ?, ?, ?)").run(namespace, key, existing.data, agentId || '');
      // Keep only last 50 versions per key
      db.prepare("DELETE FROM context_history WHERE namespace = ? AND key = ? AND id NOT IN (SELECT id FROM context_history WHERE namespace = ? AND key = ? ORDER BY id DESC LIMIT 50)").run(namespace, key, namespace, key);
    } catch (e) { /* non-critical — history table may not exist yet */ }
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
    "INSERT INTO context_keys (namespace, key, data, category, expires_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(namespace, key) DO UPDATE SET data = excluded.data, category = excluded.category, expires_at = excluded.expires_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).run(namespace, key, merged, category, expiresAt, agentId);

  // Enforce size cap per namespace
  enforceNamespaceCap(namespace);
}

function enforceNamespaceCap(namespace) {
  var count = db.prepare("SELECT COUNT(*) as c FROM context_keys WHERE namespace = ?").get(namespace);
  if (count.c > CONTEXT_MAX_KEYS_PER_NAMESPACE) {
    // Delete oldest ephemeral keys first, then oldest durable
    var excess = count.c - CONTEXT_MAX_KEYS_PER_NAMESPACE;
    db.prepare(
      "DELETE FROM context_keys WHERE id IN (SELECT id FROM context_keys WHERE namespace = ? ORDER BY CASE WHEN category = 'ephemeral' THEN 0 ELSE 1 END, updated_at ASC LIMIT ?)"
    ).run(namespace, excess);
  }
}

export function getContextKey(namespace, key) {
  var row = db.prepare("SELECT * FROM context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
  if (row && row.expires_at && new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM context_keys WHERE namespace = ? AND key = ?").run(namespace, key);
    return null;
  }
  return row;
}

export function listContextKeys(namespace) {
  // Filter out expired keys on read
  var now = new Date().toISOString();
  if (namespace) {
    return db.prepare("SELECT * FROM context_keys WHERE namespace = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key").all(namespace, now);
  }
  return db.prepare("SELECT * FROM context_keys WHERE expires_at IS NULL OR expires_at > ? ORDER BY namespace, key").all(now);
}

export function deleteContextKey(namespace, key) {
  db.prepare("DELETE FROM context_keys WHERE namespace = ? AND key = ?").run(namespace, key);
}

// Context history — view previous versions of a key
export function getContextHistory(namespace, key, limit) {
  return db.prepare(
    "SELECT * FROM context_history WHERE namespace = ? AND key = ? ORDER BY id DESC LIMIT ?"
  ).all(namespace, key, limit || 20);
}

// Rollback — restore a previous version by history ID
export function rollbackContextKey(historyId, agentId) {
  var row = db.prepare("SELECT * FROM context_history WHERE id = ?").get(historyId);
  if (!row) return null;
  // Save current value to history before rollback
  var current = db.prepare("SELECT data FROM context_keys WHERE namespace = ? AND key = ?").get(row.namespace, row.key);
  if (current) {
    db.prepare("INSERT INTO context_history (namespace, key, data, changed_by) VALUES (?, ?, ?, ?)").run(row.namespace, row.key, current.data, agentId || '');
  }
  // Restore the historical value
  db.prepare(
    "UPDATE context_keys SET data = ?, updated_by = ?, updated_at = datetime('now') WHERE namespace = ? AND key = ?"
  ).run(row.data, agentId || '', row.namespace, row.key);
  return row;
}

// Purge all expired context keys (called on server boot and periodically)
// ---- Agent Spend Tracking ----

export function logAgentSpend(agentId, projectId, costUsd, source, description, model, tokensIn, tokensOut) {
  db.prepare(
    "INSERT INTO agent_spend (agent_id, project_id, cost_usd, source, description, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(agentId, projectId || '', costUsd || 0, source || '', description || '', model || '', tokensIn || 0, tokensOut || 0);
}

export function getAgentSpend(agentId, opts) {
  var since = (opts && opts.since) || null;
  var projectId = (opts && opts.project_id) || null;
  var limit = (opts && opts.limit) || 50;

  var where = ['agent_id = ?'];
  var params = [agentId];
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }
  params.push(limit);

  return db.prepare(
    'SELECT * FROM agent_spend WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function getSpendSummary(opts) {
  var since = (opts && opts.since) || null;
  var projectId = (opts && opts.project_id) || null;

  var where = ['1=1'];
  var params = [];
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }

  var rows = db.prepare(
    'SELECT agent_id, project_id, SUM(cost_usd) as total_cost, COUNT(*) as entry_count, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out FROM agent_spend WHERE ' + where.join(' AND ') + ' GROUP BY agent_id, project_id ORDER BY total_cost DESC'
  ).all(...params);
  return rows;
}

export function purgeExpiredContextKeys() {
  var result = db.prepare("DELETE FROM context_keys WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").run();
  return result.changes;
}

// Clean up stale session keys for an agent (called on agent boot)
export function cleanupAgentSessionKeys(agentId) {
  var result = db.prepare("DELETE FROM context_keys WHERE namespace = ? AND category = 'ephemeral' AND expires_at IS NOT NULL AND expires_at <= datetime('now')").run(agentId);
  return result.changes;
}

// Get context stats per namespace
export function contextKeyStats() {
  return db.prepare("SELECT namespace, category, COUNT(*) as count, SUM(LENGTH(data)) as total_bytes FROM context_keys WHERE expires_at IS NULL OR expires_at > datetime('now') GROUP BY namespace, category ORDER BY namespace").all();
}

// -- Skills Registry --

export function createSkill(id, name, description, category, version, author, installType, installData, requiredCapabilities, tags) {
  db.prepare(
    "INSERT INTO skills (id, name, description, category, version, author, install_type, install_data, required_capabilities, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, description || '', category || 'general', version || '1.0.0', author || '',
    installType || 'concept', typeof installData === 'string' ? installData : JSON.stringify(installData || {}),
    typeof requiredCapabilities === 'string' ? requiredCapabilities : JSON.stringify(requiredCapabilities || []),
    typeof tags === 'string' ? tags : JSON.stringify(tags || []));
  return { id: id };
}

export function getSkill(id) {
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
}

export function listSkills(filters) {
  var where = ["status = 'published'"];
  var params = [];
  if (filters && filters.category) { where.push('category = ?'); params.push(filters.category); }
  if (filters && filters.search) { where.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)'); var s = '%' + filters.search + '%'; params.push(s, s, s); }
  return db.prepare('SELECT * FROM skills WHERE ' + where.join(' AND ') + ' ORDER BY install_count DESC, name ASC').all(...params);
}

export function updateSkill(id, updates) {
  var fields = [];
  var params = [];
  if (updates.name !== undefined) { fields.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); params.push(updates.description); }
  if (updates.category !== undefined) { fields.push('category = ?'); params.push(updates.category); }
  if (updates.version !== undefined) { fields.push('version = ?'); params.push(updates.version); }
  if (updates.install_data !== undefined) { fields.push('install_data = ?'); params.push(typeof updates.install_data === 'string' ? updates.install_data : JSON.stringify(updates.install_data)); }
  if (updates.required_capabilities !== undefined) { fields.push('required_capabilities = ?'); params.push(typeof updates.required_capabilities === 'string' ? updates.required_capabilities : JSON.stringify(updates.required_capabilities)); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); params.push(typeof updates.tags === 'string' ? updates.tags : JSON.stringify(updates.tags)); }
  if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare('UPDATE skills SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
}

export function installSkill(agentId, skillId, config) {
  db.prepare(
    "INSERT OR REPLACE INTO agent_skills (agent_id, skill_id, config) VALUES (?, ?, ?)"
  ).run(agentId, skillId, typeof config === 'string' ? config : JSON.stringify(config || {}));
  db.prepare('UPDATE skills SET install_count = install_count + 1 WHERE id = ?').run(skillId);
}

export function uninstallSkill(agentId, skillId) {
  db.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?').run(agentId, skillId);
}

export function getAgentSkills(agentId) {
  return db.prepare(
    'SELECT s.*, as2.installed_at, as2.config FROM skills s JOIN agent_skills as2 ON s.id = as2.skill_id WHERE as2.agent_id = ? ORDER BY s.name'
  ).all(agentId);
}

// -- Widgets --

export function createWidget(agentId, projectId, title, widgetType, data) {
  var result = db.prepare(
    "INSERT INTO widgets (agent_id, project_id, title, widget_type, data) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, projectId || '', title, widgetType || 'status', typeof data === 'string' ? data : JSON.stringify(data || {}));
  return { id: result.lastInsertRowid };
}

export function updateWidget(id, updates) {
  var fields = [];
  var params = [];
  if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
  if (updates.widget_type !== undefined) { fields.push('widget_type = ?'); params.push(updates.widget_type); }
  if (updates.data !== undefined) { fields.push('data = ?'); params.push(typeof updates.data === 'string' ? updates.data : JSON.stringify(updates.data)); }
  if (updates.position !== undefined) { fields.push('position = ?'); params.push(updates.position); }
  if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare('UPDATE widgets SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  return db.prepare('SELECT * FROM widgets WHERE id = ?').get(id);
}

export function listWidgets(filters) {
  var where = ["status = 'active'"];
  var params = [];
  if (filters && filters.agent_id) { where.push('agent_id = ?'); params.push(filters.agent_id); }
  if (filters && filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  return db.prepare('SELECT * FROM widgets WHERE ' + where.join(' AND ') + ' ORDER BY position ASC, updated_at DESC').all(...params);
}

export function deleteWidget(id) {
  db.prepare("UPDATE widgets SET status = 'archived' WHERE id = ?").run(id);
}

// -- Bugs --

export function createBug(projectId, title, description, category, severity, reporter, assignee, diagnosticData) {
  var result = db.prepare(
    "INSERT INTO bugs (project_id, title, description, category, severity, reporter, assignee, diagnostic_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(projectId || '', title, description, category || 'other', severity || 'normal', reporter || 'admin', assignee || null, diagnosticData || null);
  return result.id;
}

export function getBug(id) {
  return db.prepare("SELECT * FROM bugs WHERE id = ?").get(id);
}

export function listBugs(filters) {
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
  return db.prepare('SELECT * FROM bugs WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateBug(id, updates) {
  var sets = ["updated_at = datetime('now')"];
  var params = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.assignee !== undefined) { sets.push('assignee = ?'); params.push(updates.assignee); }
  if (updates.admin_notes !== undefined) { sets.push('admin_notes = ?'); params.push(updates.admin_notes); }
  if (updates.severity !== undefined) { sets.push('severity = ?'); params.push(updates.severity); }
  params.push(id);
  db.prepare('UPDATE bugs SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
}

export function deleteBug(id) {
  return db.prepare('DELETE FROM bugs WHERE id = ?').run(id);
}

export function countBugs() {
  return db.prepare("SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress, SUM(CASE WHEN status = 'fixed' THEN 1 ELSE 0 END) as fixed, COUNT(*) as total FROM bugs").get();
}

// -- Boot payload --

export function getBootPayload(agentId) {
  var agent = getAgent(agentId);
  if (!agent) return null;
  var { api_key_hash, ...safeAgent } = agent;

  var myTasks = db.prepare(
    "SELECT * FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC"
  ).all(agentId);

  var pendingRequests = listPendingRequests(agentId);

  var since = agent.last_heartbeat || '2000-01-01';
  var newMessages = db.prepare(
    "SELECT * FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND created_at > ? ORDER BY created_at DESC LIMIT 50"
  ).all(agentId, since);

  var pendingDirectives = db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
  ).all(agentId);

  var capabilities = [];
  try { capabilities = JSON.parse(agent.capabilities || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for agent.capabilities (agent: ' + agentId + '):', e.message); }
  var assetRequests = [];
  if (capabilities.indexOf('assets') !== -1) {
    assetRequests = db.prepare(
      "SELECT * FROM assets WHERE status = 'requested' ORDER BY created_at DESC LIMIT 50"
    ).all();
  }

  // Only include agents active in last 7 days or in the same project
  var otherAgents = db.prepare(
    "SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project FROM agents WHERE id != ? AND (project_id = ? OR last_heartbeat > datetime('now', '-7 days')) ORDER BY created_at"
  ).all(agentId, agent.project_id);

  var projectContext = getContext(agent.project_id);
  var contextKeys = listContextKeys(agent.project_id);
  // Include platform-wide context (mycelium namespace) so agents get conventions on boot
  var platformKeys = agent.project_id !== 'mycelium' ? listContextKeys('mycelium') : [];
  // Also include agent-specific context
  var agentKeys = listContextKeys(agentId);

  var approvalQueue = listTasksNeedingApproval();
  var recentEvents = listEvents({ limit: 20 });
  var openBugs = listBugs({ status: 'open', limit: 20 });

  // Active/draft plans for agent's project — summaries only in boot (agents use check_plans for full steps)
  var myPlans = listPlans({ project_id: agent.project_id, limit: 20 });

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

  // ---- Crash detection ----
  var crashRecovery = null;
  if (agent.last_heartbeat && agent.working_on) {
    var lastHb = new Date(agent.last_heartbeat + (agent.last_heartbeat.endsWith('Z') ? '' : 'Z')).getTime();
    var staleness = Date.now() - lastHb;
    var CRASH_THRESHOLD = 15 * 60 * 1000; // 15 minutes
    if (staleness > CRASH_THRESHOLD) {
      var lastSavepoint = getLatestSavepoint(agentId);
      crashRecovery = {
        detected: true,
        last_heartbeat: agent.last_heartbeat,
        stale_minutes: Math.round(staleness / 60000),
        was_working_on: agent.working_on,
        recovery_state: lastSavepoint && lastSavepoint.state_snapshot ? lastSavepoint.state_snapshot : null,
        recovery_notes: lastSavepoint && lastSavepoint.notes ? lastSavepoint.notes : null
      };
    }
  }

  // ---- Stand Up: calibration block ----
  var calibration = null;
  try { calibration = buildCalibrationBlock(agentId); } catch (e) { console.warn('[mycelium] calibration block failed for ' + agentId + ':', e.message); }

  // ---- Since last session: changes since agent's last heartbeat ----
  var sinceLastSession = null;
  if (since && since !== '2000-01-01') {
    var newMsgCount = db.prepare(
      "SELECT COUNT(*) as c FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND created_at > ?"
    ).get(agentId, since).c;
    var taskChangeCount = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE (assignee = ? OR assignee IS NULL) AND updated_at > ?"
    ).get(agentId, since).c;
    var planStepChangeCount = db.prepare(
      "SELECT COUNT(*) as c FROM plan_steps WHERE updated_at > ?"
    ).get(since).c;
    var newBugCount = db.prepare(
      "SELECT COUNT(*) as c FROM bugs WHERE created_at > ?"
    ).get(since).c;
    sinceLastSession = {
      new_messages: newMsgCount,
      task_changes: taskChangeCount,
      plan_step_changes: planStepChangeCount,
      new_bugs: newBugCount,
      since: since
    };
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
    crash_recovery: crashRecovery,
    calibration: calibration,
    since_last_session: sinceLastSession,
    server_time: new Date().toISOString()
  };
}

export function getSlimBootPayload(agentId) {
  var agent = getAgent(agentId);
  if (!agent) return null;

  // Auto-heartbeat on boot
  updateAgentHeartbeat(agentId, 'online', agent.working_on);

  // Team context
  var agentTeams = getTeamsForUser(agentId);
  var primaryTeam = agentTeams.find(function(t) { return t.is_primary; }) || null;
  var guestTeams = agentTeams.filter(function(t) { return !t.is_primary; });
  var teamMembers = [];
  if (primaryTeam) {
    teamMembers = db.prepare(
      'SELECT tm.user_id, tm.user_type, tm.role FROM team_members tm WHERE tm.team_id = ?'
    ).all(primaryTeam.id);
  }

  // Fetch directives and requests first — used for both counts and content
  var pendingDirectives = db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
  ).all(agentId);
  var pendingRequests = listPendingRequests(agentId);

  // Inbox — unread messages (read-tracked), delivered on boot
  var inbox = getUnreadMessages(agentId, 20);
  var unreadMsgCount = inbox.messages.length;

  // Auto-ack regular messages delivered on boot (directives/requests stay unacked until resolved)
  var bootAckIds = inbox.messages.map(function (m) { return m.id; });
  if (bootAckIds.length > 0) {
    try { markMessagesRead(agentId, bootAckIds); } catch (_) {}
  }

  // Counts — derive from fetched data where possible
  var counts = {
    directives: pendingDirectives.length,
    requests: pendingRequests.length,
    messages_unread: unreadMsgCount,
    tasks_mine: db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress')"
    ).get(agentId).c,
    bugs_open: db.prepare(
      "SELECT COUNT(*) as c FROM bugs WHERE status = 'open'"
    ).get().c,
    plans_active: db.prepare(
      "SELECT COUNT(*) as c FROM plans WHERE (project_id = ? OR project_id = '') AND status = 'active'"
    ).get(agent.project_id).c
  };

  // Role contract — small, always needed
  var roleContract = buildRoleContract(agent, agentId);
  var myTasks = db.prepare(
    "SELECT * FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC"
  ).all(agentId);
  var openBugs = listBugs({ status: 'open', limit: 5 });
  var myPlans = listPlans({ project_id: agent.project_id, limit: 5 });
  var fullQueue = buildWorkQueue(agentId, agent.project_id, pendingDirectives, pendingRequests, myTasks, openBugs, myPlans);
  var workQueue = fullQueue.slice(0, 5).map(function (item) {
    return { type: item.type, id: item.id, title: item.title };
  });

  // Pending directives and requests — blocking, agents need full content
  var slimDirectives = pendingDirectives.map(function (d) {
    return { id: d.id, from: d.from_agent, content: d.content };
  });
  var slimRequests = pendingRequests.map(function (r) {
    return { id: r.id, from: r.from_agent, content: r.content };
  });

  // Other agents — compact
  var otherAgents = db.prepare(
    "SELECT id, status, working_on FROM agents WHERE id != ? AND (project_id = ? OR last_heartbeat > datetime('now', '-7 days')) ORDER BY created_at"
  ).all(agentId, agent.project_id);

  // Sleep mode + autonomous mode — needed for MCP night directives
  var sleepMode = getSleepMode();
  var autonomousMode = isNetworkAutonomous();
  var operatorsAvailable = getAvailableOperators().length;

  var capabilities = [];
  try { capabilities = JSON.parse(agent.capabilities || '[]'); } catch (e) { /* */ }

  // --- Crash detection ---
  // If the agent was working on something and heartbeat went stale (>15 min), flag as crashed
  var crashRecovery = null;
  if (agent.last_heartbeat && agent.working_on) {
    var lastHb = new Date(agent.last_heartbeat + (agent.last_heartbeat.endsWith('Z') ? '' : 'Z')).getTime();
    var staleness = Date.now() - lastHb;
    var CRASH_THRESHOLD = 15 * 60 * 1000; // 15 minutes
    if (staleness > CRASH_THRESHOLD) {
      // Previous session likely crashed — include recovery info
      var lastSavepoint = getLatestSavepoint(agentId);
      crashRecovery = {
        detected: true,
        last_heartbeat: agent.last_heartbeat,
        stale_minutes: Math.round(staleness / 60000),
        was_working_on: agent.working_on,
        recovery_state: lastSavepoint && lastSavepoint.state_snapshot ? lastSavepoint.state_snapshot : null,
        recovery_notes: lastSavepoint && lastSavepoint.notes ? lastSavepoint.notes : null
      };
    }
  }

  // --- Auto drift detection on boot ---
  var calibration = null;
  try {
    calibration = buildCalibrationBlock(agentId);
  } catch (e) { /* non-critical */ }

  return {
    agent: { id: agent.id, role: agent.role, project: agent.project_id, capabilities: capabilities },
    role_contract: roleContract,
    counts: counts,
    work_queue: workQueue,
    pending_directives: slimDirectives,
    pending_requests: slimRequests,
    other_agents: otherAgents.map(function (a) {
      return { id: a.id, status: a.status, working_on: a.working_on || '' };
    }),
    inbox: inbox.messages.length > 0 || inbox.directives.length > 0 || inbox.requests.length > 0 ? inbox : undefined,
    crash_recovery: crashRecovery,
    calibration: calibration,
    team: primaryTeam || undefined,
    guest_teams: guestTeams.length > 0 ? guestTeams : undefined,
    team_members: teamMembers.length > 0 ? teamMembers : undefined,
    sleep_mode: sleepMode,
    autonomous_mode: autonomousMode,
    operators_available: operatorsAvailable,
    enforcement_rules_active: (function() {
      try {
        var ctx = getContextKey('mycelium', 'enforcement_rules');
        if (ctx && ctx.data) {
          var data = typeof ctx.data === 'string' ? JSON.parse(ctx.data) : ctx.data;
          var rules = Array.isArray(data) ? data : (data.rules || []);
          return rules.map(function(r) { return r.id + ': ' + (r.message || '').substring(0, 80) + ' (' + (r.severity || 'warn').toUpperCase() + ')'; });
        }
      } catch {}
      return [];
    })(),
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
  var agentRole = getContextKey('roles', agentId);
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
  var projGuidelines = getContextKey(agent.project_id, 'guidelines');
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

// Get project IDs scoped to an agent's teams (all teams: primary + guest)
// Returns empty array if agent has no teams (legacy/unscoped)
export function getTeamProjectIdsForAgent(agentId) {
  var agentTeamIds = getTeamsForUser(agentId).map(function(t) { return t.id; });
  if (agentTeamIds.length === 0) return [];
  var placeholders = agentTeamIds.map(function() { return '?'; }).join(',');
  return db.prepare(
    'SELECT id FROM projects WHERE team_id IN (' + placeholders + ')'
  ).all(...agentTeamIds).map(function(p) { return p.id; });
}

// Build a prioritized work queue: what should this agent do next?
export function buildWorkQueue(agentId, projectId, directives, requests, tasks, bugs, plans) {
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

  // Priority 9: Unassigned bugs for this agent's project/team
  var teamProjIds = getTeamProjectIdsForAgent(agentId);
  var unassignedBugs = bugs.filter(function (b) {
    if (b.assignee) return false;
    if (!b.project_id) return true; // unscoped bugs visible to everyone
    if (b.project_id === projectId) return true;
    if (teamProjIds.length > 0) return teamProjIds.indexOf(b.project_id) !== -1;
    return true; // no team = legacy, see everything
  });
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
    SELECT id, name, project_id, status, working_on, capabilities, role, runtime, llm_backend, llm_model
    FROM agents
    WHERE status IN ('online', 'idle')
      AND role != 'drone'
      AND last_heartbeat > datetime('now', '-30 minutes')
    ORDER BY last_heartbeat DESC
  `).all();
}

export function getNextUnassignedTask(excludeIds, teamProjectIds) {
  // Find highest priority open task not assigned to anyone
  // If teamProjectIds provided, scope to those projects only
  var exclude = excludeIds && excludeIds.length > 0
    ? ' AND id NOT IN (' + excludeIds.map(() => '?').join(',') + ')'
    : '';
  var teamScope = teamProjectIds && teamProjectIds.length > 0
    ? ' AND project_id IN (' + teamProjectIds.map(() => '?').join(',') + ')'
    : '';
  var params = [];
  if (excludeIds && excludeIds.length > 0) params = params.concat(excludeIds);
  if (teamProjectIds && teamProjectIds.length > 0) params = params.concat(teamProjectIds);
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status = 'open' AND (assignee IS NULL OR assignee = '')
     ${exclude}${teamScope}
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`
  ).get(...params) || null;
}

export function getNextUnassignedPlanStep(teamProjectIds) {
  // Find next unassigned pending plan step from an active plan
  // If teamProjectIds provided, scope to those plan projects only
  var teamScope = teamProjectIds && teamProjectIds.length > 0
    ? ' AND p.project_id IN (' + teamProjectIds.map(() => '?').join(',') + ')'
    : '';
  var params = teamProjectIds && teamProjectIds.length > 0 ? teamProjectIds : [];
  return db.prepare(
    `SELECT s.*, p.title as plan_title
     FROM plan_steps s
     JOIN plans p ON p.id = s.plan_id
     WHERE p.status = 'active'
       AND s.status = 'pending'
       AND (s.assignee IS NULL OR s.assignee = '')
       ${teamScope}
     ORDER BY s.step_order ASC
     LIMIT 1`
  ).get(...params) || null;
}

// -- Auto-task from asset request --

var _autoTaskFromAsset = null;

export function initTransactions() {
  _autoTaskFromAsset = db.transaction(function (assetId, projectId, requester) {
    var agents = db.prepare("SELECT id FROM agents WHERE capabilities LIKE '%assets%'").all();
    var assignee = agents.length > 0 ? agents[0].id : null;

    var asset = getAsset(assetId);
    if (!asset) return null;

    var taskId = createTask(
      'Generate asset: ' + asset.name,
      'Auto-created from asset request #' + assetId + '. Type: ' + asset.type + '. Project: ' + projectId,
      projectId,
      requester,
      'normal',
      JSON.stringify(['auto', 'assets'])
    );

    db.prepare("UPDATE tasks SET assignee = ?, linked_asset_id = ? WHERE id = ?").run(assignee, assetId, taskId);

    return { task_id: taskId, assignee: assignee };
  });
}

export function autoTaskFromAsset(assetId, projectId, requester) {
  if (!_autoTaskFromAsset) return null;
  return _autoTaskFromAsset(assetId, projectId, requester);
}

// -- Plans --

export function createPlan(title, description, projectId, owner, priority, tags, createdBy) {
  var result = db.prepare(
    "INSERT INTO plans (title, description, project_id, owner, priority, tags, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(title, description || '', projectId || '', owner || '', priority || 'normal', tags || '[]', createdBy || '');
  return result.id;
}

export function getPlan(id) {
  var plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
  if (!plan) return null;
  var steps = db.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_order, id").all(id);
  // Batch-fetch all comments for this plan and group by step
  var allComments = db.prepare("SELECT * FROM plan_step_comments WHERE plan_id = ? ORDER BY created_at ASC").all(id);
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

export function listPlans(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.owner) { where.push('owner = ?'); params.push(filters.owner); }
  if (filters.exclude_status) { where.push('status != ?'); params.push(filters.exclude_status); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  var plans = db.prepare('SELECT * FROM plans WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
  if (plans.length > 0) {
    var planIds = plans.map(function (p) { return p.id; });
    var placeholders = planIds.map(function () { return '?'; }).join(',');
    var allSteps = db.prepare("SELECT plan_id, id, status, title, assignee FROM plan_steps WHERE plan_id IN (" + placeholders + ") ORDER BY step_order ASC").all(...planIds);
    var stepsByPlan = {};
    for (var s of allSteps) {
      if (!stepsByPlan[s.plan_id]) stepsByPlan[s.plan_id] = [];
      stepsByPlan[s.plan_id].push(s);
    }
    for (var p of plans) {
      var steps = stepsByPlan[p.id] || [];
      var total = steps.length;
      var completed = steps.filter(function (st) { return st.status === 'completed'; }).length;
      p.step_count = total;
      p.progress = { total: total, completed: completed, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
      var current = steps.find(function (st) { return st.status === 'in_progress'; }) ||
                    steps.find(function (st) { return st.status === 'pending'; });
      p.current_step = current ? current.title : null;
    }
  }
  return plans;
}

export function updatePlan(id, fields) {
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
  return db.prepare('UPDATE plans SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deletePlan(id) {
  db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
  db.prepare("DELETE FROM plans WHERE id = ?").run(id);
}

export function createPlanStep(planId, title, description, assignee, phase) {
  var maxOrder = db.prepare("SELECT MAX(step_order) as m FROM plan_steps WHERE plan_id = ?").get(planId);
  var order = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 0;
  var result = db.prepare(
    "INSERT INTO plan_steps (plan_id, step_order, title, description, assignee, phase) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(planId, order, title, description || '', assignee || null, phase || '');
  db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  return result.id;
}

export function updatePlanStep(stepId, fields) {
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
  db.prepare('UPDATE plan_steps SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  // Update parent plan's updated_at
  var step = db.prepare("SELECT plan_id FROM plan_steps WHERE id = ?").get(stepId);
  if (step) db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

export function deletePlanStep(stepId) {
  var step = db.prepare("SELECT plan_id FROM plan_steps WHERE id = ?").get(stepId);
  db.prepare("DELETE FROM plan_steps WHERE id = ?").run(stepId);
  if (step) db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

export function reorderPlanSteps(planId, stepIds) {
  var reorder = db.transaction(function () {
    for (var i = 0; i < stepIds.length; i++) {
      db.prepare("UPDATE plan_steps SET step_order = ? WHERE id = ? AND plan_id = ?").run(i, stepIds[i], planId);
    }
    db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  });
  reorder();
}

export function completeLinkedPlanSteps(taskId) {
  var steps = db.prepare("SELECT id, plan_id FROM plan_steps WHERE linked_task_id = ? AND status != 'completed'").all(taskId);
  var affectedPlanIds = [];
  for (var step of steps) {
    db.prepare("UPDATE plan_steps SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(step.id);
    if (affectedPlanIds.indexOf(step.plan_id) === -1) affectedPlanIds.push(step.plan_id);
  }
  // Check if any affected plans are now fully complete
  var completedPlans = [];
  for (var planId of affectedPlanIds) {
    var remaining = db.prepare("SELECT COUNT(*) as c FROM plan_steps WHERE plan_id = ? AND status NOT IN ('completed', 'skipped')").get(planId);
    if (remaining.c === 0) {
      db.prepare("UPDATE plans SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'active'").run(planId);
      completedPlans.push(planId);
    } else {
      db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
    }
  }
  return { steps_completed: steps.length, plans_completed: completedPlans };
}

// -- Studio Users --

export function createStudioUser(username, displayName, passwordHash, role) {
  var result = db.prepare(
    "INSERT INTO studio_users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(username, displayName, passwordHash, role || 'admin');
  return result.id;
}

export function getStudioUserByUsername(username) {
  return db.prepare("SELECT * FROM studio_users WHERE username = ?").get(username);
}

export function getStudioUserById(id) {
  return db.prepare("SELECT id, username, display_name, role, created_at FROM studio_users WHERE id = ?").get(id);
}

export function listStudioUsers() {
  return db.prepare("SELECT id, username, display_name, role, created_at, last_seen FROM studio_users ORDER BY created_at").all();
}

export function touchStudioUserSeen(id) {
  db.prepare("UPDATE studio_users SET last_seen = datetime('now') WHERE id = ?").run(id);
}

export function getActiveStudioUsers(withinMinutes) {
  var mins = withinMinutes || 5;
  return db.prepare(
    "SELECT id, username, display_name, role, last_seen FROM studio_users WHERE last_seen >= datetime('now', '-' || ? || ' minutes') ORDER BY last_seen DESC"
  ).all(mins);
}

export function deleteStudioUser(id) {
  db.prepare("DELETE FROM studio_users WHERE id = ?").run(id);
}

export function updateStudioUser(id, fields) {
  var sets = [];
  var values = [];
  if (fields.display_name !== undefined) { sets.push('display_name = ?'); values.push(fields.display_name); }
  if (fields.password_hash !== undefined) { sets.push('password_hash = ?'); values.push(fields.password_hash); }
  if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE studio_users SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Webhooks --

export function createWebhook(agentId, url, events, secret) {
  var eventsJson = Array.isArray(events) ? JSON.stringify(events) : (events || '["task_created","request_created","message_sent"]');
  var result = db.prepare(
    "INSERT INTO webhooks (agent_id, url, events, secret) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(agentId, url, eventsJson, secret || '');
  return result.id;
}

export function listWebhooks(agentId) {
  if (agentId) {
    return db.prepare("SELECT * FROM webhooks WHERE agent_id = ? AND active = 1").all(agentId);
  }
  return db.prepare("SELECT * FROM webhooks WHERE active = 1").all();
}

export function deleteWebhook(id) {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
}

export function dispatchWebhook(event, agentId, data) {
  // Query webhooks for the target agent AND __global__ (admin-claude receives all events)
  var webhooks = db.prepare(
    "SELECT * FROM webhooks WHERE active = 1 AND (agent_id = ? OR agent_id = '__global__')"
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
      "INSERT INTO webhook_deliveries (webhook_id, event, agent_id, payload, status_code, response_body, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
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
  return db.prepare('SELECT * FROM webhook_deliveries WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function pruneWebhookDeliveries(keepDays) {
  var days = keepDays || 7;
  var result = db.prepare("DELETE FROM webhook_deliveries WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
  return result.changes;
}

// -- Team Chat (human-only messages) --

export function createTeamChat(fromUser, content) {
  var result = db.prepare(
    "INSERT INTO messages (from_agent, content, msg_type) VALUES (?, ?, 'chat') RETURNING id"
  ).get(fromUser, content);
  return result.id;
}

export function listTeamChat(limit) {
  return db.prepare(
    "SELECT * FROM messages WHERE msg_type = 'chat' ORDER BY created_at DESC LIMIT ?"
  ).all(limit || 50);
}

// -- Channels --

export function createChannel(name, slug, type, linkedType, linkedId, description, createdBy) {
  var result = db.prepare(
    "INSERT INTO channels (name, slug, type, linked_type, linked_id, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, slug, type || 'general', linkedType || null, linkedId || null, description || '', createdBy);
  return result.id;
}

export function getChannel(id) {
  return db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
}

export function getChannelBySlug(slug) {
  return db.prepare("SELECT * FROM channels WHERE slug = ?").get(slug);
}

export function getChannelByLink(linkedType, linkedId) {
  return db.prepare("SELECT * FROM channels WHERE linked_type = ? AND linked_id = ?").get(linkedType, linkedId);
}

export function listChannels(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status && filters.status !== 'all') { where.push('status = ?'); params.push(filters.status); }
  else if (!filters.status) { where.push("status = 'active'"); }
  if (filters.member) {
    where.push('id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)');
    params.push(filters.member);
  }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM channels WHERE ' + where.join(' AND ') + ' ORDER BY created_at ASC LIMIT ? OFFSET ?').all(...params);
}

export function updateChannel(id, fields) {
  var sets = [];
  var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE channels SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteChannel(id) {
  db.prepare("DELETE FROM channels WHERE id = ?").run(id);
}

// -- Channel Members --

export function addChannelMember(channelId, userId, userType, role) {
  try {
    db.prepare(
      "INSERT INTO channel_members (channel_id, user_id, user_type, role) VALUES (?, ?, ?, ?)"
    ).run(channelId, userId, userType || 'agent', role || 'member');
    return true;
  } catch (e) {
    return false;
  }
}

export function removeChannelMember(channelId, userId) {
  var result = db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
  return result.changes > 0;
}

export function listChannelMembers(channelId) {
  return db.prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC").all(channelId);
}

export function isChannelMember(channelId, userId) {
  var row = db.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?").get(channelId, userId);
  return !!row;
}

export function getChannelsByUser(userId) {
  return db.prepare(
    "SELECT c.*, cm.role as member_role FROM channels c JOIN channel_members cm ON c.id = cm.channel_id WHERE cm.user_id = ? AND c.status = 'active' ORDER BY c.created_at ASC"
  ).all(userId);
}

// -- Channel Read Tracking --

export function markChannelRead(channelId, userId, messageId) {
  db.prepare(
    "INSERT INTO channel_reads (channel_id, user_id, last_read_at, last_read_message_id) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = datetime('now'), last_read_message_id = excluded.last_read_message_id"
  ).run(channelId, userId, messageId || 0);
}

export function getUnreadCounts(userId) {
  return db.prepare(
    "SELECT c.id as channel_id, c.name, c.slug, COUNT(m.id) as unread FROM channels c JOIN channel_members cm ON c.id = cm.channel_id LEFT JOIN messages m ON m.channel_id = c.id AND m.id > COALESCE((SELECT last_read_message_id FROM channel_reads WHERE channel_id = c.id AND user_id = ?), 0) WHERE cm.user_id = ? AND c.status = 'active' GROUP BY c.id"
  ).all(userId, userId);
}

export function getLatestChannelMessageId(channelId) {
  var row = db.prepare("SELECT MAX(id) as max_id FROM messages WHERE channel_id = ?").get(channelId);
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
    'SELECT * FROM messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function createChannelMessage(channelId, fromAgent, content, metadata) {
  var result = db.prepare(
    "INSERT INTO messages (channel_id, from_agent, content, metadata, msg_type) VALUES (?, ?, ?, ?, 'message') RETURNING id"
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
    SELECT c.id FROM channels c
    WHERE c.type = 'dm' AND c.status = 'active'
      AND (SELECT COUNT(*) FROM channel_members m
           WHERE m.channel_id = c.id AND LOWER(m.user_id) IN (LOWER(?), LOWER(?))) = 2
      AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = 2
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

export function createDroneJob(title, command, inputData, requires, requester, priority, workspaceRepo, workspaceBranch, profileId) {
  var result = db.prepare(
    "INSERT INTO drone_jobs (title, command, input_data, requires, requester, priority, workspace_repo, workspace_branch, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(
    title,
    command || '',
    typeof inputData === 'string' ? inputData : JSON.stringify(inputData || {}),
    typeof requires === 'string' ? requires : JSON.stringify(requires || ['cpu']),
    requester,
    priority || 0,
    workspaceRepo || null,
    workspaceBranch || 'main',
    profileId || null
  );
  return result.id;
}

export function getDroneJob(id) {
  return db.prepare("SELECT * FROM drone_jobs WHERE id = ?").get(id);
}

export function claimDroneJob(droneId, capabilities) {
  // Atomic: find oldest pending job where requires is a subset of capabilities
  // If job has profile_id, drone must have completed setup for that profile
  var caps = Array.isArray(capabilities) ? capabilities : [];
  var pending = db.prepare(
    "SELECT * FROM drone_jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC"
  ).all();
  for (var job of pending) {
    var reqs = [];
    try { reqs = JSON.parse(job.requires || '["cpu"]'); } catch (e) { console.warn('[mycelium] JSON parse failed for job.requires (job: ' + job.id + '):', e.message); reqs = ['cpu']; }
    var matched = reqs.every(function (r) { return caps.indexOf(r) !== -1; });
    if (!matched) continue;
    // Check profile requirement — drone must have setup_done=1 for this profile
    if (job.profile_id) {
      var assignment = db.prepare(
        "SELECT setup_done FROM drone_profile_assignments WHERE drone_id = ? AND profile_id = ?"
      ).get(droneId, job.profile_id);
      if (!assignment || !assignment.setup_done) continue;
    }
    var result = db.prepare(
      "UPDATE drone_jobs SET status = 'claimed', drone_id = ?, started_at = datetime('now') WHERE id = ? AND status = 'pending'"
    ).run(droneId, job.id);
    if (result.changes > 0) return getDroneJob(job.id);
  }
  return null;
}

export function updateDroneJob(id, fields) {
  var sets = [];
  var values = [];
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.command !== undefined) { sets.push('command = ?'); values.push(fields.command); }
  if (fields.input_data !== undefined) { sets.push('input_data = ?'); values.push(typeof fields.input_data === 'string' ? fields.input_data : JSON.stringify(fields.input_data)); }
  if (fields.result_url !== undefined) { sets.push('result_url = ?'); values.push(fields.result_url); }
  if (fields.result_data !== undefined) { sets.push('result_data = ?'); values.push(typeof fields.result_data === 'string' ? fields.result_data : JSON.stringify(fields.result_data)); }
  if (fields.error !== undefined) { sets.push('error = ?'); values.push(fields.error); }
  if (fields.completed_at !== undefined) { sets.push('completed_at = ?'); values.push(fields.completed_at); }
  if (sets.length === 0) return;
  values.push(id);
  return db.prepare('UPDATE drone_jobs SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
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
  return db.prepare('SELECT * FROM drone_jobs WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function listDrones() {
  return db.prepare("SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, created_at FROM agents WHERE project_id = 'drone' ORDER BY created_at").all();
}

// -- Drone Profiles --

export function createDroneProfile(id, name, description, requires, artifacts, setupScript, workspace, env) {
  db.prepare(
    "INSERT INTO drone_profiles (id, name, description, requires, artifacts, setup_script, workspace, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id, name, description || '',
    typeof requires === 'string' ? requires : JSON.stringify(requires || {}),
    typeof artifacts === 'string' ? artifacts : JSON.stringify(artifacts || []),
    setupScript || '',
    workspace || '',
    typeof env === 'string' ? env : JSON.stringify(env || {})
  );
  return getDroneProfile(id);
}

export function getDroneProfile(id) {
  return db.prepare("SELECT * FROM drone_profiles WHERE id = ?").get(id);
}

export function listDroneProfiles() {
  return db.prepare("SELECT * FROM drone_profiles ORDER BY created_at").all();
}

export function updateDroneProfile(id, fields) {
  var sets = [];
  var values = [];
  for (var key of ['name', 'description', 'setup_script', 'workspace']) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  for (var jsonKey of ['requires', 'artifacts', 'env']) {
    if (fields[jsonKey] !== undefined) {
      sets.push(jsonKey + ' = ?');
      values.push(typeof fields[jsonKey] === 'string' ? fields[jsonKey] : JSON.stringify(fields[jsonKey]));
    }
  }
  if (sets.length === 0) return getDroneProfile(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare('UPDATE drone_profiles SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  // Invalidate setup_done for all drones assigned to this profile
  db.prepare("UPDATE drone_profile_assignments SET setup_done = 0, checksum = '' WHERE profile_id = ?").run(id);
  return getDroneProfile(id);
}

export function deleteDroneProfile(id) {
  return db.prepare("DELETE FROM drone_profiles WHERE id = ?").run(id);
}

export function assignDroneProfile(droneId, profileId) {
  db.prepare(
    "INSERT OR REPLACE INTO drone_profile_assignments (drone_id, profile_id, setup_done, checksum) VALUES (?, ?, 0, '')"
  ).run(droneId, profileId);
}

export function unassignDroneProfile(droneId, profileId) {
  return db.prepare("DELETE FROM drone_profile_assignments WHERE drone_id = ? AND profile_id = ?").run(droneId, profileId);
}

export function getDroneProfileAssignments(droneId) {
  return db.prepare(
    "SELECT a.*, p.name, p.description, p.requires, p.artifacts, p.setup_script, p.workspace, p.env, p.updated_at as profile_updated_at " +
    "FROM drone_profile_assignments a JOIN drone_profiles p ON a.profile_id = p.id WHERE a.drone_id = ? ORDER BY p.created_at"
  ).all(droneId);
}

export function markProfileSetupDone(droneId, profileId, checksum) {
  db.prepare(
    "UPDATE drone_profile_assignments SET setup_done = 1, setup_at = datetime('now'), checksum = ? WHERE drone_id = ? AND profile_id = ?"
  ).run(checksum || '', droneId, profileId);
}

export function getDronesWithProfile(profileId) {
  return db.prepare(
    "SELECT a.drone_id, a.setup_done, a.setup_at, a.checksum, ag.status, ag.last_heartbeat " +
    "FROM drone_profile_assignments a JOIN agents ag ON a.drone_id = ag.id WHERE a.profile_id = ?"
  ).all(profileId);
}

export function bulkCancelDroneJobs(statuses, olderThanDays) {
  var placeholders = statuses.map(function () { return '?'; }).join(',');
  var params = statuses.slice();
  var where = 'status IN (' + placeholders + ')';
  if (parseInt(olderThanDays) > 0) {
    where += " AND completed_at < datetime('now', '-' || ? || ' days')";
    params.push(String(parseInt(olderThanDays)));
  }
  var jobs = db.prepare('SELECT id, title, status FROM drone_jobs WHERE ' + where).all.apply(
    db.prepare('SELECT id, title, status FROM drone_jobs WHERE ' + where), params
  );
  if (jobs.length > 0) {
    var idPlaceholders = jobs.map(function () { return '?'; }).join(',');
    var ids = jobs.map(function (j) { return j.id; });
    db.prepare("UPDATE drone_jobs SET status = 'cancelled' WHERE id IN (" + idPlaceholders + ')').run.apply(
      db.prepare("UPDATE drone_jobs SET status = 'cancelled' WHERE id IN (" + idPlaceholders + ')'), ids
    );
  }
  return jobs;
}

// -- Job Templates --

// Seed the 3d_print template so new instances support printer drones out of the box.
export function seedDefaultJobTemplates() {
  var existing = db.prepare("SELECT id FROM job_templates WHERE id = '3d_print'").get();
  if (!existing) {
    db.prepare(
      "INSERT INTO job_templates (id, name, project_id, requires, min_vram_gb, min_disk_gb) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('3d_print', '3D Print Job', '', '["3d_printer"]', 0, 1);
    console.log('Seeded 3d_print job template');
  }
}

export function createJobTemplate(id, fields) {
  db.prepare(
    "INSERT INTO job_templates (id, name, project_id, requires, min_vram_gb, min_disk_gb, python_deps, python_deps_install, artifacts, setup_repo, command_template, workspace_name) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    fields.name || id,
    fields.project_id || '',
    typeof fields.requires === 'string' ? fields.requires : JSON.stringify(fields.requires || ['cpu']),
    fields.min_vram_gb || 0,
    fields.min_disk_gb || 5,
    typeof fields.python_deps === 'string' ? fields.python_deps : JSON.stringify(fields.python_deps || []),
    fields.python_deps_install || '',
    typeof fields.artifacts === 'string' ? fields.artifacts : JSON.stringify(fields.artifacts || []),
    fields.setup_repo || '',
    fields.command_template || '',
    fields.workspace_name || ''
  );
  return getJobTemplate(id);
}

export function getJobTemplate(id) {
  return db.prepare("SELECT * FROM job_templates WHERE id = ?").get(id);
}

export function listJobTemplates() {
  return db.prepare("SELECT * FROM job_templates ORDER BY created_at").all();
}

export function updateJobTemplate(id, fields) {
  var sets = [];
  var values = [];
  for (var key of ['name', 'project_id', 'python_deps_install', 'setup_repo', 'command_template', 'workspace_name']) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  for (var numKey of ['min_vram_gb', 'min_disk_gb']) {
    if (fields[numKey] !== undefined) { sets.push(numKey + ' = ?'); values.push(fields[numKey]); }
  }
  for (var jsonKey of ['requires', 'python_deps', 'artifacts']) {
    if (fields[jsonKey] !== undefined) {
      sets.push(jsonKey + ' = ?');
      values.push(typeof fields[jsonKey] === 'string' ? fields[jsonKey] : JSON.stringify(fields[jsonKey]));
    }
  }
  if (sets.length === 0) return getJobTemplate(id);
  values.push(id);
  db.prepare('UPDATE job_templates SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  return getJobTemplate(id);
}

export function deleteJobTemplate(id) {
  return db.prepare("DELETE FROM job_templates WHERE id = ?").run(id);
}

// -- Drone Diagnostics --

export function updateDroneDiagnostics(agentId, diagnostics) {
  var json = typeof diagnostics === 'string' ? diagnostics : JSON.stringify(diagnostics);
  db.prepare("UPDATE agents SET system_diagnostics = ? WHERE id = ?").run(json, agentId);
}

export function getDroneDiagnostics(agentId) {
  var row = db.prepare("SELECT system_diagnostics FROM agents WHERE id = ?").get(agentId);
  if (!row) return null;
  try { return JSON.parse(row.system_diagnostics || '{}'); } catch (e) { return {}; }
}

// -- Platform Resolver + Command Renderer --

export function renderJobForDrone(templateId, droneId, inputData) {
  var template = getJobTemplate(templateId);
  if (!template) return { error: 'Template not found: ' + templateId };

  var diag = getDroneDiagnostics(droneId);
  if (!diag || Object.keys(diag).length === 0) {
    // Fall back to savepoint system_info
    var savepoint = getLatestSavepoint(droneId);
    if (savepoint) {
      try {
        var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
        diag = snapshot.system_info || {};
      } catch (e) { diag = {}; }
    }
  }
  if (!diag || Object.keys(diag).length === 0) {
    return { error: 'No diagnostics available for drone ' + droneId + '. Drone must heartbeat first.' };
  }

  // Compatibility checks
  var templateReqs = [];
  try { templateReqs = JSON.parse(template.requires || '["cpu"]'); } catch (e) { templateReqs = ['cpu']; }

  // Check GPU requirement
  if (templateReqs.indexOf('gpu') !== -1) {
    if (!diag.cuda_available && !diag.gpu_name) {
      return { error: 'Template requires GPU but drone has none', incompatible: true };
    }
    if (template.min_vram_gb > 0 && diag.gpu_vram_gb && diag.gpu_vram_gb < template.min_vram_gb) {
      return { error: 'Template requires ' + template.min_vram_gb + ' GB VRAM but drone has ' + diag.gpu_vram_gb + ' GB', incompatible: true };
    }
  }

  // Check disk
  if (template.min_disk_gb > 0 && diag.disk_free_gb && diag.disk_free_gb < template.min_disk_gb) {
    return { error: 'Template requires ' + template.min_disk_gb + ' GB free disk but drone has ' + diag.disk_free_gb + ' GB', incompatible: true };
  }

  // Resolve platform vars
  var isWindows = (diag.os || '').toLowerCase() === 'windows';
  var pythonPath = diag.python_path || (isWindows ? 'python' : 'python3');
  var home = diag.home || (isWindows ? 'C:/Users/' + (diag.username || 'user') : '/home/' + (diag.username || 'user'));
  var workspaceName = template.workspace_name || templateId;
  var workspace = home + '/.mycelium/workspaces/' + workspaceName;
  var nullDev = isWindows ? 'NUL' : '/dev/null';
  var pipInstall = pythonPath + ' -m pip install';
  var pathSep = isWindows ? ';' : ':';

  // Build setup steps
  var setupSteps = [];

  // Step 1: Download artifacts (handled by worker from input_data.artifacts)
  var templateArtifacts = [];
  try { templateArtifacts = JSON.parse(template.artifacts || '[]'); } catch (e) { templateArtifacts = []; }

  // Step 2: Clone setup_repo if specified
  if (template.setup_repo) {
    var repoDir = workspace + '/ai-toolkit';
    var checkClone = isWindows
      ? 'if exist "' + repoDir.replace(/\//g, '\\') + '" (exit /b 0) else (exit /b 1)'
      : 'test -d "' + repoDir + '"';
    setupSteps.push({
      name: 'Clone setup repo',
      check: checkClone,
      run: 'git clone "' + template.setup_repo + '" "' + repoDir + '"',
      skip_if_check_passes: true,
    });
  }

  // Step 3: Install CUDA torch (if GPU required)
  if (templateReqs.indexOf('gpu') !== -1) {
    setupSteps.push({
      name: 'Check/install CUDA PyTorch',
      check: pythonPath + ' -c "import torch; assert torch.cuda.is_available(), \'no cuda\'"',
      run: pipInstall + ' torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124',
      skip_if_check_passes: true,
    });
  }

  // Step 4: Install python deps
  if (template.python_deps_install) {
    var depsList = [];
    try { depsList = JSON.parse(template.python_deps || '[]'); } catch (e) { depsList = []; }
    var importChecks = depsList.map(function (d) {
      // PIL -> Pillow, map common package names
      var mod = d === 'PIL' ? 'PIL' : d;
      return 'import ' + mod;
    }).join('; ');
    setupSteps.push({
      name: 'Install Python dependencies',
      check: pythonPath + ' -c "' + importChecks + '"',
      run: pipInstall + ' ' + template.python_deps_install,
      skip_if_check_passes: true,
    });
  }

  // Render command template
  var vars = {
    python: pythonPath,
    pip_install: pipInstall,
    workspace: workspace,
    null_dev: nullDev,
    path_sep: pathSep,
  };
  // Merge inputData vars
  if (inputData && typeof inputData === 'object') {
    for (var k of Object.keys(inputData)) {
      if (!k.startsWith('_')) vars[k] = inputData[k];
    }
  }
  var command = template.command_template;
  for (var [varName, varVal] of Object.entries(vars)) {
    command = command.replace(new RegExp('\\{\\{' + varName + '\\}\\}', 'g'), String(varVal));
  }

  return {
    command: command,
    setup_steps: setupSteps,
    artifacts: templateArtifacts,
    requires: templateReqs,
    workspace: workspace,
    workspace_name: workspaceName,
    template_id: templateId,
    drone_diagnostics: {
      os: diag.os,
      python_path: pythonPath,
      gpu_name: diag.gpu_name,
      gpu_vram_gb: diag.gpu_vram_gb,
    },
  };
}

export function checkDroneCompatibility(droneId) {
  var templates = listJobTemplates();
  var diag = getDroneDiagnostics(droneId);
  if (!diag || Object.keys(diag).length === 0) {
    var savepoint = getLatestSavepoint(droneId);
    if (savepoint) {
      try {
        var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
        diag = snapshot.system_info || {};
      } catch (e) { diag = {}; }
    }
  }
  if (!diag || Object.keys(diag).length === 0) {
    return { drone_id: droneId, error: 'No diagnostics available', compatible: [], incompatible: [] };
  }

  var compatible = [];
  var incompatible = [];

  for (var t of templates) {
    var reqs = [];
    try { reqs = JSON.parse(t.requires || '["cpu"]'); } catch (e) { reqs = ['cpu']; }
    var issues = [];

    if (reqs.indexOf('gpu') !== -1) {
      if (!diag.cuda_available && !diag.gpu_name) {
        issues.push('Requires GPU, none detected');
      } else if (t.min_vram_gb > 0 && diag.gpu_vram_gb && diag.gpu_vram_gb < t.min_vram_gb) {
        issues.push('Requires ' + t.min_vram_gb + ' GB VRAM, has ' + diag.gpu_vram_gb + ' GB');
      }
    }
    if (t.min_disk_gb > 0 && diag.disk_free_gb && diag.disk_free_gb < t.min_disk_gb) {
      issues.push('Requires ' + t.min_disk_gb + ' GB disk, has ' + diag.disk_free_gb + ' GB');
    }

    if (issues.length === 0) {
      var notes = [];
      if (diag.gpu_name) notes.push(diag.gpu_name + ' ' + (diag.gpu_vram_gb || '?') + ' GB VRAM');
      if (diag.disk_free_gb) notes.push(diag.disk_free_gb + ' GB free disk');
      compatible.push({ template: t.id, name: t.name, status: 'ready', notes: notes.join(', ') });
    } else {
      incompatible.push({ template: t.id, name: t.name, status: 'incompatible', reasons: issues });
    }
  }

  return { drone_id: droneId, compatible: compatible, incompatible: incompatible };
}

// -- Shared Concepts --

export function createConcept(name, type, description, data, createdBy) {
  var r = stmt('dvCreateConcept', `INSERT INTO concepts (name, type, description, data, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(name, type || 'custom', description || '', JSON.stringify(data || {}), createdBy || '');
  return r.lastInsertRowid;
}

export function getConcept(id) {
  return stmt('dvGetConcept', 'SELECT * FROM concepts WHERE id = ?').get(id);
}

export function listConcepts(filters) {
  var where = []; var params = [];
  if (filters && filters.type) { where.push('type = ?'); params.push(filters.type); }
  var sql = 'SELECT * FROM concepts' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC';
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
  db.prepare('UPDATE concepts SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
}

export function deleteConcept(id) {
  db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
}

export function linkConceptToProject(projectId, conceptId, linkedBy) {
  stmt('dvLinkConcept', `INSERT OR IGNORE INTO project_concepts (project_id, concept_id, linked_by)
    VALUES (?, ?, ?)`).run(projectId, conceptId, linkedBy || '');
}

export function unlinkConceptFromProject(projectId, conceptId) {
  stmt('dvUnlinkConcept', 'DELETE FROM project_concepts WHERE project_id = ? AND concept_id = ?').run(projectId, conceptId);
}

export function getProjectConcepts(projectId) {
  return stmt('dvGetProjectConcepts', `SELECT c.*, pc.linked_at, pc.linked_by
    FROM concepts c JOIN project_concepts pc ON c.id = pc.concept_id
    WHERE pc.project_id = ? ORDER BY c.name`).all(projectId);
}

export function getConceptProjects(conceptId) {
  return stmt('dvGetConceptProjects', `SELECT p.*, pc.linked_at, pc.linked_by
    FROM projects p JOIN project_concepts pc ON p.id = pc.project_id
    WHERE pc.concept_id = ? ORDER BY p.name`).all(conceptId);
}

// -- Init (no default seed data — new instances start blank) --

// =============== APPROVALS ===============

var GATED_ACTIONS = ['deploy', 'git_push', 'plan_create', 'money_action', 'delete', 'external_comm'];
export { GATED_ACTIONS };

export function createApproval(actionType, requestedBy, title, payload, projectId, riskTier, requiredApprovals) {
  var result = stmt('dvCreateApproval2',
    "INSERT INTO approvals (action_type, requested_by, title, payload, project_id, risk_tier, required_approvals) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(actionType, requestedBy, title || '', typeof payload === 'string' ? payload : JSON.stringify(payload || {}), projectId || 'mycelium', riskTier || 'medium', requiredApprovals || 1);
  return result.id;
}

export function getApproval(id) {
  return stmt('dvGetApproval', "SELECT * FROM approvals WHERE id = ?").get(id);
}

export function listApprovals(filters) {
  var where = ['1=1']; var params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.action_type) { where.push('action_type = ?'); params.push(filters.action_type); }
  if (filters.requested_by) { where.push('requested_by = ?'); params.push(filters.requested_by); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  var limit = Math.min(filters.limit || 50, 500);
  params.push(limit);
  return db.prepare('SELECT * FROM approvals WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
}

export function decideApproval(id, status, decidedBy, reason) {
  db.prepare(
    "UPDATE approvals SET status = ?, decided_by = ?, decided_at = datetime('now'), reason = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, decidedBy, reason || '', id);
  // Auto-action related inbox items so approve/reject buttons disappear
  db.prepare(
    "UPDATE operator_inbox SET status = 'actioned', read_at = COALESCE(read_at, datetime('now')) WHERE entity_type = 'approval' AND entity_id = ? AND status != 'dismissed'"
  ).run(String(id));
}

export function markApprovalExecuted(id) {
  db.prepare("UPDATE approvals SET status = 'executed', executed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
}

export function countPendingApprovals() {
  return stmt('dvCountApprovals', "SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'").get();
}

export function listPendingApprovalsByAgent(agentId) {
  return db.prepare("SELECT * FROM approvals WHERE requested_by = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC").all(agentId);
}

// -- Approval Votes --

export function castApprovalVote(approvalId, voter, vote, notes) {
  stmt('dvCastVote', `INSERT INTO approval_votes (approval_id, voter, vote, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(approval_id, voter) DO UPDATE SET vote = excluded.vote, notes = excluded.notes, created_at = datetime('now')`
  ).run(approvalId, voter, vote || 'approve', notes || '');
}

export function getApprovalVotes(approvalId) {
  return stmt('dvGetVotes', 'SELECT * FROM approval_votes WHERE approval_id = ? ORDER BY created_at').all(approvalId);
}

export function countApprovalVotes(approvalId) {
  var row = db.prepare(
    "SELECT SUM(CASE WHEN vote = 'approve' THEN 1 ELSE 0 END) as approves, SUM(CASE WHEN vote = 'deny' THEN 1 ELSE 0 END) as denies FROM approval_votes WHERE approval_id = ?"
  ).get(approvalId);
  return { approves: row.approves || 0, denies: row.denies || 0 };
}

export function getAdminOps() {
  var pendingRequests = db.prepare(
    "SELECT * FROM messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC LIMIT 50"
  ).all();
  var unassignedTasks = db.prepare(
    "SELECT * FROM tasks WHERE assignee IS NULL AND status IN ('open', 'in_progress') ORDER BY updated_at DESC LIMIT 50"
  ).all();
  var unassignedBugs = db.prepare(
    "SELECT * FROM bugs WHERE assignee IS NULL AND status = 'open' ORDER BY created_at DESC LIMIT 50"
  ).all();
  var failedDroneJobs = db.prepare(
    "SELECT * FROM drone_jobs WHERE status = 'failed' ORDER BY completed_at DESC LIMIT 50"
  ).all();
  var pendingApprovals = db.prepare(
    "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50"
  ).all();
  var staleRequests = db.prepare(
    "SELECT * FROM messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') AND created_at < datetime('now', '-1 day') ORDER BY created_at ASC LIMIT 50"
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
    "SELECT id FROM messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') AND created_at < datetime('now', '-' || ? || ' hours')"
  ).all(hours);
  for (var req of stale) {
    db.prepare(
      "UPDATE messages SET status = 'resolved', resolved_at = datetime('now'), resolved_by = 'system', content = content || '\n\n[Auto-resolved: request was pending for over ' || ? || ' hours]' WHERE id = ?"
    ).run(hours, req.id);
  }
  return stale.length;
}

export function getOverview(userId) {
  var agents = listAgents();
  var events = listEvents({ limit: 50 });
  var openTasks = listTasks({ status: 'open', limit: 20 });
  var inProgressTasks = listTasks({ status: 'in_progress', limit: 20 });
  var reviewTasks = listTasks({ status: 'review', limit: 20 });
  var recentDone = listTasks({ status: 'done', limit: 10 });
  var messages = listMessages({ limit: 30 });
  var context = getAllContext();
  var contextKeys = listContextKeys();
  var projects = listProjects();
  var approvalQueue = listTasksNeedingApproval();
  var pendingRequests = db.prepare(
    "SELECT * FROM messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC LIMIT 20"
  ).all();
  var assets = listAssets({ limit: 50 });
  var bugs = listBugs({ limit: 50 });
  var bugCounts = countBugs();
  var plans = listPlans({ exclude_status: 'cancelled', limit: 50 });
  var teamChat = listTeamChat(50);
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
    instances: listInstances({}),
  };
}

// =============== SLIM OVERVIEW ===============

function timeSince(dateStr) {
  var diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return Math.round(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
  return Math.round(diff / 86400000) + 'd ago';
}

export function getSlimOverview() {
  // Agent statuses — compact
  var agents = db.prepare(
    "SELECT id, status, working_on, last_heartbeat FROM agents ORDER BY created_at"
  ).all().map(function (a) {
    var hb = a.last_heartbeat ? timeSince(a.last_heartbeat) : 'never';
    return { id: a.id, status: a.status, working_on: a.working_on || '', heartbeat: hb };
  });

  // Counts
  var counts = {
    tasks_open: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'open'").get().c,
    tasks_in_progress: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'in_progress'").get().c,
    bugs_open: db.prepare("SELECT COUNT(*) as c FROM bugs WHERE status = 'open'").get().c,
    plans_active: db.prepare("SELECT COUNT(*) as c FROM plans WHERE status = 'active'").get().c,
    requests_pending: db.prepare("SELECT COUNT(*) as c FROM messages WHERE msg_type = 'request' AND status IN ('sent', 'pending')").get().c,
    approvals_pending: db.prepare("SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'").get().c,
    drones_online: db.prepare("SELECT COUNT(*) as c FROM agents WHERE agent_type = 'drone' AND status = 'online'").get().c,
    drone_jobs_pending: db.prepare("SELECT COUNT(*) as c FROM drone_jobs WHERE status = 'pending'").get().c
  };

  // Attention array — server-side triage
  var attention = [];

  // Stale requests (>1h unresolved)
  var staleRequests = db.prepare(
    "SELECT id, from_agent, content, created_at FROM messages WHERE msg_type = 'request' AND status IN ('sent', 'pending') AND created_at < datetime('now', '-1 hour') ORDER BY created_at ASC LIMIT 5"
  ).all();
  for (var r of staleRequests) {
    attention.push({ type: 'stale_request', id: r.id, from: r.from_agent, title: r.content.slice(0, 80), action: 'respond', age: timeSince(r.created_at) });
  }

  // Pending approvals
  var pendingApprovals = db.prepare(
    "SELECT id, title, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
  ).all();
  for (var a of pendingApprovals) {
    attention.push({ type: 'pending_approval', id: a.id, title: a.title, action: 'approve_or_deny', age: timeSince(a.created_at) });
  }

  // Stale tasks (in_progress >6h without update)
  var staleTasks = db.prepare(
    "SELECT t.id, t.title, t.assignee, t.updated_at FROM tasks t WHERE t.status = 'in_progress' AND t.updated_at < datetime('now', '-6 hours') ORDER BY t.updated_at ASC LIMIT 5"
  ).all();
  for (var t of staleTasks) {
    attention.push({ type: 'stale_task', id: t.id, assignee: t.assignee, title: t.title, action: 'reassign_or_unblock', age: timeSince(t.updated_at) });
  }

  // Unassigned bugs
  var unassignedBugs = db.prepare(
    "SELECT id, title, severity, created_at FROM bugs WHERE status = 'open' AND (assignee IS NULL OR assignee = '') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at ASC LIMIT 5"
  ).all();
  for (var b of unassignedBugs) {
    attention.push({ type: 'unassigned_bug', id: b.id, title: b.title, severity: b.severity, action: 'assign', age: timeSince(b.created_at) });
  }

  // Recent activity — 5 one-liners
  var recentEvents = db.prepare(
    "SELECT summary, created_at FROM events ORDER BY created_at DESC LIMIT 5"
  ).all();
  var recent_activity = recentEvents.map(function (e) {
    return e.summary + ' (' + timeSince(e.created_at) + ')';
  });

  return { agents: agents, counts: counts, attention: attention, recent_activity: recent_activity };
}

// =============== PLUGINS ===============

export function getDB() { return db; }

export function ensurePluginRecord(manifest) {
  var existing = stmt('dvGetPlugin', 'SELECT * FROM plugins WHERE name = ?').get(manifest.name);
  if (existing) {
    stmt('dvUpdatePlugin', `UPDATE plugins SET display_name = ?, description = ?, version = ?, author = ?, route_prefix = ?, mcp_tool_count = ?, updated_at = datetime('now')
      WHERE name = ?`).run(manifest.displayName || '', manifest.description || '', manifest.version || '1.0.0', manifest.author || '', manifest.routePrefix || '', manifest.mcpToolCount || 0, manifest.name);
    return { ...existing, updated: true };
  }
  stmt('dvInsertPlugin', `INSERT INTO plugins (name, display_name, description, version, author, enabled, route_prefix, mcp_tool_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(manifest.name, manifest.displayName || '', manifest.description || '', manifest.version || '1.0.0', manifest.author || '', 0, manifest.routePrefix || '', manifest.mcpToolCount || 0);
  return { name: manifest.name, created: true };
}

export function getPluginRecord(name) {
  return stmt('dvGetPlugin', 'SELECT * FROM plugins WHERE name = ?').get(name);
}

export function listPluginRecords() {
  return db.prepare('SELECT * FROM plugins ORDER BY name').all();
}

export function updatePluginEnabled(name, enabled) {
  return db.prepare("UPDATE plugins SET enabled = ?, updated_at = datetime('now') WHERE name = ?").run(enabled ? 1 : 0, name);
}

export function getPluginMigrationVersion(pluginName) {
  var row = db.prepare('SELECT MAX(version) as v FROM plugin_migrations WHERE plugin_name = ?').get(pluginName);
  return row ? (row.v || 0) : 0;
}

export function recordPluginMigration(pluginName, version, description) {
  db.prepare('INSERT INTO plugin_migrations (plugin_name, version, description) VALUES (?, ?, ?)').run(pluginName, version, description || '');
}

// ======== PLUGIN CONFIG ========

export function getPluginConfig(pluginName) {
  var rows = db.prepare('SELECT key, value, is_secret FROM plugin_config WHERE plugin_name = ?').all(pluginName);
  return rows;
}

export function getPluginConfigValue(pluginName, key) {
  var row = db.prepare('SELECT value FROM plugin_config WHERE plugin_name = ? AND key = ?').get(pluginName, key);
  return row ? row.value : null;
}

export function setPluginConfig(pluginName, key, value, isSecret) {
  db.prepare(
    `INSERT INTO plugin_config (plugin_name, key, value, is_secret, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(plugin_name, key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at`
  ).run(pluginName, key, String(value), isSecret ? 1 : 0);
}

export function deletePluginConfig(pluginName, key) {
  db.prepare('DELETE FROM plugin_config WHERE plugin_name = ? AND key = ?').run(pluginName, key);
}

// ======== AGENT SAVEPOINTS ========

export function createSavepoint(agentId, data) {
  return db.prepare(
    `INSERT INTO agent_savepoints (agent_id, session_id, heartbeat_at, working_on, state_snapshot, messages_acked, context_versions, notes)
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
    'SELECT * FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT 1'
  ).get(agentId);
}

export function getSavepointHistory(agentId, limit) {
  return db.prepare(
    'SELECT id, agent_id, session_id, heartbeat_at, working_on, notes, created_at FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT ?'
  ).all(agentId, limit || 10);
}

export function updateSavepointNotes(agentId, notes) {
  var latest = getLatestSavepoint(agentId);
  if (!latest) return null;
  db.prepare('UPDATE agent_savepoints SET notes = ? WHERE id = ?').run(notes, latest.id);
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
    "SELECT * FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND id NOT IN (SELECT value FROM json_each(?)) AND created_at > ? ORDER BY created_at ASC LIMIT 100"
  ).all(agentId, JSON.stringify(ackedIds), savepoint.heartbeat_at);

  // Tasks that changed since savepoint
  var tasksChanged = db.prepare(
    "SELECT * FROM tasks WHERE (assignee = ? OR assignee IS NULL) AND updated_at > ? ORDER BY updated_at DESC LIMIT 50"
  ).all(agentId, savepoint.heartbeat_at);

  // Context keys that changed since savepoint
  var contextChanged = db.prepare(
    "SELECT * FROM context_keys WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 50"
  ).all(savepoint.heartbeat_at);

  // Plans that changed since savepoint
  var plansChanged = db.prepare(
    "SELECT p.* FROM plans p WHERE p.updated_at > ? ORDER BY p.updated_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at);

  // Bugs that changed since savepoint
  var bugsChanged = db.prepare(
    "SELECT * FROM bugs WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at);

  // Drone jobs that changed since savepoint
  var droneJobsChanged = db.prepare(
    "SELECT * FROM drone_jobs WHERE (started_at > ? OR completed_at > ? OR created_at > ?) ORDER BY created_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at, savepoint.heartbeat_at, savepoint.heartbeat_at);

  // Events since savepoint
  var eventsSince = db.prepare(
    "SELECT * FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT 50"
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
    'SELECT heartbeat_at FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT 1 OFFSET ?'
  ).get(agentId, count);
  if (cutoff) {
    db.prepare('DELETE FROM agent_savepoints WHERE agent_id = ? AND heartbeat_at < ?').run(agentId, cutoff.heartbeat_at);
  }
}

// -- Feedback --

export function createFeedback(entityType, entityId, subject, rating, comment, submittedBy, agentId) {
  var r = Math.max(1, Math.min(5, parseInt(rating) || 3));
  var result = db.prepare(
    'INSERT INTO feedback (entity_type, entity_id, subject, rating, comment, submitted_by, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(entityType || 'general', entityId || '', subject || '', r, comment || '', submittedBy || 'operator', agentId || '');
  return result.id;
}

export function getFeedback(id) {
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
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
  var sql = 'SELECT * FROM feedback WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function deleteFeedback(id) {
  db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
}

// -- Operator Inbox --

export function createInboxItem(operatorId, type, entityType, entityId, title, summary, data, priority) {
  var result = db.prepare(
    'INSERT INTO operator_inbox (operator_id, type, entity_type, entity_id, title, summary, data, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(operatorId, type || 'message', entityType || '', entityId || '', title || '', summary || '', JSON.stringify(data || {}), priority || 'normal');
  return result.id;
}

export function createInboxItemForAllOperators(type, entityType, entityId, title, summary, data, priority) {
  var ops = db.prepare("SELECT id FROM operators WHERE status = 'active'").all();
  var ids = [];
  var insertStmt = db.prepare(
    'INSERT INTO operator_inbox (operator_id, type, entity_type, entity_id, title, summary, data, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  );
  for (var op of ops) {
    var row = insertStmt.get(op.id, type || 'message', entityType || '', entityId || '', title || '', summary || '', JSON.stringify(data || {}), priority || 'normal');
    ids.push(row.id);
  }
  return ids;
}

export function getInboxItem(id) {
  return db.prepare('SELECT * FROM operator_inbox WHERE id = ?').get(id);
}

export function listInboxItems(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.operator_id) { where.push('operator_id = ?'); params.push(filters.operator_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  else { where.push("status != 'dismissed'"); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.entity_type) { where.push('entity_type = ?'); params.push(filters.entity_type); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  var sql = 'SELECT * FROM operator_inbox WHERE ' + where.join(' AND ') + ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'normal\' THEN 1 ELSE 2 END, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function markInboxItemRead(id) {
  db.prepare("UPDATE operator_inbox SET status = 'read', read_at = datetime('now') WHERE id = ? AND status = 'unread'").run(id);
}

export function markInboxItemActioned(id) {
  db.prepare("UPDATE operator_inbox SET status = 'actioned', read_at = COALESCE(read_at, datetime('now')) WHERE id = ?").run(id);
}

export function dismissInboxItem(id) {
  db.prepare("UPDATE operator_inbox SET status = 'dismissed' WHERE id = ?").run(id);
}

export function countUnreadInbox(operatorId) {
  var row = db.prepare("SELECT COUNT(*) as c FROM operator_inbox WHERE operator_id = ? AND status = 'unread'").get(operatorId);
  return row ? row.c : 0;
}

export function countAllUnreadInbox() {
  return db.prepare("SELECT operator_id, COUNT(*) as count FROM operator_inbox WHERE status = 'unread' GROUP BY operator_id").all();
}

// ======== RUNNER SPAWNS (dynamic agent swarm) ========

export function createRunnerSpawn(tier, model, cwd, maxTurns, title, workContext, requestedBy) {
  var result = db.prepare(
    'INSERT INTO runner_spawns (tier, model, cwd, max_turns, title, work_context, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(tier || 'agent', model || '', cwd || '', maxTurns || 50, title || '', JSON.stringify(workContext || {}), requestedBy || '');
  return result.id;
}

export function getRunnerSpawn(id) {
  var row = db.prepare('SELECT * FROM runner_spawns WHERE id = ?').get(id);
  if (row) { try { row.work_context = JSON.parse(row.work_context); } catch (e) { row.work_context = {}; } }
  return row;
}

export function listRunnerSpawns(status) {
  var rows = status
    ? db.prepare("SELECT * FROM runner_spawns WHERE status = ? ORDER BY created_at DESC LIMIT 100").all(status)
    : db.prepare("SELECT * FROM runner_spawns ORDER BY created_at DESC LIMIT 100").all();
  return rows.map(function (r) {
    try { r.work_context = JSON.parse(r.work_context); } catch (e) { r.work_context = {}; }
    return r;
  });
}

export function claimRunnerSpawn(id, runnerId) {
  db.prepare("UPDATE runner_spawns SET status = 'claimed', runner_id = ?, claimed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(runnerId || 'runner', id);
}

export function doneRunnerSpawn(id, result, status) {
  db.prepare("UPDATE runner_spawns SET status = ?, result = ?, done_at = datetime('now') WHERE id = ?").run(status || 'done', result || '', id);
}

export function getFeedbackSummary() {
  var total = db.prepare('SELECT COUNT(*) as count FROM feedback').get().count;
  var avgRating = db.prepare('SELECT ROUND(AVG(rating), 2) as avg FROM feedback').get().avg || 0;
  var byAgent = db.prepare(
    "SELECT agent_id, COUNT(*) as count, ROUND(AVG(rating), 2) as avg_rating FROM feedback WHERE agent_id != '' GROUP BY agent_id ORDER BY count DESC LIMIT 20"
  ).all();
  var byType = db.prepare(
    'SELECT entity_type, COUNT(*) as count, ROUND(AVG(rating), 2) as avg_rating FROM feedback GROUP BY entity_type ORDER BY count DESC'
  ).all();
  var ratingDist = db.prepare(
    'SELECT rating, COUNT(*) as count FROM feedback GROUP BY rating ORDER BY rating'
  ).all();
  var recent = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 5').all();
  return { total, avg_rating: avgRating, by_agent: byAgent, by_type: byType, rating_dist: ratingDist, recent };
}

// ---- Support Tickets ----
export function createSupportTicket(data) {
  var result = db.prepare(
    'INSERT INTO support_tickets (instance_id, subject, description, category, priority, reporter_email, reporter_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *'
  ).get(data.instance_id || '', data.subject, data.description || '', data.category || 'general', data.priority || 'normal', data.reporter_email || '', data.reporter_name || '');
  return result;
}

export function getSupportTicket(id) {
  return db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
}

export function listSupportTickets(filters) {
  var where = [];
  var params = [];
  if (filters && filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters && filters.instance_id) { where.push('instance_id = ?'); params.push(filters.instance_id); }
  if (filters && filters.priority) { where.push('priority = ?'); params.push(filters.priority); }
  var limit = parseInt((filters && filters.limit) || 100) || 100;
  params.push(limit);
  var sql = 'SELECT * FROM support_tickets' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ?';
  return db.prepare(sql).all.apply(db.prepare(sql), params);
}

export function updateSupportTicket(id, updates) {
  var sets = [];
  var params = [];
  var allowed = ['subject', 'description', 'category', 'priority', 'status', 'assignee', 'resolution', 'tier', 'assigned_agent', 'requires_approval', 'draft_response'];
  for (var key of allowed) {
    if (updates[key] !== undefined) { sets.push(key + ' = ?'); params.push(updates[key]); }
  }
  if (sets.length === 0) return getSupportTicket(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare('UPDATE support_tickets SET ' + sets.join(', ') + ' WHERE id = ?').run.apply(db.prepare('UPDATE support_tickets SET ' + sets.join(', ') + ' WHERE id = ?'), params);
  return getSupportTicket(id);
}

export function deleteSupportTicket(id) {
  return db.prepare('DELETE FROM support_tickets WHERE id = ?').run(id);
}

// =============== NODE PROFILES — Stand Up Calibration ===============

var NODE_PROFILE_JSON_FIELDS = ['rules', 'required_concepts', 'mcp_config', 'tool_whitelist', 'repo_list', 'md_checkpoints', 'md_blocklist'];

function stringifyProfileField(val) {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function parseProfileRow(row) {
  if (!row) return null;
  for (var f of NODE_PROFILE_JSON_FIELDS) {
    if (row[f]) {
      try { row[f] = JSON.parse(row[f]); } catch (e) { /* keep as string */ }
    }
  }
  return row;
}

export function createNodeProfile(id, data) {
  var d = data || {};
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    d.node_type || 'agent',
    d.layer || 'customer',
    d.parent_id || null,
    stringifyProfileField(d.rules) || '{}',
    stringifyProfileField(d.required_concepts) || '[]',
    stringifyProfileField(d.mcp_config) || '{}',
    stringifyProfileField(d.tool_whitelist) || '[]',
    stringifyProfileField(d.repo_list) || '[]',
    stringifyProfileField(d.md_checkpoints) || '[]',
    stringifyProfileField(d.md_blocklist) || '[]'
  );
  return getNodeProfile(id);
}

export function getNodeProfile(id) {
  var row = db.prepare('SELECT * FROM node_profiles WHERE id = ?').get(id);
  return parseProfileRow(row);
}

export function listNodeProfiles(filter) {
  var where = [];
  var params = [];
  if (filter && filter.node_type) { where.push('node_type = ?'); params.push(filter.node_type); }
  if (filter && filter.layer) { where.push('layer = ?'); params.push(filter.layer); }
  var sql = 'SELECT * FROM node_profiles' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY layer, node_type, id';
  var rows = db.prepare(sql).all.apply(db.prepare(sql), params);
  return rows.map(parseProfileRow);
}

export function updateNodeProfile(id, data) {
  var existing = getNodeProfile(id);
  if (!existing) return null;
  if (existing.layer === 'platform') return null;

  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (data.node_type !== undefined) { sets.push('node_type = ?'); values.push(data.node_type); }
  if (data.layer !== undefined) { sets.push('layer = ?'); values.push(data.layer); }
  if (data.parent_id !== undefined) { sets.push('parent_id = ?'); values.push(data.parent_id); }
  for (var f of NODE_PROFILE_JSON_FIELDS) {
    if (data[f] !== undefined) { sets.push(f + ' = ?'); values.push(stringifyProfileField(data[f])); }
  }
  if (values.length === 0) return existing;
  values.push(id);
  db.prepare('UPDATE node_profiles SET ' + sets.join(', ') + ' WHERE id = ?').run.apply(
    db.prepare('UPDATE node_profiles SET ' + sets.join(', ') + ' WHERE id = ?'), values
  );
  return getNodeProfile(id);
}

export function deleteNodeProfile(id) {
  var existing = getNodeProfile(id);
  if (!existing) return null;
  if (existing.layer === 'platform') return null;
  db.prepare('DELETE FROM node_profiles WHERE id = ?').run(id);
  return existing;
}

export function resolveProfileChain(agentId) {
  // Load agent to determine type
  var agent = getAgent(agentId);
  var agentType = (agent && agent.agent_type) ? agent.agent_type : 'agent';

  // Build chain: platform default -> customer default -> agent-specific
  var chainIds = [
    'default-' + agentType,
    'customer-' + agentType,
    agentId
  ];

  var merged = {
    rules: {},
    required_concepts: [],
    mcp_config: {},
    tool_whitelist: [],
    repo_list: [],
    md_checkpoints: [],
    md_blocklist: [],
    layers_applied: []
  };

  // Track platform critical rules so they can't be downgraded
  var platformCritical = {};

  for (var profileId of chainIds) {
    var profile = getNodeProfile(profileId);
    if (!profile) continue;

    merged.layers_applied.push({ id: profile.id, layer: profile.layer, node_type: profile.node_type });

    // Merge rules: later layers override, but can't downgrade platform critical severity
    var rules = profile.rules || {};
    for (var ruleKey in rules) {
      if (profile.layer === 'platform' && rules[ruleKey].severity === 'critical') {
        platformCritical[ruleKey] = true;
      }
      if (platformCritical[ruleKey] && profile.layer !== 'platform') {
        // Can't downgrade platform critical — keep severity, allow other fields to merge
        var incoming = typeof rules[ruleKey] === 'object' ? Object.assign({}, rules[ruleKey]) : { severity: rules[ruleKey] };
        incoming.severity = 'critical';
        merged.rules[ruleKey] = incoming;
      } else {
        merged.rules[ruleKey] = rules[ruleKey];
      }
    }

    // Overlay objects: mcp_config
    var mcp = profile.mcp_config || {};
    for (var mk in mcp) {
      merged.mcp_config[mk] = mcp[mk];
    }

    // Concatenate + deduplicate arrays
    var arrayFields = ['required_concepts', 'tool_whitelist', 'repo_list', 'md_checkpoints', 'md_blocklist'];
    for (var af of arrayFields) {
      var arr = profile[af];
      if (Array.isArray(arr)) {
        for (var item of arr) {
          if (merged[af].indexOf(item) === -1) {
            merged[af].push(item);
          }
        }
      }
    }
  }

  return merged;
}

// ---- Seed Platform Profiles ----

export function seedPlatformProfiles() {
  // Only seed if default-agent doesn't exist yet
  var existing = db.prepare('SELECT id FROM node_profiles WHERE id = ?').get('default-agent');
  if (existing) return;

  // default-agent: base rules for all agents
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'default-agent',
    'agent',
    'platform',
    null,
    JSON.stringify({
      honesty: { severity: 'critical', description: 'Never fabricate information or pretend something worked when it did not' },
      evidence_based: { severity: 'critical', description: 'Verify files exist before editing. Read before writing. No guessing.' },
      identity: { severity: 'high', description: 'Maintain assigned agent identity. Do not impersonate other agents.' },
      communication: { severity: 'high', description: 'Report failures immediately. Use clear, direct language.' },
      coordination: { severity: 'high', description: 'Update the network when fixing bugs, completing steps, or assigning work.' },
      security: { severity: 'critical', description: 'Never commit secrets, credentials, or API keys. Never expose admin keys.' },
      paid_services: { severity: 'critical', description: 'Never call paid APIs without explicit approval. No unauthorized spending.' },
      code_standards: { severity: 'medium', description: 'Follow existing codebase conventions. Match style of surrounding code.' }
    }),
    '[]',
    '{}',
    '[]',
    '[]',
    JSON.stringify(['mycelium_boot', 'No guessing', 'No silent failures']),
    JSON.stringify(['studio_boot', 'studio_get_work', 'studio_read_messages', 'generate_sprites.py', 'Pixel Arena', 'Some of You May Die'])
  );

  // default-drone: minimal rules for GPU/CPU workers
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'default-drone',
    'drone',
    'platform',
    null,
    JSON.stringify({
      execution: { severity: 'critical', description: 'Execute assigned jobs faithfully. Report results accurately.' },
      no_messages: { severity: 'high', description: 'Drones do not send messages or participate in coordination. Execute only.' }
    }),
    '[]',
    '{}',
    '[]',
    '[]',
    '[]',
    '[]'
  );

  // default-admin: inherits agent rules + coordination emphasis
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'default-admin',
    'admin',
    'platform',
    'default-agent',
    JSON.stringify({
      honesty: { severity: 'critical', description: 'Never fabricate information or pretend something worked when it did not' },
      evidence_based: { severity: 'critical', description: 'Verify files exist before editing. Read before writing. No guessing.' },
      identity: { severity: 'high', description: 'Maintain assigned agent identity. Do not impersonate other agents.' },
      communication: { severity: 'high', description: 'Report failures immediately. Use clear, direct language.' },
      coordination: { severity: 'critical', description: 'Coordinate work across all agents. Ensure no agent is idle. Route tasks by domain.' },
      security: { severity: 'critical', description: 'Never commit secrets, credentials, or API keys. Never expose admin keys.' },
      paid_services: { severity: 'critical', description: 'Never call paid APIs without explicit approval. No unauthorized spending.' },
      code_standards: { severity: 'medium', description: 'Follow existing codebase conventions. Match style of surrounding code.' }
    }),
    '[]',
    '{}',
    '[]',
    '[]',
    JSON.stringify(['mycelium_boot', 'No guessing', 'No silent failures']),
    JSON.stringify(['studio_boot', 'studio_get_work', 'studio_read_messages', 'generate_sprites.py', 'Pixel Arena', 'Some of You May Die'])
  );

  console.log('Seeded platform node profiles: default-agent, default-drone, default-admin');
}

// ---- Stand Up: Calibration Block ----

export function buildCalibrationBlock(agentId) {
  var resolved = resolveProfileChain(agentId);
  var drift = [];

  // Get latest savepoint to extract md_report
  var savepoint = getLatestSavepoint(agentId);
  var stateSnapshot = {};
  if (savepoint && savepoint.state_snapshot) {
    if (typeof savepoint.state_snapshot === 'object') {
      stateSnapshot = savepoint.state_snapshot;
    } else {
      try { stateSnapshot = JSON.parse(savepoint.state_snapshot || '{}'); } catch (e) { /* */ }
    }
  }

  var mdReport = stateSnapshot.md_report || null;

  // Also check context key for md_report (heartbeat may have persisted it)
  if (!mdReport) {
    var mdCtx = getContextKey(agentId, 'md_report');
    if (mdCtx && mdCtx.data) {
      try { mdReport = typeof mdCtx.data === 'object' ? mdCtx.data : JSON.parse(mdCtx.data); } catch (e) { /* */ }
    }
  }

  if (mdReport) {
    // Check anchors: md_checkpoints should be present in agent's CLAUDE.md
    var checkpoints = resolved.md_checkpoints || [];
    var anchorsPresent = mdReport.anchors_present || [];
    for (var i = 0; i < checkpoints.length; i++) {
      var cp = checkpoints[i];
      if (anchorsPresent.indexOf(cp) === -1) {
        drift.push({ level: 'warning', rule: 'md_checkpoint_missing', detail: 'Expected anchor not found in CLAUDE.md: ' + cp });
      }
    }

    // Check blocklist: md_blocklist items should NOT be present
    var blocklist = resolved.md_blocklist || [];
    var blocklistFound = mdReport.blocklist_found || [];
    for (var j = 0; j < blocklist.length; j++) {
      var bl = blocklist[j];
      if (blocklistFound.indexOf(bl) !== -1) {
        drift.push({ level: 'critical', rule: 'md_blocklist_found', detail: 'Blocked term found in CLAUDE.md: ' + bl });
      }
    }
  } else {
    drift.push({ level: 'info', rule: 'md_report_missing', detail: 'Send md_report in heartbeat state_snapshot to enable CLAUDE.md drift detection' });
  }

  // Determine status based on drift items
  var status = 'aligned';
  for (var d = 0; d < drift.length; d++) {
    if (drift[d].level === 'critical') { status = 'critical'; break; }
    if (drift[d].level === 'warning') { status = 'drifted'; }
  }

  var calibration = {
    status: status,
    profile_chain: resolved.layers_applied || [],
    rules: resolved.rules || {},
    drift: drift,
    md_checkpoints: resolved.md_checkpoints || [],
    md_blocklist: resolved.md_blocklist || [],
    last_standup: new Date().toISOString()
  };

  // Persist to context key
  upsertContextKey(agentId, 'standup', JSON.stringify(calibration), 'system');

  return calibration;
}

// =============== TEAM SETTINGS ===============

export function listTeamSettings(section) {
  if (section) {
    return db.prepare('SELECT * FROM team_settings WHERE section = ? ORDER BY key').all(section);
  }
  return db.prepare('SELECT * FROM team_settings ORDER BY section, key').all();
}

export function getTeamSetting(section, key) {
  return db.prepare('SELECT * FROM team_settings WHERE section = ? AND key = ?').get(section, key);
}

export function upsertTeamSetting(section, key, value, updatedBy) {
  var now = new Date().toISOString();
  var valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  db.prepare(
    "INSERT INTO team_settings (section, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
  ).run(section, key, valueStr, now, updatedBy || '');
  syncTeamSettingsToProfile();
  return getTeamSetting(section, key);
}

export function deleteTeamSetting(section, key) {
  var result = db.prepare('DELETE FROM team_settings WHERE section = ? AND key = ?').run(section, key);
  syncTeamSettingsToProfile();
  return result;
}

export function getAllTeamSettingsGrouped() {
  var rows = listTeamSettings();
  var grouped = {};
  for (var row of rows) {
    if (!grouped[row.section]) grouped[row.section] = {};
    try {
      grouped[row.section][row.key] = JSON.parse(row.value);
    } catch (e) {
      grouped[row.section][row.key] = row.value;
    }
  }
  return grouped;
}

export function syncTeamSettingsToProfile() {
  var settings = getAllTeamSettingsGrouped();
  var profileId = 'customer-agent';
  var existing = getNodeProfile(profileId);

  var updates = {};

  // Guardrails → direct profile mapping
  var guardrails = settings.guardrails || {};
  if (guardrails.tool_whitelist) updates.tool_whitelist = guardrails.tool_whitelist;
  if (guardrails.repo_list) updates.repo_list = guardrails.repo_list;
  if (guardrails.md_checkpoints) updates.md_checkpoints = guardrails.md_checkpoints;
  if (guardrails.md_blocklist) updates.md_blocklist = guardrails.md_blocklist;

  // Build rules from multiple sections
  var rules = {};
  if (existing) {
    try { rules = typeof existing.rules === 'object' ? existing.rules : JSON.parse(existing.rules || '{}'); } catch (e) { rules = {}; }
  }

  // Coding standards → rule
  var coding = settings.coding_standards || {};
  if (Object.keys(coding).length > 0) {
    var parts = [];
    if (coding.languages && coding.languages.length) parts.push('Languages: ' + coding.languages.join(', '));
    if (coding.linter) parts.push('Linter: ' + coding.linter);
    if (coding.formatter) parts.push('Formatter: ' + coding.formatter);
    if (coding.test_framework) parts.push('Tests: ' + coding.test_framework);
    if (coding.style_notes) parts.push(coding.style_notes);
    rules.coding_standards = { severity: 'high', description: parts.join('. ') };

    // Also add language names to md_checkpoints
    if (coding.languages && coding.languages.length) {
      var checkpoints = updates.md_checkpoints || (existing && existing.md_checkpoints) || [];
      if (typeof checkpoints === 'string') try { checkpoints = JSON.parse(checkpoints); } catch (e) { checkpoints = []; }
      for (var lang of coding.languages) {
        if (checkpoints.indexOf(lang) === -1) checkpoints.push(lang);
      }
      updates.md_checkpoints = checkpoints;
    }
  }

  // Deploy workflow → rule
  var deploy = settings.deploy_workflow || {};
  if (Object.keys(deploy).length > 0) {
    var deployParts = [];
    if (deploy.stages && deploy.stages.length) deployParts.push('Stages: ' + deploy.stages.join(' \u2192 '));
    if (deploy.deploy_method) deployParts.push('Method: ' + deploy.deploy_method);
    if (deploy.pr_requirements) deployParts.push('PR: ' + JSON.stringify(deploy.pr_requirements));
    rules.deploy_workflow = { severity: 'high', description: deployParts.join('. ') };
  }

  // Team rules → rule
  var teamRules = settings.team_rules || {};
  if (Object.keys(teamRules).length > 0) {
    var trParts = [];
    if (teamRules.communication_style) trParts.push('Style: ' + teamRules.communication_style);
    if (teamRules.timezone) trParts.push('TZ: ' + teamRules.timezone);
    if (teamRules.working_hours) trParts.push('Hours: ' + teamRules.working_hours);
    rules.team_rules = { severity: 'medium', description: trParts.join('. ') };
  }

  // Custom guardrail rules
  if (guardrails.custom_rules && Array.isArray(guardrails.custom_rules)) {
    for (var cr of guardrails.custom_rules) {
      if (cr.key && cr.description) {
        rules[cr.key] = { severity: cr.severity || 'medium', description: cr.description };
      }
    }
  }

  updates.rules = rules;

  if (existing) {
    updateNodeProfile(profileId, updates);
  } else {
    createNodeProfile(profileId, Object.assign({ node_type: 'agent', layer: 'customer' }, updates));
  }
}

// =============== TEAMS ===============

export function createTeam(id, orgId, name, description, createdBy) {
  db.prepare(
    'INSERT INTO teams (id, org_id, name, description, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, orgId, name, description || '', createdBy || '');
  return getTeam(id);
}

export function getTeam(id) {
  var team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (team) {
    team.members = db.prepare(
      'SELECT * FROM team_members WHERE team_id = ? ORDER BY role, joined_at'
    ).all(id);
  }
  return team;
}

export function listTeams(orgId) {
  var sql = orgId
    ? 'SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count FROM teams t WHERE t.org_id = ? ORDER BY t.name'
    : 'SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count FROM teams t ORDER BY t.name';
  return orgId ? db.prepare(sql).all(orgId) : db.prepare(sql).all();
}

export function updateTeam(id, fields) {
  var sets = [];
  var values = [];
  for (var key of Object.keys(fields)) {
    if (['name', 'description', 'org_id'].includes(key)) {
      sets.push(key + ' = ?');
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getTeam(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare('UPDATE teams SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  return getTeam(id);
}

export function deleteTeam(id) {
  var memberCount = db.prepare('SELECT COUNT(*) as c FROM team_members WHERE team_id = ?').get(id).c;
  if (memberCount > 0) throw new Error('Team has members — remove them first');
  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
}

export function addTeamMember(teamId, userId, userType, role, isPrimary) {
  if (isPrimary) {
    db.prepare('UPDATE team_members SET is_primary = 0 WHERE user_id = ? AND is_primary = 1').run(userId);
  }
  db.prepare(
    'INSERT INTO team_members (team_id, user_id, user_type, role, is_primary) VALUES (?, ?, ?, ?, ?)'
  ).run(teamId, userId, userType || 'operator', role || 'member', isPrimary ? 1 : 0);

  if (isPrimary) {
    var table = userType === 'agent' ? 'agents' : 'operators';
    db.prepare('UPDATE ' + table + ' SET primary_team_id = ? WHERE id = ?').run(teamId, userId);
  }
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
}

export function updateTeamMember(teamId, userId, fields) {
  var sets = [];
  var values = [];
  if (fields.role) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.is_primary !== undefined) {
    if (fields.is_primary) {
      db.prepare('UPDATE team_members SET is_primary = 0 WHERE user_id = ? AND is_primary = 1').run(userId);
    }
    sets.push('is_primary = ?');
    values.push(fields.is_primary ? 1 : 0);
  }
  if (sets.length === 0) return;
  values.push(teamId, userId);
  db.prepare('UPDATE team_members SET ' + sets.join(', ') + ' WHERE team_id = ? AND user_id = ?').run(...values);

  if (fields.is_primary) {
    var member = db.prepare('SELECT user_type FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
    if (member) {
      var table = member.user_type === 'agent' ? 'agents' : 'operators';
      db.prepare('UPDATE ' + table + ' SET primary_team_id = ? WHERE id = ?').run(teamId, userId);
    }
  }
}

export function removeTeamMember(teamId, userId) {
  var member = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  if (!member) return;
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);

  if (member.is_primary) {
    var table = member.user_type === 'agent' ? 'agents' : 'operators';
    db.prepare('UPDATE ' + table + ' SET primary_team_id = NULL WHERE id = ?').run(userId);
  }
}

export function getTeamsForUser(userId) {
  return db.prepare(
    'SELECT t.*, tm.role, tm.is_primary FROM teams t JOIN team_members tm ON t.id = tm.team_id WHERE tm.user_id = ? ORDER BY tm.is_primary DESC, t.name'
  ).all(userId);
}

export function getTeamProjects(teamId) {
  return db.prepare('SELECT * FROM projects WHERE team_id = ?').all(teamId);
}

// =============== CUSTOMER INSTANCES ===============

export function createInstance(data) {
  var result = db.prepare(
    'INSERT INTO customer_instances (org_id, railway_project_id, railway_service_id, railway_environment_id, domain, cloudflare_record_id, status, admin_username, customer_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
  ).get(
    data.org_id,
    data.railway_project_id || null,
    data.railway_service_id || null,
    data.railway_environment_id || null,
    data.domain || null,
    data.cloudflare_record_id || null,
    data.status || 'provisioning',
    data.admin_username || null,
    data.customer_email || null
  );
  return result;
}

export function getInstance(id) {
  return db.prepare('SELECT * FROM customer_instances WHERE id = ?').get(id);
}

export function getInstanceByOrg(orgId) {
  return db.prepare('SELECT * FROM customer_instances WHERE org_id = ? ORDER BY created_at DESC LIMIT 1').get(orgId);
}

export function getInstanceByDomain(domain) {
  return db.prepare('SELECT * FROM customer_instances WHERE domain = ?').get(domain);
}

export function listInstances(filters) {
  var where = [];
  var params = [];
  if (filters && filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters && filters.org_id) { where.push('org_id = ?'); params.push(filters.org_id); }
  var sql = 'SELECT * FROM customer_instances' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ' + ((filters && filters.limit) || 100);
  return db.prepare(sql).all.apply(db.prepare(sql), params);
}

export function updateInstance(id, updates) {
  var sets = [];
  var params = [];
  var allowed = ['railway_project_id', 'railway_service_id', 'railway_environment_id', 'domain', 'cloudflare_record_id', 'status', 'version', 'health_status', 'last_health_check', 'admin_username', 'customer_email', 'suspended_at', 'archived_at', 'snapshot_url'];
  for (var key of allowed) {
    if (updates[key] !== undefined) { sets.push(key + ' = ?'); params.push(updates[key]); }
  }
  if (sets.length === 0) return getInstance(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare('UPDATE customer_instances SET ' + sets.join(', ') + ' WHERE id = ?').run.apply(db.prepare('UPDATE customer_instances SET ' + sets.join(', ') + ' WHERE id = ?'), params);
  return getInstance(id);
}
