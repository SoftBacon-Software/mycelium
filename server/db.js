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
// Wave 4 re-imports: resident boot/overview/workqueue/initDB functions still call
// these now-extracted entity helpers by bare name. `export *` re-exports them to
// consumers but does NOT bind them in THIS module's lexical scope (same trap the
// earlier waves hit), so import them explicitly. Acyclic — each db/*.js imports
// only ./db/core.js + sibling db/*.js, never this barrel (../db.js).
import { listTasks, listTasksNeedingApproval } from './db/tasks.js';
import { listPlans } from './db/plans.js';
import { listAssets } from './db/assets.js';
import { listDrones, listDroneJobs, seedDefaultJobTemplates } from './db/drones.js';
import { getTeamsForUser } from './db/teams.js';

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
export * from './db/tasks.js';
export * from './db/plans.js';
export * from './db/drones.js';
export * from './db/assets.js';
export * from './db/teams.js';

export function initDB() {
  initDBConnection();
  ensureDefaultChannels();
  seedPlatformProfiles();
  seedDefaultJobTemplates();
  console.log('Mycelium DB initialized at ' + DB_PATH);
}

// =============== MYCELIUM PLATFORM ===============

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

// -- Studio Users --

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
