// =============== MYCELIUM — Database Layer ===============
import { db, stmt, buildUpdate, initDBConnection, getDB, DB_PATH } from './db/core.js';
// Resident db.js functions (getBootPayload, overview/health) still call these now-extracted
// helpers by bare name. The `export *` barrel below re-exports them to consumers but does NOT
// bind them in THIS module's lexical scope — so import them explicitly. db/*.js imports only
// ./db/core.js, so this is acyclic (the barrel db/*.js → ../db.js is the forbidden direction).
import { getSleepMode, listInstanceConfig } from './db/config.js';
import { listEvents } from './db/events.js';
import { listBugs, countBugs } from './db/bugs.js';
import { isNetworkAutonomous, getAvailableOperators, listOperators, getActiveStudioUsers } from './db/operators.js';
import { getProject, listProjects } from './db/projects.js';
import { getProjectConcepts, listConcepts, getConceptProjects } from './db/concepts.js';
import { listPendingApprovalsByAgent, listApprovals } from './db/approvals.js';
import { listPendingRequests, getUnreadMessages, markMessagesRead, listMessages, listTeamChat } from './db/messages.js';
import { getContext, getAllContext, listContextKeys, getContextKey, upsertContextKey } from './db/context.js';
import { getAgent, listAgents, resolveAssignee, updateAgentHeartbeat } from './db/agents.js';
import { ensureDefaultChannels, getChannelsByUser, getUnreadCounts, isChannelMember, listChannels } from './db/channels.js';
import { listPluginRecords } from './db/plugins.js';
import { getLatestSavepoint } from './db/savepoints.js';
import { buildCalibrationBlock, createNodeProfile, getNodeProfile, seedPlatformProfiles, updateNodeProfile } from './db/node-profiles.js';

export { getDB };

// -- Decomposition barrel: db/* entity modules (each imports only ./db/core.js) --
export * from './db/config.js';
export * from './db/spend.js';
export * from './db/bugs.js';
export * from './db/feedback.js';
export * from './db/events.js';
export * from './db/widgets.js';
export * from './db/skills.js';
export * from './db/operators.js';
export * from './db/projects.js';
export * from './db/concepts.js';
export * from './db/approvals.js';
export * from './db/runs.js';
export * from './db/messages.js';
export * from './db/context.js';
export * from './db/agents.js';
export * from './db/savepoints.js';
export * from './db/plugins.js';
export * from './db/health.js';
export * from './db/webhooks.js';
export * from './db/channels.js';
export * from './db/agent-profiles.js';
export * from './db/node-profiles.js';

export function initDB() {
  initDBConnection();
  ensureDefaultChannels();
  seedPlatformProfiles();
  seedDefaultJobTemplates();
  console.log('Mycelium DB initialized at ' + DB_PATH);
}

// =============== MYCELIUM PLATFORM ===============

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
  // Pre-process transformed fields
  var f = Object.assign({}, fields);
  if (f.assignee !== undefined && f.assignee !== null) f.assignee = resolveAssignee(f.assignee);
  if (f.needs_approval !== undefined) f.needs_approval = f.needs_approval ? 1 : 0;
  if (f.blocked_by !== undefined) f.blocked_by = JSON.stringify(f.blocked_by);
  if (f.blocks !== undefined) f.blocks = JSON.stringify(f.blocks);
  buildUpdate('tasks', id, f, ['title', 'description', 'status', 'assignee', 'priority', 'tags', 'needs_approval', 'blocked_by', 'blocks', 'branch', 'pr_url', 'repo', 'review_metadata'], { updatedAt: true });
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

// -- Task Deliverables --
// The agent's final output, distinct from the task_comments status thread.
// Append-only; getTaskDeliverables returns all attempts oldest-first.

export function addTaskDeliverable(taskId, author, kind, format, content, flags) {
  var result = db.prepare(
    "INSERT INTO task_deliverables (task_id, author, kind, format, content, flags) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
  ).get(taskId, author, kind || 'report', format || 'markdown', content, flags || '');
  return result;
}

