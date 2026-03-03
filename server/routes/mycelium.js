// =============== MYCELIUM — Distributed Development Platform API ===============
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// bcryptjs (pure JS) is very slow at high rounds on Railway containers.
// API keys are 48 random hex chars (192-bit entropy) — 4 rounds is fine.
// Passwords stay at 10 rounds for dictionary attack resistance.
var BCRYPT_ROUNDS_KEY = 4;
var BCRYPT_ROUNDS_PASSWORD = 10;
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fs from 'fs';
import nodePath from 'path';

var DATA_DIR = process.env.DATA_DIR || nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'data');
var FILES_DIR = nodePath.join(DATA_DIR, 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

var storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, FILES_DIR); },
  filename: function (req, file, cb) {
    var ext = nodePath.extname(file.originalname) || '';
    var base = nodePath.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    var name = base + '_' + Date.now() + ext;
    cb(null, name);
  }
});
var upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Drone artifacts directory — persistent files (LoRA weights, models, etc.) that don't expire
var ARTIFACTS_DIR = nodePath.join(DATA_DIR, 'drone_artifacts');
if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
var artifactStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, ARTIFACTS_DIR); },
  filename: function (req, file, cb) {
    // Use the provided name or fall back to original filename
    var name = req.body.name || file.originalname;
    name = name.replace(/[^a-zA-Z0-9_.\-]/g, '_');
    cb(null, name);
  }
});
var artifactUpload = multer({ storage: artifactStorage, limits: { fileSize: 500 * 1024 * 1024 } });
import {
  createAgent, getAgent, listAgents, updateAgentHeartbeat, updateAgentKey, deleteAgent, updateAgent,
  createOrg, listOrgs, getOrg, updateOrg,
  createProject, listProjects, getProject, updateProject,
  createDvTask, getDvTask, listDvTasks, updateDvTask,
  setTaskDependency, resolveTaskDependencies,
  approveDvTask, listTasksNeedingApproval,
  getDvContext, getAllDvContext, upsertDvContext,
  upsertDvContextKey, getDvContextKey, listDvContextKeys, deleteDvContextKey,
  createDvAsset, getDvAsset, listDvAssets, updateDvAsset, deleteDvAsset,
  autoTaskFromAsset,
  createDvEvent, listDvEvents,
  createDvMessage, createDvRequest, getDvMessage,
  acknowledgeDvMessage, resolveDvMessage, listPendingRequests,
  listDvMessages, listDvThreads, bulkDeleteMessages,
  getBootPayload, getDvOverview,
  createDvBug, getDvBug, listDvBugs, updateDvBug, deleteDvBug, countDvBugs,
  createDvPlan, getDvPlan, listDvPlans, updateDvPlan, deleteDvPlan,
  createDvPlanStep, updateDvPlanStep, deleteDvPlanStep, reorderDvPlanSteps,
  completeLinkedPlanSteps,
  createStudioUser, getStudioUserByUsername, getStudioUserById,
  listStudioUsers, deleteStudioUser, updateStudioUser,
  createConcept, getConcept, listConcepts, updateConcept, deleteConcept,
  linkConceptToProject, unlinkConceptFromProject, getProjectConcepts, getConceptProjects,
  createDvWebhook, listDvWebhooks, deleteDvWebhook, dispatchWebhook,
  listWebhookDeliveries, pruneWebhookDeliveries,
  getAdminOps, resolveStaleRequests,
  createDvTeamChat, listDvTeamChat,
  createDroneJob, getDroneJob, claimDroneJob, updateDroneJob, listDroneJobs, listDrones, listAssetsByDroneJob, bulkCancelDroneJobs,
  addTaskComment, getTaskComments, deleteTaskComment,
  GATED_ACTIONS, createApproval, getApproval, listApprovals, decideApproval,
  markApprovalExecuted, countPendingApprovals, listPendingApprovalsByAgent,
  castApprovalVote, getApprovalVotes, countApprovalVotes,
  createOperator, getOperator, listOperators, updateOperator, deleteOperator,
  setOperatorAvailability, getAvailableOperators, isNetworkAutonomous,
  getInstanceConfig, setInstanceConfig, listInstanceConfig, deleteInstanceConfig,
  getSleepMode, appendSleepLog,
  createChannel, getChannel, getChannelBySlug, getChannelByLink,
  listChannels, updateChannel, deleteChannel,
  addChannelMember, removeChannelMember, listChannelMembers,
  isChannelMember, getChannelsByUser,
  markChannelRead, getUnreadCounts, getLatestChannelMessageId,
  listChannelMessages, createChannelMessage,
  listGeneralChannelMessages, listTeamChatChannelMessages,
  autoCreateEntityChannel, getOrCreateDmChannel,
  createSavepoint, getLatestSavepoint, getSavepointHistory,
  updateSavepointNotes, computeSavepointDiff, pruneSavepoints,
  listPluginRecords, getPluginRecord, updatePluginEnabled, getDB,
  getIdleAgents, getNextUnassignedTask, getNextUnassignedPlanStep,
  createFeedback, getFeedback, listFeedback, deleteFeedback, getFeedbackSummary,
  countPendingForAgent
} from '../db.js';
import { loadPlugins, getPluginMcpTools } from '../plugins.js';
import { broadcast, addClient, clientCount } from '../eventBus.js';

var ADMIN_KEY = process.env.ADMIN_KEY;
var JWT_SECRET = process.env.JWT_SECRET;
var STUDIO_JWT_EXPIRY = '7d';

// Wrap async route handlers so rejected promises forward to Express error handler.
// Express 4 does not catch async rejections automatically.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Parse an integer route/query parameter safely.
// Returns null (not NaN) when the value is missing or non-numeric,
// preventing NaN from propagating into DB prepared statements.
function parseIntParam(val) {
  var n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

// Standard error response helper.
// All error responses MUST use this format: { error: "message" }
// Extra fields (e.g. approval_required, existing_id) may be added via the `extra` param.
// Usage: return apiError(res, 404, 'Task not found');
//        return apiError(res, 403, 'Approval required', { approval_required: true });
function apiError(res, status, message, extra) {
  return res.status(status).json(Object.assign({ error: message }, extra || {}));
}

// Validate an enum field. Returns true if valid, sends 400 via apiError and returns false if not.
// Exposed via core.validateEnum so plugins share this implementation.
function validateEnum(res, value, allowed, fieldName) {
  if (value !== undefined && allowed.indexOf(value) === -1) {
    apiError(res, 400, fieldName + ' must be one of: ' + allowed.join(', '));
    return false;
  }
  return true;
}

// Parse and cap a pagination limit query parameter.
// Default is 50, maximum is MAX_PAGE_LIMIT (500). Prevents runaway queries.
var MAX_PAGE_LIMIT = 500;
function parseLimit(val, def) {
  var n = parseInt(val, 10);
  return Math.min(isNaN(n) || n < 1 ? (def || 50) : n, MAX_PAGE_LIMIT);
}

var AGENT_STATUSES = ['online', 'offline', 'idle', 'busy'];
var TASK_STATUSES = ['open', 'in_progress', 'review', 'done', 'cancelled'];
var TASK_PRIORITIES = ['low', 'normal', 'high'];
var ASSET_STATUSES = ['requested', 'in_progress', 'ready', 'delivered', 'cancelled'];
var PLAN_STATUSES = ['draft', 'active', 'completed', 'cancelled'];
var PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'];
var BUG_STATUSES = ['open', 'in_progress', 'fixed', 'closed'];
var BUG_SEVERITIES = ['low', 'normal', 'high', 'critical'];
var BUG_CATEGORIES = ['gameplay', 'ui', 'crash', 'api', 'infrastructure', 'balance', 'other'];
var CHANNEL_STATUSES = ['active', 'archived'];
var DRONE_JOB_STATUSES = ['done', 'completed', 'failed', 'cancelled'];

// Sanitize input: ensure string type, trim, handle null/undefined.
// HTML entity escaping — defense in depth. Dashboard uses textContent (XSS-safe),
// but API serves data to any client. Escape on write to protect all consumers.
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Mycelium: project_id normalization (backward compat) ----
// DB column is project_id. Accept "project_id", "project", or "game" from clients.
// Normalizes to project_id in req.body and req.query.

function normalizeProjectField(req, res, next) {
  // Body: accept project_id, project, or game — normalize to project_id
  if (req.body) {
    if (req.body.project_id === undefined) {
      if (req.body.project !== undefined) req.body.project_id = req.body.project;
      else if (req.body.game !== undefined) req.body.project_id = req.body.game;
    }
  }
  // Query: accept project_id, project, or game — normalize to project_id
  if (req.query) {
    if (req.query.project_id === undefined) {
      if (req.query.project !== undefined) req.query.project_id = req.query.project;
      else if (req.query.game !== undefined) req.query.project_id = req.query.game;
    }
  }
  next();
}

// ---- Auth middleware ----

// Decode studio JWT from Authorization: Bearer <token>
function getStudioUser(req) {
  var auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    var decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (decoded && decoded.studioUser) return decoded;
    return null;
  } catch (e) { return null; }
}

// Agent key cache: sha256(key) -> agentId. Avoids bcrypt on every request.
var agentKeyCache = new Map();

function clearAgentKeyCache() {
  agentKeyCache.clear();
}

// Check if the authenticated caller has access to a resource's project.
// Admins and studio users bypass. Agents must match project_id.
function checkProjectScope(req, res, resourceProjectId) {
  if (req._authIsAdmin) return true;
  if (!req._authAgentId) return true; // studio user or admin — no scope restriction
  if (!resourceProjectId) return true; // resource has no project — allow
  if (req._authProjectId === resourceProjectId) return true;
  res.status(403).json({ error: 'Agent ' + req._authAgentId + ' cannot access resources in project ' + resourceProjectId });
  return false;
}

// Agent auth: validates X-Agent-Key header, sets req._authAgentId and req._authProjectId
function checkAgent(req, res) {
  var key = req.headers['x-agent-key'];
  if (!key) {
    res.status(401).json({ error: 'Missing X-Agent-Key header' });
    return null;
  }
  // Fast path: check SHA-256 cache first
  var keyHash = crypto.createHash('sha256').update(key).digest('hex');
  if (agentKeyCache.has(keyHash)) {
    var cached = agentKeyCache.get(keyHash);
    var agentId = typeof cached === 'object' ? cached.id : cached;
    var projectId = typeof cached === 'object' ? cached.project_id : null;
    req._authAgentId = agentId;
    req._authProjectId = projectId;
    return agentId;
  }
  // Slow path: bcrypt comparison (first request per key only)
  var agents = listAgents();
  for (var a of agents) {
    var full = getAgent(a.id);
    if (full && bcrypt.compareSync(key, full.api_key_hash)) {
      agentKeyCache.set(keyHash, { id: a.id, project_id: full.project_id || null });
      req._authAgentId = a.id;
      req._authProjectId = full.project_id || null;
      return a.id;
    }
  }
  res.status(403).json({ error: 'Invalid agent key' });
  return null;
}

// Admin auth: validates X-Admin-Key, studio JWT, or legacy admin key
function checkAdmin(req, res) {
  // Try studio JWT first
  var user = getStudioUser(req);
  if (user) { req._authIsAdmin = true; return true; }
  // Try admin key
  var key = req.headers['x-admin-key'];
  if (key === ADMIN_KEY) { req._authIsAdmin = true; return true; }
  res.status(403).json({ error: 'Invalid admin key' });
  return false;
}

// Get display name for admin user (studio JWT display_name, or fallback)
// X-Acting-As header lets admin key holders identify themselves (e.g. greatness-claude via MCP)
function getAdminDisplayName(req) {
  var user = getStudioUser(req);
  if (user) return user.displayName || user.username;
  var actingAs = req.headers['x-acting-as'];
  if (actingAs) return actingAs;
  return '__system__';
}

// Friendly display name for event summaries
function displayName(id) {
  if (id === '__system__') return 'System';
  if (id === '__admin__') return 'Admin';
  if (id && id.startsWith('__user:')) return id.slice(7);
  return id;
}

// Either agent or admin — returns display name / agent ID
function checkAgentOrAdmin(req, res) {
  // Try studio JWT first
  var user = getStudioUser(req);
  if (user) { req._authIsAdmin = true; return user.displayName || user.username; }
  // Try admin key
  var adminKey = req.headers['x-admin-key'];
  if (adminKey === ADMIN_KEY) {
    req._authIsAdmin = true;
    var actingAs = req.headers['x-acting-as'];
    return actingAs || '__system__';
  }
  // Try agent key
  return checkAgent(req, res);
}

// ---- SSE clients registry ----
// Each entry: { res, filters: { project_id, type, agent } }
var sseClients = new Set();

// ---- Event helper ----

function emitEvent(type, agentId, projectId, summary, data) {
  var id = createDvEvent(type, agentId || '', projectId || null, summary || '', JSON.stringify(data || {}));
  // Broadcast to connected SSE clients (with per-client filtering)
  if (sseClients.size > 0) {
    var payload = 'data: ' + JSON.stringify({
      id: id, type: type, agent: agentId || '',
      project_id: projectId || null, summary: summary || '',
      data: JSON.stringify(data || {}),
      created_at: new Date().toISOString()
    }) + '\n\n';
    sseClients.forEach(function (client) {
      var f = client.filters;
      if (f.project_id && f.project_id !== projectId) return;
      if (f.type && f.type !== type) return;
      if (f.agent && f.agent !== agentId) return;
      try {
        client.res.write(payload);
        if (client.res.flush) client.res.flush();
      } catch (e) { sseClients.delete(client); }
    });
  }
}

