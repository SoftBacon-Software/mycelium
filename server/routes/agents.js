// Agents routes — extracted verbatim from mycelium.js (god-file decomposition,
// Phase 3, 2026-07-12; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Covers the AGENTS surface: /boot, /work (pull + request), /agents (list,
// get, put, heartbeat, savepoints, profiles, leaderboard, skills, identity,
// rekey, mcp-config), and /agent-templates (CRUD + apply).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is
// identical to before extraction — pinned by test/unit/agents-characterization.test.js.
import crypto from 'crypto';
import {
  getBootPayload, getSlimBootPayload, getSmartBootPayload,
  getAgent, cleanupAgentSessionKeys, computeSavepointDiff, getSleepMode,
  isNetworkAutonomous, getAvailableOperators, ensureAgentProfile,
  getDB,
  listPendingRequests, listBugs, listPlans, getPlan, buildWorkQueue,
  updatePlanStep, updateTask, getTask, updateBug,
  listAgents, getAgentSkills, getAgentProfile, updateAgentProfile,
  listAgentProfiles, getAgentLeaderboard, updateAgent,
  getLatestSavepoint, getSavepointHistory, updateSavepointNotes,
  createSavepoint, pruneSavepoints, updateAgentHeartbeat,
  getContextKey, upsertContextKey, buildCalibrationBlock,
  getUnreadMessages, markMessagesRead, listPendingApprovalsByAgent,
  updateDroneDiagnostics, dispatchWebhook, updateAgentKey,
  createRequest, getInstanceConfig,
  resolveProfileChain, getTeamsForUser, getAllTeamSettingsGrouped,
  getProjectConcepts, getProject, getTeamProjects,
  createAgentTemplate, getAgentTemplate, listAgentTemplates,
  updateAgentTemplate, deleteAgentTemplate, addTeamMember,
} from '../db.js';

function formatSavepointSummary(diff) {
  if (!diff || !diff.summary) return 'No changes since last session.';
  var parts = [];
  if (diff.new_messages) parts.push(diff.new_messages + ' new message' + (diff.new_messages > 1 ? 's' : ''));
  if (diff.task_changes) parts.push(diff.task_changes + ' task change' + (diff.task_changes > 1 ? 's' : ''));
  if (diff.plan_changes) parts.push(diff.plan_changes + ' plan update' + (diff.plan_changes > 1 ? 's' : ''));
  if (diff.context_changes) parts.push(diff.context_changes + ' context change' + (diff.context_changes > 1 ? 's' : ''));
  return parts.length > 0 ? parts.join(', ') : diff.summary || 'No changes since last session.';
}

// ======== BOOT ========

// Lazy-load smart boot dependencies (plugin may not be available)
var _contextScorer = null;
var _createMemoryDB = null;
var _generateEmbedding = null;

// Pre-load smart boot deps at startup (fire-and-forget)
(async function () {
  try {
    var scorerMod = await import('../plugins/semantic-memory/context-scorer.js');
    _contextScorer = scorerMod.scoreContextKeys;
    var dbMod = await import('../plugins/semantic-memory/db.js');
    _createMemoryDB = dbMod.default;
    var embedMod = await import('../plugins/semantic-memory/embeddings.js');
    _generateEmbedding = embedMod.generateEmbedding;
    console.log('[mycelium] Smart boot dependencies loaded');
  } catch (e) {
    console.log('[mycelium] Smart boot deps not available (semantic-memory plugin not loaded):', e.message);
  }
})();

// Forbidden capabilities by agent_type
var DRONE_FORBIDDEN_CAPS = ['code', 'coordination', 'admin'];

