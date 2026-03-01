// =============== DIOVERSE HUB — Distributed Game Studio API ===============
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
  createConcept, getConcept, listConcepts, updateConcept, deleteConcept,
  linkConceptToProject, unlinkConceptFromProject, getProjectConcepts, getConceptProjects,
  createDvWebhook, listDvWebhooks, deleteDvWebhook, dispatchWebhook,
  createDvTeamChat, listDvTeamChat,
  createDroneJob, getDroneJob, claimDroneJob, updateDroneJob, listDroneJobs, listDrones,
  addTaskComment, getTaskComments, deleteTaskComment,
  createOutreachCampaign, getOutreachCampaign, listOutreachCampaigns, updateOutreachCampaign,
  createOutreachContact, getOutreachContact, listOutreachContacts, updateOutreachContact,
  deleteOutreachContact, countOutreachContacts, findOutreachContactByEmail,
  GATED_ACTIONS, createApproval, getApproval, listApprovals, decideApproval,
  markApprovalExecuted, countPendingApprovals, listPendingApprovalsByAgent,
  castApprovalVote, getApprovalVotes, countApprovalVotes,
  createOperator, getOperator, listOperators, updateOperator, deleteOperator,
  getInstanceConfig, setInstanceConfig, listInstanceConfig, deleteInstanceConfig,
  createChannel, getChannel, getChannelBySlug, getChannelByLink,
  listChannels, updateChannel, deleteChannel,
  addChannelMember, removeChannelMember, listChannelMembers,
  isChannelMember, getChannelsByUser,
  markChannelRead, getUnreadCounts, getLatestChannelMessageId,
  listChannelMessages, createChannelMessage,
  listGeneralChannelMessages, listTeamChatChannelMessages,
  autoCreateEntityChannel, getOrCreateDmChannel
} from '../db.js';

var ADMIN_KEY = process.env.ADMIN_KEY;
var JWT_SECRET = process.env.JWT_SECRET;
var STUDIO_JWT_EXPIRY = '7d';