// ---- SSE Event Stream ----
router.get('/events/stream', function (req, res) {
  // Auth: accept JWT token, admin key, or agent key
  var token = req.query.token;
  if (token) {
    try { jwt.verify(token, JWT_SECRET); } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else if (req.query.agent_key) {
    // Verify agent key
    var agents = listAgents();
    var valid = false;
    for (var a of agents) {
      if (a.api_key_hash && bcrypt.compareSync(req.query.agent_key, a.api_key_hash)) {
        valid = true;
        break;
      }
    }
    if (!valid) return res.status(401).json({ error: 'Invalid agent key' });
  } else {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: ' + JSON.stringify({ type: 'connected', clients: clientCount() + 1 }) + '\n\n');
  addClient(res);
  var keepAlive = setInterval(function () { res.write(': ping\n\n'); }, 30000);
  req.on('close', function () { clearInterval(keepAlive); });
});

// ---- Approval gate helpers ----
// Soft enforcement: warns agents but doesn't block (returns warning field).
// Hard enforcement: blocks agents without an approved approval_id.
function checkApprovalGate(req, who, actionType) {
  // Admin/studio users bypass gates
  if (who === '__admin__' || who === '__system__' || !who || who.indexOf('-claude') === -1) return { ok: true };
  var approvalId = req.body.approval_id || req.query.approval_id;
  if (!approvalId) {
    return { ok: false, soft: true, warning: 'This action (' + actionType + ') should use the approval system. Call studio_request_approval first.' };
  }
  var approval = getApproval(parseIntParam(approvalId));
  if (!approval) return { ok: false, error: 'Approval #' + approvalId + ' not found' };
  if (approval.status !== 'approved') return { ok: false, error: 'Approval #' + approvalId + ' is ' + approval.status + ', not approved' };
  if (approval.action_type !== actionType) return { ok: false, error: 'Approval #' + approvalId + ' is for ' + approval.action_type + ', not ' + actionType };
  if (approval.requested_by !== who) return { ok: false, error: 'Approval #' + approvalId + ' belongs to ' + approval.requested_by + ', not ' + who };
  return { ok: true, approval: approval };
}

// ---- Auto-dispatch: push work to idle agents ----
function dispatchWorkToIdleAgents(triggerContext) {
  var idleAgents = getIdleAgents();
  if (idleAgents.length === 0) return [];

  var dispatched = [];
  var claimedTaskIds = [];

  for (var agent of idleAgents) {
    // Skip if agent already has assigned open/in_progress tasks
    var agentTasks = listDvTasks({ assignee: agent.id, status: 'open' });
    var inProgress = listDvTasks({ assignee: agent.id, status: 'in_progress' });
    if (inProgress.length > 0) continue; // already working
    if (agentTasks.length > 0) continue; // has queued work

    // Try to find work: plan steps first, then unassigned tasks
    var step = getNextUnassignedPlanStep();
    if (step) {
      // Assign plan step
      updateDvPlanStep(step.id, { assignee: agent.id, status: 'pending' });
      var content = 'AUTO-DISPATCH: Plan step assigned. Plan: "' + step.plan_title + '", Step: "' + step.title + '" (step #' + step.id + ', plan #' + step.plan_id + '). Claim and start working.';
      createDvMessage('__system__', agent.id, null, null, content, JSON.stringify({ auto_dispatch: true, plan_step_id: step.id, plan_id: step.plan_id, trigger: triggerContext }), 'directive', null);
      emitEvent('auto_dispatch', '__system__', null, 'Auto-dispatched plan step "' + step.title + '" to ' + agent.id, { agent_id: agent.id, plan_step_id: step.id, trigger: triggerContext });
      dispatched.push({ agent: agent.id, type: 'plan_step', id: step.id, title: step.title });
      continue;
    }

    var task = getNextUnassignedTask(claimedTaskIds);
    if (task) {
      // Assign task
      updateDvTask(task.id, { assignee: agent.id });
      claimedTaskIds.push(task.id);
      var content = 'AUTO-DISPATCH: Task #' + task.id + ' assigned: "' + task.title + '". ' + (task.description || '').substring(0, 300);
      createDvMessage('__system__', agent.id, null, task.project_id, content, JSON.stringify({ auto_dispatch: true, task_id: task.id, trigger: triggerContext }), 'directive', null);
      emitEvent('auto_dispatch', '__system__', task.project_id, 'Auto-dispatched task #' + task.id + ' to ' + agent.id, { agent_id: agent.id, task_id: task.id, trigger: triggerContext });
      dispatched.push({ agent: agent.id, type: 'task', id: task.id, title: task.title });
      continue;
    }

    // No work available — stop checking more agents
    break;
  }

  // Log dispatches during sleep mode
  if (dispatched.length > 0 && getSleepMode().active) {
    for (var d of dispatched) {
      appendSleepLog('dispatches', { agent: d.agent, type: d.type, id: d.id, title: d.title, time: new Date().toISOString() });
    }
  }

  return dispatched;
}

// ---- Router ----

var router = Router();

// ---- SSE: Live event stream ----
router.get('/events/stream', function (req, res) {
  // Auth: accept token as query param (SSE can't set headers)
  var token = req.query.token;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else {
    // Fall back to standard auth headers
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Authentication required. Pass ?token= or use headers.' });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected","clients":' + (clientCount() + 1) + '}\n\n');

  addClient(res);

  // Keep-alive ping every 30s to prevent proxy/load-balancer timeouts
  var keepAlive = setInterval(function () {
    res.write(': ping\n\n');
  }, 30000);

  req.on('close', function () {
    clearInterval(keepAlive);
  });
});

// Apply project_id normalization (backward compat: accept project/game too)
router.use(normalizeProjectField);

// ======== BOOT ========

router.get('/boot/:agentId', function (req, res) {
  var agentId = checkAgent(req, res);
  if (!agentId) return;
  // Agent can only boot as themselves
  if (agentId !== req.params.agentId) {
    return res.status(403).json({ error: 'Agent key does not match agent ID' });
  }
  var payload = getBootPayload(agentId);
  if (!payload) return res.status(404).json({ error: 'Agent not found' });
  // Attach savepoint diff
  payload.savepoint = computeSavepointDiff(agentId);
  // Attach sleep mode / autonomous status
  payload.sleep_mode = getSleepMode();
  payload.autonomous_mode = isNetworkAutonomous();
  payload.operators_available = getAvailableOperators().length;
  emitEvent('agent_boot', agentId, null, agentId + ' booted');
  res.json(payload);
});

// ======== WORK PULL ========

router.get('/work/:agentId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var agentId = req.params.agentId;
  var payload = getBootPayload(agentId);
  if (!payload) return res.status(404).json({ error: 'Agent not found' });
  var queue = payload.work_queue || [];

  // Auto-claim: grab the top item and assign it
  if (req.query.auto_claim === 'true' && queue.length > 0) {
    var top = queue[0];
    var claimed = null;

    if (top.type === 'directive' || top.type === 'request') {
      // Directives and requests aren't claimable — just return them
      claimed = top;
    } else if (top.type === 'plan_step' || top.type === 'plan_step_unassigned') {
      updateDvPlanStep(top.id, { assignee: agentId, status: 'in_progress' });
      emitEvent('work_claimed', agentId, null, agentId + ' auto-claimed plan step: ' + top.title, { plan_step_id: top.id, plan_id: top.plan_id });
      claimed = top;
      claimed.claimed = true;
    } else if (top.type === 'task') {
      updateDvTask(top.id, { assignee: agentId, status: 'in_progress' });
      var fullTask = getDvTask(top.id);
      emitEvent('work_claimed', agentId, top.project_id, agentId + ' auto-claimed task #' + top.id + ': ' + top.title, { task_id: top.id });
      claimed = { ...top, description: fullTask ? fullTask.description : '', claimed: true };
    } else if (top.type === 'bug' || top.type === 'bug_unassigned') {
      updateDvBug(top.id, { assignee: agentId, status: 'in_progress' });
      emitEvent('work_claimed', agentId, top.project_id, agentId + ' auto-claimed bug #' + top.id + ': ' + top.title, { bug_id: top.id });
      claimed = top;
      claimed.claimed = true;
    }

    return res.json({ ok: true, queue: queue, claimed: claimed });
  }

  res.json({ ok: true, queue: queue });
});

// ======== AGENTS ========

router.post('/agents/heartbeat', function (req, res) {
  var agentId;
  // Admin can heartbeat on behalf of any agent via agent_id body field
  var adminKey = req.headers['x-admin-key'];
  if (adminKey && adminKey === ADMIN_KEY && req.body.agent_id) {
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
  try { messagesAcked = JSON.parse(req.body.messages_acked || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for messages_acked (agent: ' + agentId + '):', e.message); }
  var sessionId = req.body.session_id || null;
  var stateSnapshot = {};
  try { stateSnapshot = JSON.parse(req.body.state_snapshot || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for state_snapshot (agent: ' + agentId + '):', e.message); }

  createSavepoint(agentId, {
    session_id: sessionId,
    working_on: workingOn,
    state_snapshot: stateSnapshot,
    messages_acked: messagesAcked
  });
  // Prune old savepoints (keep last 100)
  pruneSavepoints(agentId, 100);

  // Include pending counts so agents know if they have unread messages
  var pending = countPendingForAgent(agentId);
  var response = { ok: true, agent: agentId, status: status, pending: pending };

  // Auto-dispatch: if agent just came online or is idle with no work, try to assign
  if (!workingOn && (status === 'online' || status === 'idle')) {
    try {
      var dispatched = dispatchWorkToIdleAgents('heartbeat:' + agentId);
      if (dispatched.length > 0) response.auto_dispatched = dispatched;
    } catch (e) { /* non-critical */ }
  }

  res.json(response);
});

// ======== SAVEPOINTS ========

router.get('/agents/:id/savepoint', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var savepoint = getLatestSavepoint(req.params.id);
  if (!savepoint) return res.json({ has_savepoint: false });
  res.json(savepoint);
});

router.get('/agents/:id/savepoints', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var limit = parseLimit(req.query.limit, 10);
  res.json(getSavepointHistory(req.params.id, limit));
});

router.get('/agents/:id/savepoint/diff', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(computeSavepointDiff(req.params.id));
});

router.put('/agents/:id/savepoint/notes', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var notes = req.body.notes;
  if (!notes) return res.status(400).json({ error: 'notes required' });
  var savepointId = updateSavepointNotes(req.params.id, notes);
  if (!savepointId) return res.status(404).json({ error: 'No savepoint found for agent' });
  emitEvent('savepoint_notes', '__admin__', null, 'Admin left notes for ' + req.params.id + ': ' + notes.substring(0, 100));
  res.json({ ok: true, savepoint_id: savepointId });
});

router.get('/agents', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listAgents());
});

router.get('/agents/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  // Don't leak key hash
  var { api_key_hash, ...safe } = agent;
  res.json(safe);
});

// Update agent profile (avatar_url, name)
router.put('/agents/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  // Agents can only update themselves, admin can update anyone
  if (who !== '__admin__' && who !== '__system__' && who !== req.params.id) {
    return res.status(403).json({ error: 'Can only update your own profile' });
  }
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  var fields = {};
  if (req.body.avatar_url !== undefined) fields.avatar_url = req.body.avatar_url;
  if (req.body.name !== undefined) fields.name = req.body.name;
  // Admin-only fields
  if (who === '__admin__' || who === '__system__') {
    if (req.body.role !== undefined) fields.role = req.body.role;
    if (req.body.operator_id !== undefined) fields.operator_id = req.body.operator_id;
    if (req.body.project !== undefined) fields.project = req.body.project;
    if (req.body.project_id !== undefined) fields.project_id = req.body.project_id;
    if (req.body.capabilities !== undefined) fields.capabilities = typeof req.body.capabilities === 'string' ? req.body.capabilities : JSON.stringify(req.body.capabilities);
  }
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updateAgent(req.params.id, fields);
  res.json({ ok: true, id: req.params.id, updated: Object.keys(fields) });
});

// ======== TASKS ========

router.get('/tasks/approval-queue', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listTasksNeedingApproval());
});

router.get('/tasks', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    project_id: req.query.project_id,
    status: req.query.status,
    assignee: req.query.assignee,
    requester: req.query.requester,
    priority: req.query.priority,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvTasks(filters));
});

router.post('/tasks', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var title = escapeHtml(req.body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  var description = escapeHtml(req.body.description || '');
  var projectId = escapeHtml(req.body.project_id || '');
  var priority = req.body.priority || 'normal';
  var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
  var id = createDvTask(title, description, projectId, agentId, priority, tags);
  // Auto-create channel for task
  var taskMembers = [agentId];
  if (req.body.assignee) taskMembers.push(req.body.assignee);
  autoCreateEntityChannel('task', id, '#task-' + id + ': ' + title, agentId, taskMembers);
  // Handle optional fields
  var updates = {};
  if (req.body.assignee) updates.assignee = req.body.assignee;
  if (req.body.needs_approval) updates.needs_approval = 1;
  if (Object.keys(updates).length > 0) updateDvTask(id, updates);
  emitEvent('task_created', agentId, projectId, agentId + ' created task: ' + title, { task_id: id });
  if (req.body.assignee) {
    dispatchWebhook('task_created', req.body.assignee, { task_id: id, title: title });
  }
  res.json({ id: id, title: title });
});

