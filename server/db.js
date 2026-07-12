// =============== MYCELIUM — Database Layer (barrel facade) ===============
// Wave 1 of db.js decomposition (see docs/DB-DECOMPOSITION-PLAN.md). The
// connection, schema/migration, and shared helpers (the live `db` binding, the
// prepared-statement cache `stmt`, `buildUpdate`, `getDB`) now live in
// ./db/core.js; the 300 entity functions below still live here and migrate one
// module per PR in later waves. This barrel preserves the exact ESM export
// surface — no consumer (routes, index.js, plugins.js, plugin deep imports,
// test/unit/db-*.test.js) changes a single import.
import { db, stmt, buildUpdate, getDB, initDBConnection, DB_PATH } from './db/core.js';
// Re-import the config functions this barrel's own remaining internals still call
// (listInstanceConfig in the overview composite, getSleepMode in the boot payload).
// `export *` below re-exports them for consumers; it does NOT create a local
// binding, so internal callers need this named import. config.js imports only
// ./core.js — no cycle.
import { listInstanceConfig, getSleepMode } from './db/config.js';
// listBugs + countBugs are called by the boot payload + overview composites still
// living in this barrel; same named-import contract as config above.
import { listBugs, countBugs } from './db/bugs.js';
// listEvents is called by the boot payload + overview composites still living in
// this barrel; same named-import contract as config/bugs above.
import { listEvents } from './db/events.js';
// listConcepts / getProjectConcepts / getConceptProjects are called by the boot
// payload + overview composites still living in this barrel; same named-import
// contract as config/bugs/events above. concepts.js imports only ./core.js.
import { listConcepts, getProjectConcepts, getConceptProjects } from './db/concepts.js';
// getProject / listProjects / listOrgs are called by the boot payload + overview
// composites still living in this barrel; same named-import contract as above.
// projects.js imports only ./core.js.
import { getProject, listProjects, listOrgs } from './db/projects.js';
// listPluginRecords is called by the slim boot payload + admin-ops composites
// still living in this barrel; same named-import contract as above. plugins.js
// imports only ./core.js.
import { listPluginRecords } from './db/plugins.js';
// getContext / getAllContext / upsertContextKey / getContextKey / listContextKeys
// are called by the boot payload + role-contract + admin-ops composites still
// living in this barrel; same named-import contract as above. context.js
// imports only ./core.js.
import { getContext, getAllContext, upsertContextKey, getContextKey, listContextKeys } from './db/context.js';
// getLatestSavepoint is called by the boot payload + drones + node-profiles
// composites still living in this barrel; same named-import contract as
// above. savepoints.js imports only ./core.js.
import { getLatestSavepoint } from './db/savepoints.js';
// listPendingRequests / markMessagesRead / getUnreadMessages / listMessages /
// listTeamChat are called by the boot payload + overview composites still
// living in this barrel; same named-import contract as above. messages.js
// imports only ./core.js.
import { listPendingRequests, markMessagesRead, getUnreadMessages, listMessages, listTeamChat } from './db/messages.js';
// listOperators / getAvailableOperators / isNetworkAutonomous /
// getActiveStudioUsers are called by the boot payload + channel seeds +
// overview composites still living in this barrel; same named-import
// contract as above. operators.js imports only ./core.js.
import { listOperators, getAvailableOperators, isNetworkAutonomous, getActiveStudioUsers } from './db/operators.js';
// listApprovals / listPendingApprovalsByAgent are called by the boot payload +
// admin-ops composites still living in this barrel; same named-import
// contract as above. approvals.js imports only ./core.js.
import { listApprovals, listPendingApprovalsByAgent } from './db/approvals.js';
// getAgent / resolveAssignee / listAgents / updateAgentHeartbeat are called by
// the boot payload + role-contract + task/plan updates + channel seeds +
// overview composites still living in this barrel; same named-import
// contract as above. agents.js imports only ./core.js.
import { getAgent, resolveAssignee, listAgents, updateAgentHeartbeat } from './db/agents.js';
// createTask / listTasks / listTasksNeedingApproval are called by the boot
// payload + overview composites still living in this barrel; same
// named-import contract as above. tasks.js imports ./core.js + ./agents.js.
import { createTask, listTasks, listTasksNeedingApproval } from './db/tasks.js';
// listPlans is called by the boot payload + role-contract composites still
// living in this barrel; same named-import contract as above. plans.js
// imports ./core.js + ./agents.js.
import { listPlans } from './db/plans.js';
// ensureDefaultChannels is one of the initDB seeds (mechanics §3) — initDB
// below now calls this import instead of a local copy. getChannelsByUser /
// getUnreadCounts / listChannels / isChannelMember are called by the boot
// payload + role-contract + overview composites still living in this barrel;
// same named-import contract as above. channels.js imports ./core.js +
// ./operators.js + ./agents.js.
import { ensureDefaultChannels, getChannelsByUser, getUnreadCounts, listChannels, isChannelMember } from './db/channels.js';
// seedDefaultJobTemplates is one of the initDB seeds (mechanics §3) — initDB
// below now calls this import instead of a local copy. listDrones /
// listDroneJobs are called by the overview composite still living in this
// barrel; same named-import contract as above. drones.js imports ./core.js +
// ./savepoints.js.
import { seedDefaultJobTemplates, listDrones, listDroneJobs } from './db/drones.js';
// seedPlatformProfiles is one of the initDB seeds (mechanics §3) — initDB
// below now calls this import instead of a local copy. buildCalibrationBlock
// is called by the boot payload + role-contract composites still living in
// this barrel; getNodeProfile / updateNodeProfile / createNodeProfile are
// called by syncTeamSettingsToProfile (teams — not yet extracted, still in
// this barrel). Same named-import contract as above. node-profiles.js
// imports ./core.js + ./agents.js + ./savepoints.js + ./context.js.
import { seedPlatformProfiles, buildCalibrationBlock, getNodeProfile, updateNodeProfile, createNodeProfile } from './db/node-profiles.js';
// listAssets is called by the overview composite still living in this
// barrel; same named-import contract as above. assets.js imports ./core.js +
// ./tasks.js.
import { listAssets } from './db/assets.js';