export function getTaskDeliverables(taskId) {
  return db.prepare(
    "SELECT * FROM task_deliverables WHERE task_id = ? ORDER BY created_at ASC, id ASC"
  ).all(taskId);
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
  // Returns {changes} for callers that check result.changes
  var changed = buildUpdate('assets', id, fields, ['status', 'path', 'metadata', 'file_path', 'download_url', 'requested_by', 'assigned_to', 'drone_job_id', 'prompt'], { updatedAt: true });
  return { changes: changed ? 1 : 0 };
}

export function deleteAsset(id) {
  return db.prepare('DELETE FROM assets WHERE id = ?').run(id);
}

export function listAssetsByDroneJob(droneJobId) {
  return db.prepare('SELECT * FROM assets WHERE drone_job_id = ?').all(droneJobId);
}

// -- Widgets --

export function getWidget(id) {
  return db.prepare('SELECT * FROM widgets WHERE id = ?').get(id);
}

// -- Boot payload --

function buildCrashRecovery(agent, agentId) {
  if (!agent.last_heartbeat || !agent.working_on) return null;
  var lastHb = new Date(agent.last_heartbeat + (agent.last_heartbeat.endsWith('Z') ? '' : 'Z')).getTime();
  var staleness = Date.now() - lastHb;
  var CRASH_THRESHOLD = 15 * 60 * 1000;
  if (staleness <= CRASH_THRESHOLD) return null;
  var lastSavepoint = getLatestSavepoint(agentId);
  return {
    detected: true,
    last_heartbeat: agent.last_heartbeat,
    stale_minutes: Math.round(staleness / 60000),
    was_working_on: agent.working_on,
    recovery_state: lastSavepoint && lastSavepoint.state_snapshot ? lastSavepoint.state_snapshot : null,
    recovery_notes: lastSavepoint && lastSavepoint.notes ? lastSavepoint.notes : null
  };
}

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
    "SELECT id, from_agent, to_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND created_at > ? ORDER BY created_at DESC LIMIT 50"
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

  // Only include agents active in last 7 days or in the same project (trimmed fields for coordination)
  var otherAgents = db.prepare(
    "SELECT id, name AS display_name, status, working_on, last_heartbeat, project_id, llm_backend, runtime FROM agents WHERE id != ? AND (project_id = ? OR last_heartbeat > datetime('now', '-7 days')) ORDER BY created_at"
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

  var crashRecovery = buildCrashRecovery(agent, agentId);

  // ---- Stand Up: calibration block ----
  var calibration = null;
  try { calibration = buildCalibrationBlock(agentId); } catch (e) { console.warn('[mycelium] calibration block failed for ' + agentId + ':', e.message); }

  // ---- Since last session: changes since agent's last heartbeat (single query) ----
  var sinceLastSession = null;
  if (since && since !== '2000-01-01') {
    var sessionCounts = db.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND created_at > ?) as new_messages, " +
      "(SELECT COUNT(*) FROM tasks WHERE (assignee = ? OR assignee IS NULL) AND updated_at > ?) as task_changes, " +
      "(SELECT COUNT(*) FROM plan_steps WHERE updated_at > ?) as plan_step_changes, " +
      "(SELECT COUNT(*) FROM bugs WHERE created_at > ?) as new_bugs"
    ).get(agentId, since, agentId, since, since, since);
    sinceLastSession = {
      new_messages: sessionCounts.new_messages,
      task_changes: sessionCounts.task_changes,
      plan_step_changes: sessionCounts.plan_step_changes,
      new_bugs: sessionCounts.new_bugs,
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

  var crashRecovery = buildCrashRecovery(agent, agentId);

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

// Smart boot: slim boot + scored context injection
export function getSmartBootPayload(agentId, contextScorer, memoryDb, queryEmbedding) {
  var slim = getSlimBootPayload(agentId);
  if (!slim) return null;

  var agent = getAgent(agentId);
  var projectId = agent ? agent.project_id : '';

  // Gather work context from slim boot data
  var workContext = {
    tasks: [],
    plan_steps: [],
    messages: [],
    project_id: projectId
  };

  // Get assigned tasks for context
  try {
    var myTasks = db.prepare(
      "SELECT title, description FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress') LIMIT 10"
    ).all(agentId);
    workContext.tasks = myTasks;
  } catch (e) { /* */ }

  // Get plan steps assigned to this agent
  try {
    var mySteps = db.prepare(
      "SELECT ps.title, ps.description FROM plan_steps ps JOIN plans p ON ps.plan_id = p.id WHERE ps.assignee = ? AND ps.status IN ('pending', 'in_progress') AND p.status = 'active' LIMIT 10"
    ).all(agentId);
    workContext.plan_steps = mySteps;
  } catch (e) { /* */ }

  // Get recent messages
  try {
    var recentMsgs = db.prepare(
      "SELECT content FROM messages WHERE to_agent = ? AND created_at > datetime('now', '-1 day') ORDER BY created_at DESC LIMIT 5"
    ).all(agentId);
    workContext.messages = recentMsgs;
  } catch (e) { /* */ }

  // Load ALL context keys for agent's namespaces
  var namespaces = [agentId, projectId, 'mycelium'].filter(Boolean);
  var allKeys = [];
  var seen = {};
  for (var ns of namespaces) {
    var keys = listContextKeys(ns);
    for (var k of keys) {
      var uid = k.namespace + ':' + k.key;
      if (!seen[uid]) {
        seen[uid] = true;
        allKeys.push(k);
      }
    }
  }

  // Get embedding config + key embeddings from semantic memory if available
  var scorerOpts = {};
  if (memoryDb) {
    try {
      var config = memoryDb.getAllConfig();
      if (config.embedding_provider && config.embedding_provider !== 'none') {
        // Batch-load embeddings for context keys (single query instead of N+1)
        var keyEmbeddings = {};
        var sourceIds = allKeys.map(function (ck) { return ck.namespace + ':' + ck.key; });
        if (sourceIds.length > 0) {
          var placeholders = sourceIds.map(function () { return '?'; }).join(',');
          var embRows = db.prepare(
            'SELECT source_id, embedding FROM sm_embeddings WHERE source_type = ? AND source_id IN (' + placeholders + ') AND embedding IS NOT NULL'
          ).all('context_key', ...sourceIds);
          for (var embRow of embRows) {
            if (embRow.embedding) {
              try {
                keyEmbeddings[embRow.source_id] = JSON.parse(typeof embRow.embedding === 'string' ? embRow.embedding : embRow.embedding.toString());
              } catch (e) { /* */ }
            }
          }
        }
        if (Object.keys(keyEmbeddings).length > 0) {
          scorerOpts.keyEmbeddings = keyEmbeddings;
        }
        if (queryEmbedding) {
          scorerOpts.queryEmbedding = queryEmbedding;
        }
      }
    } catch (e) { /* semantic-memory not available */ }
  }

  // Score and filter
  var maxKeys = 20; // default, could be configured via instance config
  try {
    var maxKeysSetting = db.prepare("SELECT value FROM instance_config WHERE key = 'smart_boot_max_keys'").get();
    if (maxKeysSetting) maxKeys = parseInt(maxKeysSetting.value) || 20;
  } catch (e) { /* */ }

  var scored = contextScorer(allKeys, workContext, scorerOpts);

  // Always include critical keys + top N by score
  var selected = [];
  var nonCritical = [];
  for (var s of scored) {
    if (s.critical) {
      selected.push(s);
    } else {
      nonCritical.push(s);
    }
  }

  // Fill remaining slots with top-scored non-critical keys
  var remaining = maxKeys - selected.length;
  if (remaining > 0) {
    selected = selected.concat(nonCritical.slice(0, remaining));
  }

  // Determine scoring method
  var method = scorerOpts.queryEmbedding ? 'hybrid' : (scorerOpts.keyEmbeddings ? 'keyword+vector' : 'keyword+access');

  // Attach to slim boot
  slim.context_keys = selected.map(function (s) {
    return { namespace: s.namespace, key: s.key, data: s.data, score: Math.round(s.score * 1000) / 1000, reasons: s.reasons };
  });
  slim.context_meta = {
    total_available: allKeys.length,
    selected: selected.length,
    method: method,
    max_keys: maxKeys
  };

  return slim;
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
// --- Capability-aware routing (planner-triage-first) -----------------------
// A "planner" is any agent advertising the `reasoning_planning` capability.
// Unassigned bugs are planner-shaped work (triage → author a plan, or delegate
// a single-shot task), so we route them to the planner instead of letting
// whichever agent polls first single-shot them. Safe fallback: if there is no
// ONLINE planner in scope, behave exactly as before (offer to all) — solo /
// non-squad / public deployments are unaffected, and a planner being offline
// can't starve the bug queue.
function _capsHave(caps, name) {
  if (!caps) return false;
  try {
    var arr = typeof caps === 'string' ? JSON.parse(caps) : caps;
    return Array.isArray(arr) && arr.indexOf(name) !== -1;
  } catch (e) { return false; }
}

function agentIsPlanner(agentId) {
  try {
    var row = db.prepare('SELECT capabilities FROM agents WHERE id = ?').get(agentId);
    return !!(row && _capsHave(row.capabilities, 'reasoning_planning'));
  } catch (e) { return false; }
}

// Is there an ONLINE planner (heartbeat within 30m) whose visibility overlaps
// this agent's scope — so unassigned bugs there are the planner's to triage?
// Mirrors the same project/team/legacy scoping the bug-visibility filter uses.
function scopeHasOnlinePlanner(agentId, projectId, teamProjIds) {
  try {
    var planners = db.prepare(
      "SELECT id, project_id FROM agents " +
      "WHERE capabilities LIKE '%reasoning_planning%' AND id != ? " +
      "AND last_heartbeat > datetime('now','-30 minutes')"
    ).all(agentId);
    var noTeam = !teamProjIds || teamProjIds.length === 0;
    for (var p of planners) {
      if (!p.project_id) return true;                                  // unscoped planner sees all
      if (p.project_id === projectId) return true;                     // same project
      if (!noTeam && teamProjIds.indexOf(p.project_id) !== -1) return true; // same team
      if (noTeam) return true;                                         // legacy: this agent sees all → any planner counts
    }
    return false;
  } catch (e) { return false; }
}

// Step ordering (durable rule): a plan step is "ready" to claim only when every
// EARLIER step in its plan (lower step_order) is completed. Plan steps are
// sequential by design — verify follows code, deploy follows build — so a later
// step is never offered for claim before its predecessors finish. Enforced
// wherever a step is offered (here + getNextUnassignedPlanStep's SQL). Today
// step_order IS the dependency order; an explicit parallel/dependency model
// would generalize this later.
function _planPriorsComplete(plan, step) {
  var order = step.step_order;
  return (plan.steps || []).every(function (s) {
    return s.step_order >= order || s.status === 'completed';
  });
}

export function buildWorkQueue(agentId, projectId, directives, requests, tasks, bugs, plans) {
  var queue = [];

  // Directives are DEPRECATED (2026-06-05) — no longer served as work.
  // They were a top-priority item used to push work AND "keep agents awake,"
  // but a worker can't reliably CLOSE a bare directive, so it re-claims and
  // re-runs it every poll (~170x/sec). That loop, times an event-per-heartbeat,
  // flooded the events table to 18M rows / 3GB and pegged the server. Aligning
  // to the OpenJarvis model: work is PULL-claimed via tasks/plan-steps below,
  // liveness is an ephemeral last-seen timestamp, and there is no keep-awake
  // nudge. Not serving directives here means no source can ever loop a worker.
  void directives;

  // Priority 2: Pending requests (respond before new work)
  for (var r of requests) {
    queue.push({ priority: 1, type: 'request', id: r.id, title: 'Request from ' + r.from_agent, summary: (r.content || '').substring(0, 200), status: r.status, from_agent: r.from_agent, content: r.content });
  }

  // Priority 3: In-progress plan steps assigned to this agent
  // Priority 4: Pending plan steps assigned to this agent
  for (var plan of plans) {
    if (!plan.steps) continue;
    for (var step of plan.steps) {
      if (step.assignee === agentId && step.status === 'in_progress') {
        queue.push({ priority: 2, type: 'plan_step', id: step.id, plan_id: plan.id, plan_title: plan.title, title: step.title, status: step.status, project_id: plan.project_id });
      }
    }
    for (var step of plan.steps) {
      if (step.assignee === agentId && step.status === 'pending' && _planPriorsComplete(plan, step)) {
        queue.push({ priority: 3, type: 'plan_step', id: step.id, plan_id: plan.id, plan_title: plan.title, title: step.title, status: step.status, project_id: plan.project_id });
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
      if (!step.assignee && step.status === 'pending' && _planPriorsComplete(plan, step)) {
        queue.push({ priority: 7, type: 'plan_step_unassigned', id: step.id, plan_id: plan.id, plan_title: plan.title, title: step.title, status: step.status, project_id: plan.project_id });
      }
    }
  }

  // Priority 9: Unassigned bugs for this agent's project/team.
  // Planner-triage-first: an unassigned bug is planner-shaped work, so route
  // it to the planner for triage rather than letting whichever agent polls
  // first single-shot it. A non-planner is shown unassigned bugs ONLY when no
  // online planner is in scope (fallback so solo/public deployments and a
  // planner-offline situation still get bugs picked up).
  var teamProjIds = getTeamProjectIdsForAgent(agentId);
  var deferToPlanner = !agentIsPlanner(agentId)
    && scopeHasOnlinePlanner(agentId, projectId, teamProjIds);
  var unassignedBugs = deferToPlanner ? [] : bugs.filter(function (b) {
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
  // Excludes agents with working_on set (runner is active on something)
  return db.prepare(`
    SELECT id, name, project_id, status, working_on, capabilities, role, runtime, llm_backend, llm_model
    FROM agents
    WHERE status IN ('online', 'idle')
      AND role != 'drone'
      AND (working_on IS NULL OR working_on = '')
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
       -- Step ordering (durable): a plan step is not claimable until ALL earlier
       -- steps in its plan (lower step_order) are completed. Plan steps are
       -- sequential by design — a verify step must not run before the code step
       -- it checks; a deploy not before its build. Enforced here AND in
       -- buildWorkQueue (the assigned-claim path) so out-of-order execution
       -- cannot happen regardless of how the steps were assigned.
       AND NOT EXISTS (
         SELECT 1 FROM plan_steps prior
         WHERE prior.plan_id = s.plan_id
           AND prior.step_order < s.step_order
           AND prior.status != 'completed'
       )
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
    var allSteps = db.prepare("SELECT plan_id, id, status, title, assignee, step_order FROM plan_steps WHERE plan_id IN (" + placeholders + ") ORDER BY step_order ASC").all(...planIds);
    var stepsByPlan = {};
    for (var s of allSteps) {
      if (!stepsByPlan[s.plan_id]) stepsByPlan[s.plan_id] = [];
      stepsByPlan[s.plan_id].push(s);
    }
    for (var p of plans) {
      var steps = stepsByPlan[p.id] || [];
      p.steps = steps;
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
  var f = Object.assign({}, fields);
  if (f.tags !== undefined && typeof f.tags !== 'string') f.tags = JSON.stringify(f.tags);
  buildUpdate('plans', id, f, ['title', 'description', 'status', 'owner', 'priority', 'tags', 'project_id'], { updatedAt: true });
}

export function deletePlan(id) {
  db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
  db.prepare("DELETE FROM plans WHERE id = ?").run(id);
}

export function createPlanStep(planId, title, description, assignee, phase) {
  assignee = resolveAssignee(assignee);
  var maxOrder = db.prepare("SELECT MAX(step_order) as m FROM plan_steps WHERE plan_id = ?").get(planId);
  var order = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 0;
  var result = db.prepare(
    "INSERT INTO plan_steps (plan_id, step_order, title, description, assignee, phase) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(planId, order, title, description || '', assignee || null, phase || '');
  db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  return result.id;
}

export function updatePlanStep(stepId, fields) {
  if (fields.assignee !== undefined && fields.assignee !== null) fields.assignee = resolveAssignee(fields.assignee);
  var extra = fields.status === 'completed' ? ["completed_at = datetime('now')"] : [];
  buildUpdate('plan_steps', stepId, fields, ['title', 'description', 'status', 'assignee', 'linked_task_id', 'linked_branch', 'linked_pr_url', 'phase', 'step_order'], { updatedAt: true, extraSets: extra });
  // Update parent plan's updated_at
  var step = db.prepare("SELECT plan_id FROM plan_steps WHERE id = ?").get(stepId);
  if (step) db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

// Bounded self-heal for a FAILED plan step. If the step still has retry budget,
// reopen it + the phase it guards (the immediately-prior step_order) to 'pending'
// and attach the failure `critique` to those reopened steps, so the work re-cycles
// with the verifier's reasons fed forward. Returns {action:'retried'|'exhausted'|'none'}.
// Runtime-agnostic: it only moves platform rows; the reopened steps flow through the
// normal work queue to whatever agent/runner is assigned. The caller decides what to
// do on 'exhausted' (block + escalate). maxAttempts is the caller's policy knob.
export function autoRetryOrEscalatePlanStep(planId, stepId, maxAttempts, critique) {
  var failed = db.prepare("SELECT id, step_order, attempt_count FROM plan_steps WHERE id = ? AND plan_id = ?").get(stepId, planId);
  if (!failed) return { action: 'none' };
  var attempts = failed.attempt_count || 0;
  if (attempts >= maxAttempts) return { action: 'exhausted', attempts: attempts };
  var nextAttempt = attempts + 1;
  var steps = db.prepare("SELECT id, step_order, status FROM plan_steps WHERE plan_id = ?").all(planId);
  // The phase this step guards = the greatest step_order below it (re-run the impl
  // a verify step checks). Reopen those completed steps + the failed step itself.
  var priorOrders = steps.map(function (s) { return s.step_order; }).filter(function (o) { return o < failed.step_order; });
  var priorOrder = priorOrders.length ? Math.max.apply(null, priorOrders) : null;
  var toReopen = steps.filter(function (s) {
    return s.id === stepId || (priorOrder !== null && s.step_order === priorOrder && s.status === 'completed');
  });
  var tx = db.transaction(function () {
    for (var s of toReopen) {
      db.prepare("UPDATE plan_steps SET status = 'pending', completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(s.id);
      if (critique && s.id !== stepId) {
        addPlanStepComment(s.id, planId, '__system__',
          '[auto-retry ' + nextAttempt + '/' + maxAttempts + '] Prior verification FAILED — fix before re-submitting:\n' + critique);
      }
    }
    db.prepare("UPDATE plan_steps SET attempt_count = ?, updated_at = datetime('now') WHERE id = ?").run(nextAttempt, stepId);
    db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  });
  tx();
  return { action: 'retried', attempt: nextAttempt, max: maxAttempts, reopened: toReopen.length };
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
  var caps = Array.isArray(capabilities) ? capabilities : [];

  return db.transaction(function () {
    var pending = db.prepare(
      "SELECT * FROM drone_jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC"
    ).all();

    for (var i = 0; i < pending.length; i++) {
      var job = pending[i];
      var reqs = [];
      try { reqs = JSON.parse(job.requires || '["cpu"]'); } catch (e) { console.warn('[mycelium] JSON parse failed for job.requires (job: ' + job.id + '):', e.message); reqs = ['cpu']; }
      var matched = reqs.every(function (r) { return caps.indexOf(r) !== -1; });
      if (!matched) continue;

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
  })();
}

export function updateDroneJob(id, fields) {
  var f = Object.assign({}, fields);
  if (f.input_data !== undefined && typeof f.input_data !== 'string') f.input_data = JSON.stringify(f.input_data);
  if (f.result_data !== undefined && typeof f.result_data !== 'string') f.result_data = JSON.stringify(f.result_data);
  buildUpdate('drone_jobs', id, f, ['status', 'command', 'input_data', 'result_url', 'result_data', 'error', 'completed_at', 'drone_id', 'started_at']);
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

// Bug #137: Release stale claimed jobs (claimed >1 hour ago, not completed)
// If droneId provided, scoped to that drone. Otherwise releases ALL stale jobs.
export function releaseStaleClaimedJobs(droneId) {
  var staleJobs;
  if (droneId) {
    staleJobs = db.prepare(
      "SELECT * FROM drone_jobs WHERE status = 'claimed' AND drone_id = ? AND started_at < datetime('now', '-1 hour')"
    ).all(droneId);
  } else {
    staleJobs = db.prepare(
      "SELECT * FROM drone_jobs WHERE status = 'claimed' AND started_at < datetime('now', '-1 hour')"
    ).all();
  }
  var msg = droneId
    ? '[stale_timeout] Job was claimed for >1 hour with no completion. Auto-failed on drone restart.'
    : '[stale_timeout] Job was claimed for >1 hour with no progress. Auto-failed by server.';
  for (var job of staleJobs) {
    db.prepare(
      "UPDATE drone_jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(msg, job.id);
  }
  return staleJobs;
}

export function listDrones() {
  return db.prepare("SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, created_at FROM agents WHERE project_id = 'drone' ORDER BY created_at").all();
}

export function pauseDrone(droneId) {
  db.prepare(`UPDATE agents SET status = 'paused', working_on = 'Paused (GPU released)' WHERE id = ?`).run(droneId);
  return { ok: true, status: 'paused' };
}

export function resumeDrone(droneId) {
  db.prepare(`UPDATE agents SET status = 'online', working_on = '' WHERE id = ?`).run(droneId);
  return { ok: true, status: 'online' };
}

export function getDroneStatus(droneId) {
  var agent = db.prepare(`SELECT id, name, status, working_on, capabilities, last_heartbeat FROM agents WHERE id = ?`).get(droneId);
  if (!agent) return null;
  var pendingJobs = db.prepare(`SELECT COUNT(*) as count FROM drone_jobs WHERE status = 'pending'`).get();
  return {
    ...agent,
    capabilities: JSON.parse(agent.capabilities || '[]'),
    queued_jobs: pendingJobs.count
  };
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
  // Merge inputData vars. These are user-supplied and get interpolated into a
  // command executed on the drone, so reject shell metacharacters (C-2): $ and
  // backtick do command substitution even inside quotes; ; | & < > chain and
  // redirect. Blocking them stops injection cross-OS without touching normal
  // prompt text (letters, spaces, commas, apostrophes, parens all pass).
  var SHELL_META = /[$`;|&<>\n\r\0]/;
  if (inputData && typeof inputData === 'object') {
    for (var k of Object.keys(inputData)) {
      if (k.startsWith('_')) continue;
      var v = inputData[k];
      if (typeof v === 'string' && SHELL_META.test(v)) {
        return { error: 'Input value for "' + k + '" contains disallowed shell characters ($ ` ; | & < > newline)' };
      }
      vars[k] = v;
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

// -- Init (no default seed data — new instances start blank) --

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
  };
}

// =============== SLIM OVERVIEW ===============

function timeSince(dateStr) {
  // SQLite datetime('now') yields a space-separated UTC string with no zone
  // (e.g. "2026-06-01 14:23:05"). Per the ECMAScript Date spec only the
  // 'T'-separated ISO form is treated as UTC when the zone is omitted; the
  // space form parses as LOCAL time, landing hours in the future on hosts west
  // of UTC and producing negative ages. Normalize to ISO-UTC before parsing,
  // mirroring the frontend's parseTimestamp (utils/time.ts).
  var ms = dateStr.includes('T')
    ? new Date(dateStr).getTime()
    : new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
  var diff = Date.now() - ms;
  if (diff < 0) diff = 0; // clamp residual skew, like timeAgo's "just now"
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
  var changed = buildUpdate('teams', id, fields, ['name', 'description', 'org_id'], { updatedAt: true });
  if (!changed) return getTeam(id);
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