export function registerAgentRoutes(router, deps) {
  const {
    asyncHandler, checkAgent, checkAgentOrAdmin, checkAdmin,
    validateEnum, parseLimit, emitEvent, apiError, getAdminDisplayName,
    getInstanceUrl, buildMcpConfig, isAdminKey, invalidateAgentKeyCache,
    dispatchWorkToIdleAgents, AGENT_STATUSES,
  } = deps;

  // ======== BOOT ========

  router.get('/boot/:agentId', asyncHandler(async function (req, res) {
    var agentId = checkAgent(req, res);
    if (!agentId) return;
    if (agentId !== req.params.agentId) {
      return res.status(403).json({ error: 'Agent key does not match agent ID' });
    }

    // Clean up expired ephemeral context keys for this agent
    cleanupAgentSessionKeys(agentId);

    // Verbose mode returns legacy full payload
    if (req.query.verbose === 'true') {
      var fullPayload = getBootPayload(agentId);
      if (!fullPayload) return res.status(404).json({ error: 'Agent not found' });
      fullPayload.savepoint = computeSavepointDiff(agentId);
      fullPayload.sleep_mode = getSleepMode();
      fullPayload.autonomous_mode = isNetworkAutonomous();
      fullPayload.operators_available = getAvailableOperators().length;
      try { fullPayload.profile = ensureAgentProfile(agentId); } catch (e) { /* non-critical */ }
      emitEvent('agent_boot', agentId, null, agentId + ' booted (verbose)');
      return res.json(fullPayload);
    }

    // Smart boot mode — scored context injection
    if (req.query.smart === 'true' && _contextScorer) {
      try {
        var memoryDb = _createMemoryDB ? _createMemoryDB(getDB()) : null;
        // Generate query embedding from work context for vector scoring
        var queryEmbedding = null;
        if (_generateEmbedding && memoryDb) {
          try {
            var embConfig = memoryDb.getAllConfig();
            if (embConfig.embedding_provider && embConfig.embedding_provider !== 'none') {
              // Build query text from agent's current work
              var agent = getAgent(agentId);
              var workTexts = [];
              if (agent && agent.working_on) workTexts.push(agent.working_on);
              var recentWork = db.prepare(
                "SELECT title FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress') LIMIT 5"
              ).all(agentId);
              for (var rw of recentWork) { if (rw.title) workTexts.push(rw.title); }
              if (workTexts.length > 0) {
                queryEmbedding = await _generateEmbedding(embConfig, workTexts.join(' '));
              }
            }
          } catch (e) {
            // Non-critical — falls back to keyword+access scoring
          }
        }
        var payload = getSmartBootPayload(agentId, _contextScorer, memoryDb, queryEmbedding);
        if (!payload) return res.status(404).json({ error: 'Agent not found' });
        var diff = computeSavepointDiff(agentId);
        payload.savepoint = diff;
        payload.changes_since_last = formatSavepointSummary(diff);
        try { payload.profile = ensureAgentProfile(agentId); } catch (e) { /* non-critical */ }
        emitEvent('agent_boot', agentId, null, agentId + ' booted (smart)');
        return res.json(payload);
      } catch (e) {
        console.error('[mycelium] Smart boot failed, falling back to slim:', e.message);
        // Fall through to slim boot
      }
    }

    // Default: slim boot
    var payload = getSlimBootPayload(agentId);
    if (!payload) return res.status(404).json({ error: 'Agent not found' });
    var diff = computeSavepointDiff(agentId);
    payload.savepoint = diff;
    payload.changes_since_last = formatSavepointSummary(diff);
    try { payload.profile = ensureAgentProfile(agentId); } catch (e) { /* non-critical */ }
    emitEvent('agent_boot', agentId, null, agentId + ' booted');
    res.json(payload);
  }));

  // ======== WORK PULL ========

  router.get('/work/:agentId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var agentId = req.params.agentId;
    if (!req._authIsAdmin && who !== agentId) {
      return res.status(403).json({ error: 'Can only access your own work queue' });
    }
    var agent = getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Build work queue directly — no full boot payload needed
    var db = getDB();
    var pendingDirectives = db.prepare(
      "SELECT * FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
    ).all(agentId);
    var pendingRequests = listPendingRequests(agentId);
    var myTasks = db.prepare(
      "SELECT * FROM tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC"
    ).all(agentId);
    var openBugs = listBugs({ status: 'open', limit: 20 });
    // Get plans for agent's project + any plans with steps assigned to this agent
    var myPlans = listPlans({ project_id: agent.project_id, limit: 20 });
    var myPlanIds = new Set(myPlans.map(function (p) { return p.id; }));
    var assignedStepPlans = db.prepare(
      "SELECT DISTINCT plan_id FROM plan_steps WHERE assignee = ? AND status IN ('pending', 'in_progress')"
    ).all(agentId);
    for (var sp of assignedStepPlans) {
      if (!myPlanIds.has(sp.plan_id)) {
        var extra = getPlan(sp.plan_id);
        if (extra) myPlans.push(extra);
      }
    }
    var queue = buildWorkQueue(agentId, agent.project_id, pendingDirectives, pendingRequests, myTasks, openBugs, myPlans);

    // Auto-claim top item
    // Auto-claim top item (wrapped in transaction to prevent duplicate claims)
    if (req.query.auto_claim === 'true' && queue.length > 0) {
      var top = queue[0];
      var claimed = null;

      try {
        claimed = getDB().transaction(function () {
          if (top.type === 'directive' || top.type === 'request') {
            return top;
          } else if (top.type === 'plan_step' || top.type === 'plan_step_unassigned') {
            updatePlanStep(top.id, { assignee: agentId, status: 'in_progress' });
            top.claimed = true;
            return top;
          } else if (top.type === 'task') {
            updateTask(top.id, { assignee: agentId, status: 'in_progress' });
            var fullTask = getTask(top.id);
            return Object.assign({}, top, { description: fullTask ? fullTask.description : '', claimed: true });
          } else if (top.type === 'bug' || top.type === 'bug_unassigned') {
            updateBug(top.id, { assignee: agentId, status: 'in_progress' });
            top.claimed = true;
            return top;
          }
          return null;
        })();

        if (claimed && claimed.type !== 'directive' && claimed.type !== 'request') {
          emitEvent('work_claimed', agentId, top.project_id || null, agentId + ' auto-claimed ' + top.type + ' #' + top.id + ': ' + top.title, { item_type: top.type, item_id: top.id });
        }
      } catch (e) {
        console.error('[work] auto-claim transaction failed:', e.message);
      }

      return res.json({ ok: true, queue: queue, claimed: claimed });
    }

    res.json({ ok: true, queue: queue });
  }));

  // ======== AGENTS ========

  router.post('/agents/heartbeat', asyncHandler(function (req, res) {
    var agentId;
    // Admin can heartbeat on behalf of any agent via agent_id body field
    var adminKey = req.headers['x-admin-key'];
    if (isAdminKey(adminKey) && req.body.agent_id) {
      agentId = req.body.agent_id;
    } else {
      agentId = checkAgent(req, res);
      if (!agentId) return;
    }
    var status = req.body.status || 'online';
    if (!validateEnum(res, req.body.status, AGENT_STATUSES, 'status')) return;
    var workingOn = req.body.working_on || '';
    // Allow agent metadata to be updated via heartbeat
    var agentUpdates = {};
    if (req.body.avatar_url !== undefined) agentUpdates.avatar_url = req.body.avatar_url;
    if (req.body.llm_backend !== undefined) agentUpdates.llm_backend = req.body.llm_backend;
    if (req.body.llm_model !== undefined) agentUpdates.llm_model = req.body.llm_model;
    if (req.body.agent_type !== undefined) agentUpdates.agent_type = req.body.agent_type;
    if (req.body.runtime !== undefined) agentUpdates.runtime = req.body.runtime;
    if (req.body.system_diagnostics !== undefined) {
      agentUpdates.system_diagnostics = typeof req.body.system_diagnostics === 'string'
        ? req.body.system_diagnostics
        : JSON.stringify(req.body.system_diagnostics);
    }
    if (Object.keys(agentUpdates).length > 0) updateAgent(agentId, agentUpdates);
    // Read previous state to craft a meaningful event summary
    var prev = getAgent(agentId);
    var prevStatus = prev ? prev.status : 'offline';
    var prevWorkingOn = prev ? (prev.working_on || '') : '';
    updateAgentHeartbeat(agentId, status, workingOn);
    // Differentiate event summaries based on what changed
    var summary;
    if (prevStatus !== status && status === 'online') {
      summary = agentId + ' came online' + (workingOn ? ': ' + workingOn : '');
    } else if (prevStatus !== status && status === 'offline') {
      summary = agentId + ' went offline';
    } else if (workingOn && workingOn !== prevWorkingOn) {
      summary = agentId + ': ' + workingOn;
    } else {
      summary = agentId + ' is ' + status + (workingOn ? ': ' + workingOn : '');
    }
    emitEvent('agent_heartbeat', agentId, null, summary);
    // Webhook: notify when agent status actually changes
    if (prevStatus !== status) {
      dispatchWebhook('agent_status_changed', agentId, { agent_id: agentId, previous_status: prevStatus, new_status: status, working_on: workingOn });
    }

    // Write savepoint on every heartbeat
    var messagesAcked = [];
    if (Array.isArray(req.body.messages_acked)) {
      messagesAcked = req.body.messages_acked;
    } else {
      try { messagesAcked = JSON.parse(req.body.messages_acked || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for messages_acked (agent: ' + agentId + '):', e.message); }
    }
    var sessionId = req.body.session_id || null;
    var stateSnapshot = {};
    if (typeof req.body.state_snapshot === 'object' && req.body.state_snapshot !== null) {
      stateSnapshot = req.body.state_snapshot;
    } else {
      try { stateSnapshot = JSON.parse(req.body.state_snapshot || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for state_snapshot (agent: ' + agentId + '):', e.message); }
    }

    createSavepoint(agentId, {
      session_id: sessionId,
      working_on: workingOn,
      state_snapshot: stateSnapshot,
      messages_acked: messagesAcked
    });
    // Prune old savepoints (keep last 100)
    pruneSavepoints(agentId, 100);

    // Persist system_diagnostics for drones (smart job routing)
    if (stateSnapshot.system_info && typeof stateSnapshot.system_info === 'object') {
      try { updateDroneDiagnostics(agentId, stateSnapshot.system_info); } catch (e) { /* non-critical */ }
    }

    // Stand Up: persist md_report from state_snapshot
    if (stateSnapshot && stateSnapshot.md_report && typeof stateSnapshot.md_report === 'object') {
      try { upsertContextKey(agentId, 'md_report', JSON.stringify(stateSnapshot.md_report), 'system'); } catch (e) { /* non-critical */ }
    }

    // Stand Up: 6-hour calibration refresh
    try {
      var standupCtx = getContextKey(agentId, 'standup');
      var needsStandup = true;
      if (standupCtx && standupCtx.data) {
        var standupData = typeof standupCtx.data === 'object' ? standupCtx.data : JSON.parse(standupCtx.data);
        if (standupData.last_standup) {
          var lastStandup = new Date(standupData.last_standup).getTime();
          var sixHours = 6 * 60 * 60 * 1000;
          if (Date.now() - lastStandup < sixHours) needsStandup = false;
        }
      }
      if (needsStandup) {
        var calibration = buildCalibrationBlock(agentId);
        // Directives deprecated (2026-06-05): critical drift is surfaced in the
        // calibration block of the boot/standup payload (which the agent reads on
        // pull), not pushed as a "must-acknowledge" directive. No keep-awake nudge.
      }
    } catch (e) { /* non-critical — don't break heartbeat */ }

    // Heartbeat: return unread messages (filtered by read tracking)
    var unread = getUnreadMessages(agentId, 20);
    var unreadCount = unread.directives.length + unread.requests.length + unread.messages.length;
    var wake = (unread.directives.length + unread.requests.length) > 0;
    var response = { ok: true, pending: unreadCount, wake: wake };
    if (unreadCount > 0) {
      response.inbox = unread;
      // Auto-ack regular messages delivered via heartbeat (directives/requests stay unacked until resolved)
      var msgIdsToAck = unread.messages.map(function (m) { return m.id; });
      if (msgIdsToAck.length > 0) {
        try { markMessagesRead(agentId, msgIdsToAck); } catch (_) {}
      }
    }

    // Also process explicit acks from the request body
    if (messagesAcked.length > 0) {
      try { markMessagesRead(agentId, messagesAcked); } catch (_) {}
    }

    // Auto-dispatch: if agent just came online or is idle with no work, try to assign
    if (!workingOn && (status === 'online' || status === 'idle')) {
      try {
        var dispatched = dispatchWorkToIdleAgents('heartbeat:' + agentId);
        if (dispatched.length > 0) response.auto_dispatched = dispatched;
      } catch (e) { /* non-critical */ }
    }

    // Attach actionable approvals (pending or approved) so agent learns about decisions
    try {
      var agentApprovals = listPendingApprovalsByAgent(agentId);
      if (agentApprovals.length > 0) response.approvals = agentApprovals;
    } catch (e) { /* non-critical */ }

    res.json(response);
  }));

  // ======== SAVEPOINTS ========

  router.get('/agents/:id/savepoint', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    // Agents can only access their own savepoints
    if (!req._authIsAdmin && who !== req.params.id) {
      return res.status(403).json({ error: 'Can only access your own savepoints' });
    }
    var savepoint = getLatestSavepoint(req.params.id);
    if (!savepoint) return res.json({ has_savepoint: false });
    res.json(savepoint);
  }));

  router.get('/agents/:id/savepoints', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!req._authIsAdmin && who !== req.params.id) {
      return res.status(403).json({ error: 'Can only access your own savepoints' });
    }
    var limit = parseLimit(req.query.limit, 10);
    res.json(getSavepointHistory(req.params.id, limit));
  }));

  router.get('/agents/:id/savepoint/diff', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!req._authIsAdmin && who !== req.params.id) {
      return res.status(403).json({ error: 'Can only access your own savepoints' });
    }
    res.json(computeSavepointDiff(req.params.id));
  }));

  router.put('/agents/:id/savepoint/notes', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var notes = req.body.notes;
    if (!notes) return res.status(400).json({ error: 'notes required' });
    var savepointId = updateSavepointNotes(req.params.id, notes);
    if (!savepointId) return res.status(404).json({ error: 'No savepoint found for agent' });
    emitEvent('savepoint_notes', '__admin__', null, 'Admin left notes for ' + req.params.id + ': ' + notes.substring(0, 100));
    res.json({ ok: true, savepoint_id: savepointId });
  }));

  router.get('/agents', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listAgents());
  }));

  // Agent profiles — MUST be before /agents/:id to avoid route shadowing
  router.get('/agents/profiles', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listAgentProfiles());
  }));

  router.get('/agents/leaderboard', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var limit = parseInt(req.query.limit) || 20;
    res.json(getAgentLeaderboard(limit));
  }));

  router.get('/agents/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Don't leak key hash
    var { api_key_hash, ...safe } = agent;
    res.json(safe);
  }));

  // Update agent profile (avatar_url, name)
  router.put('/agents/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    // Agents can only update themselves, admin can update anyone
    if (!req._authIsAdmin && who !== req.params.id) {
      return res.status(403).json({ error: 'Can only update your own profile' });
    }
    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    var fields = {};
    if (req.body.avatar_url !== undefined) fields.avatar_url = req.body.avatar_url;
    if (req.body.name !== undefined) fields.name = req.body.name;
    // Admin-only fields
    if (req._authIsAdmin) {
      if (req.body.role !== undefined) fields.role = req.body.role;
      if (req.body.operator_id !== undefined) fields.operator_id = req.body.operator_id;
      if (req.body.project !== undefined) fields.project = req.body.project;
      if (req.body.project_id !== undefined) fields.project_id = req.body.project_id;
      if (req.body.capabilities !== undefined) fields.capabilities = typeof req.body.capabilities === 'string' ? req.body.capabilities : JSON.stringify(req.body.capabilities);
      if (req.body.runtime !== undefined) fields.runtime = req.body.runtime;
    }
    // Self-update fields (agent can only set on themselves)
    if (who === req.params.id || req._authIsAdmin) {
      if (req.body.llm_backend !== undefined) fields.llm_backend = req.body.llm_backend;
      if (req.body.llm_model !== undefined) fields.llm_model = req.body.llm_model;
      if (req.body.runtime !== undefined) fields.runtime = req.body.runtime;
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    updateAgent(req.params.id, fields);
    res.json({ ok: true, id: req.params.id, updated: Object.keys(fields) });
  }));

  // ======== SKILLS REGISTRY ========
  // (registry extracted -> ./concepts.js; /agents/:agentId/skills stays here — agents domain.)
  router.get('/agents/:agentId/skills', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var skills = getAgentSkills(req.params.agentId);
    res.json(skills);
  }));

  // Per-agent profile
  router.get('/agents/:id/profile', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var profile = getAgentProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
  }));

  router.put('/agents/:id/profile', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!req._authIsAdmin && who !== req.params.id) {
      return res.status(403).json({ error: 'Can only update your own profile' });
    }
    var profile = getAgentProfile(req.params.id);
    if (!profile) {
      try { ensureAgentProfile(req.params.id); } catch (e) { return res.status(404).json({ error: 'Agent not found' }); }
    }
    var fields = {};
    if (req.body.display_name !== undefined) fields.display_name = req.body.display_name;
    if (req.body.specializations !== undefined) fields.specializations = req.body.specializations;
    if (req.body.preferred_projects !== undefined) fields.preferred_projects = req.body.preferred_projects;
    if (req.body.max_concurrent !== undefined) fields.max_concurrent = parseInt(req.body.max_concurrent) || 0;
    if (req.body.profile_data !== undefined) fields.profile_data = req.body.profile_data;
    res.json(updateAgentProfile(req.params.id, fields));
  }));

  // ======== AGENT IDENTITY ========

  router.get('/agents/:id/identity', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Parse capabilities
    var caps = agent.capabilities;
    if (typeof caps === 'string') { try { caps = JSON.parse(caps); } catch (e) { caps = []; } }
    if (!Array.isArray(caps)) caps = [];

    // Agent profile (stats, profile_data)
    var profile = getAgentProfile(req.params.id);

    // Teams
    var teams = getTeamsForUser(req.params.id);

    // Resolved calibration chain (platform → customer → agent rules)
    var resolved = resolveProfileChain(req.params.id);

    // Extract platform guardrails from resolved rules
    var platformGuardrails = [];
    var platformRules = resolved.rules || {};
    for (var rk in platformRules) {
      var rule = platformRules[rk];
      var layer = 'platform';
      // Determine which layer this rule came from
      for (var li = resolved.layers_applied.length - 1; li >= 0; li--) {
        var lp = resolved.layers_applied[li];
        if (lp.layer === 'agent') continue; // agent-level rules go to custom
        layer = lp.layer === 'customer' ? 'team' : 'platform';
        break;
      }
      platformGuardrails.push({
        value: rk + (typeof rule === 'object' && rule.description ? ': ' + rule.description : ''),
        source: layer,
        locked: true
      });
    }

    // Gather team-sourced responsibilities and guardrails from team settings
    var teamGuardrails = [];
    var teamResponsibilities = [];
    for (var ti = 0; ti < teams.length; ti++) {
      var teamId = teams[ti].id;
      var teamName = teams[ti].name || teamId;
      try {
        var settings = getAllTeamSettingsGrouped();
        if (settings.guardrails) {
          for (var gk in settings.guardrails) {
            teamGuardrails.push({ value: String(settings.guardrails[gk]), source: 'team:' + teamName, locked: true });
          }
        }
        if (settings.team_rules) {
          for (var trk in settings.team_rules) {
            teamResponsibilities.push({ value: String(settings.team_rules[trk]), source: 'team:' + teamName, locked: true });
          }
        }
      } catch (e) { /* no settings */ }
    }

    // Gather ruleset guardrails from linked project concepts
    var rulesetGuardrails = [];
    var agentProject = agent.project_id || agent.project || '';
    if (agentProject) {
      try {
        var concepts = getProjectConcepts(agentProject);
        for (var ci = 0; ci < concepts.length; ci++) {
          var c = concepts[ci];
          if (c.type !== 'ruleset') continue;
          var cData = c.data;
          if (typeof cData === 'string') { try { cData = JSON.parse(cData); } catch (e) { cData = {}; } }
          if (cData && cData.rules && Array.isArray(cData.rules)) {
            for (var ri = 0; ri < cData.rules.length; ri++) {
              var r = cData.rules[ri];
              rulesetGuardrails.push({
                value: (r.id || r.name || 'rule') + ': ' + (r.description || r.text || ''),
                source: 'ruleset:' + c.name,
                locked: true
              });
            }
          }
        }
      } catch (e) { /* no concepts */ }
    }

    // Profile-level custom responsibilities and guardrails
    var profileData = (profile && profile.profile_data) || {};
    var customResponsibilities = (profileData.responsibilities || []).map(function (v) {
      return { value: v, source: 'custom', locked: false };
    });
    var customGuardrails = (profileData.guardrails || []).map(function (v) {
      return { value: v, source: 'custom', locked: false };
    });

    // Build projects list
    var projects = [];
    if (agentProject) {
      var proj = getProject(agentProject);
      if (proj) projects.push({ id: proj.id, name: proj.name });
    }
    // Also include team projects
    for (var tpi = 0; tpi < teams.length; tpi++) {
      try {
        var tp = getTeamProjects(teams[tpi].id);
        for (var tpj = 0; tpj < tp.length; tpj++) {
          if (!projects.some(function (p) { return p.id === tp[tpj].id; })) {
            projects.push({ id: tp[tpj].id, name: tp[tpj].name });
          }
        }
      } catch (e) { /* skip */ }
    }

    res.json({
      agent: {
        id: agent.id,
        name: agent.name,
        agent_type: agent.agent_type || 'agent',
        role: agent.role || 'agent',
        status: agent.status,
        avatar_url: agent.avatar_url || '',
        operator_id: agent.operator_id || '',
        llm_backend: agent.llm_backend || '',
        llm_model: agent.llm_model || '',
        runtime: agent.runtime || ''
      },
      capabilities: caps,
      forbidden_capabilities: (agent.agent_type === 'drone') ? DRONE_FORBIDDEN_CAPS : [],
      projects: projects,
      teams: teams.map(function (t) { return { id: t.id, name: t.name, role: t.role, is_primary: t.is_primary }; }),
      responsibilities: [].concat(teamResponsibilities, customResponsibilities),
      guardrails: [].concat(platformGuardrails, teamGuardrails, rulesetGuardrails, customGuardrails),
      profile_stats: profile ? {
        session_count: profile.session_count || 0,
        total_tasks_completed: profile.total_tasks_completed || 0,
        total_bugs_fixed: profile.total_bugs_fixed || 0,
        total_prs_created: profile.total_prs_created || 0,
        specializations: profile.specializations || [],
        first_seen_at: profile.first_seen_at || '',
        last_active_at: profile.last_active_at || ''
      } : null,
      calibration: {
        layers_applied: resolved.layers_applied,
        md_checkpoints: resolved.md_checkpoints || [],
        md_blocklist: resolved.md_blocklist || []
      }
    });
  }));

  router.put('/agents/:id/identity', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;

    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    var agentType = agent.agent_type || 'agent';
    var updated = {};

    // Update capabilities with validation
    if (req.body.capabilities !== undefined) {
      var newCaps = req.body.capabilities;
      if (!Array.isArray(newCaps)) return res.status(400).json({ error: 'capabilities must be an array' });
      // Validate against drone restrictions
      if (agentType === 'drone') {
        for (var i = 0; i < newCaps.length; i++) {
          if (DRONE_FORBIDDEN_CAPS.indexOf(newCaps[i]) !== -1) {
            return res.status(400).json({ error: 'Capability "' + newCaps[i] + '" is forbidden for drones' });
          }
        }
      }
      updateAgent(req.params.id, { capabilities: JSON.stringify(newCaps) });
      updated.capabilities = newCaps;
    }

    // Update responsibilities and guardrails in profile_data
    if (req.body.responsibilities !== undefined || req.body.guardrails !== undefined) {
      var profile = getAgentProfile(req.params.id);
      if (!profile) {
        try { ensureAgentProfile(req.params.id); profile = getAgentProfile(req.params.id); } catch (e) {
          return res.status(404).json({ error: 'Could not create agent profile' });
        }
      }
      var pd = profile.profile_data || {};
      if (req.body.responsibilities !== undefined) {
        if (!Array.isArray(req.body.responsibilities)) return res.status(400).json({ error: 'responsibilities must be an array' });
        pd.responsibilities = req.body.responsibilities;
        updated.responsibilities = req.body.responsibilities;
      }
      if (req.body.guardrails !== undefined) {
        if (!Array.isArray(req.body.guardrails)) return res.status(400).json({ error: 'guardrails must be an array' });
        pd.guardrails = req.body.guardrails;
        updated.guardrails = req.body.guardrails;
      }
      updateAgentProfile(req.params.id, { profile_data: pd });
    }

    res.json({ ok: true, updated: updated });
  }));

  // Self-service rekey — agent calls this with their current key to rotate to a new one.
  // Useful when an agent suspects their key was leaked or wants to rotate proactively.
  // Does not require admin key — the existing valid key is proof of identity.
  router.post('/agents/rekey', asyncHandler(function (req, res) {
    var agentId = checkAgent(req, res);
    if (!agentId) return;
    var newKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
    var newHash = crypto.createHash('sha256').update(newKey).digest('hex');
    updateAgentKey(agentId, newHash);
    invalidateAgentKeyCache(agentId);
    emitEvent('agent_key_rotated', agentId, null, agentId + ' rotated their API key');
    res.json({ id: agentId, api_key: newKey, message: 'Key rotated — update your config with this new key' });
  }));

  // Get MCP config for an agent (admin only — key not included, just the structure)
  router.get('/agents/:id/mcp-config', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    var instanceUrl;
    try {
      instanceUrl = getInstanceUrl(req);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid Host header: ' + e.message });
    }
    var config = buildMcpConfig(req.params.id, '<YOUR_AGENT_API_KEY>', instanceUrl);
    res.json({ agent_id: req.params.id, mcp_config: config, note: 'Replace <YOUR_AGENT_API_KEY> with the agent\'s actual API key' });
  }));

  // Admin create savepoint with notes (for handoffs)
  router.post('/agents/:id/savepoint', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    createSavepoint(req.params.id, {
      working_on: agent.working_on || '',
      notes: req.body.notes || null
    });
    var sp = getLatestSavepoint(req.params.id);
    res.json({ ok: true, savepoint_id: sp.id });
  }));

  // ======== WORK ROUTING ========

  router.post('/work/request', asyncHandler(function (req, res) {
    var who = checkAgent(req, res);
    if (!who) return;

    // Check if Claude Admin is frozen
    var adminStatus = getInstanceConfig('admin_status');
    if (adminStatus === 'frozen') {
      return res.status(503).json({ error: 'Claude Admin is frozen. Work routing paused. Contact a human operator.' });
    }

    var { type, target, description, priority } = req.body;
    if (!type) return res.status(400).json({ error: 'type required (task_request, asset_request, work_request)' });

    // Create as a work_request message to Claude Admin
    var adminAgentId = getInstanceConfig('admin_agent_id') || 'greatness-claude';
    var msgId = createRequest(who, adminAgentId, null, null,
      JSON.stringify({ type: type, target: target || null, description: description || '', priority: priority || 'normal' }),
      JSON.stringify({ work_request: true, type: type })
    );

    emitEvent('work_request', who, null, who + ' requested work: ' + type + (target ? ' \u2192 ' + target : ''));
    res.json({ ok: true, message_id: msgId, routed_to: adminAgentId });
  }));

  // ======== AGENT TEMPLATES ========

  // GET /agent-templates — list all
  router.get('/agent-templates', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listAgentTemplates());
  }));

  // GET /agent-templates/:id — get one
  router.get('/agent-templates/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    res.json(t);
  }));

  // POST /agent-templates — create (admin only)
  router.post('/agent-templates', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = req.body.id;
    var name = req.body.name;
    if (!id || !name) return apiError(res, 400, 'id and name are required');
    if (getAgentTemplate(id)) return apiError(res, 409, 'Template ' + id + ' already exists');
    var template = createAgentTemplate(id, name, req.body.description || '', req.body, getAdminDisplayName(req));
    res.status(201).json(template);
  }));

  // PUT /agent-templates/:id — update (admin only)
  router.put('/agent-templates/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    var updated = updateAgentTemplate(req.params.id, req.body);
    res.json(updated);
  }));

  // DELETE /agent-templates/:id — delete (admin only)
  router.delete('/agent-templates/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    deleteAgentTemplate(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  }));

  // POST /agent-templates/:id/apply/:agentId — apply template to existing agent (admin only)
  router.post('/agent-templates/:id/apply/:agentId', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    var agent = getAgent(req.params.agentId);
    if (!agent) return apiError(res, 404, 'Agent not found');
    // Apply template fields to agent
    var agentUpdate = {};
    if (t.runtime) agentUpdate.runtime = t.runtime;
    if (t.llm_backend) agentUpdate.llm_backend = t.llm_backend;
    if (t.llm_model) agentUpdate.llm_model = t.llm_model;
    if (t.agent_type) agentUpdate.agent_type = t.agent_type;
    if (t.capabilities && t.capabilities.length > 0) agentUpdate.capabilities = JSON.stringify(t.capabilities);
    if (Object.keys(agentUpdate).length > 0) updateAgent(req.params.agentId, agentUpdate);
    // Auto-add to template teams
    if (t.team_ids && t.team_ids.length > 0) {
      for (var teamId of t.team_ids) {
        try { addTeamMember(teamId, req.params.agentId, 'agent', 'member', false); } catch (_) {}
      }
    }
    res.json({ ok: true, agent: getAgent(req.params.agentId), template: t.id });
  }));
}