export { getDB };

// Entity modules migrate here one per PR (see docs/DB-DECOMPOSITION-PLAN.md).
// Wave 2 pilot: spend (3 functions, zero coupling). Wave 3: config, bugs,
// feedback, events, widgets, skills, concepts, projects, runs, plugins, health,
// webhooks. Each is re-exported so the barrel's public surface stays exactly 306.
export * from './db/spend.js';
export * from './db/config.js';
export * from './db/bugs.js';
export * from './db/feedback.js';
export * from './db/events.js';
export * from './db/widgets.js';
export * from './db/skills.js';
export * from './db/concepts.js';
export * from './db/projects.js';
export * from './db/runs.js';
export * from './db/plugins.js';
export * from './db/health.js';
export * from './db/webhooks.js';
export * from './db/context.js';
export * from './db/savepoints.js';
export * from './db/messages.js';
export * from './db/operators.js';
export * from './db/approvals.js';
export * from './db/agents.js';
export * from './db/tasks.js';
export * from './db/plans.js';
export * from './db/agent-profiles.js';
export * from './db/channels.js';
export * from './db/drones.js';
export * from './db/node-profiles.js';
export * from './db/assets.js';

// Composed initDB — the ONE non-verbatim edit in the campaign (mechanics §3):
// core owns connection+migrations+schema+instance_config seeding (initDBConnection);
// the barrel composes the three entity seeds (still local until their modules
// extract in later waves) + the log line. Keeps the module graph a strict DAG
// (core never imports the entity modules that own the seeds).
export function initDB() {
  initDBConnection();
  ensureDefaultChannels();
  seedPlatformProfiles();
  seedDefaultJobTemplates();
  console.log('Mycelium DB initialized at ' + DB_PATH);
}

// -- Projects / Organizations --  → moved to ./db/projects.js (Wave 3)

// -- Tasks --  → moved to ./db/tasks.js (Wave 4)

// -- Plan Step Comments --  → moved to ./db/plans.js (Wave 4)

// -- Assets --  → moved to ./db/assets.js (Wave 4)

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

// -- Auto-task from asset request --  → moved to ./db/assets.js (Wave 4)

// -- Plans --  → moved to ./db/plans.js (Wave 4)

// -- Channels --  → moved to ./db/channels.js (Wave 4)

// -- Drone Jobs --  → moved to ./db/drones.js (Wave 4)

// -- Shared Concepts --  → moved to ./db/concepts.js (Wave 3)
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

// =============== NODE PROFILES — Stand Up Calibration ===============  → moved to ./db/node-profiles.js (Wave 4)

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


// -- Agent Profiles --  → moved to ./db/agent-profiles.js (Wave 4)