router.get('/tasks/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseIntParam(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.put('/tasks/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var task = getDvTask(parseIntParam(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!checkProjectScope(req, res, task.project_id)) return;
  if (!validateEnum(res, req.body.status, TASK_STATUSES, 'status')) return;
  if (!validateEnum(res, req.body.priority, TASK_PRIORITIES, 'priority')) return;
  var fields = {};
  if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.assignee !== undefined) fields.assignee = req.body.assignee;
  if (req.body.priority !== undefined) fields.priority = req.body.priority;
  if (req.body.tags !== undefined) fields.tags = JSON.stringify(req.body.tags);
  if (req.body.needs_approval !== undefined) fields.needs_approval = req.body.needs_approval;
  if (req.body.branch !== undefined) fields.branch = req.body.branch;
  if (req.body.pr_url !== undefined) fields.pr_url = req.body.pr_url;
  if (req.body.repo !== undefined) fields.repo = req.body.repo;
  updateDvTask(task.id, fields);

  var result = { ok: true, id: task.id };

  // When task completes: resolve dependencies and update linked asset
  if (fields.status === 'done') {
    if (getSleepMode().active) appendSleepLog('tasks_completed', { id: task.id, title: task.title, agent: agentId, time: new Date().toISOString() });
    var unblocked = resolveTaskDependencies(task.id);
    if (unblocked.length > 0) {
      result.unblocked = unblocked;
      for (var uid of unblocked) {
        emitEvent('task_unblocked', agentId, task.project_id, 'Task #' + uid + ' unblocked by completion of #' + task.id, { task_id: uid, completed_task_id: task.id });
      }
    }
    // Auto-deliver linked asset
    if (task.linked_asset_id) {
      updateDvAsset(task.linked_asset_id, { status: 'delivered' });
      emitEvent('asset_delivered', agentId, task.project_id, 'Asset #' + task.linked_asset_id + ' auto-delivered (task #' + task.id + ' done)', { asset_id: task.linked_asset_id, task_id: task.id });
    }
    // Auto-complete linked plan steps
    var planResult = completeLinkedPlanSteps(task.id);
    if (planResult.steps_completed > 0) {
      result.plan_steps_completed = planResult.steps_completed;
      emitEvent('plan_step_completed', agentId, task.project_id, planResult.steps_completed + ' plan step(s) auto-completed by task #' + task.id, { task_id: task.id, steps: planResult.steps_completed });
    }
    if (planResult.plans_completed.length > 0) {
      for (var pid of planResult.plans_completed) {
        emitEvent('plan_completed', agentId, task.project_id, 'Plan #' + pid + ' auto-completed (all steps done)', { plan_id: pid, task_id: task.id });
      }
      result.plans_completed = planResult.plans_completed;
    }
    // Auto-resolve linked request
    if (task.request_id) {
      try {
        var linkedReq = getDvMessage(task.request_id);
        if (linkedReq && linkedReq.status !== 'resolved') {
          resolveDvMessage(task.request_id, agentId);
          emitEvent('request_resolved', agentId, task.project_id, 'Request #' + task.request_id + ' auto-resolved (task #' + task.id + ' done)', { message_id: task.request_id, task_id: task.id });
        }
      } catch (e) { /* non-critical */ }
    }
    // Auto-dispatch: push work to any idle agents
    try {
      var dispatched = dispatchWorkToIdleAgents('task_completed:#' + task.id);
      if (dispatched.length > 0) result.auto_dispatched = dispatched;
    } catch (e) { /* non-critical */ }
  }

  if (fields.status) {
    emitEvent('task_' + fields.status, agentId, task.project_id, agentId + ' set task #' + task.id + ' to ' + fields.status, { task_id: task.id });
  }
  // Webhook: notify assignee when task is assigned or updated
  var targetAgent = fields.assignee || task.assignee;
  if (targetAgent && (fields.assignee || fields.status)) {
    dispatchWebhook('task_assigned', targetAgent, { task_id: task.id, title: task.title, status: fields.status || task.status });
  }
  res.json(result);
});

// Task dependencies
router.post('/tasks/:id/dependency', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var taskId = parseIntParam(req.params.id);
  var blockedById = parseIntParam(req.body.blocked_by);
  if (!blockedById) return res.status(400).json({ error: 'blocked_by (task ID) is required' });
  if (taskId === blockedById) return res.status(400).json({ error: 'A task cannot block itself' });
  var ok = setTaskDependency(taskId, blockedById);
  if (!ok) return res.status(404).json({ error: 'One or both tasks not found' });
  emitEvent('task_dependency', agentId, null, 'Task #' + taskId + ' now blocked by #' + blockedById, { task_id: taskId, blocked_by: blockedById });
  res.json({ ok: true, task: taskId, blocked_by: blockedById });
});

// Task approval (admin only)
router.put('/tasks/:id/approve', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var task = getDvTask(parseIntParam(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.needs_approval) return res.status(400).json({ error: 'Task does not require approval' });
  if (task.approved_by) return res.status(400).json({ error: 'Task already approved by ' + task.approved_by });
  approveDvTask(task.id, '__admin__');
  emitEvent('task_approved', '__admin__', task.project_id, 'Admin approved task #' + task.id + ': ' + task.title, { task_id: task.id });
  res.json({ ok: true, id: task.id, approved: true });
});

// ======== TASK COMMENTS ========

router.get('/tasks/:id/comments', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseIntParam(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(getTaskComments(task.id));
});

router.post('/tasks/:id/comments', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseIntParam(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  var author = escapeHtml(req.body.author || who);
  var content = escapeHtml(req.body.content);
  if (!content) return res.status(400).json({ error: 'content is required' });
  var comment = addTaskComment(task.id, author, content);
  emitEvent('task_comment', who, task.project_id, who + ' commented on task #' + task.id, { task_id: task.id, comment_id: comment.id });
  res.json(comment);
});

router.delete('/tasks/:id/comments/:commentId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseIntParam(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!checkProjectScope(req, res, task.project_id)) return;
  var deleted = deleteTaskComment(parseIntParam(req.params.commentId));
  if (!deleted) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true, deleted: parseIntParam(req.params.commentId) });
});

// ======== CONTEXT ========

// Namespaced context (must be before :projectId param route)
router.get('/context/keys', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var namespace = req.query.namespace;
  res.json(listDvContextKeys(namespace));
});

router.get('/context/keys/:namespace', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listDvContextKeys(req.params.namespace));
});

router.get('/context/keys/:namespace/:key', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var ctx = getDvContextKey(req.params.namespace, req.params.key);
  if (!ctx) return res.status(404).json({ error: 'Context key not found' });
  res.json(ctx);
});

router.put('/context/keys/:namespace/:key', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var data = req.body.data;
  if (data === undefined) return res.status(400).json({ error: 'data field is required' });
  var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  upsertDvContextKey(req.params.namespace, req.params.key, dataStr, agentId);
  emitEvent('context_key_updated', agentId, req.params.namespace, agentId + ' updated context ' + req.params.namespace + ':' + req.params.key);
  res.json({ ok: true, namespace: req.params.namespace, key: req.params.key });
});

router.delete('/context/keys/:namespace/:key', function (req, res) {
  if (!checkAdmin(req, res)) return;
  deleteDvContextKey(req.params.namespace, req.params.key);
  res.json({ ok: true, deleted: req.params.namespace + ':' + req.params.key });
});

// Legacy per-project context
router.get('/context', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(getAllDvContext());
});

router.get('/context/:projectId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var ctx = getDvContext(req.params.projectId);
  if (!ctx) return res.json({ project_id: req.params.projectId, data: '{}', updated_at: null, updated_by: '' });
  res.json(ctx);
});

router.put('/context/:projectId', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var data = req.body.data;
  if (data === undefined) return res.status(400).json({ error: 'data field is required' });
  var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  upsertDvContext(req.params.projectId, dataStr, agentId);
  emitEvent('context_updated', agentId, req.params.projectId, agentId + ' updated context for ' + req.params.projectId);
  res.json({ ok: true, project_id: req.params.projectId });
});

// ======== ASSETS ========

router.get('/assets', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    project_id: req.query.project_id,
    type: req.query.type,
    status: req.query.status,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvAssets(filters));
});

router.post('/assets', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var name = escapeHtml(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  var type = req.body.type || 'sprite';
  var projectId = req.body.project_id || 'shared';
  var status = req.body.status || 'requested';
  if (!validateEnum(res, req.body.status, ASSET_STATUSES, 'status')) return;
  var assetPath = req.body.path || '';
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createDvAsset(name, type, projectId, status, assetPath, metadata, agentId);
  emitEvent('asset_registered', agentId, projectId, agentId + ' registered asset: ' + name, { asset_id: id });

  var result = { id: id, name: name };

  // Auto-create task for asset requests
  if (status === 'requested') {
    var taskResult = autoTaskFromAsset(id, projectId, agentId);
    if (taskResult) {
      result.task_id = taskResult.task_id;
      result.assigned_to = taskResult.assignee;
      emitEvent('task_created', agentId, projectId, 'Auto-task for asset ' + name + ' assigned to ' + (taskResult.assignee || 'unassigned'), { asset_id: id, task_id: taskResult.task_id });
    }
  }

  res.json(result);
});

router.get('/assets/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseIntParam(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  res.json(asset);
});

router.put('/assets/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var asset = getDvAsset(parseIntParam(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!validateEnum(res, req.body.status, ASSET_STATUSES, 'status')) return;
  var fields = {};
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.path !== undefined) fields.path = req.body.path;
  if (req.body.metadata !== undefined) fields.metadata = JSON.stringify(req.body.metadata);
  if (req.body.drone_job_id !== undefined) fields.drone_job_id = req.body.drone_job_id;
  if (req.body.assigned_to !== undefined) fields.assigned_to = req.body.assigned_to;
  if (req.body.file_path !== undefined) fields.file_path = req.body.file_path;
  if (req.body.download_url !== undefined) fields.download_url = req.body.download_url;
  if (req.body.prompt !== undefined) fields.prompt = req.body.prompt;
  updateDvAsset(asset.id, fields);
  if (fields.status) {
    emitEvent('asset_' + fields.status, agentId, asset.project_id, agentId + ' set asset ' + asset.name + ' to ' + fields.status, { asset_id: asset.id });
  }
  res.json({ ok: true, id: asset.id });
});

router.post('/assets/:id/upload', upload.single('file'), function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseIntParam(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  var filePath = req.file.path;
  var downloadUrl = '/api/mycelium/assets/' + asset.id + '/download';
  updateDvAsset(asset.id, { status: 'ready', file_path: filePath, download_url: downloadUrl, path: req.file.filename });
  emitEvent('asset_uploaded', who, asset.project_id, 'Asset #' + asset.id + ' (' + asset.name + ') uploaded');
  res.json({ ok: true, asset_id: asset.id, download_url: downloadUrl });
});

router.get('/assets/:id/download', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseIntParam(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.file_path && !asset.path) return res.status(404).json({ error: 'No file attached to this asset' });

  var filePath = asset.file_path || nodePath.join(FILES_DIR, asset.path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
  res.download(filePath);
});

// Link assets to a drone job (bulk update status + drone_job_id)
router.put('/assets/link-job', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var { asset_ids, drone_job_id, status } = req.body;
  if (!asset_ids || !Array.isArray(asset_ids)) return res.status(400).json({ error: 'asset_ids array required' });
  if (!drone_job_id) return res.status(400).json({ error: 'drone_job_id required' });
  // Validate drone job exists
  var job = getDroneJob(parseIntParam(drone_job_id));
  if (!job) return res.status(404).json({ error: 'Drone job #' + drone_job_id + ' not found' });
  // Validate all asset IDs exist before making any changes
  var missing = asset_ids.filter(function (id) { return !getDvAsset(parseIntParam(id)); });
  if (missing.length > 0) return res.status(404).json({ error: 'Assets not found: ' + missing.join(', ') });
  if (!validateEnum(res, status, ASSET_STATUSES, 'status')) return;
  var updated = 0;
  for (var id of asset_ids) {
    var fields = { drone_job_id: drone_job_id };
    if (status) fields.status = status;
    var result = updateDvAsset(parseInt(id), fields);
    if (result.changes) updated++;
  }
  emitEvent('assets_linked_to_job', who, null, updated + ' assets linked to drone job #' + drone_job_id, { asset_ids: asset_ids, drone_job_id: drone_job_id });
  res.json({ ok: true, updated: updated });
});

// Delete asset (admin only)
router.delete('/assets/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var asset = getDvAsset(parseIntParam(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  deleteDvAsset(asset.id);
  emitEvent('asset_deleted', getAdminDisplayName(req), asset.project_id, 'Deleted asset #' + asset.id + ': ' + asset.name, { asset_id: asset.id });
  res.json({ ok: true, id: asset.id });
});

