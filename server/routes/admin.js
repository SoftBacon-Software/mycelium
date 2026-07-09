// Admin routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import nodePath from 'path';
import {
  addChannelMember, addTeamMember, archiveOldEvents, archiveOldMessages, createAgent, createMessage, createSavepoint, deleteAgent, getActiveStudioUsers, getAdminOps, getAgent, getAgentTemplate, getAvailableOperators, getChannelBySlug, getContextKey, getDB, getInstanceConfig, getOperator, getOverview, getSleepMode, getSlimOverview, isNetworkAutonomous, listAgents, listEvents, listInstanceConfig, listOperators, pruneSavepoints, pruneWebhookDeliveries, setInstanceConfig, setOperatorAvailability, updateAgent, updateAgentHeartbeat, updateAgentKey, upsertContextKey,
} from '../db.js';

export function registerAdminRoutes(router, deps) {
  const {
    AGENT_STATUSES, adminWriteLimiter, asyncHandler, buildMcpConfig, checkAdmin, checkAgentOrAdmin, clearAgentKeyCache, displayName, emitEvent, getAdminDisplayName, getInstanceUrl, getStudioUser, invalidateAgentKeyCache, runHealthPatrol, validateEnum,
  } = deps;

router.get('/admin/config', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listInstanceConfig());
}));

router.get('/admin/config/:key', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var val = getInstanceConfig(req.params.key);
  if (val === null) return res.status(404).json({ error: 'Config key not found' });
  res.json({ key: req.params.key, value: val });
}));

router.put('/admin/config/:key', adminWriteLimiter, asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  setInstanceConfig(req.params.key, typeof value === 'string' ? value : JSON.stringify(value), who);
  emitEvent('config_changed', who, null, 'Config ' + req.params.key + ' updated');
  res.json({ key: req.params.key, value: getInstanceConfig(req.params.key) });
}));

router.post('/admin/cleanup', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var messageDays = req.body.message_days || 90;
  var eventDays = req.body.event_days || 60;
  var messagesArchived = archiveOldMessages(messageDays);
  var eventsArchived = archiveOldEvents(eventDays);
  var webhooksArchived = pruneWebhookDeliveries(eventDays);
  var savepointsPruned = pruneSavepoints(eventDays);
  emitEvent('admin_cleanup', getAdminDisplayName(req), null,
    'Cleanup: ' + messagesArchived + ' messages, ' + eventsArchived + ' events, ' + webhooksArchived + ' webhook deliveries, ' + savepointsPruned + ' savepoints pruned');
  res.json({
    ok: true,
    messages_archived: messagesArchived,
    events_archived: eventsArchived,
    webhooks_archived: webhooksArchived,
    savepoints_pruned: savepointsPruned,
  });
}));

router.put('/admin/override', adminWriteLimiter, asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var action = req.body.action || 'freeze';
  if (action === 'freeze') {
    setInstanceConfig('admin_status', 'frozen', who);
    emitEvent('admin_frozen', who, null, who + ' froze Claude Admin');
    res.json({ ok: true, admin_status: 'frozen', message: 'Claude Admin frozen. All work assignments paused.' });
  } else if (action === 'unfreeze') {
    setInstanceConfig('admin_status', 'coordinator', who);
    emitEvent('admin_unfrozen', who, null, who + ' unfroze Claude Admin');
    res.json({ ok: true, admin_status: 'coordinator', message: 'Claude Admin unfrozen. Resuming operations.' });
  } else {
    res.status(400).json({ error: 'action must be freeze or unfreeze' });
  }
}));

