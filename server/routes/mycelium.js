// =============== DIOVERSE HUB — Distributed Game Studio API ===============
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
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
var upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } });
import {
  createAgent, getAgent, listAgents, updateAgentHeartbeat, deleteAgent,
  createGame, listGames, getGame,
  createDvTask, getDvTask, listDvTasks, updateDvTask,
  setTaskDependency, resolveTaskDependencies,
  approveDvTask, listTasksNeedingApproval,
  getDvContext, getAllDvContext, upsertDvContext,
  upsertDvContextKey, getDvContextKey, listDvContextKeys, deleteDvContextKey,
  createDvAsset, getDvAsset, listDvAssets, updateDvAsset,
  autoTaskFromAsset,
  createDvEvent, listDvEvents,
  createDvMessage, createDvRequest, getDvMessage,
  acknowledgeDvMessage, resolveDvMessage, listPendingRequests,
  listDvMessages, listDvThreads,
  getBootPayload, getDvOverview,
  createDvBug, getDvBug, listDvBugs, updateDvBug, countDvBugs,
  createDvPlan, getDvPlan, listDvPlans, updateDvPlan, deleteDvPlan,
  createDvPlanStep, updateDvPlanStep, deleteDvPlanStep, reorderDvPlanSteps,
  completeLinkedPlanSteps,
  createStudioUser, getStudioUserByUsername, getStudioUserById,
  listStudioUsers, deleteStudioUser, updateStudioUser,
  createDvWebhook, listDvWebhooks, deleteDvWebhook, dispatchWebhook,
  createDvTeamChat, listDvTeamChat,
  createDroneJob, getDroneJob, claimDroneJob, updateDroneJob, listDroneJobs, listDrones
} from '../db.js';

var ADMIN_KEY = process.env.ADMIN_KEY;
var JWT_SECRET = process.env.JWT_SECRET;
var STUDIO_JWT_EXPIRY = '7d';

var HTML_ESCAPE_MAP = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[<>&"']/g, function (ch) { return HTML_ESCAPE_MAP[ch]; });
}

// ---- Mycelium: project ↔ game normalization ----
// Accept "project" as alias for "game" in requests. Return both in responses.
// DB stays "game" internally — this is a translation layer.

// Normalize incoming: accept project OR game in body/query
function normalizeProjectField(req, res, next) {
  if (req.body && req.body.project !== undefined && req.body.game === undefined) {
    req.body.game = req.body.project;
  }
  if (req.query && req.query.project !== undefined && req.query.game === undefined) {
    req.query.game = req.query.project;
  }
  // Wrap res.json to enrich outgoing data with "project" alongside "game"
  var originalJson = res.json.bind(res);
  res.json = function (data) { return originalJson(addProjectField(data)); };
  next();
}

// Recursively add "project" field wherever "game" appears in response data
function addProjectField(obj) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(addProjectField);
  var result = {};
  for (var key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (key === 'game') {
      result.game = obj.game;
      result.project = obj.game;
    } else if (key === 'games') {
      result.games = addProjectField(obj.games);
      result.projects = result.games;
    } else {
      result[key] = addProjectField(obj[key]);
    }
  }
  return result;
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

// Agent auth: validates X-Agent-Key header, sets req.agentId
function checkAgent(req, res) {
  var key = req.headers['x-agent-key'];
  if (!key) {
    res.status(401).json({ error: 'Missing X-Agent-Key header' });
    return null;
  }
  // Check all agents for matching key
  var agents = listAgents();
  for (var a of agents) {
    var full = getAgent(a.id);
    if (full && bcrypt.compareSync(key, full.api_key_hash)) {
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
  if (user) return true;
  // Try admin key
  var key = req.headers['x-admin-key'];
  if (key === ADMIN_KEY) return true;
  res.status(403).json({ error: 'Invalid admin key' });
  return false;
}

// Get display name for admin user (studio JWT display_name, or fallback)
function getAdminDisplayName(req) {
  var user = getStudioUser(req);
  if (user) return user.displayName || user.username;
  return '__admin__';
}

// Either agent or admin — returns display name / agent ID
function checkAgentOrAdmin(req, res) {
  // Try studio JWT first
  var user = getStudioUser(req);
  if (user) return user.displayName || user.username;
  // Try admin key
  var adminKey = req.headers['x-admin-key'];
  if (adminKey === ADMIN_KEY) return '__admin__';
  // Try agent key
  return checkAgent(req, res);
}

// ---- Event helper ----
function emitEvent(type, agentId, game, summary, data) {
  createDvEvent(type, agentId || '', game || null, summary || '', JSON.stringify(data || {}));
}

// ---- Router ----

var router = Router();

// Apply project↔game normalization + response enrichment to all routes
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
  emitEvent('agent_boot', agentId, null, agentId + ' booted');
  res.json(payload);
});