// Sanitize input: ensure string type, trim, handle null/undefined.
// HTML entity escaping removed — frontend uses textContent which is XSS-safe.
// Keeping function signature so all call sites continue to work.
function escapeHtml(str) {
  if (!str) return '';
  return String(str);
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

// Agent key cache: sha256(key) -> agentId. Avoids bcrypt on every request.
var agentKeyCache = new Map();

function clearAgentKeyCache() {
  agentKeyCache.clear();
}

// Agent auth: validates X-Agent-Key header, sets req.agentId
function checkAgent(req, res) {
  var key = req.headers['x-agent-key'];
  if (!key) {
    res.status(401).json({ error: 'Missing X-Agent-Key header' });
    return null;
  }
  // Fast path: check SHA-256 cache first
  var keyHash = crypto.createHash('sha256').update(key).digest('hex');
  if (agentKeyCache.has(keyHash)) {
    return agentKeyCache.get(keyHash);
  }
  // Slow path: bcrypt comparison (first request per key only)
  var agents = listAgents();
  for (var a of agents) {
    var full = getAgent(a.id);
    if (full && bcrypt.compareSync(key, full.api_key_hash)) {
      agentKeyCache.set(keyHash, a.id);
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

// ---- Approval gate helpers ----
// Soft enforcement: warns agents but doesn't block (returns warning field).
// Hard enforcement: blocks agents without an approved approval_id.
function checkApprovalGate(req, who, actionType) {
  // Admin/studio users bypass gates
  if (who === '__admin__' || !who || who.indexOf('-claude') === -1) return { ok: true };
  var approvalId = req.body.approval_id || req.query.approval_id;
  if (!approvalId) {
    return { ok: false, soft: true, warning: 'This action (' + actionType + ') should use the approval system. Call studio_request_approval first.' };
  }
  var approval = getApproval(parseInt(approvalId));
  if (!approval) return { ok: false, error: 'Approval #' + approvalId + ' not found' };
  if (approval.status !== 'approved') return { ok: false, error: 'Approval #' + approvalId + ' is ' + approval.status + ', not approved' };
  if (approval.action_type !== actionType) return { ok: false, error: 'Approval #' + approvalId + ' is for ' + approval.action_type + ', not ' + actionType };
  if (approval.requested_by !== who) return { ok: false, error: 'Approval #' + approvalId + ' belongs to ' + approval.requested_by + ', not ' + who };
  return { ok: true, approval: approval };
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
  var workingOn = req.body.working_on || '';
  // Allow avatar_url to be set via heartbeat
  if (req.body.avatar_url !== undefined) {
    updateAgent(agentId, { avatar_url: req.body.avatar_url });
  }
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

// Update agent profile (avatar_url, name)
router.put('/agents/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  // Agents can only update themselves, admin can update anyone
  if (who !== '__admin__' && who !== req.params.id) {
    return res.status(403).json({ error: 'Can only update your own profile' });
  }
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  var fields = {};
  if (req.body.avatar_url !== undefined) fields.avatar_url = req.body.avatar_url;
  if (req.body.name !== undefined) fields.name = req.body.name;
  // Admin-only fields
  if (who === '__admin__') {
    if (req.body.role !== undefined) fields.role = req.body.role;
    if (req.body.operator_id !== undefined) fields.operator_id = req.body.operator_id;
    if (req.body.project !== undefined) fields.project = req.body.project;
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
  // Auto-create channel for task
  var taskMembers = [agentId];
  if (req.body.assignee) taskMembers.push(req.body.assignee);
  autoCreateEntityChannel('task', id, '#task-' + id + ': ' + title, agentId, taskMembers);
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

// ======== TASK COMMENTS ========

router.get('/tasks/:id/comments', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(getTaskComments(task.id));
});

router.post('/tasks/:id/comments', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  var author = escapeHtml(req.body.author || who);
  var content = escapeHtml(req.body.content);
  if (!content) return res.status(400).json({ error: 'content is required' });
  var comment = addTaskComment(task.id, author, content);
  emitEvent('task_comment', who, task.game, who + ' commented on task #' + task.id, { task_id: task.id, comment_id: comment.id });
  res.json(comment);
});

router.delete('/tasks/:id/comments/:commentId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var task = getDvTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  var deleted = deleteTaskComment(parseInt(req.params.commentId));
  if (!deleted) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true, deleted: parseInt(req.params.commentId) });
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

router.post('/assets/:id/upload', upload.single('file'), function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseInt(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  var filePath = req.file.path;
  var downloadUrl = '/api/mycelium/assets/' + asset.id + '/download';
  updateDvAsset(asset.id, { status: 'ready', file_path: filePath, download_url: downloadUrl, path: req.file.filename });
  emitEvent('asset_uploaded', who, asset.game, 'Asset #' + asset.id + ' (' + asset.name + ') uploaded');
  res.json({ ok: true, asset_id: asset.id, download_url: downloadUrl });
});

router.get('/assets/:id/download', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseInt(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.file_path && !asset.path) return res.status(404).json({ error: 'No file attached to this asset' });

  var filePath = asset.file_path || nodePath.join(FILES_DIR, asset.path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
  res.download(filePath);
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
    offset: parseInt(req.query.offset) || 0,
    channel_id: req.query.channel_id ? parseInt(req.query.channel_id) : undefined
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
  var game = req.body.game || null;
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  // Route to channel
  var channelId = req.body.channel_id ? parseInt(req.body.channel_id) : null;
  if (!channelId && toAgent) {
    // DM: auto-create DM channel
    channelId = getOrCreateDmChannel(agentId, toAgent, 'agent', 'agent');
  }
  if (!channelId && !toAgent) {
    // Broadcast: route to #general
    var general = getChannelBySlug('general');
    if (general) channelId = general.id;
  }
  var id = createDvMessage(agentId, toAgent, threadId, game, content, metadata, msgType, channelId);
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
  var gate = checkApprovalGate(req, agentId, 'plan_create');
  var title = escapeHtml(req.body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });
  var description = escapeHtml(req.body.description || '');
  var game = escapeHtml(req.body.game || 'dioverse');
  var owner = escapeHtml(req.body.owner || '');
  var priority = req.body.priority || 'normal';
  var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
  var id = createDvPlan(title, description, game, owner, priority, tags, agentId);
  // Auto-create channel for plan
  var planMembers = [];
  if (owner) planMembers.push(owner);
  autoCreateEntityChannel('plan', id, '#plan-' + id + ': ' + title, agentId, planMembers);
  emitEvent('plan_created', agentId, game, agentId + ' created plan: ' + title, { plan_id: id });
  var result = { id: id, title: title };
  if (gate.warning) result.approval_warning = gate.warning;
  res.json(result);
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
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var gate = checkApprovalGate(req, who, 'delete');
  if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
  var plan = getDvPlan(parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  deleteDvPlan(plan.id);
  emitEvent('plan_deleted', who, plan.game, who + ' deleted plan #' + plan.id + ': ' + plan.title, { plan_id: plan.id });
  var result = { ok: true, deleted: plan.id };
  if (gate.warning) result.approval_warning = gate.warning;
  res.json(result);
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
router.post('/studio/login', async function (req, res) {
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
router.post('/studio/users', async function (req, res) {
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
});

// List studio users (admin only)
router.get('/studio/users', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listStudioUsers());
});

// Update studio user password (admin only)
router.put('/studio/users/:id/password', async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  var newPassword = req.body.password || '';
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  var hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS_PASSWORD);
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

// ======== ADMIN ========

// Register new agent (returns plaintext API key — store it, shown only once)
router.post('/admin/agents', async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var id = req.body.id;
  var name = req.body.name;
  var game = req.body.game;
  if (!id || !name || !game) return res.status(400).json({ error: 'id, name, and game are required' });
  // Check if exists
  if (getAgent(id)) return res.status(409).json({ error: 'Agent ' + id + ' already exists' });
  // Generate API key
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS_KEY);
  var capabilities = req.body.capabilities ? JSON.stringify(req.body.capabilities) : '["code","assets"]';
  createAgent(id, name, game, hash, capabilities);
  // Auto-add new agent to #general
  var generalChannel = getChannelBySlug('general');
  if (generalChannel) {
    addChannelMember(generalChannel.id, id, 'agent', 'member');
  }
  emitEvent('agent_registered', '__admin__', null, 'Admin registered agent: ' + id);
  res.json({ id: id, api_key: apiKey, message: 'Store this key — it will not be shown again' });
});

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
router.put('/admin/agents/:id/key', async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  var apiKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
  var hash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS_KEY);
  updateAgentKey(req.params.id, hash);
  clearAgentKeyCache();  // invalidate cached keys
  emitEvent('agent_key_regenerated', '__admin__', null, 'Admin regenerated key for: ' + req.params.id);
  res.json({ id: req.params.id, api_key: apiKey, message: 'Store this key — it will not be shown again' });
});

// Admin heartbeat for any agent
router.put('/admin/agents/:id/heartbeat', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
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
  res.json({ ok: true, agent: req.params.id, status: status });
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
    try { c.data = JSON.parse(c.data); } catch (e) {}
  });
  res.json(concepts);
});

