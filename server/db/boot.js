// =============== MYCELIUM — DB entity: boot payloads ===============
// Extracted from server/db.js (Wave 6 of the decomposition — see
// docs/DB-DECOMPOSITION-PLAN.md, §1 db/boot.js / §3 Wave 6). LAST module
// extracted — the hairball: imports from agents, tasks, messages, context,
// config, operators, events, bugs, plans, channels, concepts, projects,
// plugins (`listPluginRecords`), approvals (`listPendingApprovalsByAgent`),
// savepoints, node-profiles (`buildCalibrationBlock`), teams
// (`getTeamsForUser`), workqueue (`buildWorkQueue`). All of those siblings
// landed in earlier waves, so this composite — the widest fan-in in the
// campaign — can land now, dead last, per the callee-first ordering law.
// NOT read-only: auto-heartbeats (`updateAgentHeartbeat`), auto-acks inbox
// (`markMessagesRead`), and calibration writes a context key. Private
// `buildCrashRecovery` / `buildRoleContract` move with the module and stay
// unexported. Bodies moved VERBATIM — bare db.prepare(...) keeps working via
// the ESM live binding (initDBConnection assigns db; nobody else may). The
// barrel server/db.js re-exports these via `export * from './db/boot.js'`
// so no consumer changes a single import.
import { db } from './core.js';
import { getAgent, updateAgentHeartbeat } from './agents.js';
import { listPendingRequests, getUnreadMessages, markMessagesRead } from './messages.js';
import { getContext, listContextKeys, getContextKey } from './context.js';
import { listTasksNeedingApproval } from './tasks.js';
import { listEvents } from './events.js';
import { listBugs } from './bugs.js';
import { listPlans } from './plans.js';
import { getChannelsByUser, getUnreadCounts } from './channels.js';
import { getProject } from './projects.js';
import { getProjectConcepts } from './concepts.js';
import { buildCalibrationBlock } from './node-profiles.js';
import { listPluginRecords } from './plugins.js';
import { listPendingApprovalsByAgent } from './approvals.js';
import { getTeamsForUser } from './teams.js';
import { getSleepMode } from './config.js';
import { isNetworkAutonomous, getAvailableOperators } from './operators.js';
import { getLatestSavepoint } from './savepoints.js';
import { buildWorkQueue } from './workqueue.js';

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