router.put('/admin/sleep', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var action = req.body.action;
  if (action !== 'on' && action !== 'off') {
    return res.status(400).json({ error: 'action must be on or off' });
  }

  // Resolve operator_id — explicit body param, or auto-detect from JWT studio user
  function resolveOperatorId(bodyId) {
    if (bodyId) return bodyId;
    var studioUser = getStudioUser(req);
    if (!studioUser) return null;
    var allOps = listOperators();
    var linked = allOps.find(function(o) { return String(o.studio_user_id) === String(studioUser.userId); });
    return linked ? linked.id : null;
  }

  if (action === 'on') {
    var directive = req.body.directive || '';
    var priorities = req.body.priorities || [];
    var approvalPolicy = req.body.approval_policy || 'queue_high';
    var autoWakeAt = req.body.auto_wake_at || null;
    var sleptAt = new Date().toISOString();

    // Mark operator as sleeping and record their personal sleep start time
    var operatorId = resolveOperatorId(req.body.operator_id);
    if (operatorId) {
      var op = getOperator(operatorId);
      if (op) setOperatorAvailability(operatorId, 'sleeping', directive);
    }

    // Auto-detect inactive operators and mark them away.
    // If an operator hasn't been on the dashboard in 30 min, they're not at
    // the computer — don't let them block autonomous mode.
    var INACTIVE_THRESHOLD_MINUTES = 30;
    var allOpsForSleep = listOperators();
    var activeStudioUsers = getActiveStudioUsers(INACTIVE_THRESHOLD_MINUTES);
    var activeStudioUserIds = new Set(activeStudioUsers.map(function(u) { return u.id; }));
    var autoAwayOps = [];

    for (var otherOp of allOpsForSleep) {
      if (otherOp.id === operatorId) continue;
      if (otherOp.status !== 'active') continue;
      if (otherOp.availability !== 'available') continue;

      var isActive = otherOp.studio_user_id && activeStudioUserIds.has(otherOp.studio_user_id);
      if (!isActive) {
        setOperatorAvailability(otherOp.id, 'away', 'Auto-marked away — no dashboard activity at sleep mode activation');
        autoAwayOps.push(otherOp.id);
        emitEvent('operator_availability', '__system__', null,
          displayName(otherOp.id) + ' auto-marked away (no recent dashboard activity)');
      }
    }

    // Store auto-away list so we can restore them on wake
    if (autoAwayOps.length > 0) {
      setInstanceConfig('sleep_mode_auto_away', JSON.stringify(autoAwayOps), who);
    }

    // Track per-operator sleep start times so each gets a personal morning summary
    var sleepStarts = {};
    try {
      var existing = getInstanceConfig('sleep_mode_operator_starts');
      if (existing) sleepStarts = JSON.parse(existing);
    } catch (_) {}
    sleepStarts[operatorId || who] = sleptAt;
    setInstanceConfig('sleep_mode_operator_starts', JSON.stringify(sleepStarts), who);

    var config = {
      active: true,
      directive: directive,
      priorities: priorities,
      approval_policy: approvalPolicy,
      auto_wake_at: autoWakeAt,
      started_at: sleptAt,
      started_by: who
    };
    setInstanceConfig('sleep_mode', JSON.stringify(config), who);
    setInstanceConfig('sleep_mode_log', JSON.stringify({
      tasks_completed: [], steps_completed: [], approvals_queued: [],
      dispatches: [], errors: [], messages_sent: 0
    }), who);

    var autonomous = isNetworkAutonomous();
    // Directives deprecated (2026-06-05): the night/sleep "directive" text is
    // retained in sleep_mode config for the morning summary, but we no longer
    // broadcast per-agent directives to "keep agents awake" (the failed
    // experiment). Agents pull work from /work; the scheduler/poll is the nudge.

    emitEvent('sleep_mode_on', who, null, who + ' activated sleep mode' + (autonomous ? ' (network autonomous)' : ''));
    res.json({ ok: true, sleep_mode: config, autonomous: autonomous, auto_away_operators: autoAwayOps });

  } else {
    // action === 'off'
    // Any operator can end sleep mode — if they were sleeping, wake them; always end global sleep mode.
    var operatorId2 = resolveOperatorId(req.body.operator_id);
    var wasAlreadyAwake = false;
    if (operatorId2) {
      var op2 = getOperator(operatorId2);
      if (op2) {
        wasAlreadyAwake = op2.availability === 'available';
        setOperatorAvailability(operatorId2, 'available', '');
      }
    }

    // Get this operator's personal sleep start time for their summary
    var mySleptAt = null;
    try {
      var startsVal = getInstanceConfig('sleep_mode_operator_starts');
      if (startsVal) {
        var starts = JSON.parse(startsVal);
        mySleptAt = starts[operatorId2 || who] || null;
        // Clear this operator's entry
        delete starts[operatorId2 || who];
        setInstanceConfig('sleep_mode_operator_starts', JSON.stringify(starts), who);
      }
    } catch (_) {}

    // Build personal morning summary from the shared log
    var log = null;
    var logVal = getInstanceConfig('sleep_mode_log');
    try { log = logVal ? JSON.parse(logVal) : null; } catch (e) { log = null; }

    // Always end global sleep mode — any operator can kill it for everyone
    // Wake up any operators still marked as sleeping
    var allOps = listOperators ? listOperators() : [];
    for (var sleepingOp of allOps) {
      if (sleepingOp.availability === 'sleeping') {
        setOperatorAvailability(sleepingOp.id, 'available', '');
      }
    }

    // Restore operators that were auto-marked away during sleep activation
    var autoAwayVal = getInstanceConfig('sleep_mode_auto_away');
    if (autoAwayVal) {
      try {
        var autoAwayIds = JSON.parse(autoAwayVal);
        for (var awayId of autoAwayIds) {
          var awayOp = getOperator(awayId);
          // Only restore if still away — respect manual status changes during the night
          if (awayOp && awayOp.availability === 'away') {
            setOperatorAvailability(awayId, 'available', '');
            emitEvent('operator_availability', '__system__', null,
              displayName(awayId) + ' restored to available (sleep mode ended)');
          }
        }
      } catch (_) {}
    }

    setInstanceConfig('sleep_mode', JSON.stringify({ active: false }), who);
    setInstanceConfig('sleep_mode_operator_starts', '{}', who);
    setInstanceConfig('sleep_mode_auto_away', '[]', who);

    var wakeMsg = wasAlreadyAwake
      ? who + ' ended sleep mode (override)'
      : who + ' is back — sleep mode ended';
    emitEvent('sleep_mode_off', who, null, wakeMsg);

    var agents2 = listAgents();
    for (var agent2 of agents2) {
      if (agent2.status === 'online' || agent2.status === 'idle') {
        createMessage('__system__', agent2.id, null, null, 'Sleep mode ended. Human operators are available again.', '{}', 'info');
      }
    }

    // Send morning summary as inbox message to the waking operator so it shows up on next boot
    if (log && operatorId2) {
      // Filter log entries to only those that occurred during THIS sleep window
      var sleepStart = mySleptAt ? new Date(mySleptAt).getTime() : 0;
      var overnightTasks = (log.tasks_completed || []).filter(function(t) {
        return t.time && new Date(t.time).getTime() >= sleepStart;
      });
      var overnightSteps = (log.steps_completed || []).filter(function(s) {
        return s.time && new Date(s.time).getTime() >= sleepStart;
      });
      var overnightApprovals = (log.approvals_queued || []).filter(function(a) {
        return a.time && new Date(a.time).getTime() >= sleepStart;
      });

      // DB cross-check: get actual task completions as authoritative source
      var dbTasks = [];
      if (mySleptAt) {
        try {
          dbTasks = getDB().prepare(
            "SELECT id, title, assignee, updated_at FROM tasks WHERE status = 'done' AND updated_at >= ?"
          ).all(mySleptAt);
        } catch (e) { /* non-critical */ }
      }

      var summaryLines = ['Good morning! Here\'s what happened while you were away:'];
      // Use DB count if available (more reliable), fall back to log
      var taskCount = dbTasks.length > 0 ? dbTasks.length : overnightTasks.length;
      var taskList = dbTasks.length > 0 ? dbTasks : overnightTasks;
      if (taskCount > 0) {
        summaryLines.push('\nTasks completed (' + taskCount + '):');
        for (var t of taskList) summaryLines.push('  \u2713 ' + (t.title || t.id));
      }
      if (overnightSteps.length > 0) {
        summaryLines.push('\nPlan steps completed (' + overnightSteps.length + '):');
        for (var s of overnightSteps) summaryLines.push('  \u2713 ' + (s.title || s.id));
      }
      if (overnightApprovals.length > 0) {
        summaryLines.push('\nApprovals waiting (' + overnightApprovals.length + '):');
        for (var a of overnightApprovals) summaryLines.push('  ! ' + (a.title || a.id));
      }
      if (log.dispatches && log.dispatches.length > 0) summaryLines.push('\nAgent dispatches: ' + log.dispatches.length);
      if (log.messages_sent && log.messages_sent > 0) summaryLines.push('Messages sent: ' + log.messages_sent);
      if (summaryLines.length === 1) summaryLines.push('\nNothing to report — quiet night.');
      if (mySleptAt) summaryLines.push('\nSlept since: ' + mySleptAt);
      var wakeUpAgent = listAgents().find(function(a) { return a.operator_id === operatorId2; });
      if (wakeUpAgent) {
        createMessage('__system__', wakeUpAgent.id, null, null, summaryLines.join('\n'), '{}', 'info');
      }
    }

    res.json({
      ok: true,
      sleep_mode: { active: false },
      was_override: wasAlreadyAwake,
      slept_since: mySleptAt,
      morning_summary: log && operatorId2 ? {
        tasks_completed: overnightTasks || [],
        tasks_completed_db: dbTasks || [],
        steps_completed: overnightSteps || [],
        approvals_queued: overnightApprovals || [],
        dispatches: log.dispatches || [],
        messages_sent: log.messages_sent || 0
      } : log
    });
  }
}));