// Get single concept
router.get('/concepts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concept = getConcept(parseInt(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  concept.projects = getConceptProjects(concept.id);
  try { concept.data = JSON.parse(concept.data); } catch (e) {}
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
  try { concept.data = JSON.parse(concept.data); } catch (e) {}
  concept.projects = [];
  res.json(concept);
});

// Update concept
router.put('/concepts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concept = getConcept(parseInt(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  updateConcept(concept.id, req.body);
  var updated = getConcept(concept.id);
  try { updated.data = JSON.parse(updated.data); } catch (e) {}
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
  var concept = getConcept(parseInt(req.params.id));
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
  var concept = getConcept(parseInt(req.params.id));
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  var projectId = req.body.project || req.body.game;
  if (!projectId) return res.status(400).json({ error: 'project is required' });
  linkConceptToProject(projectId, concept.id, who);
  emitEvent('concept_linked', who, projectId, 'Linked concept "' + concept.name + '" to project ' + projectId);
  res.json({ ok: true, concept_id: concept.id, project: projectId });
});

// Unlink concept from project
router.delete('/concepts/:id/link/:projectId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  unlinkConceptFromProject(req.params.projectId, parseInt(req.params.id));
  res.json({ ok: true });
});

// Get concepts for a specific project
router.get('/projects/:projectId/concepts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var concepts = getProjectConcepts(req.params.projectId);
  concepts.forEach(function (c) {
    try { c.data = JSON.parse(c.data); } catch (e) {}
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
  // Auto-create channel for bug
  var bugMembers = [who];
  if (assignee) bugMembers.push(assignee);
  autoCreateEntityChannel('bug', id, '#bug-' + id + ': ' + title, who, bugMembers);
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
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listChannels(filters));
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
  var channel = getChannel(parseInt(req.params.id));
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
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
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
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  deleteChannel(channel.id);
  emitEvent('channel_deleted', getAdminDisplayName(req), null, 'Deleted channel ' + channel.name, { channel_id: channel.id });
  res.json({ ok: true, deleted: channel.id });
});

// -- Channel Members --

router.get('/channels/:id/members', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  res.json(listChannelMembers(channel.id));
});

