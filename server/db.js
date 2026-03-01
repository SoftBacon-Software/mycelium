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

  // Run platform schema
  var schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Migrations: add columns that may not exist yet
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
  ];

  for (var [table, col, def] of migrations) {
    try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def); } catch (e) { /* already exists */ }
  }

  // Indexes on migrated columns
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_tasks_blocked ON dv_tasks(blocked_by)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_tasks_approval ON dv_tasks(needs_approval)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_type ON dv_messages(msg_type)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_status ON dv_messages(status)'); } catch (e) {}

  console.log('Mycelium DB initialized at ' + DB_PATH);
}

// Prepared statement cache
var _stmts = {};
function stmt(key, sql) {
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

// =============== DIOVERSE HUB ===============

// -- Agents --

export function createAgent(id, name, game, apiKeyHash, capabilities) {
  stmt('dvCreateAgent', `INSERT INTO dv_agents (id, name, game, api_key_hash, capabilities)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, game, apiKeyHash, capabilities || '[]');
}

export function getAgent(id) {
  return stmt('dvGetAgent', 'SELECT * FROM dv_agents WHERE id = ?').get(id);
}

export function getAgentByKeyHash(apiKeyHash) {
  return stmt('dvGetAgentByKey', 'SELECT * FROM dv_agents WHERE api_key_hash = ?').get(apiKeyHash);
}

export function listAgents() {
  return stmt('dvListAgents', 'SELECT id, name, game, status, working_on, last_heartbeat, capabilities, avatar_url, created_at FROM dv_agents ORDER BY created_at').all();
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
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_agents SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Games --

export function createGame(id, name, description, repoUrl) {
  stmt('dvCreateGame', `INSERT OR IGNORE INTO dv_games (id, name, description, repo_url)
    VALUES (?, ?, ?, ?)`).run(id, name, description || '', repoUrl || '');
}

export function listGames() {
  return stmt('dvListGames', 'SELECT * FROM dv_games ORDER BY created_at').all();
}

export function getGame(id) {
  return stmt('dvGetGame', 'SELECT * FROM dv_games WHERE id = ?').get(id);
}

// -- Tasks --

export function createDvTask(title, description, game, requester, priority, tags) {
  var result = stmt('dvCreateTask', `INSERT INTO dv_tasks (title, description, game, requester, priority, tags)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(title, description || '', game || 'dioverse', requester, priority || 'normal', tags || '[]');
  return result.id;
}

export function getDvTask(id) {
  return stmt('dvGetTask', 'SELECT * FROM dv_tasks WHERE id = ?').get(id);
}

export function listDvTasks(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.game) { where.push('game = ?'); params.push(filters.game); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.requester) { where.push('requester = ?'); params.push(filters.requester); }
  var limit = filters.limit || 50;
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
  try { blockedBy = JSON.parse(task.blocked_by || '[]'); } catch (e) { /* */ }
  if (blockedBy.indexOf(blockedById) === -1) {
    blockedBy.push(blockedById);
    db.prepare("UPDATE dv_tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(blockedBy), taskId);
  }

  var blocks = [];
  try { blocks = JSON.parse(blocker.blocks || '[]'); } catch (e) { /* */ }
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
  try { blocks = JSON.parse(task.blocks || '[]'); } catch (e) { /* */ }

  var unblocked = [];
  for (var blockedId of blocks) {
    var blocked = getDvTask(blockedId);
    if (!blocked) continue;
    var deps = [];
    try { deps = JSON.parse(blocked.blocked_by || '[]'); } catch (e) { /* */ }
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

// -- Context --

export function getDvContext(game) {
  return stmt('dvGetContext', 'SELECT * FROM dv_context WHERE game = ?').get(game);
}

export function getAllDvContext() {
  return stmt('dvGetAllContext', 'SELECT * FROM dv_context ORDER BY updated_at DESC').all();
}

export function upsertDvContext(game, data, agentId) {
  stmt('dvUpsertContext', `INSERT INTO dv_context (game, data, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(game) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(game, data, agentId);
}

// -- Assets --

export function createDvAsset(name, type, game, status, path, metadata, requester) {
  var result = stmt('dvCreateAsset', `INSERT INTO dv_assets (name, type, game, status, path, metadata, requester)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(name, type || 'sprite', game || 'shared', status || 'requested', path || '', metadata || '{}', requester || '');
  return result.id;
}

export function getDvAsset(id) {
  return stmt('dvGetAsset', 'SELECT * FROM dv_assets WHERE id = ?').get(id);
}

export function listDvAssets(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.game) { where.push('game = ?'); params.push(filters.game); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  var limit = filters.limit || 50;
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
  values.push(id);
  return db.prepare('UPDATE dv_assets SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Events --

export function createDvEvent(type, agent, game, summary, data) {
  var result = stmt('dvCreateEvent', `INSERT INTO dv_events (type, agent, game, summary, data)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).get(type, agent || '', game || null, summary || '', data || '{}');
  return result.id;
}

export function listDvEvents(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  if (filters.game) { where.push('game = ?'); params.push(filters.game); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.agent) { where.push('agent = ?'); params.push(filters.agent); }
  var limit = filters.limit || 50;
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_events WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

// -- Messages --

export function createDvMessage(fromAgent, toAgent, threadId, game, content, metadata) {
  var result = stmt('dvCreateMessage', `INSERT INTO dv_messages (from_agent, to_agent, thread_id, game, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(fromAgent, toAgent || null, threadId || null, game || null, content, metadata || '{}');
  return result.id;
}

export function createDvRequest(fromAgent, toAgent, threadId, game, content, metadata) {
  var result = db.prepare(
    "INSERT INTO dv_messages (from_agent, to_agent, thread_id, game, content, metadata, msg_type, status) VALUES (?, ?, ?, ?, ?, ?, 'request', 'pending') RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, game || null, content, metadata || '{}');
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

export function getDvMessage(id) {
  return db.prepare("SELECT * FROM dv_messages WHERE id = ?").get(id);
}

export function listDvMessages(filters) {
  var where = ["msg_type != 'chat'"];
  var params = [];
  if (filters.from_agent) { where.push('from_agent = ?'); params.push(filters.from_agent); }
  if (filters.to_agent) { where.push('(to_agent = ? OR to_agent IS NULL)'); params.push(filters.to_agent); }
  if (filters.thread_id) { where.push('thread_id = ?'); params.push(filters.thread_id); }
  if (filters.game) { where.push('game = ?'); params.push(filters.game); }
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  var limit = filters.limit || 50;
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function listDvThreads(limit) {
  return db.prepare(`SELECT thread_id, COUNT(*) as message_count,
    MAX(created_at) as last_message_at,
    (SELECT from_agent FROM dv_messages m2 WHERE m2.thread_id = dv_messages.thread_id ORDER BY created_at DESC LIMIT 1) as last_sender
    FROM dv_messages WHERE thread_id IS NOT NULL
    GROUP BY thread_id ORDER BY last_message_at DESC LIMIT ?`).all(limit || 20);
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

// -- Dioverse Bugs --

export function createDvBug(game, title, description, category, severity, reporter, assignee, diagnosticData) {
  var result = db.prepare(
    "INSERT INTO dv_bugs (game, title, description, category, severity, reporter, assignee, diagnostic_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(game || 'dioverse', title, description, category || 'other', severity || 'normal', reporter || 'admin', assignee || null, diagnosticData || null);
  return result.id;
}

export function getDvBug(id) {
  return db.prepare("SELECT * FROM dv_bugs WHERE id = ?").get(id);
}

export function listDvBugs(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.game) { where.push('game = ?'); params.push(filters.game); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.reporter) { where.push('reporter = ?'); params.push(filters.reporter); }
  var limit = filters.limit || 50;
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
    "SELECT * FROM dv_messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type = 'message' AND created_at > ? ORDER BY created_at DESC LIMIT 50"
  ).all(agentId, since);

  var capabilities = [];
  try { capabilities = JSON.parse(agent.capabilities || '[]'); } catch (e) { /* */ }
  var assetRequests = [];
  if (capabilities.indexOf('assets') !== -1) {
    assetRequests = db.prepare(
      "SELECT * FROM dv_assets WHERE status = 'requested' ORDER BY created_at DESC LIMIT 50"
    ).all();
  }

  var otherAgents = db.prepare(
    "SELECT id, name, game, status, working_on, last_heartbeat, capabilities, avatar_url FROM dv_agents WHERE id != ? ORDER BY created_at"
  ).all(agentId);

  var gameContext = getDvContext(agent.game);
  var contextKeys = listDvContextKeys(agent.game);

  var approvalQueue = listTasksNeedingApproval();
  var recentEvents = listDvEvents({ limit: 20 });
  var openBugs = listDvBugs({ status: 'open', limit: 20 });

  // Active/draft plans for agent's game
  var myPlans = listDvPlans({ game: agent.game, limit: 20 });
  // Also include dioverse-scoped plans
  var dioPlans = listDvPlans({ game: 'dioverse', limit: 20 });
  var allPlans = myPlans.concat(dioPlans.filter(function (p) { return !myPlans.some(function (mp) { return mp.id === p.id; }); }));
  // Enrich with full steps for active/draft plans
  for (var pl of allPlans) {
    if (pl.status === 'active' || pl.status === 'draft') {
      var full = getDvPlan(pl.id);
      if (full) pl.steps = full.steps;
    }
  }

  // Auto-heartbeat on boot
  updateAgentHeartbeat(agentId, 'online', agent.working_on);

  return {
    agent: safeAgent,
    tasks: myTasks,
    pending_requests: pendingRequests,
    new_messages: newMessages,
    asset_requests: assetRequests,
    other_agents: otherAgents,
    game_context: gameContext,
    context_keys: contextKeys,
    approval_queue: approvalQueue,
    my_approvals: listPendingApprovalsByAgent(agentId),
    recent_events: recentEvents,
    open_bugs: openBugs,
    plans: allPlans,
    server_time: new Date().toISOString()
  };
}

// -- Auto-task from asset request --

var _autoTaskFromAsset = null;

export function initDioverseTransactions() {
  _autoTaskFromAsset = db.transaction(function (assetId, game, requester) {
    var agents = db.prepare("SELECT id FROM dv_agents WHERE capabilities LIKE '%assets%'").all();
    var assignee = agents.length > 0 ? agents[0].id : null;

    var asset = getDvAsset(assetId);
    if (!asset) return null;

    var taskId = createDvTask(
      'Generate asset: ' + asset.name,
      'Auto-created from asset request #' + assetId + '. Type: ' + asset.type + '. Game: ' + game,
      game,
      requester,
      'normal',
      JSON.stringify(['auto', 'assets'])
    );

    db.prepare("UPDATE dv_tasks SET assignee = ?, linked_asset_id = ? WHERE id = ?").run(assignee, assetId, taskId);

    return { task_id: taskId, assignee: assignee };
  });
}

export function autoTaskFromAsset(assetId, game, requester) {
  if (!_autoTaskFromAsset) return null;
  return _autoTaskFromAsset(assetId, game, requester);
}

// -- Plans --

export function createDvPlan(title, description, game, owner, priority, tags, createdBy) {
  var result = db.prepare(
    "INSERT INTO dv_plans (title, description, game, owner, priority, tags, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(title, description || '', game || 'dioverse', owner || '', priority || 'normal', tags || '[]', createdBy || '');
  return result.id;
}

export function getDvPlan(id) {
  var plan = db.prepare("SELECT * FROM dv_plans WHERE id = ?").get(id);
  if (!plan) return null;
  var steps = db.prepare("SELECT * FROM dv_plan_steps WHERE plan_id = ? ORDER BY step_order, id").all(id);
  var total = steps.length;
  var completed = steps.filter(function (s) { return s.status === 'completed'; }).length;
  plan.steps = steps;
  plan.progress = { total: total, completed: completed, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
  return plan;
}

export function listDvPlans(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.game) { where.push('game = ?'); params.push(filters.game); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.owner) { where.push('owner = ?'); params.push(filters.owner); }
  if (filters.exclude_status) { where.push('status != ?'); params.push(filters.exclude_status); }
  var limit = filters.limit || 50;
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
  if (fields.game !== undefined) { sets.push('game = ?'); values.push(fields.game); }
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
  return db.prepare("SELECT id, username, display_name, role, created_at FROM dv_studio_users ORDER BY created_at").all();
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
  var webhooks = db.prepare(
    "SELECT * FROM dv_webhooks WHERE active = 1 AND agent_id = ?"
  ).all(agentId);

  for (var wh of webhooks) {
    var events = [];
    try { events = JSON.parse(wh.events); } catch (e) { continue; }
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

    // Non-blocking fetch with 5s timeout
    fetch(wh.url, {
      method: 'POST',
      headers: headers,
      body: payload,
      signal: AbortSignal.timeout(5000)
    }).catch(function (err) {
      console.error('[webhook] Failed to dispatch to', wh.url, ':', err.message);
    });
  }
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

// -- Drone Jobs --

export function createDroneJob(title, command, inputData, requires, requester, priority) {
  var result = db.prepare(
    "INSERT INTO dv_drone_jobs (title, command, input_data, requires, requester, priority) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(
    title,
    command || '',
    typeof inputData === 'string' ? inputData : JSON.stringify(inputData || {}),
    typeof requires === 'string' ? requires : JSON.stringify(requires || ['cpu']),
    requester,
    priority || 0
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
    try { reqs = JSON.parse(job.requires || '["cpu"]'); } catch (e) { reqs = ['cpu']; }
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
  return db.prepare("SELECT id, name, game, status, working_on, last_heartbeat, capabilities, created_at FROM dv_agents WHERE game = 'drone' ORDER BY created_at").all();
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
  return stmt('dvGetConceptProjects', `SELECT g.*, pc.linked_at, pc.linked_by
    FROM dv_games g JOIN dv_project_concepts pc ON g.id = pc.project_id
    WHERE pc.concept_id = ? ORDER BY g.name`).all(conceptId);
}

// -- Dioverse Hub init (seed default games + admin user) --

export function initDioverse() {
  createGame('willing-sacrifice', 'Willing Sacrifice', 'Autobattler RPG where Dio is the arena master');
  createGame('king-city', 'King City', 'Zombie survival town builder where Dio appears as a chibi narrator');
}

// -- Dioverse Hub admin overview --

// =============== APPROVALS ===============

var GATED_ACTIONS = ['deploy', 'outreach_send', 'git_push', 'plan_create', 'money_action', 'delete', 'external_comm'];
export { GATED_ACTIONS };

export function createApproval(actionType, requestedBy, title, payload, project) {
  var result = stmt('dvCreateApproval',
    "INSERT INTO dv_approvals (action_type, requested_by, title, payload, project) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).get(actionType, requestedBy, title || '', typeof payload === 'string' ? payload : JSON.stringify(payload || {}), project || 'mycelium');
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
  if (filters.project) { where.push('project = ?'); params.push(filters.project); }
  var limit = filters.limit || 50;
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

export function getDvOverview() {
  var agents = listAgents();
  var events = listDvEvents({ limit: 50 });
  var openTasks = listDvTasks({ status: 'open', limit: 20 });
  var inProgressTasks = listDvTasks({ status: 'in_progress', limit: 20 });
  var reviewTasks = listDvTasks({ status: 'review', limit: 20 });
  var recentDone = listDvTasks({ status: 'done', limit: 10 });
  var messages = listDvMessages({ limit: 30 });
  var context = getAllDvContext();
  var contextKeys = listDvContextKeys();
  var games = listGames();
  var approvalQueue = listTasksNeedingApproval();
  var pendingRequests = db.prepare(
    "SELECT * FROM dv_messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC LIMIT 20"
  ).all();
  var assets = listDvAssets({ limit: 50 });
  var bugs = listDvBugs({ limit: 50 });
  var bugCounts = countDvBugs();
  var plans = listDvPlans({ exclude_status: 'cancelled', limit: 50 });
  var teamChat = listDvTeamChat(50);
  return {
    agents: agents,
    events: events,
    tasks: { open: openTasks, in_progress: inProgressTasks, review: reviewTasks, done: recentDone },
    messages: messages,
    team_chat: teamChat,
    context: context,
    context_keys: contextKeys,
    projects: games,
    games: games,
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
        try { con.data = JSON.parse(con.data); } catch (e) {}
      });
      return c;
    })()
  };
}

// =============== OUTREACH ===============

// -- Outreach Campaigns --

export function createOutreachCampaign(project, name, personaPrompt, gameFacts, templates, config, createdBy) {
  var result = stmt('orCreateCampaign', `INSERT INTO dv_outreach_campaigns (project, name, persona_prompt, game_facts, templates, config, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(project, name, personaPrompt || '', gameFacts || '', templates || '{}', config || '{}', createdBy || '');
  return result.id;
}

export function getOutreachCampaign(id) {
  return stmt('orGetCampaign', 'SELECT * FROM dv_outreach_campaigns WHERE id = ?').get(id);
}

export function listOutreachCampaigns(filters) {
  var where = ['1=1']; var params = [];
  if (filters.project) { where.push('project = ?'); params.push(filters.project); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  params.push(filters.limit || 50);
  return db.prepare('SELECT * FROM dv_outreach_campaigns WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
}

export function updateOutreachCampaign(id, fields) {
  var sets = ["updated_at = datetime('now')"]; var values = [];
  for (var key of ['name', 'persona_prompt', 'game_facts', 'templates', 'config', 'status']) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  values.push(id);
  return db.prepare('UPDATE dv_outreach_campaigns SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Outreach Contacts --

export function createOutreachContact(fields) {
  var result = db.prepare(`INSERT INTO dv_outreach_contacts
    (project, campaign_id, type, name, email, outlet, tier, archetype, subscriber_count, status, last_content, notes, metadata, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
    fields.project, fields.campaign_id || null, fields.type || 'creator', fields.name,
    fields.email || '', fields.outlet || '', fields.tier || '', fields.archetype || '',
    fields.subscriber_count || 0, fields.status || 'discovered', fields.last_content || '',
    fields.notes || '', fields.metadata || '{}', fields.created_by || ''
  );
  return result.id;
}

export function getOutreachContact(id) {
  return stmt('orGetContact', 'SELECT * FROM dv_outreach_contacts WHERE id = ?').get(id);
}

export function listOutreachContacts(filters) {
  var where = ['1=1']; var params = [];
  if (filters.project) { where.push('project = ?'); params.push(filters.project); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.campaign_id) { where.push('campaign_id = ?'); params.push(filters.campaign_id); }
  var limit = filters.limit || 50;
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_outreach_contacts WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateOutreachContact(id, fields) {
  var sets = ["updated_at = datetime('now')"]; var values = [];
  var allowed = ['name', 'email', 'outlet', 'tier', 'archetype', 'subscriber_count', 'status',
    'pitch_subject', 'pitch_body', 'last_content', 'key_assigned', 'pitch_sent_at',
    'followup_due_at', 'followup_sent_at', 'response_at', 'outcome', 'notes', 'metadata', 'campaign_id'];
  for (var key of allowed) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  values.push(id);
  return db.prepare('UPDATE dv_outreach_contacts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteOutreachContact(id) {
  return db.prepare('DELETE FROM dv_outreach_contacts WHERE id = ?').run(id);
}

export function countOutreachContacts(project) {
  var rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM dv_outreach_contacts WHERE project = ? GROUP BY status'
  ).all(project);
  var counts = {};
  for (var r of rows) counts[r.status] = r.count;
  return counts;
}

export function findOutreachContactByEmail(project, email) {
  return db.prepare('SELECT * FROM dv_outreach_contacts WHERE project = ? AND email = ?').get(project, email);
}