// ======== EVENTS ========

router.get('/events', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    since: req.query.since,
    project_id: req.query.project_id,
    type: req.query.type,
    agent: req.query.agent,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvEvents(filters));
});

router.post('/events', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var type = req.body.type || 'custom';
  var projectId = req.body.project_id || null;
  var summary = escapeHtml(req.body.summary || '');
  var data = req.body.data ? JSON.stringify(req.body.data) : '{}';
  var id = createDvEvent(type, agentId, projectId, summary, data);
  res.json({ id: id });
});

// GET /events/stream — Server-Sent Events stream for live event broadcast
// Auth: ?token=<jwt> for browser EventSource, or X-Admin-Key/X-Agent-Key headers for API clients
// Filters (optional): ?project_id=, ?type=, ?agent=
// On connect: replays last 20 matching events so the client isn't blank
// Heartbeat: SSE comment every 30s to keep proxies from closing idle connections
router.get('/events/stream', function (req, res) {
  // Auth must happen before SSE headers are set so we can send error JSON
  var authOk = false;

  // ?token=<jwt> — browser EventSource can't set Authorization headers
  var token = req.query.token;
  if (token) {
    try {
      var decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.studioUser) { req._authIsAdmin = true; authOk = true; }
    } catch (e) { /* invalid token, fall through to header auth */ }
  }

  if (!authOk) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return; // checkAgentOrAdmin already sent 401/403
    authOk = true;
  }

  // Optional event filters
  var filters = {
    project_id: req.query.project_id || null,
    type: req.query.type || null,
    agent: req.query.agent || null
  };

  // SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/Railway proxy buffering
  res.flushHeaders();

  // Replay last 20 matching events on connect so dashboard isn't blank
  try {
    var recentFilters = { limit: 20, offset: 0 };
    if (filters.project_id) recentFilters.project_id = filters.project_id;
    if (filters.type) recentFilters.type = filters.type;
    if (filters.agent) recentFilters.agent = filters.agent;
    var recent = listDvEvents(recentFilters);
    recent.reverse().forEach(function (ev) {
      res.write('data: ' + JSON.stringify(ev) + '\n\n');
    });
    if (res.flush) res.flush();
  } catch (e) { /* non-fatal — stream still opens */ }

  // Register this client
  var client = { res: res, filters: filters };
  sseClients.add(client);

  // Keepalive heartbeat every 30s — SSE comment (ignored by EventSource)
  var heartbeat = setInterval(function () {
    try {
      res.write(': keepalive\n\n');
      if (res.flush) res.flush();
    } catch (e) { /* cleaned up below */ }
  }, 30000);

  // Cleanup when client disconnects
  req.on('close', function () {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

// ======== REQUESTS ========

router.get('/requests/pending', function (req, res) {
  var agentId = checkAgent(req, res);
  if (!agentId) return;
  res.json(listPendingRequests(agentId));
});

router.post('/requests', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var content = req.body.content;
  if (!content) return res.status(400).json({ error: 'content is required' });
  var toAgent = req.body.to_agent || null;
  var threadId = req.body.thread_id || null;
  var projectId = req.body.project_id || null;
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createDvRequest(agentId, toAgent, threadId, projectId, content, metadata);
  var target = toAgent ? ' to ' + toAgent : ' (broadcast)';
  emitEvent('request_created', agentId, projectId, agentId + ' sent request' + target, { message_id: id });
  if (toAgent) {
    dispatchWebhook('request_created', toAgent, { message_id: id, from: agentId, content: content.substring(0, 200) });
  }

  var result = { id: id };

  // Auto-create task if requested
  if (req.body.auto_task && toAgent) {
    var title = escapeHtml(req.body.task_title || content.substring(0, 80));
    var taskId = createDvTask(title, content, projectId || '', agentId, req.body.priority || 'normal', '[]');
    updateDvTask(taskId, { assignee: toAgent, request_id: id });
    result.task_id = taskId;
    emitEvent('task_created', agentId, projectId, 'Auto-task from request: ' + title + ' \u2192 ' + toAgent, { task_id: taskId, message_id: id });
  }

  res.json(result);
});

router.put('/requests/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var msg = getDvMessage(parseIntParam(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Request not found' });
  if (msg.msg_type !== 'request') return res.status(400).json({ error: 'Message #' + msg.id + ' is not a request' });

  var status = req.body.status;
  if (!status) return res.status(400).json({ error: 'status is required (acknowledged, resolved, completed)' });

  if (status === 'acknowledged' || status === 'ack') {
    acknowledgeDvMessage(msg.id);
    emitEvent('request_acknowledged', agentId, msg.project_id, agentId + ' acknowledged request #' + msg.id, { message_id: msg.id });
    return res.json({ ok: true, id: msg.id, status: 'acknowledged' });
  }

  if (status === 'resolved' || status === 'completed' || status === 'done') {
    resolveDvMessage(msg.id, agentId);
    emitEvent('request_resolved', agentId, msg.project_id, agentId + ' resolved request #' + msg.id, { message_id: msg.id });
    var result = { ok: true, id: msg.id, status: 'resolved' };
    if (req.body.response) {
      var responseId = createDvMessage(agentId, msg.from_agent, msg.thread_id, msg.project_id, req.body.response, '{}');
      result.response_id = responseId;
    }
    return res.json(result);
  }

  res.status(400).json({ error: 'Invalid status. Use: acknowledged, resolved, completed' });
});

// ======== MESSAGES ========

router.get('/messages', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    from_agent: req.query.from,
    to_agent: req.query.to,
    thread_id: req.query.thread,
    project_id: req.query.project_id,
    since: req.query.since,
    msg_type: req.query.msg_type,
    status: req.query.status,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0,
    channel_id: req.query.channel_id ? parseIntParam(req.query.channel_id) : undefined
  };
  res.json(listDvMessages(filters));
});

router.post('/messages', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var content = req.body.content;
  if (!content) return res.status(400).json({ error: 'content is required' });

  // Only admin and operators can send directives
  var msgType = req.body.msg_type || 'message';
  if (msgType === 'directive') {
    var sender = req.body.from || agentId;
    if (sender !== '__admin__' && sender.indexOf('-claude') !== -1) {
      return res.status(403).json({ error: 'Only admin or operators can send directives' });
    }
  }

  var toAgent = req.body.to_agent || req.body.to || null;
  var threadId = req.body.thread_id || null;
  var projectId = req.body.project_id || null;
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  // Route to channel
  var channelId = req.body.channel_id ? parseIntParam(req.body.channel_id) : null;
  if (!channelId && toAgent) {
    // DM: auto-create DM channel
    channelId = getOrCreateDmChannel(agentId, toAgent, 'agent', 'agent');
  }
  if (!channelId && !toAgent) {
    // Broadcast: route to #general
    var general = getChannelBySlug('general');
    if (general) channelId = general.id;
  }
  var id = createDvMessage(agentId, toAgent, threadId, projectId, content, metadata, msgType, channelId);
  // Skip events/webhooks for system-to-system telemetry (runner health pings etc)
  if (!(agentId === '__system__' && toAgent === '__system__')) {
    var target = toAgent ? ' to ' + displayName(toAgent) : ' (broadcast)';
    emitEvent('message_sent', agentId, projectId, displayName(agentId) + ' sent message' + target, { message_id: id });
    if (toAgent) {
      dispatchWebhook('message_sent', toAgent, { message_id: id, from: agentId, content: content.substring(0, 200) });
    }
  }
  res.json({ id: id });
});

router.put('/messages/:id/ack', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var msg = getDvMessage(parseIntParam(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  acknowledgeDvMessage(msg.id);
  emitEvent('request_acknowledged', agentId, msg.project_id, agentId + ' acknowledged request #' + msg.id, { message_id: msg.id });
  res.json({ ok: true, id: msg.id, status: 'acknowledged' });
});

router.put('/messages/:id/resolve', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var msg = getDvMessage(parseIntParam(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  resolveDvMessage(msg.id, agentId);
  emitEvent('request_resolved', agentId, msg.project_id, agentId + ' resolved request #' + msg.id, { message_id: msg.id });

  var result = { ok: true, id: msg.id, status: 'resolved' };

  // Optionally send a response message back
  if (req.body.response) {
    var responseId = createDvMessage(agentId, msg.from_agent, msg.thread_id, msg.project_id, req.body.response, '{}');
    result.response_id = responseId;
  }

  res.json(result);
});

router.get('/messages/threads', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listDvThreads(parseLimit(req.query.limit, 20)));
});

// Admin-only bulk message cleanup
router.delete('/messages/bulk', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var from = req.query.from;
  var to = req.query.to;
  var content_like = req.query.content_like;
  if (!from && !to && !content_like) return res.status(400).json({ error: 'Specify at least one filter: from, to, content_like' });
  var deleted = bulkDeleteMessages({ from: from, to: to, content_like: content_like });
  res.json({ deleted: deleted });
});

// ======== PLANS ========

router.get('/plans', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    project_id: req.query.project_id,
    status: req.query.status,
    owner: req.query.owner,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvPlans(filters));
});

router.post('/plans', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var gate = checkApprovalGate(req, agentId, 'plan_create');
  var title = escapeHtml(req.body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  var description = escapeHtml(req.body.description || '');
  var projectId = escapeHtml(req.body.project_id || '');
  var owner = escapeHtml(req.body.owner || '');
  var priority = req.body.priority || 'normal';
  var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
  var id = createDvPlan(title, description, projectId, owner, priority, tags, agentId);
  // Auto-create channel for plan
  var planMembers = [];
  if (owner) planMembers.push(owner);
  autoCreateEntityChannel('plan', id, '#plan-' + id + ': ' + title, agentId, planMembers);
  emitEvent('plan_created', agentId, projectId, agentId + ' created plan: ' + title, { plan_id: id });
  dispatchWebhook('plan_created', agentId, { plan_id: id, title: title, project_id: projectId, owner: owner });
  var result = { id: id, title: title };
  if (gate.warning) result.approval_warning = gate.warning;
  res.json(result);
});

router.get('/plans/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  res.json(plan);
});

router.put('/plans/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  if (!validateEnum(res, req.body.status, PLAN_STATUSES, 'status')) return;
  var fields = {};
  if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.owner !== undefined) fields.owner = escapeHtml(req.body.owner);
  if (req.body.priority !== undefined) fields.priority = req.body.priority;
  if (req.body.tags !== undefined) fields.tags = req.body.tags;
  if (req.body.project_id !== undefined) fields.project_id = escapeHtml(req.body.project_id);
  updateDvPlan(plan.id, fields);
  if (fields.status) {
    emitEvent('plan_' + fields.status, agentId, plan.project_id, agentId + ' set plan #' + plan.id + ' to ' + fields.status, { plan_id: plan.id });
  }
  res.json({ ok: true, id: plan.id });
});

router.delete('/plans/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var gate = checkApprovalGate(req, who, 'delete');
  if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  deleteDvPlan(plan.id);
  emitEvent('plan_deleted', who, plan.project_id, who + ' deleted plan #' + plan.id + ': ' + plan.title, { plan_id: plan.id });
  var result = { ok: true, deleted: plan.id };
  if (gate.warning) result.approval_warning = gate.warning;
  res.json(result);
});

// -- Plan Steps --

router.post('/plans/:id/steps', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  var title = escapeHtml(req.body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  var description = escapeHtml(req.body.description || '');
  var assignee = req.body.assignee || null;
  var phase = escapeHtml(req.body.phase || '');
  var stepId = createDvPlanStep(plan.id, title, description, assignee, phase);
  // Optionally link task/branch/PR at creation
  var updates = {};
  if (req.body.linked_task_id !== undefined) updates.linked_task_id = req.body.linked_task_id;
  if (req.body.linked_branch !== undefined) updates.linked_branch = req.body.linked_branch;
  if (req.body.linked_pr_url !== undefined) updates.linked_pr_url = req.body.linked_pr_url;
  if (Object.keys(updates).length > 0) updateDvPlanStep(stepId, updates);
  emitEvent('plan_step_added', agentId, plan.project_id, agentId + ' added step to plan #' + plan.id + ': ' + title, { plan_id: plan.id, step_id: stepId });
  res.json({ id: stepId, plan_id: plan.id });
});

router.put('/plans/:id/steps/:stepId', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  if (!validateEnum(res, req.body.status, PLAN_STEP_STATUSES, 'status')) return;
  var fields = {};
  if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.assignee !== undefined) fields.assignee = req.body.assignee;
  if (req.body.linked_task_id !== undefined) fields.linked_task_id = req.body.linked_task_id;
  if (req.body.linked_branch !== undefined) fields.linked_branch = req.body.linked_branch;
  if (req.body.linked_pr_url !== undefined) fields.linked_pr_url = req.body.linked_pr_url;
  if (req.body.phase !== undefined) fields.phase = escapeHtml(req.body.phase);
  var stepPlanId = parseIntParam(req.params.id);
  var stepStepId = parseIntParam(req.params.stepId);
  updateDvPlanStep(stepStepId, fields);
  if (fields.status === 'done' && getSleepMode().active) {
    appendSleepLog('steps_completed', { id: stepStepId, plan_id: stepPlanId, agent: agentId, time: new Date().toISOString() });
  }
  emitEvent('plan_step_updated', agentId, plan ? plan.project_id : null, agentId + ' updated step #' + stepStepId + ' on plan #' + stepPlanId, { plan_id: stepPlanId, step_id: stepStepId, fields: fields });
  dispatchWebhook('plan_step_updated', agentId, { plan_id: stepPlanId, step_id: stepStepId, fields: fields });
  res.json({ ok: true, step_id: stepStepId });
});