router.post('/channels/:id/members', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  var added = addChannelMember(channel.id, userId, req.body.user_type || 'agent', req.body.role || 'member');
  res.json({ ok: true, added: added, channel_id: channel.id, user_id: userId });
});

router.delete('/channels/:id/members/:userId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var removed = removeChannelMember(channel.id, req.params.userId);
  res.json({ ok: true, removed: removed });
});

// -- Channel Messages --

router.get('/channels/:id/messages', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var filters = {
    before: req.query.before ? parseInt(req.query.before) : undefined,
    after: req.query.after ? parseInt(req.query.after) : undefined,
    limit: parseInt(req.query.limit) || 50
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
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
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
  var channel = getChannel(parseInt(req.params.id));
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
  var workspaceRepo = req.body.workspace_repo || null;
  var workspaceBranch = req.body.workspace_branch || 'main';
  var id = createDroneJob(title, command, inputData, requires, who, priority, workspaceRepo, workspaceBranch);
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

// ======== DRONE ARTIFACTS (persistent files — models, LoRAs, etc.) ========

// Upload a drone artifact (persistent, no TTL)
router.post('/drones/artifacts', artifactUpload.single('file'), function (req, res) {
  if (!checkAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart form with field name "file"' });
  var protocol = req.headers['x-forwarded-proto'] || req.protocol;
  var host = req.headers['x-forwarded-host'] || req.get('host');
  var baseUrl = protocol + '://' + host;
  var url = baseUrl + '/api/mycelium/drones/artifacts/' + req.file.filename;
  emitEvent('artifact_uploaded', getAdminDisplayName(req), 'drone', 'Uploaded drone artifact: ' + req.file.filename + ' (' + Math.round(req.file.size / 1024) + 'KB)');
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
    limit: parseInt(req.query.limit) || 50
  };
  var approvals = listApprovals(filters);
  approvals.forEach(function (a) { try { a.payload = JSON.parse(a.payload); } catch (e) {} });
  res.json(approvals);
});

// Get single approval
router.get('/approvals/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var approval = getApproval(parseInt(req.params.id));
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  try { approval.payload = JSON.parse(approval.payload); } catch (e) {}
  res.json(approval);
});

// Approve or deny (admin only)
router.put('/approvals/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var approval = getApproval(parseInt(req.params.id));
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
  var approval = getApproval(parseInt(req.params.id));
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
  var approval = getApproval(parseInt(req.params.id));
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
  res.json(getApprovalVotes(parseInt(req.params.id)));
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

// ======== OUTREACH ========

// -- Campaigns --
router.get('/outreach/campaigns', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOutreachCampaigns({ project: req.query.project || req.query.game, status: req.query.status }));
});

router.post('/outreach/campaigns', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var b = req.body;
  if (!b.project || !b.name) return res.status(400).json({ error: 'project and name required' });
  var id = createOutreachCampaign(b.project, b.name, b.persona_prompt, b.game_facts,
    typeof b.templates === 'string' ? b.templates : JSON.stringify(b.templates || {}),
    typeof b.config === 'string' ? b.config : JSON.stringify(b.config || {}), who);
  emitEvent('outreach_campaign_created', who, b.project, who + ' created outreach campaign: ' + b.name, { campaign_id: id });
  res.json({ id: id, name: b.name });
});

router.put('/outreach/campaigns/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var campaign = getOutreachCampaign(parseInt(req.params.id));
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  var fields = {};
  for (var k of ['name', 'persona_prompt', 'game_facts', 'status']) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (req.body.templates !== undefined) fields.templates = typeof req.body.templates === 'string' ? req.body.templates : JSON.stringify(req.body.templates);
  if (req.body.config !== undefined) fields.config = typeof req.body.config === 'string' ? req.body.config : JSON.stringify(req.body.config);
  updateOutreachCampaign(campaign.id, fields);
  res.json({ ok: true, id: campaign.id });
});

// -- Contacts --
router.get('/outreach/contacts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOutreachContacts({
    project: req.query.project || req.query.game,
    status: req.query.status,
    type: req.query.type,
    campaign_id: req.query.campaign_id ? parseInt(req.query.campaign_id) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit) : 50,
    offset: req.query.offset ? parseInt(req.query.offset) : 0
  }));
});