router.get('/admin/sleep', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var config = getSleepMode();
  var log = null;
  var logVal = getInstanceConfig('sleep_mode_log');
  try { log = logVal ? JSON.parse(logVal) : null; } catch (e) {}
  res.json({
    sleep_mode: config,
    autonomous: isNetworkAutonomous(),
    available_operators: getAvailableOperators().length,
    log: log
  });
}));

router.post('/admin/agents', adminWriteLimiter, asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var id = req.body.id;
  var name = req.body.name;
  var projectId = req.body.project_id;
  if (!id || !name || !projectId) return res.status(400).json({ error: 'id, name, and project_id are required' });
  // Check if exists
  if (getAgent(id)) return res.status(409).json({ error: 'Agent ' + id + ' already exists' });
  // Generate API key — store as SHA-256 (high-entropy key, bcrypt adds no security)
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  // Resolve template defaults if provided
  var tmpl = null;
  if (req.body.template_id) {
    tmpl = getAgentTemplate(req.body.template_id);
    if (!tmpl) return res.status(400).json({ error: 'Template ' + req.body.template_id + ' not found' });
  }
  var capabilities = req.body.capabilities ? JSON.stringify(req.body.capabilities) : (tmpl && tmpl.capabilities ? JSON.stringify(tmpl.capabilities) : '["code","assets"]');
  createAgent(id, name, projectId, hash, capabilities);
  // Set optional LLM metadata (explicit body fields override template)
  var llmBackend = req.body.llm_backend || (tmpl && tmpl.llm_backend) || '';
  var llmModel = req.body.llm_model || (tmpl && tmpl.llm_model) || '';
  var agentType = req.body.agent_type || (tmpl && tmpl.agent_type) || 'agent';
  var runtime = req.body.runtime || (tmpl && tmpl.runtime) || '';
  if (llmBackend || llmModel || agentType !== 'agent' || runtime) {
    updateAgent(id, { llm_backend: llmBackend, llm_model: llmModel, agent_type: agentType, runtime: runtime });
  }
  // Auto-add to template teams
  if (tmpl && tmpl.team_ids && tmpl.team_ids.length > 0) {
    for (var tid of tmpl.team_ids) {
      try { addTeamMember(tid, id, 'agent', 'member', false); } catch (_) {}
    }
  }
  // Auto-add new agent to #general
  var generalChannel = getChannelBySlug('general');
  if (generalChannel) {
    addChannelMember(generalChannel.id, id, 'agent', 'member');
  }
  emitEvent('agent_registered', '__admin__', null, 'Admin registered agent: ' + id);
  var instanceUrl;
  try {
    instanceUrl = getInstanceUrl(req);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid Host header: ' + e.message });
  }
  var mcpConfig = buildMcpConfig(id, apiKey, instanceUrl);
  res.json({ id: id, api_key: apiKey, mcp_config: mcpConfig, message: 'Store this key — it will not be shown again. MCP config included for agent setup.' });
}));