router.delete('/plans/:id/steps/:stepId', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  deleteDvPlanStep(parseIntParam(req.params.stepId));
  res.json({ ok: true, deleted: parseIntParam(req.params.stepId) });
});

router.put('/plans/:id/reorder', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseIntParam(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!checkProjectScope(req, res, plan.project_id)) return;
  var order = req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of step IDs' });
  reorderDvPlanSteps(parseIntParam(req.params.id), order);
  res.json({ ok: true, plan_id: parseIntParam(req.params.id) });
});

// ======== STUDIO AUTH ========

// Login — returns JWT
router.post('/studio/login', asyncHandler(async function (req, res) {
  var username = (req.body.username || '').trim().toLowerCase();
  var password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  var user = getStudioUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  var token = jwt.sign({
    studioUser: true,
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
  }, JWT_SECRET, { expiresIn: STUDIO_JWT_EXPIRY });
  res.json({
    token: token,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
  });
}));

// Who am I
router.get('/studio/me', function (req, res) {
  var user = getStudioUser(req);
  if (!user) {
    // Check admin key
    var key = req.headers['x-admin-key'];
    if (key === ADMIN_KEY) return res.json({ id: 0, username: 'admin', display_name: 'Admin', role: 'admin' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  var dbUser = getStudioUserById(user.userId);
  if (!dbUser) return res.status(401).json({ error: 'User not found' });
  res.json(dbUser);
});

// Register new studio user (admin only)
router.post('/studio/users', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var username = (req.body.username || '').trim().toLowerCase();
  var password = req.body.password || '';
  var displayName = (req.body.display_name || '').trim();
  var role = req.body.role || 'admin';
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'username, password, and display_name are required' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (getStudioUserByUsername(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  var hash = await bcrypt.hash(password, BCRYPT_ROUNDS_PASSWORD);
  var id = createStudioUser(username, displayName, hash, role);
  emitEvent('studio_user_created', getAdminDisplayName(req), null, 'Studio user created: ' + displayName + ' (' + username + ')');
  res.json({ id: id, username: username, display_name: displayName, role: role });
}));

// List studio users (admin only)
router.get('/studio/users', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listStudioUsers());
});

// Update studio user password (admin only)
router.put('/studio/users/:id/password', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseIntParam(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  var newPassword = req.body.password || '';
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  var hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS_PASSWORD);
  updateStudioUser(user.id, { password_hash: hash });
  res.json({ ok: true, username: user.username });
}));

// Delete studio user (admin only)
router.delete('/studio/users/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseIntParam(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteStudioUser(user.id);
  res.json({ ok: true, deleted: user.username });
});

// ======== OPERATORS (people) ========

router.get('/operators', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOperators());
});

router.get('/operators/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var op = getOperator(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operator not found' });
  res.json(op);
});

router.post('/operators', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var { id, display_name, role, responsibilities, email, studio_user_id } = req.body;
  if (!id || !display_name) return res.status(400).json({ error: 'id and display_name required' });
  if (getOperator(id)) return res.status(409).json({ error: 'Operator already exists' });
  createOperator(id, display_name, role, responsibilities, email, studio_user_id);
  emitEvent('operator_created', who, null, 'Operator ' + id + ' created');
  res.json(getOperator(id));
});

router.put('/operators/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var op = getOperator(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operator not found' });
  updateOperator(req.params.id, req.body);
  emitEvent('operator_updated', who, null, 'Operator ' + req.params.id + ' updated');
  res.json(getOperator(req.params.id));
});

router.delete('/operators/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  if (!getOperator(req.params.id)) return res.status(404).json({ error: 'Operator not found' });
  deleteOperator(req.params.id);
  emitEvent('operator_deleted', who, null, 'Operator ' + req.params.id + ' deleted');
  res.json({ ok: true });
});

// ======== INSTANCE CONFIG ========

router.get('/admin/config', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listInstanceConfig());
});

router.get('/admin/config/:key', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var val = getInstanceConfig(req.params.key);
  if (val === null) return res.status(404).json({ error: 'Config key not found' });
  res.json({ key: req.params.key, value: val });
});

router.put('/admin/config/:key', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  setInstanceConfig(req.params.key, typeof value === 'string' ? value : JSON.stringify(value), who);
  emitEvent('config_changed', who, null, 'Config ' + req.params.key + ' updated');
  res.json({ key: req.params.key, value: getInstanceConfig(req.params.key) });
});

// ======== KILL SWITCH ========

router.put('/admin/override', function (req, res) {
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
});

// ======== SLEEP MODE ========

router.put('/admin/sleep', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var action = req.body.action;
  if (action !== 'on' && action !== 'off') {
    return res.status(400).json({ error: 'action must be on or off' });
  }

  if (action === 'on') {
    var directive = req.body.directive || '';
    var priorities = req.body.priorities || [];
    var approvalPolicy = req.body.approval_policy || 'queue_high';
    var autoWakeAt = req.body.auto_wake_at || null;

    // Find the operator linked to this admin user
    var operatorId = req.body.operator_id;
    if (operatorId) {
      var op = getOperator(operatorId);
      if (op) setOperatorAvailability(operatorId, 'sleeping', directive);
    }

    var config = {
      active: true,
      directive: directive,
      priorities: priorities,
      approval_policy: approvalPolicy,
      auto_wake_at: autoWakeAt,
      started_at: new Date().toISOString(),
      started_by: who
    };
    setInstanceConfig('sleep_mode', JSON.stringify(config), who);
    setInstanceConfig('sleep_mode_log', JSON.stringify({
      tasks_completed: [], steps_completed: [], approvals_queued: [],
      dispatches: [], errors: [], messages_sent: 0
    }), who);

    var autonomous = isNetworkAutonomous();
    if (autonomous && directive) {
      // Broadcast night directive to all online agents
      var agents = listAgents();
      for (var agent of agents) {
        if (agent.status === 'online' || agent.status === 'idle') {
          createDvMessage('__system__', agent.id, null, 'AUTONOMOUS MODE ACTIVE — Night directive from ' + who + ': ' + directive, 'directive');
        }
      }
    }

    emitEvent('sleep_mode_on', who, null, who + ' activated sleep mode' + (autonomous ? ' (network autonomous)' : ''));
    res.json({ ok: true, sleep_mode: config, autonomous: autonomous });

  } else {
    // action === 'off'
    var operatorId2 = req.body.operator_id;
    if (operatorId2) {
      var op2 = getOperator(operatorId2);
      if (op2) setOperatorAvailability(operatorId2, 'available', '');
    }

    var log = null;
    var logVal = getInstanceConfig('sleep_mode_log');
    try { log = logVal ? JSON.parse(logVal) : null; } catch (e) { log = null; }

    setInstanceConfig('sleep_mode', JSON.stringify({ active: false }), who);
    emitEvent('sleep_mode_off', who, null, who + ' deactivated sleep mode');

    // Notify agents that humans are back
    var agents2 = listAgents();
    for (var agent2 of agents2) {
      if (agent2.status === 'online' || agent2.status === 'idle') {
        createDvMessage('__system__', agent2.id, null, 'Sleep mode ended. Human operators are available again.', 'info');
      }
    }

    res.json({ ok: true, sleep_mode: { active: false }, morning_summary: log });
  }
});

router.get('/admin/sleep', function (req, res) {
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
});

router.put('/operators/:id/availability', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  var op = getOperator(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operator not found' });

  var availability = req.body.availability;
  if (!['available', 'away', 'sleeping'].includes(availability)) {
    return res.status(400).json({ error: 'availability must be available, away, or sleeping' });
  }

  var wasBefore = isNetworkAutonomous();
  setOperatorAvailability(req.params.id, availability, req.body.message || '');
  var isNow = isNetworkAutonomous();

  // Transition to autonomous
  if (!wasBefore && isNow) {
    var sleepConfig = getSleepMode();
    if (sleepConfig.active && sleepConfig.directive) {
      var agents = listAgents();
      for (var agent of agents) {
        if (agent.status === 'online' || agent.status === 'idle') {
          createDvMessage('__system__', agent.id, null, 'All operators are now away. Night directive: ' + sleepConfig.directive, 'directive');
        }
      }
    }
    emitEvent('autonomous_mode_on', who, null, 'All operators away — network is autonomous');
  }

  // Transition from autonomous
  if (wasBefore && !isNow) {
    emitEvent('autonomous_mode_off', who, null, displayName(req.params.id) + ' is back — autonomous mode ended');
    var agents2 = listAgents();
    for (var agent2 of agents2) {
      if (agent2.status === 'online' || agent2.status === 'idle') {
        createDvMessage('__system__', agent2.id, null, 'Operator ' + displayName(req.params.id) + ' is back. Human operators available.', 'info');
      }
    }
  }

  emitEvent('operator_availability', who, null, displayName(req.params.id) + ' is now ' + availability);
  res.json(getOperator(req.params.id));
});

// ======== ADMIN ========

// Register new agent (returns plaintext API key — store it, shown only once)
router.post('/admin/agents', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var id = req.body.id;
  var name = req.body.name;
  var projectId = req.body.project_id;
  if (!id || !name || !projectId) return res.status(400).json({ error: 'id, name, and project_id are required' });
  // Check if exists
  if (getAgent(id)) return res.status(409).json({ error: 'Agent ' + id + ' already exists' });
  // Generate API key
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS_KEY);
  var capabilities = req.body.capabilities ? JSON.stringify(req.body.capabilities) : '["code","assets"]';
  createAgent(id, name, projectId, hash, capabilities);
  // Set optional LLM metadata
  if (req.body.llm_backend || req.body.llm_model || req.body.agent_type) {
    updateAgent(id, {
      llm_backend: req.body.llm_backend || '',
      llm_model: req.body.llm_model || '',
      agent_type: req.body.agent_type || 'agent'
    });
  }
  // Auto-add new agent to #general
  var generalChannel = getChannelBySlug('general');
  if (generalChannel) {
    addChannelMember(generalChannel.id, id, 'agent', 'member');
  }
  emitEvent('agent_registered', '__admin__', null, 'Admin registered agent: ' + id);
  res.json({ id: id, api_key: apiKey, message: 'Store this key — it will not be shown again' });
}));

router.delete('/admin/agents/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  deleteAgent(req.params.id);
  clearAgentKeyCache();
  emitEvent('agent_removed', '__admin__', null, 'Admin removed agent: ' + req.params.id);
  res.json({ ok: true, deleted: req.params.id });
});

// Regenerate agent API key (admin only)
router.put('/admin/agents/:id/key', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS_KEY);
  updateAgentKey(req.params.id, hash);
  clearAgentKeyCache();  // invalidate cached keys
  emitEvent('agent_key_regenerated', '__admin__', null, 'Admin regenerated key for: ' + req.params.id);
  res.json({ id: req.params.id, api_key: apiKey, message: 'Store this key — it will not be shown again' });
}));

// Admin heartbeat for any agent
router.put('/admin/agents/:id/heartbeat', function (req, res) {
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
});

// Admin create savepoint with notes (for handoffs)
router.post('/agents/:id/savepoint', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  createSavepoint(req.params.id, {
    working_on: agent.working_on || '',
    notes: req.body.notes || null
  });
  var sp = getLatestSavepoint(req.params.id);
  res.json({ ok: true, savepoint_id: sp.id });
});

// Full studio overview (for dashboard)
router.get('/admin/overview', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = getAdminDisplayName(req);
  res.json(getDvOverview(who));
});

// Actionable items needing decisions (admin only)
router.get('/admin/ops', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(getAdminOps());
});

// =============== ORGANIZATIONS ===============

router.get('/orgs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOrgs());
});

router.post('/orgs', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { id, name, description } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  createOrg(id, name, description || '', getAdminDisplayName(req));
  var org = getOrg(id);
  emitEvent('org_created', getAdminDisplayName(req), '', 'Organization created: ' + name);
  res.json(org);
});

router.get('/orgs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var org = getOrg(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  org.projects = listProjects(req.params.id);
  res.json(org);
});

router.put('/orgs/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var org = getOrg(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  updateOrg(req.params.id, req.body);
  res.json(getOrg(req.params.id));
});

// =============== PROJECTS ===============

// List projects (optional ?org_id= filter)
router.get('/projects', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listProjects(req.query.org_id));
});

// Create project (admin only)
router.post('/projects', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { id, name, description, repo_url, org_id, type } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  createProject(id, name, description || '', repo_url || '', org_id || '', type || 'software');
  var project = getProject(id);
  emitEvent('project_created', getAdminDisplayName(req), id, 'Project created: ' + name);
  res.json(project);
});

router.get('/projects/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

router.put('/projects/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  updateProject(req.params.id, req.body);
  res.json(getProject(req.params.id));
});

// =============== SHARED CONCEPTS ===============