router.post('/outreach/contacts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var b = req.body;
  if (!b.project || !b.name) return res.status(400).json({ error: 'project and name required' });
  if (b.email) {
    var existing = findOutreachContactByEmail(b.project, b.email);
    if (existing) return res.status(409).json({ error: 'Contact with this email already exists', existing_id: existing.id });
  }
  var id = createOutreachContact({ ...b, created_by: who, metadata: b.metadata ? (typeof b.metadata === 'string' ? b.metadata : JSON.stringify(b.metadata)) : '{}' });
  emitEvent('outreach_contact_created', who, b.project, who + ' added outreach contact: ' + b.name, { contact_id: id });
  res.json({ id: id });
});

router.put('/outreach/contacts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  var b = req.body;
  if (b.metadata && typeof b.metadata !== 'string') b.metadata = JSON.stringify(b.metadata);
  updateOutreachContact(contact.id, b);
  emitEvent('outreach_contact_updated', who, contact.project, who + ' updated contact #' + contact.id + (b.status ? ' to ' + b.status : ''), { contact_id: contact.id });
  res.json({ ok: true, id: contact.id });
});

router.delete('/outreach/contacts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  deleteOutreachContact(contact.id);
  res.json({ ok: true, deleted: contact.id });
});

// -- Pipeline actions --

// Discover contacts (YouTube creators + Hunter.io press)
router.post('/outreach/discover', async function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var campaignId = req.body.campaign_id;
  if (!campaignId) return res.status(400).json({ error: 'campaign_id required' });
  var campaign = getOutreachCampaign(campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  try {
    var config = JSON.parse(campaign.config || '{}');
    var { discoverCreators, discoverPress } = await import('../outreach/discoverer.js');

    var findExisting = function (key) {
      // Check if contact with this notes/email already exists
      var contacts = listOutreachContacts({ project: campaign.project, limit: 1000 });
      return contacts.some(function (c) { return c.notes === key || c.email === key; });
    };

    var creators = [];
    if (config.youtube_api_key && config.queries) {
      creators = await discoverCreators(config, findExisting);
    }

    var press = [];
    if (config.hunter_api_key && config.press_targets) {
      press = await discoverPress(config, findExisting);
    }

    var created = 0;
    for (var contact of [...creators, ...press]) {
      createOutreachContact({ ...contact, project: campaign.project, campaign_id: campaignId, created_by: who });
      created++;
    }

    emitEvent('outreach_discover', who, campaign.project,
      who + ' discovered ' + created + ' contacts (' + creators.length + ' creators, ' + press.length + ' press)', { campaign_id: campaignId });
    res.json({ ok: true, creators: creators.length, press: press.length, total: created });
  } catch (e) {
    res.status(500).json({ error: 'Discovery failed: ' + e.message });
  }
});

// Research a contact (fetch latest content)
router.post('/outreach/research/:id', async function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  try {
    var campaign = contact.campaign_id ? getOutreachCampaign(contact.campaign_id) : null;
    var config = campaign ? JSON.parse(campaign.config || '{}') : {};
    var { researchCreator, researchPress } = await import('../outreach/researcher.js');

    var updates = contact.type === 'creator'
      ? await researchCreator(contact, config.youtube_api_key)
      : await researchPress(contact);

    updates.status = 'researched';
    updateOutreachContact(contact.id, updates);
    res.json({ ok: true, id: contact.id, updates: updates });
  } catch (e) {
    res.status(500).json({ error: 'Research failed: ' + e.message });
  }
});

// Personalize pitch for a contact (Claude-generated)
router.post('/outreach/personalize/:id', async function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  try {
    var campaign = contact.campaign_id ? getOutreachCampaign(contact.campaign_id) : null;
    if (!campaign) return res.status(400).json({ error: 'Contact has no campaign — cannot personalize' });
    var config = JSON.parse(campaign.config || '{}');
    var apiKey = config.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'anthropic_api_key required in campaign config or ANTHROPIC_API_KEY env' });

    var { personalize } = await import('../outreach/personalizer.js');
    var result = await personalize(contact, campaign, apiKey);

    updateOutreachContact(contact.id, {
      pitch_subject: result.pitch_subject,
      pitch_body: result.pitch_body,
      status: 'draft_ready'
    });

    res.json({ ok: true, id: contact.id, subject: result.pitch_subject, body_preview: (result.pitch_body || '').substring(0, 200) });
  } catch (e) {
    res.status(500).json({ error: 'Personalization failed: ' + e.message });
  }
});