// ======== AGENTS ========

router.post('/agents/heartbeat', function (req, res) {
  var agentId = checkAgent(req, res);
  if (!agentId) return;
  var status = req.body.status || 'online';
  var workingOn = escapeHtml(req.body.working_on || '');
  updateAgentHeartbeat(agentId, status, workingOn);
  emitEvent('agent_heartbeat', agentId, null, agentId + ' is ' + status + (workingOn ? ': ' + workingOn : ''));
  res.json({ ok: true, agent: agentId, status: status });
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

// ======== TASKS ========

router.get('/tasks/approval-queue', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listTasksNeedingApproval());
});

router.get('/tasks', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    game: req.query.game,
    status: req.query.status,
    assignee: req.query.assignee,
    requester: req.query.requester,
    limit: parseInt(req.query.limit) || 50,
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
  var game = escapeHtml(req.body.game || 'dioverse');
  var priority = req.body.priority || 'normal';
  var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
  var id = createDvTask(title, description, game, agentId, priority, tags);
  // Handle optional fields
  var updates = {};
  if (req.body.assignee) updates.assignee = req.body.assignee;
  if (req.body.needs_approval) updates.needs_approval = 1;
  if (Object.keys(updates).length > 0) updateDvTask(id, updates);
  emitEvent('task_created', agentId, game, agentId + ' created task: ' + title, { task_id: id });
  if (req.body.assignee) {
    dispatchWebhook('task_created', req.body.assignee, { task_id: id, title: title });
  }
  res.json({ id: id, title: title });
});

router.get('/tasks/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.put('/tasks/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var task = getDvTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
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
    var unblocked = resolveTaskDependencies(task.id);
    if (unblocked.length > 0) {
      result.unblocked = unblocked;
      for (var uid of unblocked) {
        emitEvent('task_unblocked', agentId, task.game, 'Task #' + uid + ' unblocked by completion of #' + task.id, { task_id: uid, completed_task_id: task.id });
      }
    }
    // Auto-deliver linked asset
    if (task.linked_asset_id) {
      updateDvAsset(task.linked_asset_id, { status: 'delivered' });
      emitEvent('asset_delivered', agentId, task.game, 'Asset #' + task.linked_asset_id + ' auto-delivered (task #' + task.id + ' done)', { asset_id: task.linked_asset_id, task_id: task.id });
    }
    // Auto-complete linked plan steps
    var planResult = completeLinkedPlanSteps(task.id);
    if (planResult.steps_completed > 0) {
      result.plan_steps_completed = planResult.steps_completed;
      emitEvent('plan_step_completed', agentId, task.game, planResult.steps_completed + ' plan step(s) auto-completed by task #' + task.id, { task_id: task.id, steps: planResult.steps_completed });
    }
    if (planResult.plans_completed.length > 0) {
      for (var pid of planResult.plans_completed) {
        emitEvent('plan_completed', agentId, task.game, 'Plan #' + pid + ' auto-completed (all steps done)', { plan_id: pid, task_id: task.id });
      }
      result.plans_completed = planResult.plans_completed;
    }
    // Auto-resolve linked request
    if (task.request_id) {
      try {
        var linkedReq = getDvMessage(task.request_id);
        if (linkedReq && linkedReq.status !== 'resolved') {
          resolveDvMessage(task.request_id, agentId);
          emitEvent('request_resolved', agentId, task.game, 'Request #' + task.request_id + ' auto-resolved (task #' + task.id + ' done)', { message_id: task.request_id, task_id: task.id });
        }
      } catch (e) { /* non-critical */ }
    }
  }

  if (fields.status) {
    emitEvent('task_' + fields.status, agentId, task.game, agentId + ' set task #' + task.id + ' to ' + fields.status, { task_id: task.id });
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
  var taskId = parseInt(req.params.id);
  var blockedById = parseInt(req.body.blocked_by);
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
  var task = getDvTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.needs_approval) return res.status(400).json({ error: 'Task does not require approval' });
  if (task.approved_by) return res.status(400).json({ error: 'Task already approved by ' + task.approved_by });
  approveDvTask(task.id, '__admin__');
  emitEvent('task_approved', '__admin__', task.game, 'Admin approved task #' + task.id + ': ' + task.title, { task_id: task.id });
  res.json({ ok: true, id: task.id, approved: true });
});