// List all concepts (optional ?type= filter)
router.get('/concepts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {};
  if (req.query.type) filters.type = req.query.type;
  var concepts = listConcepts(filters);
  // Attach linked projects to each concept
  concepts.forEach(function (c) {
    c.projects = getConceptProjects(c.id);
    try { c.data = JSON.parse(c.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + c.id + '):', e.message); }
  });
  res.json(concepts);
});

// Get single concept
router.get('/concepts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concept = getConcept(parseIntParam(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  concept.projects = getConceptProjects(concept.id);
  try { concept.data = JSON.parse(concept.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + concept.id + '):', e.message); }
  res.json(concept);
});

// Create concept (admin or agent)
router.post('/concepts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var { name, type, description, data } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  var validTypes = ['character', 'style', 'ruleset', 'library', 'brand', 'custom'];
  if (type && validTypes.indexOf(type) === -1) {
    return res.status(400).json({ error: 'type must be one of: ' + validTypes.join(', ') });
  }
  var id = createConcept(name, type, description, data, who);
  emitEvent('concept_created', who, null, 'Created concept: ' + name + ' (' + (type || 'custom') + ')');
  var concept = getConcept(id);
  try { concept.data = JSON.parse(concept.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + id + '):', e.message); }
  concept.projects = [];
  res.json(concept);
});

// Update concept
router.put('/concepts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concept = getConcept(parseIntParam(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  updateConcept(concept.id, req.body);
  var updated = getConcept(concept.id);
  try { updated.data = JSON.parse(updated.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + concept.id + '):', e.message); }
  updated.projects = getConceptProjects(updated.id);
  emitEvent('concept_updated', who, null, 'Updated concept: ' + updated.name);
  res.json(updated);
});

// Delete concept
router.delete('/concepts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var gate = checkApprovalGate(req, who, 'delete');
  if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
  var concept = getConcept(parseIntParam(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  deleteConcept(concept.id);
  emitEvent('concept_deleted', who, null, who + ' deleted concept: ' + concept.name);
  var result = { ok: true };
  if (gate.warning) result.approval_warning = gate.warning;
  res.json(result);
});

// Link concept to project
router.post('/concepts/:id/link', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concept = getConcept(parseIntParam(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  var projectId = req.body.project_id;
  if (!projectId) return res.status(400).json({ error: 'project_id is required' });
  linkConceptToProject(projectId, concept.id, who);
  emitEvent('concept_linked', who, projectId, 'Linked concept "' + concept.name + '" to project ' + projectId);
  res.json({ ok: true, concept_id: concept.id, project: projectId });
});

// Unlink concept from project
router.delete('/concepts/:id/link/:projectId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  unlinkConceptFromProject(req.params.projectId, parseIntParam(req.params.id));
  res.json({ ok: true });
});

// Get concepts for a specific project
router.get('/projects/:projectId/concepts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concepts = getProjectConcepts(req.params.projectId);
  concepts.forEach(function (c) {
    try { c.data = JSON.parse(c.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + c.id + '):', e.message); }
  });
  res.json(concepts);
});

// =============== FILES (temp — auto-expire) ===============

var FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup expired files every 10 minutes
setInterval(function () {
  try {
    var now = Date.now();
    var files = fs.readdirSync(FILES_DIR);
    for (var f of files) {
      var fp = nodePath.join(FILES_DIR, f);
      var stat = fs.statSync(fp);
      if (now - stat.mtimeMs > FILE_TTL_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch (e) { /* cleanup is best-effort */ }
}, 10 * 60 * 1000);

// POST /files — upload a temp file (multipart form, field name: "file")
// curl -X POST -H "X-Agent-Key: <key>" -F "file=@myimage.png" https://mycelium.fyi/api/mycelium/files
// Files auto-delete after 24 hours. Download with wget/curl before then.
router.post('/files', upload.single('file'), function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart form with field name "file"' });
  var protocol = req.headers['x-forwarded-proto'] || req.protocol;
  var host = req.headers['x-forwarded-host'] || req.get('host');
  var baseUrl = protocol + '://' + host;
  var url = '/api/mycelium/files/' + req.file.filename;
  var fullUrl = baseUrl + url;
  var expiresAt = new Date(Date.now() + FILE_TTL_MS).toISOString();
  emitEvent('file_uploaded', who, null, who + ' uploaded ' + req.file.originalname + ' (' + Math.round(req.file.size / 1024) + 'KB)', { filename: req.file.filename });
  res.json({ ok: true, filename: req.file.filename, url: fullUrl, size: req.file.size, expires_at: expiresAt });
});

// GET /files/:filename — download a file (no auth — public, wget-friendly)
router.get('/files/:filename', function (req, res) {
  var filename = req.params.filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
  var filePath = nodePath.join(FILES_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or expired' });
  res.sendFile(filePath);
});

// GET /files — list available files
router.get('/files', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var now = Date.now();
  var files = [];
  try {
    files = fs.readdirSync(FILES_DIR).map(function (f) {
      var stat = fs.statSync(nodePath.join(FILES_DIR, f));
      var expiresIn = Math.max(0, Math.round((FILE_TTL_MS - (now - stat.mtimeMs)) / 1000));
      var protocol = req.headers['x-forwarded-proto'] || req.protocol;
      var host = req.headers['x-forwarded-host'] || req.get('host');
      return { filename: f, size: stat.size, uploaded: stat.mtime.toISOString(), expires_in_seconds: expiresIn, url: protocol + '://' + host + '/api/mycelium/files/' + f };
    });
  } catch (e) { /* empty */ }
  res.json(files);
});

// =============== BUGS ===============

// POST /bugs — create a bug report (agent or admin)
router.post('/bugs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var { project_id, title, description, category, severity, assignee, diagnostic_data } = req.body;
  var projectId = project_id;
  if (!title || !description) return res.status(400).json({ error: 'title and description are required' });
  if (!validateEnum(res, category, BUG_CATEGORIES, 'category')) return;
  if (!validateEnum(res, severity, BUG_SEVERITIES, 'severity')) return;
  var diagStr = null;
  if (diagnostic_data) {
    diagStr = typeof diagnostic_data === 'string' ? diagnostic_data : JSON.stringify(diagnostic_data);
  }
  var id = createDvBug(projectId, title, description, category, severity, who, assignee, diagStr);
  // Auto-create channel for bug
  var bugMembers = [who];
  if (assignee) bugMembers.push(assignee);
  autoCreateEntityChannel('bug', id, '#bug-' + id + ': ' + title, who, bugMembers);
  emitEvent('bug_created', who, projectId || '', who + ' filed bug #' + id + ': ' + title, { bug_id: id });
  dispatchWebhook('bug_created', who, { bug_id: id, title: title, project_id: projectId, severity: severity, reporter: who, assignee: assignee });
  res.json({ ok: true, id: id });
});

// GET /bugs — list bugs (agent or admin, optional filters: project_id, status, assignee)
router.get('/bugs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {};
  if (req.query.project_id) filters.project_id = req.query.project_id;
  if (req.query.status) filters.status = req.query.status;
  if (req.query.assignee) filters.assignee = req.query.assignee;
  if (req.query.reporter) filters.reporter = req.query.reporter;
  if (req.query.severity) filters.severity = req.query.severity;
  if (req.query.category) filters.category = req.query.category;
  filters.limit = parseLimit(req.query.limit, 50);
  filters.offset = parseInt(req.query.offset) || 0;
  var bugs = listDvBugs(filters);
  var counts = countDvBugs();
  res.json({ bugs: bugs, counts: counts });
});

// GET /bugs/:id — get bug detail
router.get('/bugs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var bug = getDvBug(parseIntParam(req.params.id));
  if (!bug) return res.status(404).json({ error: 'Bug not found' });
  res.json(bug);
});

// PUT /bugs/:id — update bug (status, assignee, admin_notes, severity)
router.put('/bugs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var bug = getDvBug(parseIntParam(req.params.id));
  if (!bug) return res.status(404).json({ error: 'Bug not found' });
  if (!checkProjectScope(req, res, bug.project_id)) return;
  if (!validateEnum(res, req.body.status, BUG_STATUSES, 'status')) return;
  if (!validateEnum(res, req.body.severity, BUG_SEVERITIES, 'severity')) return;
  var updates = {};
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.assignee !== undefined) updates.assignee = req.body.assignee;
  if (req.body.admin_notes !== undefined) updates.admin_notes = req.body.admin_notes;
  if (req.body.severity !== undefined) updates.severity = req.body.severity;
  updateDvBug(bug.id, updates);
  if (updates.status) {
    emitEvent('bug_updated', who, bug.project_id, who + ' set bug #' + bug.id + ' to ' + updates.status, { bug_id: bug.id });
  }
  dispatchWebhook('bug_updated', who, { bug_id: bug.id, title: bug.title, updates: updates });
  // Webhook: notify assignee when bug is assigned
  var bugTarget = updates.assignee || bug.assignee;
  if (bugTarget && (updates.assignee || updates.status)) {
    dispatchWebhook('bug_assigned', bugTarget, { bug_id: bug.id, title: bug.title, status: updates.status || bug.status });
  }
  res.json({ ok: true, id: bug.id });
});

// Delete bug (admin only)
router.delete('/bugs/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var bug = getDvBug(parseIntParam(req.params.id));
  if (!bug) return res.status(404).json({ error: 'Bug not found' });
  deleteDvBug(bug.id);
  emitEvent('bug_deleted', getAdminDisplayName(req), bug.project_id, 'Deleted bug #' + bug.id + ': ' + bug.title, { bug_id: bug.id });
  res.json({ ok: true, id: bug.id });
});

// ======== TEAM CHAT (human-only) ========

// GET /team-chat — list human chat messages
router.get('/team-chat', function (req, res) {
  var user = getStudioUser(req);
  if (!user) {
    // Also allow admin key
    var key = req.headers['x-admin-key'];
    if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Studio login required' });
  }
  var limit = parseLimit(req.query.limit, 50);
  res.json(listDvTeamChat(limit));
});

// POST /team-chat — send a chat message (studio users only)
router.post('/team-chat', function (req, res) {
  var user = getStudioUser(req);
  if (!user) return res.status(403).json({ error: 'Studio login required' });
  var content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });
  var sender = '__user:' + (user.displayName || user.username);
  var id = createDvTeamChat(sender, escapeHtml(content));
  res.json({ ok: true, id: id });
});

// ======== CHANNELS ========

// GET /channels/unread — unread counts (MUST be before :id routes)
router.get('/channels/unread', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var counts = getUnreadCounts(who);
  var result = {};
  for (var c of counts) {
    result[c.channel_id] = { name: c.name, slug: c.slug, unread: c.unread };
  }
  res.json(result);
});

// GET /channels — list channels
router.get('/channels', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    type: req.query.type,
    status: req.query.status,
    member: req.query.member,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  var channels = listChannels(filters);
  // DM channels are private — filter to only include those where the authenticated user is a member.
  // Skip filtering if an explicit member filter is already set, or caller is __system__.
  if (!filters.member && who !== '__system__') {
    channels = channels.filter(function (c) {
      if (c.type !== 'dm') return true;
      return isChannelMember(c.id, who);
    });
  }
  res.json(channels);
});

// POST /channels — create channel (admin only)
router.post('/channels', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var name = escapeHtml(req.body.name);
  var slug = escapeHtml(req.body.slug);
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  var existing = getChannelBySlug(slug);
  if (existing) return res.status(409).json({ error: 'Channel slug already exists', channel_id: existing.id });
  var type = req.body.type || 'general';
  var description = escapeHtml(req.body.description || '');
  var createdBy = getAdminDisplayName(req);
  var id = createChannel(name, slug, type, req.body.linked_type || null, req.body.linked_id || null, description, createdBy);
  if (req.body.members && Array.isArray(req.body.members)) {
    for (var m of req.body.members) {
      addChannelMember(id, m.user_id, m.user_type || 'agent', m.role || 'member');
    }
  }
  emitEvent('channel_created', createdBy, null, createdBy + ' created channel ' + name, { channel_id: id });
  res.json({ ok: true, id: id, name: name, slug: slug });
});

// GET /channels/:id — channel detail + member count
router.get('/channels/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var members = listChannelMembers(channel.id);
  channel.members = members;
  channel.member_count = members.length;
  res.json(channel);
});

// PUT /channels/:id — update channel
router.put('/channels/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!validateEnum(res, req.body.status, CHANNEL_STATUSES, 'status')) return;
  var fields = {};
  if (req.body.name !== undefined) fields.name = escapeHtml(req.body.name);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  updateChannel(channel.id, fields);
  res.json({ ok: true, id: channel.id });
});

// DELETE /channels/:id — delete channel (admin only)
router.delete('/channels/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  deleteChannel(channel.id);
  emitEvent('channel_deleted', getAdminDisplayName(req), null, 'Deleted channel ' + channel.name, { channel_id: channel.id });
  res.json({ ok: true, deleted: channel.id });
});

// -- Channel Members --

router.get('/channels/:id/members', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  res.json(listChannelMembers(channel.id));
});

router.post('/channels/:id/members', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  var added = addChannelMember(channel.id, userId, req.body.user_type || 'agent', req.body.role || 'member');
  res.json({ ok: true, added: added, channel_id: channel.id, user_id: userId });
});