// Approve a pitch draft
router.put('/outreach/approve/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.status !== 'draft_ready') return res.status(400).json({ error: 'Contact status must be draft_ready, got ' + contact.status });

  var fields = { status: 'approved' };
  // Allow editing subject/body during approval
  if (req.body.pitch_subject) fields.pitch_subject = req.body.pitch_subject;
  if (req.body.pitch_body) fields.pitch_body = req.body.pitch_body;
  updateOutreachContact(contact.id, fields);
  res.json({ ok: true, id: contact.id, status: 'approved' });
});

// Send approved pitch via Gmail
router.post('/outreach/send/:id', async function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.status !== 'approved') return res.status(400).json({ error: 'Contact must be approved before sending' });
  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

  try {
    var campaign = contact.campaign_id ? getOutreachCampaign(contact.campaign_id) : null;
    var config = campaign ? JSON.parse(campaign.config || '{}') : {};

    var dryRun = config.dry_run !== undefined ? config.dry_run : true;
    if (req.body.dry_run !== undefined) dryRun = req.body.dry_run;

    // Hard gate: agents cannot send real emails without approval
    if (!dryRun) {
      var gate = checkApprovalGate(req, who, 'outreach_send');
      if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
      if (!gate.ok && gate.soft) return res.status(403).json({ error: 'Real email sending requires approval. Use studio_request_approval with action_type=outreach_send first.', approval_required: true });
    }

    if (dryRun) {
      updateOutreachContact(contact.id, {
        status: 'sent',
        pitch_sent_at: new Date().toISOString(),
        followup_due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
      });
      return res.json({ ok: true, id: contact.id, dry_run: true, would_send_to: contact.email });
    }

    var { sendEmail } = await import('../outreach/mailer.js');
    var msgId = await sendEmail(config, contact.email, contact.pitch_subject, contact.pitch_body, config.sender_email);

    updateOutreachContact(contact.id, {
      status: 'sent',
      pitch_sent_at: new Date().toISOString(),
      followup_due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    });

    emitEvent('outreach_pitch_sent', who, contact.project, who + ' sent pitch to ' + contact.name, { contact_id: contact.id, gmail_id: msgId });
    res.json({ ok: true, id: contact.id, gmail_id: msgId });
  } catch (e) {
    res.status(500).json({ error: 'Send failed: ' + e.message });
  }
});

// Send follow-up email
router.post('/outreach/followup/:id', async function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.status !== 'sent') return res.status(400).json({ error: 'Contact must be in sent status for follow-up' });

  try {
    var campaign = contact.campaign_id ? getOutreachCampaign(contact.campaign_id) : null;
    var config = campaign ? JSON.parse(campaign.config || '{}') : {};
    var templates = {};
    try { templates = JSON.parse(campaign.templates || '{}'); } catch (e) { /* */ }

    var followupTemplate = templates.followup || { subject: 'Re: ' + contact.pitch_subject, body: '' };
    var firstName = contact.name ? contact.name.split(' ')[0] : '';
    var subject = followupTemplate.subject.replace('{original_subject}', contact.pitch_subject);
    var body = followupTemplate.body
      .replace('{first_name}', firstName)
      .replace('{sender_name}', config.sender_name || '');

    var dryRun = config.dry_run !== undefined ? config.dry_run : true;
    if (req.body.dry_run !== undefined) dryRun = req.body.dry_run;

    // Hard gate: agents cannot send real followups without approval
    if (!dryRun) {
      var gate = checkApprovalGate(req, who, 'outreach_send');
      if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
      if (!gate.ok && gate.soft) return res.status(403).json({ error: 'Real email sending requires approval. Use studio_request_approval with action_type=outreach_send first.', approval_required: true });
    }

    if (!dryRun && contact.email) {
      var { sendEmail } = await import('../outreach/mailer.js');
      await sendEmail(config, contact.email, subject, body, config.sender_email);
    }

    updateOutreachContact(contact.id, {
      status: 'followed_up',
      followup_sent_at: new Date().toISOString()
    });

    res.json({ ok: true, id: contact.id, dry_run: dryRun, status: 'followed_up' });
  } catch (e) {
    res.status(500).json({ error: 'Follow-up failed: ' + e.message });
  }
});

// -- Status summary --
router.get('/outreach/status', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var project = req.query.project || req.query.game;
  if (!project) return res.status(400).json({ error: 'project query param required' });
  var counts = countOutreachContacts(project);
  var campaigns = listOutreachCampaigns({ project: project, status: 'active' });
  res.json({ project: project, contact_counts: counts, active_campaigns: campaigns.length });
});

export default router;