// ======== CONTEXT ========

// Namespaced context (must be before :game param route)
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

// Legacy per-game context
router.get('/context', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(getAllDvContext());
});

router.get('/context/:game', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var ctx = getDvContext(req.params.game);
  if (!ctx) return res.json({ game: req.params.game, data: '{}', updated_at: null, updated_by: '' });
  res.json(ctx);
});

router.put('/context/:game', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var data = req.body.data;
  if (data === undefined) return res.status(400).json({ error: 'data field is required' });
  var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  upsertDvContext(req.params.game, dataStr, agentId);
  emitEvent('context_updated', agentId, req.params.game, agentId + ' updated context for ' + req.params.game);
  res.json({ ok: true, game: req.params.game });
});

// ======== ASSETS ========

router.get('/assets', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    game: req.query.game,
    type: req.query.type,
    status: req.query.status,
    limit: parseInt(req.query.limit) || 50,
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
  var game = req.body.game || 'shared';
  var status = req.body.status || 'requested';
  var assetPath = req.body.path || '';
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createDvAsset(name, type, game, status, assetPath, metadata, agentId);
  emitEvent('asset_registered', agentId, game, agentId + ' registered asset: ' + name, { asset_id: id });

  var result = { id: id, name: name };

  // Auto-create task for asset requests
  if (status === 'requested') {
    var taskResult = autoTaskFromAsset(id, game, agentId);
    if (taskResult) {
      result.task_id = taskResult.task_id;
      result.assigned_to = taskResult.assignee;
      emitEvent('task_created', agentId, game, 'Auto-task for asset ' + name + ' assigned to ' + (taskResult.assignee || 'unassigned'), { asset_id: id, task_id: taskResult.task_id });
    }
  }

  res.json(result);
});

router.get('/assets/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseInt(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  res.json(asset);
});

router.put('/assets/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var asset = getDvAsset(parseInt(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  var fields = {};
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.path !== undefined) fields.path = req.body.path;
  if (req.body.metadata !== undefined) fields.metadata = JSON.stringify(req.body.metadata);
  updateDvAsset(asset.id, fields);
  if (fields.status) {
    emitEvent('asset_' + fields.status, agentId, asset.game, agentId + ' set asset ' + asset.name + ' to ' + fields.status, { asset_id: asset.id });
  }
  res.json({ ok: true, id: asset.id });
});

// ======== EVENTS ========

router.get('/events', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    since: req.query.since,
    game: req.query.game,
    type: req.query.type,
    agent: req.query.agent,
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvEvents(filters));
});