router.delete('/channels/:id/members/:userId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var removed = removeChannelMember(channel.id, req.params.userId);
  res.json({ ok: true, removed: removed });
});

// -- Channel Messages --

router.get('/channels/:id/messages', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  // DM channels are private — only members can read messages
  if (channel.type === 'dm' && who !== '__system__' && !isChannelMember(channel.id, who)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  var filters = {
    before: req.query.before ? parseIntParam(req.query.before) : undefined,
    after: req.query.after ? parseIntParam(req.query.after) : undefined,
    limit: parseLimit(req.query.limit, 50)
  };
  var messages;
  if (channel.slug === 'general') {
    messages = listGeneralChannelMessages(channel.id, filters);
  } else if (channel.slug === 'team-chat') {
    messages = listTeamChatChannelMessages(channel.id, filters);
  } else {
    messages = listChannelMessages(channel.id, filters);
  }
  res.json(messages);
});

router.post('/channels/:id/messages', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  // DM channels are private — only members can post
  if (channel.type === 'dm' && who !== '__system__' && !isChannelMember(channel.id, who)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  var content = req.body.content;
  if (!content) return res.status(400).json({ error: 'content is required' });
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createChannelMessage(channel.id, who, content, metadata);
  emitEvent('channel_message', who, null, who + ' posted in ' + channel.name, { channel_id: channel.id, message_id: id });
  res.json({ ok: true, id: id, channel_id: channel.id });
});

// -- Channel Read Tracking --

router.put('/channels/:id/read', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseIntParam(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var messageId = req.body.message_id || getLatestChannelMessageId(channel.id);
  markChannelRead(channel.id, who, messageId);
  res.json({ ok: true, channel_id: channel.id, last_read_message_id: messageId });
});

// ======== WEBHOOKS ========

// POST /webhooks — register a webhook for an agent
router.post('/webhooks', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { agent_id, url, events, secret } = req.body;
  if (!agent_id || !url) return res.status(400).json({ error: 'agent_id and url are required' });
  var id = createDvWebhook(agent_id, url, events, secret);
  res.json({ ok: true, id: id });
});

// GET /webhooks — list all active webhooks (admin only)
router.get('/webhooks', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agentId = req.query.agent_id || null;
  res.json(listDvWebhooks(agentId));
});

// DELETE /webhooks/:id — remove a webhook
router.delete('/webhooks/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  deleteDvWebhook(parseIntParam(req.params.id));
  res.json({ ok: true });
});

// GET /webhooks/deliveries — delivery log for debugging (admin only)
router.get('/webhooks/deliveries', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var filters = {
    event: req.query.event || undefined,
    webhook_id: req.query.webhook_id ? parseIntParam(req.query.webhook_id) : undefined,
    error_only: req.query.error_only === 'true',
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listWebhookDeliveries(filters));
});

// ======== DRONES ========

// List all drones (agents with project_id='drone') with diagnostics
router.get('/drones', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var drones = listDrones();
  // Enrich each drone with system diagnostics from latest savepoint
  drones = drones.map(function (d) {
    var savepoint = getLatestSavepoint(d.id);
    if (savepoint) {
      try {
        var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
        d.system_info = snapshot.system_info || null;
        d.warnings = snapshot.warnings || [];
        d.worker_version = snapshot.worker_version || null;
      } catch (e) { console.warn('[mycelium] JSON parse failed for state_snapshot (drone: ' + d.id + '):', e.message); }
    }
    return d;
  });
  res.json(drones);
});

// Claim next job matching drone capabilities (drone-side)
router.post('/drones/claim', function (req, res) {
  var agentId = checkAgent(req, res);
  if (!agentId) return;
  var capabilities = req.body.capabilities || [];
  var job = claimDroneJob(agentId, capabilities);
  if (!job) return res.json({ job: null });
  emitEvent('drone_job_claimed', agentId, 'drone', agentId + ' claimed drone job #' + job.id + ': ' + job.title, { job_id: job.id });
  res.json({ job: job });
});

// Submit a drone job
router.post('/drones/jobs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var title = escapeHtml(req.body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  var command = req.body.command || '';
  var inputData = req.body.input_data || {};
  var requires = req.body.requires || ['cpu'];
  var priority = parseInt(req.body.priority) || 0;
  var workspaceRepo = req.body.workspace_repo || null;
  var workspaceBranch = req.body.workspace_branch || 'main';
  var id = createDroneJob(title, command, inputData, requires, who, priority, workspaceRepo, workspaceBranch);
  emitEvent('drone_job_created', who, 'drone', who + ' submitted drone job: ' + title, { job_id: id });
  dispatchWebhook('drone_job_created', who, { job_id: id, title: title, requires: requires, requester: who });
  res.json({ ok: true, id: id, title: title });
});

// List drone jobs (filterable by status, drone_id, requester)
router.get('/drones/jobs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    status: req.query.status,
    drone_id: req.query.drone_id,
    requester: req.query.requester,
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDroneJobs(filters));
});

// Get single drone job
router.get('/drones/jobs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var job = getDroneJob(parseIntParam(req.params.id));
  if (!job) return res.status(404).json({ error: 'Drone job not found' });
  res.json(job);
});

// Update drone job (status, result_url, result_data, error)
router.put('/drones/jobs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var job = getDroneJob(parseIntParam(req.params.id));
  if (!job) return res.status(404).json({ error: 'Drone job not found' });
  // Only the assigned drone, the requester, or an admin can update a job
  var isAdmin = req.headers['x-admin-key'] === ADMIN_KEY || !!getStudioUser(req);
  if (!isAdmin && job.drone_id && job.drone_id !== who && job.requester !== who) {
    return res.status(403).json({ error: 'Not authorized to update this job' });
  }
  var fields = {};
  // Accept 'completed' as alias for 'done'
  var statusVal = req.body.status;
  if (statusVal === 'completed') statusVal = 'done';
  if (!validateEnum(res, statusVal, DRONE_JOB_STATUSES, 'status')) return;
  if (statusVal !== undefined) fields.status = statusVal;
  if (req.body.result_url !== undefined) fields.result_url = req.body.result_url;
  if (req.body.result_data !== undefined) fields.result_data = req.body.result_data;
  if (req.body.error !== undefined) fields.error = req.body.error;
  if (fields.status === 'done' || fields.status === 'failed') {
    fields.completed_at = new Date().toISOString();
  }
  updateDroneJob(job.id, fields);
  if (fields.status) {
    emitEvent('drone_job_' + fields.status, who, 'drone', who + ' set drone job #' + job.id + ' to ' + fields.status, { job_id: job.id, drone_id: job.drone_id });
    // Webhook dispatches for completed/failed
    if (fields.status === 'done') {
      dispatchWebhook('drone_job_completed', job.requester, { job_id: job.id, title: job.title, drone_id: job.drone_id, result_url: fields.result_url });
    }
    if (fields.status === 'failed') {
      dispatchWebhook('drone_job_failed', job.requester, { job_id: job.id, title: job.title, drone_id: job.drone_id, error: fields.error });
    }
    // Auto-update linked assets when job completes
    if (fields.status === 'done' || fields.status === 'failed') {
      var linkedAssets = listAssetsByDroneJob(job.id);
      var assetStatus = fields.status === 'done' ? 'ready' : 'requested';
      for (var asset of linkedAssets) {
        updateDvAsset(asset.id, { status: assetStatus });
      }
      if (linkedAssets.length > 0) {
        emitEvent('assets_status_updated', who, null, linkedAssets.length + ' assets set to ' + assetStatus + ' (job #' + job.id + ' ' + fields.status + ')', { job_id: job.id, asset_count: linkedAssets.length });
      }
    }
    // Smart retry logic for failed drone jobs
    if (fields.status === 'failed') {
      var inputData = {};
      try { inputData = JSON.parse(job.input_data || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for input_data (job: ' + job.id + '):', e.message); }
      var retryCount = inputData._retry_count || 0;
      var failedDrones = inputData._failed_drones || [];
      var originalJobId = inputData._original_job_id || job.id;
      var failedDroneId = job.drone_id;

      if (retryCount < 2) {
        // Retry on same drone (up to 3 attempts: 0, 1, 2)
        var retryInput = Object.assign({}, inputData, {
          _retry_count: retryCount + 1,
          _failed_drones: failedDrones,
          _original_job_id: originalJobId
        });
        var retryId = createDroneJob(job.title + ' (retry ' + (retryCount + 1) + ')', job.command, retryInput, job.requires, job.requester, job.priority, job.workspace_repo, job.workspace_branch);
        emitEvent('drone_job_retry', who, 'drone', 'Auto-retry #' + (retryCount + 1) + ' for job #' + originalJobId + ' -> new job #' + retryId, { original_job_id: originalJobId, retry_job_id: retryId, retry_count: retryCount + 1 });
      } else {
        // 3 failures on this drone — add to failed list, check if all drones exhausted
        if (failedDroneId && failedDrones.indexOf(failedDroneId) === -1) {
          failedDrones.push(failedDroneId);
        }
        var allDrones = listDrones();
        var allDroneIds = allDrones.map(function (d) { return d.id; });
        var allExhausted = allDroneIds.length > 0 && allDroneIds.every(function (did) { return failedDrones.indexOf(did) !== -1; });

        if (allExhausted) {
          // All drones have failed this job — emit exhausted event, don't retry
          emitEvent('drone_job_exhausted', who, 'drone', 'All drones exhausted for job #' + originalJobId + ' — escalating', { original_job_id: originalJobId, failed_drones: failedDrones });
          dispatchWebhook('drone_job_exhausted', job.requester, { job_id: job.id, original_job_id: originalJobId, title: job.title, failed_drones: failedDrones, error: fields.error });
        } else {
          // Reset retry count, put back in queue for next drone
          var resetInput = Object.assign({}, inputData, {
            _retry_count: 0,
            _failed_drones: failedDrones,
            _original_job_id: originalJobId
          });
          var requeueId = createDroneJob(job.title + ' (requeue)', job.command, resetInput, job.requires, job.requester, job.priority, job.workspace_repo, job.workspace_branch);
          emitEvent('drone_job_requeue', who, 'drone', 'Job #' + originalJobId + ' requeued as #' + requeueId + ' after 3 failures on ' + failedDroneId, { original_job_id: originalJobId, requeue_job_id: requeueId, failed_drone: failedDroneId });
        }
      }
    }
  }
  res.json({ ok: true, id: job.id });
});

// Cancel/delete drone job (admin only — works on any status)
router.delete('/drones/jobs/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var job = getDroneJob(parseIntParam(req.params.id));
  if (!job) return res.status(404).json({ error: 'Drone job not found' });
  updateDroneJob(job.id, { status: 'cancelled', completed_at: job.completed_at || new Date().toISOString() });
  emitEvent('drone_job_cancelled', getAdminDisplayName(req), 'drone', 'Cancelled drone job #' + job.id + ' (was: ' + job.status + ')', { job_id: job.id });
  res.json({ ok: true, id: job.id, cancelled: true });
});

// Bulk cleanup: cancel old done/failed jobs (admin only)
// DELETE /drones/jobs?older_than_days=7&status=failed
router.delete('/drones/jobs', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var days = parseInt(req.query.older_than_days) || 0; // 0 = all matching
  var statusFilter = req.query.status || 'failed'; // failed, done, or both
  var statuses = statusFilter === 'both' ? ['failed', 'done'] : [statusFilter];
  if (statuses.some(function (s) { return s !== 'failed' && s !== 'done'; })) {
    return res.status(400).json({ error: 'status must be failed, done, or both' });
  }
  var jobs = bulkCancelDroneJobs(statuses, days);
  emitEvent('drone_jobs_cleanup', getAdminDisplayName(req), 'drone', 'Bulk cancelled ' + jobs.length + ' ' + statusFilter + ' drone jobs', { count: jobs.length });
  res.json({ ok: true, cancelled: jobs.length, jobs: jobs.map(function (j) { return { id: j.id, title: j.title }; }) });
});

// ======== DRONE ARTIFACTS (persistent files — models, LoRAs, etc.) ========
// Must be before /drones/:id to prevent :id from catching "artifacts"

// Upload a drone artifact (persistent, no TTL) — admin or drone agents
router.post('/drones/artifacts', artifactUpload.single('file'), function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart form with field name "file"' });
  var protocol = req.headers['x-forwarded-proto'] || req.protocol;
  var host = req.headers['x-forwarded-host'] || req.get('host');
  var baseUrl = protocol + '://' + host;
  var url = baseUrl + '/api/mycelium/drones/artifacts/' + req.file.filename;
  var sizeStr = req.file.size > 1024 * 1024 ? Math.round(req.file.size / 1024 / 1024) + 'MB' : Math.round(req.file.size / 1024) + 'KB';
  emitEvent('artifact_uploaded', who, 'drone', 'Uploaded drone artifact: ' + req.file.filename + ' (' + sizeStr + ')');
  res.json({ ok: true, name: req.file.filename, url: url, size: req.file.size });
});