router.delete('/admin/agents/:id', adminWriteLimiter, asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  deleteAgent(req.params.id);
  clearAgentKeyCache();
  emitEvent('agent_removed', '__admin__', null, 'Admin removed agent: ' + req.params.id);
  res.json({ ok: true, deleted: req.params.id });
}));

router.put('/admin/agents/:id/key', adminWriteLimiter, asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  updateAgentKey(req.params.id, hash);
  invalidateAgentKeyCache(req.params.id);
  emitEvent('agent_key_regenerated', '__admin__', null, 'Admin regenerated key for: ' + req.params.id);
  res.json({ id: req.params.id, api_key: apiKey, message: 'Store this key — it will not be shown again' });
}));

router.put('/admin/agents/:id/heartbeat', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!validateEnum(res, req.body.status, AGENT_STATUSES, 'status')) return;
  var status = req.body.status || 'online';
  var workingOn = req.body.working_on || '';
  var prevStatus = agent.status;
  var prevWorkingOn = agent.working_on || '';
  updateAgentHeartbeat(req.params.id, status, workingOn);
  // Differentiate event summaries
  var summary;
  if (prevStatus !== status && status === 'online') {
    summary = req.params.id + ' came online' + (workingOn ? ': ' + workingOn : '');
  } else if (prevStatus !== status && status === 'offline') {
    summary = req.params.id + ' went offline';
  } else if (workingOn && workingOn !== prevWorkingOn) {
    summary = req.params.id + ': ' + workingOn;
  } else {
    summary = req.params.id + ' is ' + status + (workingOn ? ': ' + workingOn : '');
  }
  emitEvent('agent_heartbeat', req.params.id, null, summary);

  // Also create savepoint from admin heartbeat
  createSavepoint(req.params.id, {
    working_on: workingOn
  });
  pruneSavepoints(req.params.id, 100);

  res.json({ ok: true, agent: req.params.id, status: status });
}));