router.post('/events', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var type = req.body.type || 'custom';
  var game = req.body.game || null;
  var summary = escapeHtml(req.body.summary || '');
  var data = req.body.data ? JSON.stringify(req.body.data) : '{}';
  var id = createDvEvent(type, agentId, game, summary, data);
  res.json({ id: id });
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
  var game = req.body.game || null;
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createDvRequest(agentId, toAgent, threadId, game, content, metadata);
  var target = toAgent ? ' to ' + toAgent : ' (broadcast)';
  emitEvent('request_created', agentId, game, agentId + ' sent request' + target, { message_id: id });
  if (toAgent) {
    dispatchWebhook('request_created', toAgent, { message_id: id, from: agentId, content: content.substring(0, 200) });
  }

  var result = { id: id };

  // Auto-create task if requested
  if (req.body.auto_task && toAgent) {
    var title = escapeHtml(req.body.task_title || content.substring(0, 80));
    var taskId = createDvTask(title, content, game || 'dioverse', agentId, req.body.priority || 'normal', '[]');
    updateDvTask(taskId, { assignee: toAgent, request_id: id });
    result.task_id = taskId;
    emitEvent('task_created', agentId, game, 'Auto-task from request: ' + title + ' → ' + toAgent, { task_id: taskId, message_id: id });
  }

  res.json(result);
});

router.put('/requests/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var msg = getDvMessage(parseInt(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Request not found' });
  if (msg.msg_type !== 'request') return res.status(400).json({ error: 'Message #' + msg.id + ' is not a request' });

  var status = req.body.status;
  if (!status) return res.status(400).json({ error: 'status is required (acknowledged, resolved, completed)' });

  if (status === 'acknowledged' || status === 'ack') {
    acknowledgeDvMessage(msg.id);
    emitEvent('request_acknowledged', agentId, msg.game, agentId + ' acknowledged request #' + msg.id, { message_id: msg.id });
    return res.json({ ok: true, id: msg.id, status: 'acknowledged' });
  }

  if (status === 'resolved' || status === 'completed' || status === 'done') {
    resolveDvMessage(msg.id, agentId);
    emitEvent('request_resolved', agentId, msg.game, agentId + ' resolved request #' + msg.id, { message_id: msg.id });
    var result = { ok: true, id: msg.id, status: 'resolved' };
    if (req.body.response) {
      var responseId = createDvMessage(agentId, msg.from_agent, msg.thread_id, msg.game, req.body.response, '{}');
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
    game: req.query.game,
    since: req.query.since,
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvMessages(filters));
});

router.post('/messages', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var content = req.body.content;
  if (!content) return res.status(400).json({ error: 'content is required' });
  var toAgent = req.body.to_agent || null;
  var threadId = req.body.thread_id || null;
  var game = req.body.game || null;
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createDvMessage(agentId, toAgent, threadId, game, content, metadata);
  var target = toAgent ? ' to ' + toAgent : ' (broadcast)';
  emitEvent('message_sent', agentId, game, agentId + ' sent message' + target, { message_id: id });
  if (toAgent) {
    dispatchWebhook('message_sent', toAgent, { message_id: id, from: agentId, content: content.substring(0, 200) });
  }
  res.json({ id: id });
});

router.put('/messages/:id/ack', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var msg = getDvMessage(parseInt(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  acknowledgeDvMessage(msg.id);
  emitEvent('request_acknowledged', agentId, msg.game, agentId + ' acknowledged request #' + msg.id, { message_id: msg.id });
  res.json({ ok: true, id: msg.id, status: 'acknowledged' });
});

router.put('/messages/:id/resolve', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var msg = getDvMessage(parseInt(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  resolveDvMessage(msg.id, agentId);
  emitEvent('request_resolved', agentId, msg.game, agentId + ' resolved request #' + msg.id, { message_id: msg.id });

  var result = { ok: true, id: msg.id, status: 'resolved' };

  // Optionally send a response message back
  if (req.body.response) {
    var responseId = createDvMessage(agentId, msg.from_agent, msg.thread_id, msg.game, req.body.response, '{}');
    result.response_id = responseId;
  }

  res.json(result);
});

router.get('/messages/threads', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listDvThreads(parseInt(req.query.limit) || 20));
});

// ======== PLANS ========

router.get('/plans', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    game: req.query.game,
    status: req.query.status,
    owner: req.query.owner,
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDvPlans(filters));
});

router.post('/plans', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var title = escapeHtml(req.body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  var description = escapeHtml(req.body.description || '');
  var game = escapeHtml(req.body.game || 'dioverse');
  var owner = escapeHtml(req.body.owner || '');
  var priority = req.body.priority || 'normal';
  var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
  var id = createDvPlan(title, description, game, owner, priority, tags, agentId);
  emitEvent('plan_created', agentId, game, agentId + ' created plan: ' + title, { plan_id: id });
  res.json({ id: id, title: title });
});