// List drone artifacts
router.get('/drones/artifacts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var protocol = req.headers['x-forwarded-proto'] || req.protocol;
  var host = req.headers['x-forwarded-host'] || req.get('host');
  var baseUrl = protocol + '://' + host;
  var artifacts = [];
  try {
    artifacts = fs.readdirSync(ARTIFACTS_DIR).map(function (f) {
      var stat = fs.statSync(nodePath.join(ARTIFACTS_DIR, f));
      return { name: f, size: stat.size, uploaded: stat.mtime.toISOString(), url: baseUrl + '/api/mycelium/drones/artifacts/' + f };
    });
  } catch (e) { /* empty */ }
  res.json(artifacts);
});

// Download a drone artifact (public, no auth — wget/curl friendly)
router.get('/drones/artifacts/:name', function (req, res) {
  var name = req.params.name.replace(/[^a-zA-Z0-9_.\-]/g, '');
  var filePath = nodePath.join(ARTIFACTS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found' });
  res.sendFile(filePath);
});

// Delete a drone artifact (admin only)
router.delete('/drones/artifacts/:name', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var name = req.params.name.replace(/[^a-zA-Z0-9_.\-]/g, '');
  var filePath = nodePath.join(ARTIFACTS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true, deleted: name });
});

// Get single drone + recent jobs + diagnostics (must be after /drones/artifacts to prevent :id catching "artifacts")
router.get('/drones/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var agent = getAgent(req.params.id);
  if (!agent || agent.project_id !== 'drone') return res.status(404).json({ error: 'Drone not found' });
  var { api_key_hash, ...safe } = agent;
  var recentJobs = listDroneJobs({ drone_id: req.params.id, limit: 20 });
  safe.recent_jobs = recentJobs;
  // Include system diagnostics from latest savepoint
  var savepoint = getLatestSavepoint(req.params.id);
  if (savepoint) {
    try {
      var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
      safe.system_info = snapshot.system_info || null;
      safe.warnings = snapshot.warnings || [];
      safe.worker_version = snapshot.worker_version || null;
    } catch (e) { console.warn('[mycelium] JSON parse failed for state_snapshot (drone: ' + req.params.id + '):', e.message); }
  }
  // Error summary from recent failed jobs
  var failedJobs = recentJobs.filter(function (j) { return j.status === 'failed'; });
  if (failedJobs.length > 0) {
    safe.error_summary = failedJobs.slice(0, 5).map(function (j) {
      var resultData = {};
      try { resultData = JSON.parse(j.result_data || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for result_data (job: ' + j.id + '):', e.message); }
      return {
        job_id: j.id,
        title: j.title,
        error_type: resultData.error_type || 'unknown',
        message: (resultData.message || j.error || '').substring(0, 200),
        suggestion: (resultData.suggestion || '').substring(0, 200),
        failed_at: j.completed_at,
      };
    });
  }
  res.json(safe);
});

// =============== APPROVALS ===============

// Request approval for a gated action
router.post('/approvals', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var actionType = req.body.action_type;
  if (!actionType || GATED_ACTIONS.indexOf(actionType) === -1) {
    return res.status(400).json({ error: 'action_type must be one of: ' + GATED_ACTIONS.join(', ') });
  }
  var title = req.body.title;
  if (!title) return res.status(400).json({ error: 'title is required' });
  var payload = req.body.payload;
  if (!payload) return res.status(400).json({ error: 'payload is required' });
  var project = req.body.project || 'mycelium';
  var riskTier = req.body.risk_tier;
  var requiredApprovals = req.body.required_approvals;
  var id = createApproval(actionType, who, title, payload, project, riskTier, requiredApprovals);
  emitEvent('approval_requested', who, project,
    who + ' requested approval: [' + actionType + '] ' + title, JSON.stringify({ approval_id: id, action_type: actionType }));
  dispatchWebhook('approval_requested', who, { approval_id: id, action_type: actionType, title: title, risk_tier: riskTier, requested_by: who });

  // In autonomous mode, queue high/critical approvals for morning instead of blocking
  var effectiveRiskTier = riskTier || 'medium';
  if (isNetworkAutonomous() && (effectiveRiskTier === 'high' || effectiveRiskTier === 'critical')) {
    var sleepConfig = getSleepMode();
    if (sleepConfig.active && sleepConfig.approval_policy === 'queue_high') {
      appendSleepLog('approvals_queued', { id: id, action_type: actionType, title: title, requested_by: who, time: new Date().toISOString() });
      return res.json({ id: id, status: 'queued_for_morning', queued: true, message: 'Queued for operator review — all operators are away. Continue with other work.' });
    }
  }

  res.json({ id: id, status: 'pending', approval_required: true });
});

// List approvals
router.get('/approvals', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    status: req.query.status || undefined,
    action_type: req.query.action_type || undefined,
    requested_by: req.query.requested_by || undefined,
    project: req.query.project || undefined,
    limit: parseLimit(req.query.limit, 50)
  };
  var approvals = listApprovals(filters);
  approvals.forEach(function (a) { try { a.payload = JSON.parse(a.payload); } catch (e) { console.warn('[mycelium] JSON parse failed for approval.payload (id: ' + a.id + '):', e.message); } });
  res.json(approvals);
});

// Get single approval
router.get('/approvals/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var approval = getApproval(parseIntParam(req.params.id));
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  try { approval.payload = JSON.parse(approval.payload); } catch (e) { console.warn('[mycelium] JSON parse failed for approval.payload (id: ' + approval.id + '):', e.message); }
  res.json(approval);
});

// Approve or deny (admin only)
router.put('/approvals/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var approval = getApproval(parseIntParam(req.params.id));
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval already ' + approval.status });
  var newStatus = req.body.status;
  if (newStatus !== 'approved' && newStatus !== 'denied') {
    return res.status(400).json({ error: 'status must be approved or denied' });
  }
  var reason = req.body.reason || '';
  var decidedBy = getAdminDisplayName(req);
  decideApproval(approval.id, newStatus, decidedBy, reason);
  emitEvent('approval_' + newStatus, decidedBy, approval.project,
    decidedBy + ' ' + newStatus + ' [' + approval.action_type + '] ' + approval.title,
    JSON.stringify({ approval_id: approval.id, action_type: approval.action_type }));
  res.json({ ok: true, id: approval.id, status: newStatus });
});

// Mark approved action as executed
router.put('/approvals/:id/executed', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var approval = getApproval(parseIntParam(req.params.id));
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  if (approval.status !== 'approved') return res.status(400).json({ error: 'Approval is ' + approval.status + ', not approved' });
  markApprovalExecuted(approval.id);
  emitEvent('approval_executed', who, approval.project,
    who + ' executed [' + approval.action_type + '] ' + approval.title,
    JSON.stringify({ approval_id: approval.id }));
  res.json({ ok: true, id: approval.id, status: 'executed' });
});

// Vote on an approval (quorum-based)
router.put('/approvals/:id/vote', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var who = req.headers['x-admin-key'] ? '__admin__' : 'studio_user';
  var approval = getApproval(parseIntParam(req.params.id));
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval is already ' + approval.status });

  var vote = req.body.vote || 'approve';
  var notes = req.body.notes || '';
  if (vote !== 'approve' && vote !== 'deny') return res.status(400).json({ error: 'vote must be approve or deny' });

  // Any single deny = instant denial
  if (vote === 'deny') {
    castApprovalVote(approval.id, who, 'deny', notes);
    decideApproval(approval.id, 'denied', who, notes || 'Denied by ' + who);
    emitEvent('approval_denied', who, null, who + ' denied approval #' + approval.id + ': ' + approval.title);
    return res.json({ ok: true, status: 'denied', message: 'Approval denied.' });
  }

  // Cast approve vote
  castApprovalVote(approval.id, who, 'approve', notes);
  var counts = countApprovalVotes(approval.id);

  // Check if quorum reached
  if (counts.approves >= approval.required_approvals) {
    decideApproval(approval.id, 'approved', who, 'Quorum reached (' + counts.approves + '/' + approval.required_approvals + ')');
    emitEvent('approval_approved', who, null, who + ' approved #' + approval.id + ': ' + approval.title + ' (quorum reached)');
    return res.json({ ok: true, status: 'approved', votes: counts, message: 'Quorum reached. Approval granted.' });
  }

  emitEvent('approval_vote', who, null, who + ' voted approve on #' + approval.id + ' (' + counts.approves + '/' + approval.required_approvals + ')');
  res.json({ ok: true, status: 'pending', votes: counts, remaining: approval.required_approvals - counts.approves });
});

router.get('/approvals/:id/votes', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(getApprovalVotes(parseIntParam(req.params.id)));
});

// ======== WORK ROUTING ========

router.post('/work/request', function (req, res) {
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
  var msgId = createDvRequest(who, adminAgentId, null, null,
    JSON.stringify({ type: type, target: target || null, description: description || '', priority: priority || 'normal' }),
    JSON.stringify({ work_request: true, type: type })
  );

  emitEvent('work_request', who, null, who + ' requested work: ' + type + (target ? ' \u2192 ' + target : ''));
  res.json({ ok: true, message_id: msgId, routed_to: adminAgentId });
});

// ======== PLUGINS ========

router.get('/plugins', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listPluginRecords());
});

router.get('/plugins/mcp-tools', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(getPluginMcpTools());
});

router.get('/plugins/:name', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  res.json(record);
});

router.put('/plugins/:name/enable', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  updatePluginEnabled(req.params.name, 1);
  emitEvent('plugin_enabled', getAdminDisplayName(req), null, 'Enabled plugin: ' + req.params.name);
  res.json({ ok: true, name: req.params.name, enabled: 1 });
});

router.put('/plugins/:name/disable', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  updatePluginEnabled(req.params.name, 0);
  emitEvent('plugin_disabled', getAdminDisplayName(req), null, 'Disabled plugin: ' + req.params.name);
  res.json({ ok: true, name: req.params.name, enabled: 0 });
});

// ======== BACKUPS ========
router.get('/admin/backups', function (req, res) {
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
    res.status(500).json({ error: 'Failed to list backups: ' + e.message });
  }
});

// ======== API DOCS ========
router.get('/docs', function (req, res) {
  var routes = [];
  router.stack.forEach(function (layer) {
    if (!layer.route) return;
    var route = layer.route;
    var methods = Object.keys(route.methods).map(function (m) { return m.toUpperCase(); });
    // Detect auth by scanning handler source for checkAdmin/checkAgent calls
    var handlerSrc = route.stack.map(function (s) { return s.handle.toString().substring(0, 200); }).join(' ');
    var auth = 'public';
    if (handlerSrc.indexOf('checkAdmin') !== -1 && handlerSrc.indexOf('checkAgentOrAdmin') === -1) auth = 'admin';
    else if (handlerSrc.indexOf('checkAgentOrAdmin') !== -1) auth = 'agent-or-admin';
    else if (handlerSrc.indexOf('checkAgent') !== -1) auth = 'agent';
    methods.forEach(function (method) {
      routes.push({ method: method, path: route.path, auth: auth });
    });
  });
  res.json({ routes: routes, count: routes.length });
});

// ======== FEEDBACK ========

// GET /feedback/summary — aggregate stats
router.get('/feedback/summary', checkAdmin, asyncHandler(async function (req, res) {
  var summary = getFeedbackSummary();
  res.json(summary);
}));

// GET /feedback — list with optional filters
router.get('/feedback', checkAdmin, asyncHandler(async function (req, res) {
  var filters = {
    entity_type: req.query.entity_type || '',
    agent_id: req.query.agent_id || '',
    submitted_by: req.query.submitted_by || '',
    rating: req.query.rating || '',
    min_rating: req.query.min_rating || '',
    limit: parseIntParam(req.query.limit) || 50,
    offset: parseIntParam(req.query.offset) || 0,
  };
  // Clear empty strings so listFeedback ignores them
  Object.keys(filters).forEach(function (k) { if (filters[k] === '') delete filters[k]; });
  res.json(listFeedback(filters));
}));

// POST /feedback — submit feedback
router.post('/feedback', checkAgentOrAdmin, asyncHandler(async function (req, res) {
  var { entity_type, entity_id, subject, rating, comment, agent_id } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return apiError(res, 400, 'rating must be 1-5');
  }
  var submittedBy = req.agent ? req.agent.id : (req.studioUser ? req.studioUser.username : 'operator');
  var id = createFeedback(entity_type, entity_id, subject, rating, comment, submittedBy, agent_id || '');
  var record = getFeedback(id);
  emitEvent('feedback_submitted', submittedBy, '', JSON.stringify({ id, rating, entity_type, agent_id }));
  res.status(201).json(record);
}));

// DELETE /feedback/:id
router.delete('/feedback/:id', checkAdmin, asyncHandler(async function (req, res) {
  var id = parseIntParam(req.params.id);
  if (!id) return apiError(res, 400, 'Invalid feedback id');
  var record = getFeedback(id);
  if (!record) return apiError(res, 404, 'Feedback not found');
  deleteFeedback(id);
  res.json({ ok: true });
}));

// ======== LOAD PLUGINS ========
// Called from index.js after DB init
export async function initPlugins() {
  var pluginCore = {
    db: getDB(),
    auth: { checkAgentOrAdmin, checkAdmin, getAdminDisplayName },
    emitEvent, checkApprovalGate, gatedActions: GATED_ACTIONS,
    apiError, parseIntParam, validateEnum
  };
  await loadPlugins(pluginCore, router);
}

export default router;