router.get('/admin/overview', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  if (req.query.verbose === 'true') {
    var who = getAdminDisplayName(req);
    return res.json(getOverview(who));
  }
  res.json(getSlimOverview());
}));

router.get('/admin/ops', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(getAdminOps());
}));

router.get('/admin/api-limits', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;

  // Check cache first
  try {
    var cached = getContextKey('admin', 'api_limits');
    if (cached && cached.data) {
      var raw = typeof cached.data === 'string' ? JSON.parse(cached.data) : cached.data;
      var age = Date.now() - new Date(raw.checked_at || 0).getTime();
      if (age < 5 * 60 * 1000) {
        return res.json({ cached: true, data: raw });
      }
    }
  } catch (_) {}

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  }

  try {
    var payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    });

    var result = await new Promise(function (resolve, reject) {
      var reqOpts = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
        }
      };
      var r = https.request(reqOpts, function (resp) {
        var body = '';
        resp.on('data', function (d) { body += d; });
        resp.on('end', function () { resolve({ headers: resp.headers, status: resp.statusCode, body }); });
      });
      r.on('error', reject);
      r.setTimeout(8000, function () { r.destroy(new Error('timeout')); });
      r.write(payload);
      r.end();
    });

    var h = result.headers;
    function hnum(name) { var v = h[name]; return v != null ? parseInt(v, 10) : null; }
    function hstr(name) { return h[name] || null; }

    var tokensLimit = hnum('anthropic-ratelimit-tokens-limit');
    var tokensRemaining = hnum('anthropic-ratelimit-tokens-remaining');
    var inputLimit = hnum('anthropic-ratelimit-input-tokens-limit');
    var inputRemaining = hnum('anthropic-ratelimit-input-tokens-remaining');
    var outputLimit = hnum('anthropic-ratelimit-output-tokens-limit');
    var outputRemaining = hnum('anthropic-ratelimit-output-tokens-remaining');
    var requestsLimit = hnum('anthropic-ratelimit-requests-limit');
    var requestsRemaining = hnum('anthropic-ratelimit-requests-remaining');

    var tokenPct = tokensLimit ? Math.round((tokensRemaining / tokensLimit) * 100) : null;
    var inputPct = inputLimit ? Math.round((inputRemaining / inputLimit) * 100) : null;
    var requestPct = requestsLimit ? Math.round((requestsRemaining / requestsLimit) * 100) : null;
    var primaryPct = tokenPct !== null ? tokenPct : inputPct;
    var threshold = 20;

    var data = {
      requests_limit: requestsLimit,
      requests_remaining: requestsRemaining,
      requests_reset: hstr('anthropic-ratelimit-requests-reset'),
      tokens_limit: tokensLimit,
      tokens_remaining: tokensRemaining,
      tokens_reset: hstr('anthropic-ratelimit-tokens-reset'),
      input_tokens_limit: inputLimit,
      input_tokens_remaining: inputRemaining,
      input_tokens_reset: hstr('anthropic-ratelimit-input-tokens-reset'),
      output_tokens_limit: outputLimit,
      output_tokens_remaining: outputRemaining,
      output_tokens_reset: hstr('anthropic-ratelimit-output-tokens-reset'),
      token_pct: tokenPct,
      input_token_pct: inputPct,
      request_pct: requestPct,
      primary_pct: primaryPct,
      below_threshold: primaryPct !== null && primaryPct < threshold,
      threshold,
      drone_mode_recommended: primaryPct !== null && primaryPct < threshold,
      checked_at: new Date().toISOString(),
      http_status: result.status,
      model_probed: 'claude-haiku-4-5-20251001',
    };

    // Cache in context
    try { upsertContextKey('admin', 'api_limits', JSON.stringify(data), 'system'); } catch (_) {}

    res.json({ cached: false, data });
  } catch (err) {
    console.error('[mycelium] API limits error:', err.message);
    res.status(500).json({ error: 'Failed to check API limits' });
  }
}));