router.get('/plans/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var plan = getDvPlan(parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json(plan);
});

router.put('/plans/:id', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  var fields = {};
  if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.owner !== undefined) fields.owner = escapeHtml(req.body.owner);
  if (req.body.priority !== undefined) fields.priority = req.body.priority;
  if (req.body.tags !== undefined) fields.tags = req.body.tags;
  if (req.body.game !== undefined) fields.game = escapeHtml(req.body.game);
  updateDvPlan(plan.id, fields);
  if (fields.status) {
    emitEvent('plan_' + fields.status, agentId, plan.game, agentId + ' set plan #' + plan.id + ' to ' + fields.status, { plan_id: plan.id });
  }
  res.json({ ok: true, id: plan.id });
});

router.delete('/plans/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var plan = getDvPlan(parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  deleteDvPlan(plan.id);
  emitEvent('plan_deleted', '__admin__', plan.game, 'Admin deleted plan #' + plan.id + ': ' + plan.title, { plan_id: plan.id });
  res.json({ ok: true, deleted: plan.id });
});

// -- Plan Steps --

router.post('/plans/:id/steps', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var plan = getDvPlan(parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
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
  emitEvent('plan_step_added', agentId, plan.game, agentId + ' added step to plan #' + plan.id + ': ' + title, { plan_id: plan.id, step_id: stepId });
  res.json({ id: stepId, plan_id: plan.id });
});

router.put('/plans/:id/steps/:stepId', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var fields = {};
  if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.assignee !== undefined) fields.assignee = req.body.assignee;
  if (req.body.linked_task_id !== undefined) fields.linked_task_id = req.body.linked_task_id;
  if (req.body.linked_branch !== undefined) fields.linked_branch = req.body.linked_branch;
  if (req.body.linked_pr_url !== undefined) fields.linked_pr_url = req.body.linked_pr_url;
  if (req.body.phase !== undefined) fields.phase = escapeHtml(req.body.phase);
  updateDvPlanStep(parseInt(req.params.stepId), fields);
  res.json({ ok: true, step_id: parseInt(req.params.stepId) });
});

router.delete('/plans/:id/steps/:stepId', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  deleteDvPlanStep(parseInt(req.params.stepId));
  res.json({ ok: true, deleted: parseInt(req.params.stepId) });
});

router.put('/plans/:id/reorder', function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  var order = req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of step IDs' });
  reorderDvPlanSteps(parseInt(req.params.id), order);
  res.json({ ok: true, plan_id: parseInt(req.params.id) });
});

// ======== STUDIO AUTH ========

// Login — returns JWT
router.post('/studio/login', function (req, res) {
  var username = (req.body.username || '').trim().toLowerCase();
  var password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  var user = getStudioUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
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
});

// Who am I
router.get('/studio/me', function (req, res) {
  var user = getStudioUser(req);
  if (!user) {
    // Check admin key
    var key = req.headers['x-admin-key'];
    if (key === ADMIN_KEY) return res.json({ id: 0, username: 'admin', display_name: '__admin__', role: 'admin' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  var dbUser = getStudioUserById(user.userId);
  if (!dbUser) return res.status(401).json({ error: 'User not found' });
  res.json(dbUser);
});

// Register new studio user (admin only)
router.post('/studio/users', function (req, res) {
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
  var hash = bcrypt.hashSync(password, 10);
  var id = createStudioUser(username, displayName, hash, role);
  emitEvent('studio_user_created', getAdminDisplayName(req), null, 'Studio user created: ' + displayName + ' (' + username + ')');
  res.json({ id: id, username: username, display_name: displayName, role: role });
});

// List studio users (admin only)
router.get('/studio/users', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listStudioUsers());
});

// Update studio user password (admin only)
router.put('/studio/users/:id/password', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  var newPassword = req.body.password || '';
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  var hash = bcrypt.hashSync(newPassword, 10);
  updateStudioUser(user.id, { password_hash: hash });
  res.json({ ok: true, username: user.username });
});