router.get('/admin/api-usage', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;

  // Check cache (15 min TTL)
  try {
    var cached = getContextKey('admin', 'api_usage');
    if (cached && cached.data) {
      var raw = typeof cached.data === 'string' ? JSON.parse(cached.data) : cached.data;
      var age = Date.now() - new Date(raw.checked_at || 0).getTime();
      if (age < 15 * 60 * 1000) {
        return res.json({ cached: true, data: raw });
      }
    }
  } catch (_) {}

  var adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: 'ANTHROPIC_ADMIN_KEY not set on server' });
  }

  var days = parseInt(req.query.days) || 7;
  if (days > 31) days = 31;
  var now = new Date();
  var endAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  var startAt = new Date(endAt.getTime() - days * 24 * 60 * 60 * 1000);

  function apiGet(path) {
    return new Promise(function (resolve, reject) {
      var r = https.request({
        hostname: 'api.anthropic.com',
        path: path,
        method: 'GET',
        headers: {
          'x-api-key': adminKey,
          'anthropic-version': '2023-06-01',
        }
      }, function (resp) {
        var body = '';
        resp.on('data', function (d) { body += d; });
        resp.on('end', function () {
          if (resp.statusCode >= 400) {
            reject(new Error('Anthropic API ' + resp.statusCode + ': ' + body.slice(0, 200)));
          } else {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          }
        });
      });
      r.on('error', reject);
      r.setTimeout(15000, function () { r.destroy(new Error('timeout')); });
      r.end();
    });
  }

  try {
    var startStr = startAt.toISOString().replace(/\.\d+Z$/, 'Z');
    var endStr = endAt.toISOString().replace(/\.\d+Z$/, 'Z');

    var [usageData, costData] = await Promise.all([
      apiGet('/v1/organizations/usage_report/messages?starting_at=' + startStr + '&ending_at=' + endStr + '&group_by[]=model&bucket_width=1d'),
      apiGet('/v1/organizations/cost_report?starting_at=' + startStr + '&ending_at=' + endStr + '&bucket_width=1d'),
    ]);

    // Aggregate usage by model
    var modelTotals = {};
    var dailyTokens = [];
    for (var bucket of (usageData.data || [])) {
      var dayTotal = { date: bucket.starting_at, input: 0, output: 0, cached_read: 0, cached_create: 0 };
      for (var r of (bucket.results || [])) {
        var model = r.model || 'unknown';
        if (!modelTotals[model]) modelTotals[model] = { input: 0, output: 0, cached_read: 0, cached_create: 0 };
        var inp = r.uncached_input_tokens || 0;
        var out = r.output_tokens || 0;
        var cacheRead = r.cache_read_input_tokens || 0;
        var cacheCreate = 0;
        if (r.cache_creation) {
          cacheCreate = (r.cache_creation.ephemeral_5m_input_tokens || 0) + (r.cache_creation.ephemeral_1h_input_tokens || 0);
        }
        modelTotals[model].input += inp;
        modelTotals[model].output += out;
        modelTotals[model].cached_read += cacheRead;
        modelTotals[model].cached_create += cacheCreate;
        dayTotal.input += inp;
        dayTotal.output += out;
        dayTotal.cached_read += cacheRead;
        dayTotal.cached_create += cacheCreate;
      }
      dailyTokens.push(dayTotal);
    }

    // Aggregate cost by day
    var totalCost = 0;
    var dailyCost = [];
    for (var cb of (costData.data || [])) {
      var dayCost = 0;
      for (var cr of (cb.results || [])) {
        dayCost += parseFloat(cr.amount || 0);
      }
      totalCost += dayCost;
      dailyCost.push({ date: cb.starting_at, cost_usd: Math.round(dayCost * 100) / 100 });
    }

    var data = {
      period_days: days,
      start: startStr,
      end: endStr,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      daily_cost: dailyCost,
      by_model: modelTotals,
      daily_tokens: dailyTokens,
      checked_at: new Date().toISOString(),
    };

    try { upsertContextKey('admin', 'api_usage', JSON.stringify(data), 'system'); } catch (_) {}
    res.json({ cached: false, data });
  } catch (err) {
    console.error('[mycelium] API usage error:', err.message);
    res.status(500).json({ error: 'Failed to fetch API usage' });
  }
}));

router.get('/admin/backups', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var routeDir = nodePath.dirname(new URL(import.meta.url).pathname);
  var dataDir = process.env.DATA_DIR || nodePath.join(routeDir, '..', 'data');
  var backupDir = nodePath.join(dataDir, 'backups');
  try {
    if (!fs.existsSync(backupDir)) return res.json({ backups: [] });
    var files = fs.readdirSync(backupDir)
      .filter(function (f) { return f.startsWith('mycelium_') && f.endsWith('.db'); })
      .sort()
      .reverse()
      .map(function (f) {
        var stat = fs.statSync(nodePath.join(backupDir, f));
        return { name: f, size_mb: Math.round(stat.size / 1024 / 1024 * 10) / 10, created: stat.mtime.toISOString() };
      });
    res.json({ backups: files, count: files.length });
  } catch (e) {
    console.error('[mycelium] backup list error:', e.message);
    res.status(500).json({ error: 'Failed to list backups' });
  }
}));

router.get('/admin/health', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  try {
    res.json(runHealthPatrol());
  } catch (e) {
    return res.status(500).json({ error: 'Health patrol failed: ' + e.message });
  }
}));

router.get('/admin/health/history', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var limit = parseInt(req.query.limit) || 50;
  var events = listEvents({ type: 'health_patrol', limit: limit });
  res.json(events);
}));
}