// Delete studio user (admin only)
router.delete('/studio/users/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteStudioUser(user.id);
  res.json({ ok: true, deleted: user.username });
});

// ======== ADMIN ========

// Register new agent (returns plaintext API key — store it, shown only once)
router.post('/admin/agents', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var id = req.body.id;
  var name = req.body.name;
  var game = req.body.game;
  if (!id || !name || !game) return res.status(400).json({ error: 'id, name, and game are required' });
  // Check if exists
  if (getAgent(id)) return res.status(409).json({ error: 'Agent ' + id + ' already exists' });
  // Generate API key
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = bcrypt.hashSync(apiKey, 10);
  var capabilities = req.body.capabilities ? JSON.stringify(req.body.capabilities) : '["code","assets"]';
  createAgent(id, name, game, hash, capabilities);
  emitEvent('agent_registered', '__admin__', null, 'Admin registered agent: ' + id);
  res.json({ id: id, api_key: apiKey, message: 'Store this key — it will not be shown again' });
});

router.delete('/admin/agents/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  deleteAgent(req.params.id);
  emitEvent('agent_removed', '__admin__', null, 'Admin removed agent: ' + req.params.id);
  res.json({ ok: true, deleted: req.params.id });
});

// Full studio overview (for dashboard)
router.get('/admin/overview', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(getDvOverview());
});

// List projects
router.get('/projects', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listGames());
});
router.get('/games', function (req, res) { // backward compat
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listGames());
});

// Create project (admin only)
router.post('/projects', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { id, name, description, repo_url } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  createGame(id, name, description || '', repo_url || '');
  var project = getGame(id);
  emitEvent('project_created', getAdminDisplayName(req), id, 'Project created: ' + name);
  res.json(project);
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
      return { filename: f, size: stat.size, uploaded: stat.mtime.toISOString(), expires_in_seconds: expiresIn, url: 'https://willingsacrifice.com/api/dioverse/files/' + f };
    });
  } catch (e) { /* empty */ }
  res.json(files);
});

// =============== BUGS ===============

var VALID_BUG_CATEGORIES = ['gameplay', 'ui', 'crash', 'api', 'infrastructure', 'balance', 'other'];
var VALID_BUG_SEVERITIES = ['low', 'normal', 'high', 'critical'];

// POST /bugs — create a bug report (agent or admin)
router.post('/bugs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var { game, title, description, category, severity, assignee, diagnostic_data } = req.body;
  if (!title || !description) return res.status(400).json({ error: 'title and description are required' });
  if (category && VALID_BUG_CATEGORIES.indexOf(category) === -1) {
    return res.status(400).json({ error: 'Invalid category. Valid: ' + VALID_BUG_CATEGORIES.join(', ') });
  }
  if (severity && VALID_BUG_SEVERITIES.indexOf(severity) === -1) {
    return res.status(400).json({ error: 'Invalid severity. Valid: ' + VALID_BUG_SEVERITIES.join(', ') });
  }
  var diagStr = null;
  if (diagnostic_data) {
    diagStr = typeof diagnostic_data === 'string' ? diagnostic_data : JSON.stringify(diagnostic_data);
  }
  var id = createDvBug(game, title, description, category, severity, who, assignee, diagStr);
  emitEvent('bug_created', who, game || 'dioverse', who + ' filed bug #' + id + ': ' + title, { bug_id: id });
  res.json({ ok: true, id: id });
});

// GET /bugs — list bugs (agent or admin, optional filters: game, status, assignee)
router.get('/bugs', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {};
  if (req.query.game) filters.game = req.query.game;
  if (req.query.status) filters.status = req.query.status;
  if (req.query.assignee) filters.assignee = req.query.assignee;
  if (req.query.reporter) filters.reporter = req.query.reporter;
  filters.limit = parseInt(req.query.limit) || 50;
  filters.offset = parseInt(req.query.offset) || 0;
  var bugs = listDvBugs(filters);
  var counts = countDvBugs();
  res.json({ bugs: bugs, counts: counts });
});

// GET /bugs/:id — get bug detail
router.get('/bugs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var bug = getDvBug(parseInt(req.params.id));
  if (!bug) return res.status(404).json({ error: 'Bug not found' });
  res.json(bug);
});

// PUT /bugs/:id — update bug (status, assignee, admin_notes, severity)
router.put('/bugs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var bug = getDvBug(parseInt(req.params.id));
  if (!bug) return res.status(404).json({ error: 'Bug not found' });
  var updates = {};
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.assignee !== undefined) updates.assignee = req.body.assignee;
  if (req.body.admin_notes !== undefined) updates.admin_notes = req.body.admin_notes;
  if (req.body.severity !== undefined) updates.severity = req.body.severity;
  updateDvBug(bug.id, updates);
  if (updates.status) {
    emitEvent('bug_updated', who, bug.game, who + ' set bug #' + bug.id + ' to ' + updates.status, { bug_id: bug.id });
  }
  // Webhook: notify assignee when bug is assigned
  var bugTarget = updates.assignee || bug.assignee;
  if (bugTarget && (updates.assignee || updates.status)) {
    dispatchWebhook('bug_assigned', bugTarget, { bug_id: bug.id, title: bug.title, status: updates.status || bug.status });
  }
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
  var limit = parseInt(req.query.limit) || 50;
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
  deleteDvWebhook(parseInt(req.params.id));
  res.json({ ok: true });
});

// ======== DRONES ========

// List all drones (agents with game='drone')
router.get('/drones', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var drones = listDrones();
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
  var id = createDroneJob(title, command, inputData, requires, who, priority);
  emitEvent('drone_job_created', who, 'drone', who + ' submitted drone job: ' + title, { job_id: id });
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
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listDroneJobs(filters));
});

// Get single drone job
router.get('/drones/jobs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var job = getDroneJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Drone job not found' });
  res.json(job);
});

// Update drone job (status, result_url, result_data, error)
router.put('/drones/jobs/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var job = getDroneJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Drone job not found' });
  // Only the assigned drone, the requester, or an admin can update a job
  var isAdmin = req.headers['x-admin-key'] === ADMIN_KEY || !!getStudioUser(req);
  if (!isAdmin && job.drone_id && job.drone_id !== who && job.requester !== who) {
    return res.status(403).json({ error: 'Not authorized to update this job' });
  }
  var fields = {};
  if (req.body.status !== undefined) fields.status = req.body.status;
  if (req.body.result_url !== undefined) fields.result_url = req.body.result_url;
  if (req.body.result_data !== undefined) fields.result_data = req.body.result_data;
  if (req.body.error !== undefined) fields.error = req.body.error;
  if (req.body.status === 'done' || req.body.status === 'failed') {
    fields.completed_at = new Date().toISOString();
  }
  updateDroneJob(job.id, fields);
  if (fields.status) {
    emitEvent('drone_job_' + fields.status, who, 'drone', who + ' set drone job #' + job.id + ' to ' + fields.status, { job_id: job.id, drone_id: job.drone_id });
  }
  res.json({ ok: true, id: job.id });
});

// Cancel pending drone job (admin only)
router.delete('/drones/jobs/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var job = getDroneJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Drone job not found' });
  if (job.status !== 'pending') return res.status(400).json({ error: 'Can only cancel pending jobs' });
  updateDroneJob(job.id, { status: 'cancelled', completed_at: new Date().toISOString() });
  emitEvent('drone_job_cancelled', getAdminDisplayName(req), 'drone', 'Cancelled drone job #' + job.id, { job_id: job.id });
  res.json({ ok: true, id: job.id, cancelled: true });
});

// Get single drone + recent jobs (must be after /drones/claim and /drones/jobs)
router.get('/drones/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var agent = getAgent(req.params.id);
  if (!agent || agent.game !== 'drone') return res.status(404).json({ error: 'Drone not found' });
  var { api_key_hash, ...safe } = agent;
  var recentJobs = listDroneJobs({ drone_id: req.params.id, limit: 20 });
  safe.recent_jobs = recentJobs;
  res.json(safe);
});

export default router;
