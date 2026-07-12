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
import https from 'https';
import { sendEmail, isEmailEnabled, templatePasswordReset, templateOperatorAlert } from '../email.js';

// ---- Simple in-memory rate limiter (no dependency) ----
var _rateLimitStore = {};
function rateLimit(keyFn, maxAttempts, windowMs) {
  // Prune expired entries every 5 minutes
  setInterval(function () {
    var now = Date.now();
    for (var k in _rateLimitStore) {
      if (_rateLimitStore[k].resetAt < now) delete _rateLimitStore[k];
    }
  }, 5 * 60 * 1000).unref();

  return function (req, res, next) {
    var key = keyFn(req);
    var now = Date.now();
    var entry = _rateLimitStore[key];
    if (!entry || entry.resetAt < now) {
      _rateLimitStore[key] = { count: 1, resetAt: now + windowMs };
      return next();
    }
    entry.count++;
    if (entry.count > maxAttempts) {
      var retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many attempts. Try again in ' + retryAfter + ' seconds.' });
    }
    next();
  };
}

// ---- Input validation helpers ----
var MAX_TITLE = 500;
var MAX_DESCRIPTION = 50000;
var MAX_CONTENT = 100000;
function validateStringLength(res, value, maxLen, fieldName) {
  if (typeof value === 'string' && value.length > maxLen) {
    res.status(400).json({ error: fieldName + ' exceeds max length (' + maxLen + ' chars)' });
    return false;
  }
  return true;
}

// Login: 10 attempts per 15 minutes per IP
var loginLimiter = rateLimit(function (req) { return 'login:' + (req.ip || req.connection.remoteAddress); }, 10, 15 * 60 * 1000);
// Agent key validation: 30 failed attempts per minute per IP (enforced inline in checkAgent)
// Admin write operations: 30 per minute per IP
var adminWriteLimiter = rateLimit(function (req) { return 'admin_write:' + (req.ip || req.connection.remoteAddress); }, 30, 60 * 1000);
// Agent write operations: 30 per minute per agent
var agentWriteLimiter = rateLimit(function (req) { return 'agent_write:' + (req.headers['x-agent-key'] || req.ip || req.connection.remoteAddress); }, 30, 60 * 1000);

var DATA_DIR = process.env.DATA_DIR || nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'data');
var FILES_DIR = nodePath.join(DATA_DIR, 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Allowed file extensions for uploads (block executables, scripts, HTML)
var BLOCKED_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dll', '.com', '.scr', '.pif', '.vbs', '.js', '.wsh', '.wsf', '.html', '.htm', '.xhtml', '.svg', '.php', '.jsp', '.asp', '.aspx', '.cgi']);
function sanitizeExtension(ext) {
  var lower = (ext || '').toLowerCase();
  if (BLOCKED_EXTENSIONS.has(lower)) return '.blocked';
  return lower;
}
var storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, FILES_DIR); },
  filename: function (req, file, cb) {
    var ext = sanitizeExtension(nodePath.extname(file.originalname));
    var base = nodePath.basename(file.originalname, nodePath.extname(file.originalname)).replace(/[^a-zA-Z0-9_-]/g, '_');
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
  createAgent, getAgent, listAgents, listAllAgentsIncludingDrones, updateAgentHeartbeat, updateAgentKey, deleteAgent, updateAgent,
  createOrg, listOrgs, getOrg, updateOrg, deleteOrg,
  createProject, listProjects, getProject, updateProject, deleteProject,
  createTask, getTask, listTasks, updateTask,
  setTaskDependency, resolveTaskDependencies,
  approveTask, listTasksNeedingApproval,
  getContext, getAllContext, upsertContext,
  upsertContextKey, getContextKey, listContextKeys, deleteContextKey,
  getContextHistory, rollbackContextKey,
  logAgentSpend, getAgentSpend, getSpendSummary,
  createRun, updateRun, getRun, listRuns, claimRun, releaseStaleClaimedRuns,
  createWidget, updateWidget, listWidgets, deleteWidget,
  createSkill, getSkill, listSkills, updateSkill, installSkill, uninstallSkill, getAgentSkills,
  createAsset, getAsset, listAssets, updateAsset, deleteAsset,
  autoTaskFromAsset,
  createEvent, listEvents,
  createMessage, createRequest, getMessage,
  acknowledgeMessage, resolveMessage, listPendingRequests,
  listMessages, listThreads, bulkDeleteMessages,
  getBootPayload, getSlimBootPayload, getSmartBootPayload, getOverview, getSlimOverview, buildWorkQueue,
  createBug, getBug, listBugs, updateBug, deleteBug, countBugs,
  createPlan, getPlan, listPlans, updatePlan, deletePlan,
  createPlanStep, updatePlanStep, deletePlanStep, reorderPlanSteps,
  completeLinkedPlanSteps,
  createStudioUser, getStudioUserByUsername, getStudioUserById,
  listStudioUsers, deleteStudioUser, updateStudioUser,
  touchStudioUserSeen, getActiveStudioUsers,
  createConcept, getConcept, listConcepts, updateConcept, deleteConcept,
  linkConceptToProject, unlinkConceptFromProject, getProjectConcepts, getConceptProjects,
  createWebhook, listWebhooks, deleteWebhook, dispatchWebhook,
  listWebhookDeliveries, pruneWebhookDeliveries,
  getAdminOps, resolveStaleRequests,
  createTeamChat, listTeamChat,
  createDroneJob, getDroneJob, claimDroneJob, updateDroneJob, listDroneJobs, listDrones, listAssetsByDroneJob, bulkCancelDroneJobs, releaseStaleClaimedJobs, pauseDrone, resumeDrone, getDroneStatus,
  createJobTemplate, getJobTemplate, listJobTemplates, updateJobTemplate, deleteJobTemplate,
  updateDroneDiagnostics, getDroneDiagnostics, renderJobForDrone, checkDroneCompatibility,
  createDroneProfile, getDroneProfile, listDroneProfiles, updateDroneProfile, deleteDroneProfile,
  assignDroneProfile, unassignDroneProfile, getDroneProfileAssignments, markProfileSetupDone, getDronesWithProfile,
  addTaskComment, getTaskComments, getTaskComment, deleteTaskComment, deleteTask,
  addTaskDeliverable, getTaskDeliverables,
  addPlanStepComment, getPlanStepComments, autoRetryOrEscalatePlanStep,
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
  getOrCreateDmChannel,
  createSavepoint, getLatestSavepoint, getSavepointHistory,
  updateSavepointNotes, computeSavepointDiff, pruneSavepoints,
  listPluginRecords, getPluginRecord, updatePluginEnabled, getDB,
  getPluginConfig, setPluginConfig, deletePluginConfig,
  getIdleAgents, getNextUnassignedTask, getNextUnassignedPlanStep,
  createFeedback, getFeedback, listFeedback, deleteFeedback, getFeedbackSummary,
  countPendingForAgent, getAgentInbox, getUnreadMessages, markMessagesRead, archiveOldMessages, archiveOldEvents,
  createInboxItem, createInboxItemForAllOperators,
  getInboxItem, listInboxItems, markInboxItemRead, markInboxItemActioned,
  dismissInboxItem, countUnreadInbox, countAllUnreadInbox,
  purgeExpiredContextKeys, cleanupAgentSessionKeys, contextKeyStats, bulkDeleteContextKeys, searchContextKeys,
  createNodeProfile, getNodeProfile, listNodeProfiles, updateNodeProfile, deleteNodeProfile,
  resolveProfileChain, buildCalibrationBlock,
  listTeamSettings, getTeamSetting, upsertTeamSetting, deleteTeamSetting,
  getAllTeamSettingsGrouped, syncTeamSettingsToProfile,
  createTeam, getTeam, listTeams, updateTeam, deleteTeam,
  addTeamMember, updateTeamMember, removeTeamMember,
  getTeamsForUser, getTeamProjects, getTeamProjectIdsForAgent,
  getAgentProfile, ensureAgentProfile, updateAgentProfile, incrementProfileCounter,
  listAgentProfiles, getAgentLeaderboard,
  getStaleAgents, getStaleTasks, getStaleRequests, getStaleDrones, getStalePlanSteps,
  getReconciliationCandidates,
  createAgentTemplate, getAgentTemplate, listAgentTemplates, updateAgentTemplate, deleteAgentTemplate
} from '../db.js';
import { loadPlugins, getLoadedPlugins, getPluginMcpTools, callEventHooks, registerEventHook, getWorkerStatus } from '../plugins.js';

import { broadcast, addClient, clientCount } from '../eventBus.js';
import { registerBugRoutes } from './bugs.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerChannelRoutes } from './channels.js';
import { registerContextRoutes } from './context.js';
import { registerMessageRoutes } from './messages.js';
import { registerConceptRoutes } from './concepts.js';
import { registerAssetRoutes } from './assets.js';
import { registerDroneRoutes } from './drones.js';
import { registerTeamRoutes } from './teams.js';
import { registerPlansRoutes } from './plans.js';
import { registerTaskRoutes } from './tasks.js';
import { registerAdminRoutes } from './admin.js';

var ADMIN_KEY = process.env.ADMIN_KEY;
function isAdminKey(key) {
  if (!ADMIN_KEY || !key) return false;
  return key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
}
var JWT_SECRET = process.env.JWT_SECRET;
var STUDIO_JWT_EXPIRY = '7d';

function formatSavepointSummary(diff) {
  if (!diff || !diff.summary) return 'No changes since last session.';
  var parts = [];
  if (diff.new_messages) parts.push(diff.new_messages + ' new message' + (diff.new_messages > 1 ? 's' : ''));
  if (diff.task_changes) parts.push(diff.task_changes + ' task change' + (diff.task_changes > 1 ? 's' : ''));
  if (diff.plan_changes) parts.push(diff.plan_changes + ' plan update' + (diff.plan_changes > 1 ? 's' : ''));
  if (diff.context_changes) parts.push(diff.context_changes + ' context change' + (diff.context_changes > 1 ? 's' : ''));
  return parts.length > 0 ? parts.join(', ') : diff.summary || 'No changes since last session.';
}

// ---- MCP Config Helpers ----
function getInstanceUrl(req) {
  // Tier 1: explicit operator override — always trusted, no header parsing.
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  // Tier 2: allowlist gate — if set, the Host header must match an entry.
  var host = req.get('host');
  var allowed = (process.env.ALLOWED_HOSTS || '').split(',').map(function(s){return s.trim();}).filter(Boolean);
  if (allowed.length) {
    if (!allowed.includes(host)) {
      throw new Error('Host not allowed: ' + host);
    }
  }
  // Tier 3: legacy fallback — current behavior when neither env var is set.
  var proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return proto + '://' + host;
}

function buildMcpConfig(agentId, apiKey, instanceUrl) {
  return {
    mcpServers: {
      mycelium: {
        command: 'npx',
        args: ['-y', '@softbacon/mycelium-mcp@latest'],
        env: {
          MYCELIUM_API_KEY: apiKey,
          MYCELIUM_AGENT_ID: agentId,
          MYCELIUM_URL: instanceUrl + '/api/mycelium'
        }
      }
    }
  };
}

// Wrap async route handlers so rejected promises forward to Express error handler.
// Express 4 does not catch async rejections automatically.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Pre-action guardrail check — blocks mutations if a guardrail rule with enforcement='block' fires
function checkGuardrails(req, res, eventType, eventData) {
  if (!req.app._guardrailsCheck) return true;
  var result = req.app._guardrailsCheck(eventType, eventData);
  if (!result.allowed) {
    res.status(403).json({
      error: 'Blocked by guardrail: ' + result.violations.map(function (v) { return v.rule_name; }).join(', '),
      violations: result.violations
    });
    return false;
  }
  return true;
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
//
// Reject-with-reason (A7): the 400 body now carries a machine-readable shape
// ({ error, code, field, value, allowed }) so consumers (SDK, bridges) can
// branch on `code === 'invalid_enum'` and surface the allowed-list instead of
// scraping the human string. The human `error` message is unchanged, so
// existing string-matching callers keep working — this is additive.
function validateEnum(res, value, allowed, fieldName) {
  if (value !== undefined && allowed.indexOf(value) === -1) {
    apiError(res, 400, fieldName + ' must be one of: ' + allowed.join(', '), {
      code: 'invalid_enum',
      field: fieldName,
      value: value,
      allowed: allowed
    });
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

// ======================== CANONICAL STATUS ENUMS ========================
// SINGLE SOURCE OF TRUTH for every status/lifecycle enum the API enforces.
// Previously these were scattered as loose `var X_STATUSES = [...]` lines;
// consolidating them here (A7) means there is exactly one place to read or
// extend the legal lifecycle for each record type. The named `var`s below are
// thin aliases into STATUS_ENUMS so the ~15 existing validateEnum() call sites
// keep working unchanged — do NOT redefine the arrays inline elsewhere.
//
// Enforcement is GRADUAL by design: validateEnum() hard-rejects clearly-illegal
// values with a machine-readable reason (code:'invalid_enum'), but we do NOT
// (yet) reject questionable *transitions* (e.g. closed -> open) — those are
// log-warned via warnSuspectTransition() so currently-lenient consumers
// (older SDK/bridges) are not hard-broken. Tighten transitions later.
var STATUS_ENUMS = {
  agent:     ['online', 'offline', 'idle', 'busy'],
  task:      ['open', 'in_progress', 'review', 'done', 'cancelled'],
  asset:     ['requested', 'in_progress', 'ready', 'delivered', 'cancelled'],
  plan:      ['draft', 'active', 'completed', 'cancelled'],
  plan_step: ['pending', 'in_progress', 'completed', 'blocked', 'failed'], // 'failed' = terminal: a worker couldn't complete it (max-iter / gate fail). Leaves the work queue (never re-dispatched) + surfaces; later steps gate on prior 'completed' so it can't false-advance. Added 2026-06-07 to stop fail-loops.
  bug:       ['open', 'in_progress', 'fixed', 'closed'],
  channel:   ['active', 'archived'],
  drone_job: ['pending', 'claimed', 'done', 'completed', 'failed', 'cancelled', 'dismissed']
};
// Suspect (non-fatal) transitions: log-warn only, never reject. Keyed by enum
// type -> { fromStatus: [disallowedNextStatuses] }. Empty by default; this is
// the seam where transition discipline can be tightened without touching the
// reject path. Currently we only flag "re-opening" a terminal state.
var SUSPECT_TRANSITIONS = {
  bug:  { fixed: ['open', 'in_progress'], closed: ['open', 'in_progress'] },
  task: { done: ['open', 'in_progress'] },
  plan: { completed: ['draft', 'active'] }
};

// Log-warn (do not reject) when a status change looks like an illegal
// transition out of a terminal state. Keeps tightening observable before it is
// enforced. `current` may be undefined (record had no prior status) — skip then.
function warnSuspectTransition(enumType, current, next) {
  if (current === undefined || next === undefined || current === next) return;
  var rules = SUSPECT_TRANSITIONS[enumType];
  if (rules && rules[current] && rules[current].indexOf(next) !== -1) {
    console.warn('[enum] suspect transition on ' + enumType + ': ' + current + ' -> ' + next +
      ' (allowed but flagged; not rejected)');
  }
}

var AGENT_STATUSES = STATUS_ENUMS.agent;
var TASK_STATUSES = STATUS_ENUMS.task;
var TASK_PRIORITIES = ['low', 'normal', 'high'];
var ASSET_STATUSES = STATUS_ENUMS.asset;
var PLAN_STATUSES = STATUS_ENUMS.plan;
var PLAN_STEP_STATUSES = STATUS_ENUMS.plan_step;
var BUG_STATUSES = STATUS_ENUMS.bug;
var BUG_SEVERITIES = ['low', 'normal', 'high', 'critical'];
var DEFAULT_BUG_CATEGORIES = ['bug', 'feature', 'ui', 'crash', 'api', 'infrastructure', 'other'];

function getBugCategories(projectId) {
  if (projectId) {
    var project = getProject(projectId);
    if (project && project.bug_categories) {
      try {
        var cats = JSON.parse(project.bug_categories);
        if (Array.isArray(cats) && cats.length > 0) return cats;
      } catch (e) { /* fall through to defaults */ }
    }
  }
  return DEFAULT_BUG_CATEGORIES;
}
var CHANNEL_STATUSES = STATUS_ENUMS.channel;
var DRONE_JOB_STATUSES = STATUS_ENUMS.drone_job;

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

// ---- Liveness-write debounce (H2) ----
// getStudioUser runs on (nearly) every authenticated request and would
// otherwise fire a `last_seen` UPDATE per request (2-3/req under polling).
// Debounce per userId: at most one write per ~30s. The cache is bounded
// (pruned every 5 min); touchStudioUserSeen() stays available for callers
// that want an immediate write.
var _studioSeenCache = {}; // userId -> last touch timestamp (ms)
function touchStudioUserSeenDebounce(userId) {
  var now = Date.now();
  if (_studioSeenCache[userId] && (now - _studioSeenCache[userId]) < 30000) return;
  _studioSeenCache[userId] = now;
  touchStudioUserSeen(userId);
}
// Prune stale cache entries every 5 minutes (bounded memory)
setInterval(function () {
  var now = Date.now();
  for (var uid in _studioSeenCache) {
    if (now - _studioSeenCache[uid] > 300000) delete _studioSeenCache[uid];
  }
}, 5 * 60 * 1000).unref();

// ---- Auth middleware ----

// Decode studio JWT from Authorization: Bearer <token>
function getStudioUser(req) {
  var auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    var decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded && decoded.studioUser) {
      if (decoded.userId) touchStudioUserSeenDebounce(decoded.userId);
      return decoded;
    }
    return null;
  } catch (e) { return null; }
}

// Bounded agent key cache: max 1000 entries, 5-min TTL
var AGENT_KEY_CACHE_MAX = 1000;
var AGENT_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
var agentKeyCache = new Map();

// Lazily-computed flag: are there ANY agents whose api_key_hash is a legacy
// bcrypt ($2b$/$2a$) hash? null = not yet computed. When false, checkAgent skips
// the O(N_agents) bcrypt fallback sweep entirely, so a forged X-Agent-Key header
// cannot burn O(N x bcrypt_cost) CPU per request (DoS). Invalidated by
// clearAgentKeyCache (called on key rotation / auto-migrate) so it re-checks.
var HAS_LEGACY_BCRYPT_AGENTS = null;

function hasLegacyBcryptAgents() {
  if (HAS_LEGACY_BCRYPT_AGENTS === null) {
    var row = getDB().prepare("SELECT COUNT(*) AS c FROM agents WHERE api_key_hash LIKE '$2b$%' OR api_key_hash LIKE '$2a$%'").get();
    HAS_LEGACY_BCRYPT_AGENTS = !!(row && row.c > 0);
  }
  return HAS_LEGACY_BCRYPT_AGENTS;
}

function clearAgentKeyCache() {
  agentKeyCache.clear();
  HAS_LEGACY_BCRYPT_AGENTS = null; // re-check legacy presence on next cache miss
}

function getFromAgentKeyCache(keyHash) {
  var entry = agentKeyCache.get(keyHash);
  if (!entry) return null;
  if (Date.now() - entry.ts > AGENT_KEY_CACHE_TTL) {
    agentKeyCache.delete(keyHash);
    return null;
  }
  return entry;
}

function setInAgentKeyCache(keyHash, data) {
  if (agentKeyCache.size >= AGENT_KEY_CACHE_MAX) {
    var oldest = agentKeyCache.keys().next().value;
    agentKeyCache.delete(oldest);
  }
  agentKeyCache.set(keyHash, Object.assign({}, data, { ts: Date.now() }));
}

function invalidateAgentKeyCache(agentId) {
  for (var entry of agentKeyCache) {
    if (entry[1].id === agentId) {
      agentKeyCache.delete(entry[0]);
      break;
    }
  }
}

// Check if the authenticated caller has access to a resource's project.
// Admins and studio users bypass. Agents can READ any project but can only
// WRITE to their own project (or resources assigned to them).
function checkProjectScope(req, res, resourceProjectId, assignee) {
  if (req._authIsAdmin) return true;
  if (!req._authAgentId) return true; // studio user or admin — no scope restriction
  if (!resourceProjectId) return true; // resource has no project — allow
  if (req.method === 'GET') return true; // agents can read across projects (shared swarm context)
  if (req._authProjectId === resourceProjectId) return true;
  if (assignee && assignee === req._authAgentId) return true; // assigned agent can update their own work across projects
  // Team-scope (durable): an agent may write to any project owned by a team it
  // belongs to. This makes write-scope match DISPATCH-scope — auto-dispatch
  // already routes team-project work to the agent via getTeamProjectIdsForAgent —
  // so an agent can't be handed a team-project step yet 403 when recording its
  // result or creating a plan there.
  try {
    if (getTeamProjectIdsForAgent(req._authAgentId).indexOf(resourceProjectId) !== -1) return true;
  } catch (e) { /* fall through to 403 */ }
  res.status(403).json({ error: 'Agent ' + req._authAgentId + ' cannot access resources in project ' + resourceProjectId });
  return false;
}

// Resolve an agent-key SHA-256 hash to its agent record ({ id, project_id }) or null.
// CHEAP path only: in-memory cache + O(1) direct DB lookup. Deliberately excludes the
// legacy-bcrypt sweep and all rate-limit bookkeeping so it is safe to call from auth
// middlewares that merely need to CLASSIFY a caller (authenticated-agent vs anonymous)
// without opening a new compute surface. Writes no response and mutates no request state.
function resolveAgentKeyRecord(keyHash) {
  var cached = getFromAgentKeyCache(keyHash);
  if (cached) return { id: cached.id, project_id: cached.project_id };
  var directMatch = getDB().prepare("SELECT id, project_id FROM agents WHERE api_key_hash = ?").get(keyHash);
  if (directMatch) {
    var record = { id: directMatch.id, project_id: directMatch.project_id || null };
    setInAgentKeyCache(keyHash, record);
    return record;
  }
  return null;
}

// Agent auth: validates X-Agent-Key header, sets req._authAgentId and req._authProjectId
// Agent keys are high-entropy machine-generated secrets (192-bit) — stored as SHA-256.
// bcrypt adds no security over SHA-256 for keys of this entropy; SHA-256 is instant and
// deterministic across container restarts. Legacy bcrypt hashes auto-migrate on first use.
function checkAgent(req, res) {
  var key = req.headers['x-agent-key'];
  if (!key) {
    res.status(401).json({ error: 'Missing X-Agent-Key header' });
    return null;
  }
  // Rate limit agent key attempts
  var rlKey = 'agent:' + (req.ip || req.connection.remoteAddress);
  var now = Date.now();
  var rlEntry = _rateLimitStore[rlKey];
  if (rlEntry && rlEntry.resetAt >= now && rlEntry.count > 30) {
    var retryAfter = Math.ceil((rlEntry.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many attempts. Try again in ' + retryAfter + ' seconds.' });
    return null;
  }
  var keyHash = crypto.createHash('sha256').update(key).digest('hex');
  var resolved = resolveAgentKeyRecord(keyHash);
  if (resolved) {
    req._authAgentId = resolved.id;
    req._authProjectId = resolved.project_id;
    return resolved.id;
  }
  // Fallback: scan for legacy bcrypt hashes and auto-migrate.
  // Guarded: skip the O(N) bcrypt sweep entirely when no legacy hashes exist, so
  // a forged key can't trigger a full bcrypt comparison pass (DoS).
  if (hasLegacyBcryptAgents()) {
    var agents = listAllAgentsIncludingDrones();
    for (var a of agents) {
      var full = getAgent(a.id);
      if (!full || !full.api_key_hash) continue;
      if ((full.api_key_hash.startsWith('$2b$') || full.api_key_hash.startsWith('$2a$')) && bcrypt.compareSync(key, full.api_key_hash)) {
        updateAgentKey(a.id, keyHash);
        clearAgentKeyCache();
        setInAgentKeyCache(keyHash, { id: a.id, project_id: full.project_id || null });
        req._authAgentId = a.id;
        req._authProjectId = full.project_id || null;
        return a.id;
      }
    }
  }
  // Track failed attempt for rate limiting
  if (!rlEntry || rlEntry.resetAt < now) {
    _rateLimitStore[rlKey] = { count: 1, resetAt: now + 60 * 1000 };
  } else {
    rlEntry.count++;
  }
  res.status(403).json({ error: 'Invalid agent key' });
  return null;
}

// Admin auth: validates X-Admin-Key, studio JWT, or legacy admin key.
// Reject-path semantics (fixed 2026-07, findings §1): 401 = not authenticated
// (no credential, or a credential that failed verification); 403 = authenticated
// but not authorized. A VALID agent key is real authentication — it earns a 403
// "Admin role required", never a 401 — but grants NO admin access whatsoever.
function checkAdmin(req, res) {
  // Try studio JWT first — must have admin role
  var user = getStudioUser(req);
  if (user && user.role === 'admin') { req._authIsAdmin = true; return true; }
  if (user) { res.status(403).json({ error: 'Admin role required' }); return false; }
  // Try admin key
  var key = req.headers['x-admin-key'];
  if (isAdminKey(key)) { req._authIsAdmin = true; return true; }
  if (key) {
    // An admin key was presented but is wrong — name the actual problem.
    res.status(403).json({ error: 'Invalid admin key' });
    return false;
  }
  // No admin credential. If the caller authenticates with a valid AGENT key,
  // they are a real (non-admin) caller on an admin-only route: 403, not 401.
  // Cheap classification only — an invalid agent key falls through to the same
  // 401 as before, and resolution never grants any access or request state.
  var agentKey = req.headers['x-agent-key'];
  if (agentKey) {
    var keyHash = crypto.createHash('sha256').update(agentKey).digest('hex');
    if (resolveAgentKeyRecord(keyHash)) {
      res.status(403).json({ error: 'Admin role required' });
      return false;
    }
  }
  // Anonymous, a garbage Bearer token, or an unrecognized agent key: the caller
  // never authenticated → 401 (a garbage Bearer previously drew a misleading
  // 403 "Invalid admin key" despite no admin key being sent).
  res.status(401).json({ error: 'Authentication required' });
  return false;
}

// Any studio JWT user (operator or admin) OR admin key — NOT agent keys.
// Reject-path semantics (aligned 2026-07 with checkAdmin, findings §1):
// a fully anonymous caller gets 401; a caller who presented a credential
// (agent key, admin key, Bearer) keeps the pre-fix 403.
function checkAdminOrOperator(req, res) {
  var user = getStudioUser(req);
  if (user) { req._authIsAdmin = user.role === 'admin'; return user.displayName || user.username; }
  var key = req.headers['x-admin-key'];
  if (isAdminKey(key)) {
    req._authIsAdmin = true;
    return req.headers['x-acting-as'] || '__system__';
  }
  if (!key && !req.headers['authorization'] && !req.headers['x-agent-key']) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  res.status(403).json({ error: 'Operator or admin access required' });
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
  // Try studio JWT first — operators authenticate, but only admin-role
  // users carry the admin flag (mirrors checkAdmin/checkAdminOrOperator;
  // any-JWT-means-admin was a privilege-flattening hole)
  var user = getStudioUser(req);
  if (user) { req._authIsAdmin = user.role === 'admin'; return user.displayName || user.username; }
  // Try admin key
  var adminKey = req.headers['x-admin-key'];
  if (isAdminKey(adminKey)) {
    req._authIsAdmin = true;
    var actingAs = req.headers['x-acting-as'];
    return actingAs || '__system__';
  }
  // Try agent key
  return checkAgent(req, res);
}

// Auth guard for upload routes. checkAgentOrAdmin authenticates and writes the
// 401/403 response itself on failure; here we simply halt the chain (return)
// before next() — and therefore before upload.single() runs — so an
// unauthenticated request is rejected before any bytes hit disk.
function requireAuth(req, res, next) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return; // response already sent (401/403)
  next();
}


// ---- SSE clients registry ----
// Each entry: { res, filters: { project_id, type, agent } }
var sseClients = new Set();

// ---- Event helper ----

function emitEvent(type, agentId, projectId, summary, data) {
  // Heartbeats are high-frequency liveness pings (~1/agent/poll), NOT history —
  // aliveness lives on the agent row (last_seen/status), updated by the heartbeat
  // handler. Persisting one event per heartbeat previously flooded the events
  // table to 18M rows / 3GB (a stuck work item drove ~170 writes/sec). Match the
  // OpenJarvis model: broadcast liveness live, never persist it.
  var id = (type === 'agent_heartbeat')
    ? null
    : createEvent(type, agentId || '', projectId || null, summary || '', JSON.stringify(data || {}));
  var eventObj = {
    id: id, type: type, agent: agentId || '',
    project_id: projectId || null, summary: summary || '',
    data: data || {},
    created_at: new Date().toISOString()
  };
  // Broadcast to connected SSE clients (with per-client filtering)
  // NOTE (audit 2026-07, M2): the inner JSON.stringify(eventObj.data) is the
  // INTENTIONAL wire format, not a double-encode bug. Replayed events (the
  // on-connect backlog in the /events SSE route) read `data` straight from the
  // DB, where createEvent stores it as a JSON string — so live broadcasts
  // re-stringify to match: every SSE consumer receives `data` as a JSON
  // *string* on both paths. "Fixing" this forks the live vs replay format
  // and breaks existing clients. See docs/audit-2026-07-core-hardening.md.
  if (sseClients.size > 0) {
    var payload = 'data: ' + JSON.stringify({ ...eventObj, data: JSON.stringify(eventObj.data) }) + '\n\n';
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
  // Notify plugin event hooks (async-safe: handlers are synchronous by convention)
  callEventHooks(type, eventObj);
  return id;
}

// ---- Operator email alerts (fire-and-forget) ----
function notifyOperators(alertTitle, alertBodyHtml, actionUrl) {
  if (!isEmailEnabled()) return;
  try {
    var operators = listOperators();
    for (var op of operators) {
      if (op.email && op.status === 'active') {
        sendEmail(templateOperatorAlert(op.email, op.display_name, alertTitle, alertBodyHtml, actionUrl || 'https://mycelium.fyi/'));
      }
    }
  } catch (e) {
    console.error('[email] notifyOperators failed:', e.message);
  }
}

// ---- Approval gate helpers ----
// Soft enforcement: warns agents but doesn't block (returns warning field).
// Hard enforcement: blocks agents without an approved approval_id.
function checkApprovalGate(req, who, actionType) {
  // Admin/studio users and system bypass gates
  if (who === '__admin__' || who === '__system__' || !who || req._authIsAdmin) return { ok: true };
  var approvalId = req.body.approval_id || req.query.approval_id;
  if (!approvalId) {
    return { ok: false, soft: true, warning: 'This action (' + actionType + ') should use the approval system. Call mycelium_request_approval first.' };
  }
  var approval = getApproval(parseIntParam(approvalId));
  if (!approval) return { ok: false, error: 'Approval #' + approvalId + ' not found' };
  if (approval.status !== 'approved') return { ok: false, error: 'Approval #' + approvalId + ' is ' + approval.status + ', not approved' };
  if (approval.action_type !== actionType) return { ok: false, error: 'Approval #' + approvalId + ' is for ' + approval.action_type + ', not ' + actionType };
  if (approval.requested_by !== who) return { ok: false, error: 'Approval #' + approvalId + ' belongs to ' + approval.requested_by + ', not ' + who };
  return { ok: true, approval: approval };
}

// ---- Enforcement rules: runtime convention enforcement on tool calls ----
var _enforcementRulesCache = null;
var _enforcementRulesCacheTime = 0;
var ENFORCEMENT_CACHE_TTL = 60000; // 60s

function getEnforcementRules() {
  var now = Date.now();
  if (_enforcementRulesCache && (now - _enforcementRulesCacheTime) < ENFORCEMENT_CACHE_TTL) {
    return _enforcementRulesCache;
  }
  try {
    var ctx = getContextKey('mycelium', 'enforcement_rules');
    if (ctx && ctx.data) {
      var data = typeof ctx.data === 'string' ? JSON.parse(ctx.data) : ctx.data;
      _enforcementRulesCache = Array.isArray(data) ? data : (data.rules || []);
    } else {
      _enforcementRulesCache = [];
    }
  } catch {
    _enforcementRulesCache = [];
  }
  _enforcementRulesCacheTime = now;
  return _enforcementRulesCache;
}

function checkEnforcementRules(toolName, args, agentId) {
  var rules = getEnforcementRules();
  if (!rules.length) return { allowed: true, warnings: [], blocks: [] };

  var warnings = [];
  var blocks = [];
  var argsStr = typeof args === 'string' ? args : JSON.stringify(args || {});

  for (var rule of rules) {
    // Check if rule matches this tool
    if (rule.tool !== '*' && rule.tool !== toolName) continue;

    // Check match conditions
    if (rule.match && rule.match.content_pattern) {
      var re;
      try { re = new RegExp(rule.match.content_pattern, 'i'); } catch { continue; }
      if (!re.test(argsStr)) continue;
    }

    // Rule matched — check enforcement conditions
    var violated = false;

    if (rule.enforce) {
      // Check expected_tool — agent used wrong tool
      if (rule.enforce.expected_tool && rule.enforce.expected_tool !== toolName) {
        violated = true;
      }
      // Check expected_args
      if (rule.enforce.expected_args) {
        for (var key in rule.enforce.expected_args) {
          if (args && args[key] !== rule.enforce.expected_args[key]) {
            violated = true;
          }
        }
      }
      // Check required_role
      if (rule.enforce.required_role) {
        try {
          var agent = getAgent(agentId);
          if (agent && agent.role !== rule.enforce.required_role && agentId !== '__admin__' && agentId !== '__system__') {
            violated = true;
          }
        } catch {}
      }
    } else {
      // No enforce conditions — match alone triggers violation (block patterns)
      violated = true;
    }

    if (violated) {
      var entry = { rule_id: rule.id, message: rule.message || 'Enforcement rule violated', severity: rule.severity || 'warn' };
      if (rule.severity === 'block') {
        blocks.push(entry);
      } else {
        warnings.push(entry);
      }

      // Log enforcement event
      try {
        emitEvent('enforcement_violation', agentId, null, (rule.severity === 'block' ? 'BLOCKED' : 'WARNING') + ': ' + (rule.message || rule.id), { rule_id: rule.id, tool: toolName, severity: rule.severity });
      } catch {}
    }
  }

  return { allowed: blocks.length === 0, warnings: warnings, blocks: blocks };
}

// Wire enforcement into message sending
// ---- Capability matching: check if agent can handle work ----
function agentCanHandle(agent, workItem) {
  // Parse agent capabilities (stored as JSON array string)
  var caps = [];
  try { caps = JSON.parse(agent.capabilities || '[]'); } catch {}
  if (!Array.isArray(caps) || caps.length === 0) return true; // no caps declared = can do anything (legacy)

  // Check task tags for required capabilities (convention: tag like "requires:gpu", "requires:review")
  var tags = [];
  if (workItem.tags) {
    try { tags = typeof workItem.tags === 'string' ? JSON.parse(workItem.tags) : workItem.tags; } catch {}
  }
  for (var tag of tags) {
    if (typeof tag === 'string' && tag.startsWith('requires:')) {
      var required = tag.substring(9);
      if (caps.indexOf(required) === -1) return false;
    }
  }

  // Check title keywords as heuristic routing
  var title = ((workItem.title || '') + ' ' + (workItem.plan_title || '')).toLowerCase();
  // GPU/art work should go to agents with gpu capability
  if ((title.includes('sprite') || title.includes('art gen') || title.includes('lora') || title.includes('gpu')) && caps.indexOf('gpu') === -1 && caps.indexOf('assets') === -1) {
    return false;
  }
  // Code review should go to agents with review capability
  if ((title.includes('review') || title.includes('pr review')) && caps.indexOf('review') === -1 && caps.indexOf('admin') === -1 && caps.indexOf('code') === -1) {
    return false;
  }

  return true;
}

// ---- Auto-dispatch: push work to idle agents ----
function dispatchWorkToIdleAgents(triggerContext) {
  var idleAgents = getIdleAgents();
  if (idleAgents.length === 0) return [];

  var dispatched = [];
  var claimedTaskIds = [];

  for (var agent of idleAgents) {
    // Skip agents that are busy (working_on set means runner is active)
    if (agent.working_on && agent.working_on.trim() !== '') continue;

    // Skip agents that already have unresolved directives (prevents directive pileup/loops)
    var pendingDirectives = listMessages({ to_agent: agent.id, msg_type: 'directive', status: 'sent', limit: 1 });
    if (pendingDirectives.length > 0) continue;

    // Skip coordination-only agents (no code capability = can't do dev work)
    var agentCaps = [];
    try { agentCaps = JSON.parse(agent.capabilities || '[]'); } catch {}
    var hasCodeCap = agentCaps.some(function(c) { return c === 'code' || c === 'game-dev' || c === 'platform'; });
    if (agentCaps.length > 0 && !hasCodeCap) continue;

    // Skip if agent already has assigned open/in_progress tasks
    var agentTasks = listTasks({ assignee: agent.id, status: 'open' });
    var inProgress = listTasks({ assignee: agent.id, status: 'in_progress' });
    if (inProgress.length > 0) continue; // already working
    if (agentTasks.length > 0) continue; // has queued work

    // Try to find work: plan steps first, then unassigned tasks
    // Bug #131: Scope to agent's project(s) to prevent cross-project dispatch
    var agentProjectIds = getTeamProjectIdsForAgent(agent.id);
    // Also include the agent's own project_id field as fallback
    if (agent.project_id && agent.project_id !== 'drone' && agentProjectIds.indexOf(agent.project_id) === -1) {
      agentProjectIds.push(agent.project_id);
    }
    var step = getNextUnassignedPlanStep(agentProjectIds.length > 0 ? agentProjectIds : null);
    // Capability check — skip if agent can't handle this step
    if (step && !agentCanHandle(agent, step)) step = null;
    if (step) {
      // Assign plan step
      updatePlanStep(step.id, { assignee: agent.id, status: 'pending' });
      // Directives deprecated (2026-06-05): the assignment above IS the dispatch.
      // The agent pull-claims this step from /work on its next poll — no directive.
      emitEvent('auto_dispatch', '__system__', null, 'Auto-dispatched plan step "' + step.title + '" to ' + agent.id, { agent_id: agent.id, plan_step_id: step.id, trigger: triggerContext });
      dispatched.push({ agent: agent.id, type: 'plan_step', id: step.id, title: step.title });
      continue;
    }

    var task = getNextUnassignedTask(claimedTaskIds, agentProjectIds.length > 0 ? agentProjectIds : null);
    // Capability check — skip if agent can't handle this task
    if (task && !agentCanHandle(agent, task)) task = null;
    if (task) {
      // Assign task
      updateTask(task.id, { assignee: agent.id });
      claimedTaskIds.push(task.id);
      // Directives deprecated (2026-06-05): assigning the task IS the dispatch.
      // The agent pull-claims it from /work (myTasks tier) next poll — no directive.
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

// Apply project_id normalization (backward compat: accept project/game too)
router.use(normalizeProjectField);

// (WAITLIST route retired 2026-06-05 with the .fyi product surface — the
// research site no longer has a signup form. Operator auth lives in /studio/* API.)

// GET /public/activity — no auth, sanitized live activity feed for public dashboard
// SECURITY: Strict allowlist — only expose what's explicitly safe. No project details,
// no task/bug descriptions, no message content, no working_on specifics.
router.get('/public/activity', asyncHandler(function (req, res) {
  try {
    var db = getDB();
    var today = new Date().toISOString().slice(0, 10);

    // Online agents — names and status only (working_on leaks project info)
    var agents = db.prepare(
      "SELECT name, status FROM agents WHERE role != 'drone' ORDER BY CASE WHEN status='online' THEN 0 ELSE 1 END, name"
    ).all().map(function (a) {
      return { name: a.name, online: a.status === 'online' };
    });

    // Drones — separate from agents
    var drones = db.prepare(
      "SELECT name, status FROM agents WHERE role = 'drone' ORDER BY CASE WHEN status='online' THEN 0 ELSE 1 END, name"
    ).all().map(function (d) {
      return { name: d.name, online: d.status === 'online' };
    });

    // Aggregate stats — counts only, no details
    var tasksToday = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND updated_at >= ?"
    ).get(today).c;
    var bugsToday = db.prepare(
      "SELECT COUNT(*) as c FROM bugs WHERE status IN ('fixed','closed') AND updated_at >= ?"
    ).get(today).c;
    var plansActive = db.prepare(
      "SELECT COUNT(*) as c FROM plans WHERE status = 'active'"
    ).get().c;
    var agentsOnline = db.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE status = 'online' AND role != 'drone'"
    ).get().c;
    var totalTasksDone = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE status = 'done'"
    ).get().c;
    var totalBugsFixed = db.prepare(
      "SELECT COUNT(*) as c FROM bugs WHERE status IN ('fixed','closed')"
    ).get().c;

    // Recent events — type + agent + timestamp only (no titles — leak project info)
    var safeEventTypes = [
      'task_completed', 'task_created', 'bug_filed', 'bug_fixed',
      'plan_step_completed', 'plan_created',
      'drone_job_completed', 'pr_merged', 'bip_draft_created'
    ];
    var placeholders = safeEventTypes.map(function () { return '?'; }).join(',');
    var evtStmt = db.prepare(
      'SELECT type, agent, created_at FROM events WHERE type IN (' + placeholders + ') ORDER BY created_at DESC LIMIT 30'
    );
    var events = evtStmt.all.apply(evtStmt, safeEventTypes).map(function (e) {
      return {
        type: e.type,
        agent: e.agent || 'system',
        time: e.created_at
      };
    });

    // Active plans — generic labels, progress only (titles leak project info)
    var planRows = db.prepare(
      "SELECT id FROM plans WHERE status = 'active' ORDER BY updated_at DESC LIMIT 5"
    ).all();
    var plans = planRows.map(function (p, idx) {
      var steps = db.prepare(
        'SELECT COUNT(*) as total, SUM(CASE WHEN status = \'completed\' THEN 1 ELSE 0 END) as done FROM plan_steps WHERE plan_id = ?'
      ).get(p.id);
      return {
        title: 'Initiative ' + String.fromCharCode(65 + idx),
        progress: steps.total > 0 ? Math.round((steps.done / steps.total) * 100) : 0,
        steps_done: steps.done || 0,
        steps_total: steps.total || 0
      };
    });

    // Calibration / alignment — sanitized: status only, no rules or CLAUDE.md content
    var profileCount = db.prepare('SELECT COUNT(*) as c FROM node_profiles').get().c;
    var agentRows = db.prepare(
      "SELECT id, name, status FROM agents WHERE role != 'drone' ORDER BY name"
    ).all();
    var alignmentAgents = agentRows.map(function (a) {
      var entry = db.prepare(
        "SELECT data FROM context_keys WHERE namespace = ? AND key = 'standup'"
      ).get(a.id);
      var status = 'unknown';
      var driftCount = 0;
      if (entry) {
        try {
          var cal = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
          status = cal.status || 'unknown';
          driftCount = Array.isArray(cal.drift) ? cal.drift.length : 0;
        } catch (e) { /* malformed data */ }
      }
      return { name: a.name, online: a.status === 'online', alignment: status, drift: driftCount };
    });
    var aligned = alignmentAgents.filter(function (a) { return a.alignment === 'aligned'; }).length;
    var drifted = alignmentAgents.filter(function (a) { return a.alignment === 'drifted'; }).length;
    var critical = alignmentAgents.filter(function (a) { return a.alignment === 'critical'; }).length;
    var uncalibrated = alignmentAgents.filter(function (a) { return a.alignment === 'unknown'; }).length;

    res.json({
      agents: agents,
      drones: drones,
      stats: {
        agents_online: agentsOnline,
        drones_total: drones.length,
        drones_online: drones.filter(function (d) { return d.online; }).length,
        tasks_completed_today: tasksToday,
        bugs_fixed_today: bugsToday,
        plans_active: plansActive,
        total_tasks_done: totalTasksDone,
        total_bugs_fixed: totalBugsFixed
      },
      events: events,
      plans: plans,
      alignment: {
        profiles: profileCount,
        agents: alignmentAgents,
        summary: { aligned: aligned, drifted: drifted, critical: critical, uncalibrated: uncalibrated }
      },
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[public/activity] Error:', e.message);
    res.json({
      agents: [], drones: [], stats: { agents_online: 0, drones_total: 0, drones_online: 0, tasks_completed_today: 0, bugs_fixed_today: 0, plans_active: 0, total_tasks_done: 0, total_bugs_fixed: 0 },
      events: [], plans: [], updated_at: new Date().toISOString()
    });
  }
}));

// (Admin waitlist routes GET/PUT /waitlist retired 2026-06-05 with the .fyi
// product surface. The `waitlist` table is left intact for historical data.)

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

// ======== REASONING STREAM ========

// An agent (squad_loop) posts its reasoning chain as it works a task: thinking
// (<think>), tool_call, result, done, error. ONE stream → the operator app's
// sidecar back-half + training corpus + cockpit shimmer colour. Persisted (it's
// training data, unlike heartbeats) and SSE-broadcast to the operator app.
// Contract: mycelium-app/docs/specs/2026-06-06-reasoning-stream.md
router.post('/reasoning', agentWriteLimiter, asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var b = req.body || {};
  var agent = b.agent || who;
  var step = String(b.step || 'thinking');
  if (['thinking', 'tool_call', 'result', 'done', 'error'].indexOf(step) === -1) {
    return apiError(res, 400, 'invalid step');
  }
  var data = {
    task_id: (b.task_id != null) ? b.task_id : null,
    turn:    (b.turn != null) ? b.turn : null,
    step:    step,
    text:    (typeof b.text === 'string') ? b.text : '',
    tool:    b.tool || null
  };
  var summary = agent + ' · ' + step
    + (b.tool && b.tool.name ? ' · ' + b.tool.name : '')
    + (b.task_id != null ? ' (task #' + b.task_id + ')' : '');
  var id = emitEvent('agent_reasoning', agent, req._authProjectId || null, summary, data);
  res.json({ ok: true, id: id });
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

// ======== TASKS ======== (extracted -> ./tasks.js)

// ======== SPEND TRACKING ========

router.post('/spend', asyncHandler(function (req, res) {
  var agentId = checkAgentOrAdmin(req, res);
  if (!agentId) return;
  if (!checkGuardrails(req, res, 'spend_logged', { agent: agentId, project_id: req.body.project_id, cost_usd: req.body.cost_usd })) return;
  var costUsd = parseFloat(req.body.cost_usd) || 0;
  if (costUsd < 0) return res.status(400).json({ error: 'cost_usd must be non-negative' });
  logAgentSpend(
    agentId,
    req.body.project_id || '',
    costUsd,
    req.body.source || '',
    req.body.description || '',
    req.body.model || '',
    parseInt(req.body.tokens_in) || 0,
    parseInt(req.body.tokens_out) || 0
  );
  res.json({ ok: true });
}));

router.get('/spend/:agentId', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var entries = getAgentSpend(req.params.agentId, {
    since: req.query.since,
    project_id: req.query.project_id,
    limit: parseInt(req.query.limit) || 50
  });
  res.json(entries);
}));

router.get('/spend', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var summary = getSpendSummary({
    since: req.query.since,
    project_id: req.query.project_id
  });
  var total = summary.reduce(function (acc, r) { return acc + (r.total_cost || 0); }, 0);
  res.json({ total_cost_usd: Math.round(total * 10000) / 10000, breakdown: summary });
}));

// ======== RUNS (the run-log) ========

// Open a run. Squad writes (agent key); operator/admin pass too. Returns the row.
router.post('/runs', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  if (!checkGuardrails(req, res, 'run_started', { agent: who, project_id: req.body.project_id })) return;
  // Bind the run to the AUTHENTICATED agent — a non-admin can't attribute a run to
  // another agent. Admin (e.g. the bridge recording on behalf of an agent) may set it.
  var ownerAgent = req._authIsAdmin ? (req.body.agent_id || who) : (req._authAgentId || who);
  var run = createRun({
    id: req.body.id || crypto.randomUUID(),
    agent_id: ownerAgent,
    model: req.body.model,
    project_id: req.body.project_id,
    workflow_id: req.body.workflow_id || null,
    brief: req.body.brief,
    status: req.body.status || 'running'
  });
  res.json(run);
}));

// Close/update a run with telemetry (turns/tokens/energy/artifacts/result/finished_at).
router.put('/runs/:id', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var existing = getRun(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Run not found' });
  // Only the run's OWN agent, the worker that claimed it, or an admin may report telemetry.
  if (!req._authIsAdmin && existing.agent_id !== req._authAgentId && existing.claimed_by !== req._authAgentId) {
    return res.status(403).json({ error: 'Forbidden — not your run' });
  }
  var fields = {};
  ['model', 'status', 'turns', 'tool_calls', 'tokens_in', 'tokens_out',
   'energy_joules', 'artifacts', 'result', 'finished_at', 'duration_ms'].forEach(function (k) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  });
  // Accept JSON arrays for tool_calls/artifacts; store as strings.
  if (fields.tool_calls !== undefined && typeof fields.tool_calls !== 'string') fields.tool_calls = JSON.stringify(fields.tool_calls);
  if (fields.artifacts !== undefined && typeof fields.artifacts !== 'string') fields.artifacts = JSON.stringify(fields.artifacts);
  res.json(updateRun(req.params.id, fields));
}));

// A run-worker claims the next PENDING run (drone-style atomic claim), optionally scoped
// to one agent_id. Reaps stale claims first (like the drone claim path), so a dead worker
// can't strand a run. Returns the claimed run, or 204 when the queue is empty.
router.post('/runs/claim', asyncHandler(function (req, res) {
  var workerId = checkAgentOrAdmin(req, res);
  if (!workerId) return;
  // Stale-reap window is a SERVER constant — never client-controlled (a client could pass
  // 0 to fail every in-flight run). The worker is the authenticated principal, not
  // client-supplied (no claiming as another worker).
  releaseStaleClaimedRuns();   // default 60-min window
  var run = claimRun(workerId, { agent_id: req.body.agent_id });
  if (!run) return res.status(204).end();
  res.json(run);
}));

// The run-log the Engine Room renders. Operator-readable (studio JWT passes checkAgentOrAdmin).
router.get('/runs', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listRuns({
    agent_id: req.query.agent_id,
    project_id: req.query.project_id,
    status: req.query.status,
    since: req.query.since,
    limit: parseInt(req.query.limit) || 50
  }));
}));

router.get('/runs/:id', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
}));

// Re-run THIS agent (the singular, scope=this rerun): records a NEW pending run with the
// same agent+brief, linked via rerun_of; a run-worker claims it via POST /runs/claim. A
// run that's part of a COLLECTION (workflow_id set) defaults to re-firing the WHOLE
// workflow instead — that lives in the workflow layer, not here.
router.post('/runs/:id/rerun', asyncHandler(function (req, res) {
  var who = checkAdminOrOperator(req, res);   // rerun is an operator action — not arbitrary agents
  if (!who) return;
  var orig = getRun(req.params.id);
  if (!orig) return res.status(404).json({ error: 'Run not found' });
  if (!checkProjectScope(req, res, orig.project_id)) return;
  var fresh = createRun({
    id: crypto.randomUUID(),
    agent_id: orig.agent_id,
    model: orig.model,
    project_id: orig.project_id,
    workflow_id: orig.workflow_id || null,
    brief: orig.brief,
    status: 'pending',
    rerun_of: orig.id
  });
  res.json(fresh);
}));

// ======== WIDGETS ======== (extracted -> ./assets.js)

// ======== VOICE COMMANDS ========

// Process a voice command — parse natural language into Mycelium actions
router.post('/voice/command', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  // Strip wake word
  text = text.replace(/^(hey |ok |hello )?(mycelium|mycelia)[,.]?\s*/i, '').trim();
  if (!text) return res.json({ action: 'none', response: 'How can I help?' });

  // Parse intent
  var result = parseVoiceCommand(text, who);
  emitEvent('voice_command', who || 'operator', '', text, { action: result.action });
  res.json(result);
}));

function parseVoiceCommand(text, who) {
  var lower = text.toLowerCase();

  // Status queries
  if (lower.match(/status|how.*(things|going|look)|what.*(happening|going on)/)) {
    var agents = listAgents ? listAgents() : [];
    var online = agents.filter(function(a) { return a.status === 'online'; });
    var working = online.filter(function(a) { return a.working_on; });
    return {
      action: 'status',
      response: online.length + ' agents online, ' + working.length + ' working. ' +
        (working.length > 0 ? working.map(function(a) { return a.id + ' is on ' + a.working_on; }).join('. ') : 'Everyone is idle.')
    };
  }

  // Agent-specific status
  var agentMatch = lower.match(/(?:status|what.* doing|where.*is|check on)\s+(\S+)/);
  if (agentMatch) {
    var agentId = agentMatch[1].replace(/-claude$/, '') + '-claude';
    var agents2 = listAgents ? listAgents() : [];
    var agent = agents2.find(function(a) { return a.id === agentId || a.id === agentMatch[1]; });
    if (agent) {
      return {
        action: 'agent_status',
        response: agent.id + ' is ' + agent.status + '. ' + (agent.working_on ? 'Working on: ' + agent.working_on : 'Currently idle.')
      };
    }
  }

  // Drone status
  if (lower.match(/drone|gpu|3090|art.*drone/)) {
    var drones = listAgents ? listAgents().filter(function(a) { return a.agent_type === 'drone'; }) : [];
    return {
      action: 'drone_status',
      response: drones.length + ' drones registered. ' + drones.map(function(d) {
        return d.id + ': ' + d.status + (d.working_on ? ' (' + d.working_on + ')' : '');
      }).join('. ')
    };
  }

  // Task queries
  if (lower.match(/task|open.*task|pending.*task|what.*needs.*done/)) {
    var tasks = listTasks ? listTasks({ status: 'open', limit: 5 }) : [];
    return {
      action: 'tasks',
      response: tasks.length + ' open tasks. ' + (tasks.length > 0 ? tasks.slice(0, 3).map(function(t) { return '#' + t.id + ': ' + t.title; }).join('. ') : 'All clear.')
    };
  }

  // Bug queries
  if (lower.match(/bug|issue|problem/)) {
    var bugs = listBugs ? listBugs({ status: 'open' }) : [];
    return {
      action: 'bugs',
      response: bugs.length + ' open bugs. ' + (bugs.length > 0 ? bugs.slice(0, 3).map(function(b) { return '#' + b.id + ': ' + b.title; }).join('. ') : 'No open bugs.')
    };
  }

  // Assign task
  var assignMatch = lower.match(/assign\s+(.+?)\s+to\s+(\S+)/);
  if (assignMatch) {
    return {
      action: 'assign',
      response: 'To assign tasks, use the dashboard or send a directive. I noted your request: assign "' + assignMatch[1] + '" to ' + assignMatch[2] + '.'
    };
  }

  // Fallback
  return {
    action: 'unknown',
    response: 'I heard: "' + text + '". Try asking about agent status, tasks, bugs, or drones.'
  };
}

// ======== SKILLS REGISTRY ======== (extracted -> ./concepts.js; mounted below
// with projects + concepts. /agents/:agentId/skills stays here — agents domain.)

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

// Forbidden capabilities by agent_type
var DRONE_FORBIDDEN_CAPS = ['code', 'coordination', 'admin'];

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

// ======== ASSETS ======== (extracted -> ./assets.js)

// ======== EVENTS ======== (extracted -> ./messages.js)

// ======== REQUESTS ======== (extracted -> ./tasks.js)

// ======== MESSAGES ======== (extracted -> ./messages.js)

// ======== PLANS ======== (extracted -> ./plans.js)

// ======== STUDIO AUTH ========

// Timing-equalization dummy: a bcrypt(10) hash of a discarded random secret.
// Unknown-username logins compare against this so they cost the same ~bcrypt
// work as a wrong-password attempt. Without it, a fast 401 is a username-
// enumeration oracle (no bcrypt = user doesn't exist). The preimage was never
// recorded, and even a (impossible) match still returns 401.
var DUMMY_PASSWORD_HASH = '$2b$10$IdXAs1NYtjlSW9GPXwmXde8.C0VPUVZT8VZVs0dgdc/hSskze9Z8m';

// Login — returns JWT
router.post('/studio/login', loginLimiter, asyncHandler(async function (req, res) {
  var username = (req.body.username || '').trim().toLowerCase();
  var password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  var user = getStudioUserByUsername(username);
  if (!user) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalize timing — see DUMMY_PASSWORD_HASH
    return res.status(401).json({ error: 'Invalid username or password' });
  }
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
router.get('/studio/me', asyncHandler(function (req, res) {
  var user = getStudioUser(req);
  if (!user) {
    // Check admin key
    var key = req.headers['x-admin-key'];
    if (isAdminKey(key)) return res.json({ id: 0, username: 'admin', display_name: 'Admin', role: 'admin' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  var dbUser = getStudioUserById(user.userId);
  if (!dbUser) return res.status(401).json({ error: 'User not found' });
  res.json(dbUser);
}));

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
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (getStudioUserByUsername(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  var hash = await bcrypt.hash(password, BCRYPT_ROUNDS_PASSWORD);
  var id = createStudioUser(username, displayName, hash, role);
  emitEvent('user_created', getAdminDisplayName(req), null, 'Studio user created: ' + displayName + ' (' + username + ')');
  res.json({ id: id, username: username, display_name: displayName, role: role });
}));

// List studio users (admin only)
router.get('/studio/users', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listStudioUsers());
}));

// Update studio user (admin only)
router.put('/studio/users/:id', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseIntParam(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  var fields = {};
  if (req.body.role !== undefined) fields.role = req.body.role;
  if (req.body.display_name !== undefined) fields.display_name = req.body.display_name;
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });
  updateStudioUser(user.id, fields);
  res.json({ ok: true, id: user.id, username: user.username, ...fields });
}));

// Update studio user password (admin only)
router.put('/studio/users/:id/password', asyncHandler(async function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseIntParam(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  var newPassword = req.body.password || '';
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  var hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS_PASSWORD);
  updateStudioUser(user.id, { password_hash: hash });
  res.json({ ok: true, username: user.username });
}));

// Delete studio user (admin only)
router.delete('/studio/users/:id', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var user = getStudioUserById(parseIntParam(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteStudioUser(user.id);
  res.json({ ok: true, deleted: user.username });
}));

// ======== PASSWORD RESET (public, rate-limited) ========

// Ensure password_resets table exists (inline migration pattern, same as waitlist)
try {
  getDB().prepare(`CREATE TABLE IF NOT EXISTS password_resets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
} catch (e) { /* already exists */ }

var forgotPasswordLimiter = rateLimit(function (req) { return 'forgot:' + (req.body.email || '').toLowerCase(); }, 3, 15 * 60 * 1000);
var resetPasswordLimiter = rateLimit(function (req) { return 'reset:' + (req.ip || req.connection.remoteAddress); }, 5, 15 * 60 * 1000);

// POST /studio/forgot-password — request password reset email
router.post('/studio/forgot-password', forgotPasswordLimiter, asyncHandler(async function (req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });
  // Always return 200 (no user enumeration)
  var GENERIC = { ok: true, message: 'If that email is associated with an account, a reset link has been sent.' };
  // Find operator by email → get their studio_user_id
  var db = getDB();
  var operator = db.prepare('SELECT * FROM operators WHERE LOWER(email) = ? AND status = ?').get(email, 'active');
  if (!operator || !operator.studio_user_id) return res.json(GENERIC);
  var studioUser = getStudioUserById(operator.studio_user_id);
  if (!studioUser) return res.json(GENERIC);
  // Generate secure token (48 hex chars), store SHA-256 hash
  var token = crypto.randomBytes(32).toString('hex');
  var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  var expiresMinutes = 30;
  var expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();
  db.prepare('INSERT INTO password_resets (email, token_hash, expires_at) VALUES (?, ?, ?)').run(email, tokenHash, expiresAt);
  // Build reset URL (dashboard handles the UI)
  var resetUrl = 'https://mycelium.fyi/studio/#/reset-password?token=' + token;
  sendEmail(templatePasswordReset(email, studioUser.display_name, resetUrl, expiresMinutes));
  res.json(GENERIC);
}));

// POST /studio/reset-password — validate token and set new password
router.post('/studio/reset-password', resetPasswordLimiter, asyncHandler(async function (req, res) {
  var token = (req.body.token || '').trim();
  var newPassword = req.body.password || '';
  if (!token) return res.status(400).json({ error: 'token is required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  var db = getDB();
  var row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')").get(tokenHash);
  if (!row) return res.status(400).json({ error: 'Invalid or expired reset token' });
  // Find operator → studio user
  var operator = db.prepare('SELECT * FROM operators WHERE LOWER(email) = ?').get(row.email);
  if (!operator || !operator.studio_user_id) return res.status(400).json({ error: 'Account not found' });
  var studioUser = getStudioUserById(operator.studio_user_id);
  if (!studioUser) return res.status(400).json({ error: 'Account not found' });
  // Update password (bcrypt 10 rounds for human passwords)
  var hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS_PASSWORD);
  updateStudioUser(studioUser.id, { password_hash: hash });
  // Mark token as used
  db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
  emitEvent('password_reset', '__system__', null, 'Password reset for ' + studioUser.display_name + ' (' + studioUser.username + ')');
  res.json({ ok: true, message: 'Password has been reset. You can now log in.' });
}));

router.put('/operators/:id/availability', asyncHandler(function (req, res) {
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
    // Directives deprecated (2026-06-05): no per-agent "night directive"
    // broadcast on autonomous transition. Sleep config retains the directive
    // text for the morning summary; agents pull work, they aren't nudged awake.
    emitEvent('autonomous_mode_on', who, null, 'All operators away — network is autonomous');
  }

  // Transition from autonomous
  if (wasBefore && !isNow) {
    emitEvent('autonomous_mode_off', who, null, displayName(req.params.id) + ' is back — autonomous mode ended');
    var agents2 = listAgents();
    for (var agent2 of agents2) {
      if (agent2.status === 'online' || agent2.status === 'idle') {
        createMessage('__system__', agent2.id, null, null, 'Operator ' + displayName(req.params.id) + ' is back. Human operators available.', '{}', 'info');
      }
    }
  }

  emitEvent('operator_availability', who, null, displayName(req.params.id) + ' is now ' + availability);
  res.json(getOperator(req.params.id));
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

// =============== PROJECTS ===============

// ======== CONCEPTS / PROJECTS / SKILLS ======== (extracted -> ./concepts.js)
registerConceptRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
  parseIntParam, getAdminDisplayName, checkApprovalGate, getBugCategories,
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
}, 10 * 60 * 1000).unref();

// Bug #137: Periodically auto-fail stale claimed drone jobs (every 15 minutes)
// Bug #134/#132: Also flag drones offline if no heartbeat in 30 minutes
setInterval(function () {
  try {
    var stale = releaseStaleClaimedJobs();
    if (stale.length > 0) {
      emitEvent('drone_stale_cleanup', '__system__', 'drone', 'Auto-failed ' + stale.length + ' stale claimed drone job(s): ' + stale.map(function (j) { return '#' + j.id; }).join(', '), { job_ids: stale.map(function (j) { return j.id; }) });
    }
    // Flag drones offline if no heartbeat in 30 minutes
    var drones = listDrones();
    for (var drone of drones) {
      if (drone.status === 'online' && drone.last_heartbeat) {
        var lastSeen = new Date(drone.last_heartbeat).getTime();
        var minutesAgo = (Date.now() - lastSeen) / 60000;
        if (minutesAgo > 30) {
          updateAgentHeartbeat(drone.id, 'offline', '');
          emitEvent('drone_offline_detected', '__system__', 'drone', 'Drone ' + drone.id + ' flagged offline — no heartbeat for ' + Math.round(minutesAgo) + ' minutes', { drone_id: drone.id, minutes_since_heartbeat: Math.round(minutesAgo) });
        }
      }
    }
  } catch (e) { /* cleanup is best-effort */ }
}, 15 * 60 * 1000).unref();

// ======== FILES (temp uploads) ======== (extracted -> ./assets.js)

// =============== BUGS =============== (extracted -> ./bugs.js)
registerBugRoutes(router, {
  asyncHandler, agentWriteLimiter, checkAgentOrAdmin, checkAdmin, checkProjectScope,
  checkGuardrails, emitEvent, validateEnum, validateStringLength, getBugCategories,
  parseLimit, parseIntParam, warnSuspectTransition, getAdminDisplayName,
  MAX_TITLE, MAX_DESCRIPTION, BUG_STATUSES, BUG_SEVERITIES,
});

// ======== TEAM CHAT (human-only) ======== (extracted -> ./messages.js)

// ======== CHANNELS ======== (extracted -> ./channels.js)
registerChannelRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, escapeHtml, parseIntParam,
  parseLimit, validateEnum, emitEvent, getAdminDisplayName, CHANNEL_STATUSES,
});

// ======== CONTEXT ======== (extracted -> ./context.js)
registerContextRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
});

// ======== ADMIN (overview/config/kill-switch/health/reconciliation/stats) ======== (extracted -> ./admin.js)
registerAdminRoutes(router, {
  asyncHandler, checkAdmin, checkAgentOrAdmin, emitEvent, getAdminDisplayName,
  validateEnum, adminWriteLimiter, AGENT_STATUSES,
  getInstanceUrl, buildMcpConfig, displayName, getStudioUser,
  clearAgentKeyCache, invalidateAgentKeyCache, runHealthPatrol,
});

// ======== MESSAGES + EVENTS + TEAM-CHAT + INBOX ======== (extracted -> ./messages.js)
registerMessageRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
  escapeHtml, parseIntParam, parseLimit, emitEvent, apiError,
  validateStringLength, MAX_CONTENT, checkEnforcementRules,
  agentWriteLimiter, getStudioUser, isAdminKey, displayName,
  jwt, JWT_SECRET, sseClients,
});

// ======== ASSETS + FILES + FILE-SERVER + WIDGETS ======== (extracted -> ./assets.js)
registerAssetRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails, emitEvent,
  escapeHtml, parseIntParam, parseLimit, validateEnum, getAdminDisplayName,
  requireAuth, upload, ASSET_STATUSES, FILES_DIR, ARTIFACTS_DIR, FILE_TTL_MS,
});

// ======== TEAMS + ORGS + OPERATORS + TEAM-SETTINGS ======== (extracted -> ./teams.js)
registerTeamRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, checkAdminOrOperator,
  emitEvent, getAdminDisplayName, apiError,
});

// ======== PLANS + APPROVALS ======== (extracted -> ./plans.js)
registerPlansRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
  checkProjectScope, checkApprovalGate, escapeHtml, parseIntParam,
  parseLimit, validateEnum, validateStringLength, warnSuspectTransition,
  emitEvent, getAdminDisplayName,
  MAX_TITLE, MAX_DESCRIPTION, PLAN_STATUSES, PLAN_STEP_STATUSES,
});

registerTaskRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
  checkProjectScope, escapeHtml, parseIntParam, parseLimit, validateEnum,
  validateStringLength, warnSuspectTransition, emitEvent, dispatchWorkToIdleAgents,
  MAX_TITLE, MAX_DESCRIPTION, TASK_STATUSES, TASK_PRIORITIES, agentWriteLimiter,
});

// ======== WEBHOOKS ========

// POST /webhooks — register a webhook for an agent
router.post('/webhooks', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { agent_id, url, events, secret } = req.body;
  if (!agent_id || !url) return res.status(400).json({ error: 'agent_id and url are required' });
  var id = createWebhook(agent_id, url, events, secret);
  res.json({ ok: true, id: id });
}));

// GET /webhooks — list all active webhooks (admin only)
router.get('/webhooks', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var agentId = req.query.agent_id || null;
  res.json(listWebhooks(agentId));
}));

// DELETE /webhooks/:id — remove a webhook
router.delete('/webhooks/:id', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  deleteWebhook(parseIntParam(req.params.id));
  res.json({ ok: true });
}));

// GET /webhooks/deliveries — delivery log for debugging (admin only)
router.get('/webhooks/deliveries', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var filters = {
    event: req.query.event || undefined,
    webhook_id: req.query.webhook_id ? parseIntParam(req.query.webhook_id) : undefined,
    error_only: req.query.error_only === 'true',
    limit: parseLimit(req.query.limit, 50),
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listWebhookDeliveries(filters));
}));

// ======== DRONES ======== (extracted -> ./drones.js)
registerDroneRoutes(router, {
  asyncHandler, checkAgent, checkAgentOrAdmin, checkAdmin, checkGuardrails,
  escapeHtml, apiError, parseLimit, parseIntParam, validateEnum, emitEvent,
  getAdminDisplayName, isAdminKey, getStudioUser, DRONE_JOB_STATUSES,
  requireAuth, artifactUpload, agentWriteLimiter, ARTIFACTS_DIR,
});

// =============== APPROVALS =============== (extracted -> ./plans.js)

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

// ======== PLUGINS ========

router.get('/plugins', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(listPluginRecords());
}));

router.get('/plugins/mcp-tools', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(getPluginMcpTools());
}));

// GET /plugins/workers — worker plugin process status (admin)
router.get('/plugins/workers', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(getWorkerStatus());
}));

// ---- Marketplace ----
//
// SECURITY: the plugin registry is PINNED to a specific commit SHA, never a
// moving branch (main/master/HEAD). A moving ref would let a compromised branch
// on SoftBacon-Software/mycelium-plugins push arbitrary plugin manifests to
// every install. BUMP PROCEDURE:
//   1. Get the target HEAD SHA:
//        git ls-remote https://github.com/SoftBacon-Software/mycelium-plugins.git refs/heads/main
//   2. Review the compare diff before trusting the new commit:
//        https://github.com/SoftBacon-Software/mycelium-plugins/compare/<OLD_SHA>...<NEW_SHA>
//   3. Update REGISTRY_COMMIT below to the new 40-char SHA.
// pinned: mycelium-plugins registry commit (SoftBacon-Software/mycelium-plugins).
// To rotate, follow the steps above (git ls-remote + review the compare diff),
// then update REGISTRY_COMMIT to the new 40-char SHA. The load-time guard + tests
// (test/unit/registry-commit-pin.test.js) validate the pin for any valid SHA.
var REGISTRY_COMMIT = '972a3b351c952d6b39a8e47f62a12cb8aa9c465b';
var REGISTRY_URL = 'https://raw.githubusercontent.com/SoftBacon-Software/mycelium-plugins/' + REGISTRY_COMMIT + '/registry.json';
// Fail fast at module load if REGISTRY_URL is ever moved back to a moving ref.
if (!/[0-9a-f]{40}/.test(REGISTRY_URL)) {
  throw new Error('REGISTRY_URL must be commit-pinned to a 40-char hex SHA; got: ' + REGISTRY_URL);
}
export { REGISTRY_COMMIT, REGISTRY_URL, _studioSeenCache, touchStudioUserSeenDebounce };

var registryCache = { data: null, fetched: 0 };
var REGISTRY_TTL = 3600000; // 1 hour

router.get('/plugins/registry', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var now = Date.now();
  if (registryCache.data && (now - registryCache.fetched) < REGISTRY_TTL) {
    return res.json(registryCache.data);
  }
  fetch(REGISTRY_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('Registry fetch failed: ' + r.status);
      return r.json();
    })
    .then(function (data) {
      registryCache.data = data;
      registryCache.fetched = now;
      res.json(data);
    })
    .catch(function (err) {
      if (registryCache.data) return res.json(registryCache.data);
      res.status(502).json({ error: 'Failed to fetch plugin registry' });
    });
}));

router.get('/plugins/all-widgets', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var result = [];
  var plugins = getLoadedPlugins();
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var widgets = p.dashboard_widgets || p.dashboardWidgets || [];
    for (var j = 0; j < widgets.length; j++) {
      result.push({
        plugin: p.name,
        plugin_display_name: p.displayName || p.name,
        route_prefix: p.routePrefix || ('/' + p.name),
        widget: widgets[j]
      });
    }
  }
  res.json(result);
}));

// GET /plugins/nav — lightweight page declarations for all loaded plugins
router.get('/plugins/nav', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var plugins = getLoadedPlugins();
  var nav = [];
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    if (!p.pages || p.pages.length === 0) continue;
    nav.push({
      name: p.name,
      display_name: p.displayName || p.name,
      route_prefix: p.routePrefix || ('/' + p.name),
      pages: p.pages
    });
  }
  res.json(nav);
}));

router.get('/plugins/:name', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  // Enrich with loaded manifest data (configSchema, hooks, gatedActions)
  var loaded = getLoadedPlugins().find(function (p) { return p.name === req.params.name; });
  var mcpTools = getPluginMcpTools().filter(function (t) { return t.plugin === req.params.name; });
  res.json({
    ...record,
    type: loaded ? (loaded.type || 'legacy') : 'legacy',
    config_schema: loaded ? (loaded.configSchema || []) : [],
    mcp_tools: mcpTools.map(function (t) { return { name: t.name, description: t.description || '' }; }),
    hooks: loaded ? (loaded.hooks || []) : [],
    gated_actions: loaded ? (loaded.gatedActions || []) : [],
    pages: loaded ? (loaded.pages || []) : [],
  });
}));

router.get('/plugins/:name/config', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  var rows = getPluginConfig(req.params.name);
  // Return config as key→value map; mask secrets
  var config = {};
  for (var row of rows) {
    config[row.key] = row.is_secret ? '••••••••' : row.value;
  }
  res.json(config);
}));

router.put('/plugins/:name/config', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  var body = req.body || {};
  // Get the loaded manifest to know which keys are secrets
  var loaded = getLoadedPlugins().find(function (p) { return p.name === req.params.name; });
  var schema = loaded ? (loaded.configSchema || []) : [];
  for (var [key, value] of Object.entries(body)) {
    // Skip if the value is the masked placeholder (user didn't change a secret)
    if (value === '••••••••') continue;
    var schemaField = schema.find(function (f) { return f.key === key; });
    var isSecret = schemaField ? (schemaField.type === 'secret') : false;
    setPluginConfig(req.params.name, key, value, isSecret);
  }
  emitEvent('plugin_config_updated', getAdminDisplayName(req), null, 'Updated config for plugin: ' + req.params.name);
  res.json({ ok: true });
}));

router.put('/plugins/:name/enable', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  updatePluginEnabled(req.params.name, 1);
  emitEvent('plugin_enabled', getAdminDisplayName(req), null, 'Enabled plugin: ' + req.params.name);
  res.json({ ok: true, name: req.params.name, enabled: 1 });
}));

router.put('/plugins/:name/disable', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });
  updatePluginEnabled(req.params.name, 0);
  emitEvent('plugin_disabled', getAdminDisplayName(req), null, 'Disabled plugin: ' + req.params.name);
  res.json({ ok: true, name: req.params.name, enabled: 0 });
}));

router.post('/plugins/install', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var name = req.body.name;
  if (!name) return res.status(400).json({ error: 'Plugin name required' });

  var record = getPluginRecord(name);
  if (!record) return res.status(404).json({ error: 'Plugin not found in server/plugins/' });

  if (record.enabled) return res.json({ ok: true, message: 'Plugin already enabled', name: name });

  // Enable the plugin — server restart will load routes/handlers
  updatePluginEnabled(name, 1);
  emitEvent('plugin_installed', getAdminDisplayName(req), null, 'Installed plugin: ' + name, { plugin: name });
  res.json({ ok: true, name: name, message: 'Plugin enabled. Server restart required to fully load.' });
}));

router.delete('/plugins/:name/uninstall', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });

  // Disable first
  updatePluginEnabled(req.params.name, 0);

  // Clean up config
  var configRows = getPluginConfig(req.params.name);
  for (var row of configRows) {
    deletePluginConfig(req.params.name, row.key);
  }

  emitEvent('plugin_uninstalled', getAdminDisplayName(req), null, 'Uninstalled plugin: ' + req.params.name, { plugin: req.params.name });
  res.json({ ok: true, name: req.params.name, message: 'Plugin disabled and config cleared. Server restart required. Plugin files remain in server/plugins/ for reinstall.' });
}));

router.get('/plugins/:name/widgets', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var record = getPluginRecord(req.params.name);
  if (!record) return res.status(404).json({ error: 'Plugin not found' });

  var loaded = getLoadedPlugins().find(function (p) { return p.name === req.params.name; });
  if (!loaded) return res.json({ widgets: [] });

  var widgets = loaded.dashboard_widgets || loaded.dashboardWidgets || [];
  res.json({ widgets: widgets, route_prefix: loaded.routePrefix || ('/' + loaded.name) });
}));

// ======== API DOCS ========
router.get('/docs', asyncHandler(function (req, res) {
  if (!checkAgentOrAdmin(req, res)) return;
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
}));

// ======== FEEDBACK ========
registerFeedbackRoutes(router, {
  asyncHandler, checkAdmin, checkAgentOrAdmin, checkGuardrails,
  parseIntParam, apiError, emitEvent,
});

// ======== OPERATOR INBOX ======== (extracted -> ./messages.js)

// ======== LOAD PLUGINS ========
// Called from index.js after DB init
export async function initPlugins() {
  var pluginCore = {
    db: getDB(),
    auth: { checkAgentOrAdmin, checkAdmin, getAdminDisplayName },
    emitEvent, checkApprovalGate, gatedActions: GATED_ACTIONS,
    apiError, parseIntParam, validateEnum,
    // Event hook registration — plugins call core.onEvent(type, fn)
    onEvent: registerEventHook,
    // Inbox routing helpers for plugins
    inbox: { createInboxItem, createInboxItemForAllOperators }
  };
  await loadPlugins(pluginCore, router);
}

export { isAdminKey };
export { hasLegacyBcryptAgents, clearAgentKeyCache };

// ── GitHub Proxy Routes ────────────────────────────────────────
// Proxies GitHub API via server-side GITHUB_TOKEN so agents don't need their own tokens.
var GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

function githubApi(method, path, body) {
  var headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Mycelium/1.0'
  };
  if (GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + GITHUB_TOKEN;
  var opts = { method: method, headers: headers };
  if (body) {
    opts.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return fetch('https://api.github.com' + path, opts);
}

// List PRs
router.get('/github/prs/:owner/:repo', asyncHandler(function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured on server' });
  var state = req.query.state || 'open';
  githubApi('GET', '/repos/' + req.params.owner + '/' + req.params.repo + '/pulls?state=' + state + '&per_page=30')
    .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
    .then(function (r) {
      if (r.status !== 200) return res.status(r.status).json({ error: r.data.message || 'GitHub API error' });
      var prs = r.data.map(function (pr) {
        return { number: pr.number, title: pr.title, author: pr.user.login, branch: pr.head.ref, base: pr.base.ref, state: pr.state, draft: pr.draft, url: pr.html_url, created_at: pr.created_at, updated_at: pr.updated_at };
      });
      res.json({ count: prs.length, prs: prs });
    })
    .catch(function (e) { console.error('[mycelium] GitHub API error:', e.message); res.status(500).json({ error: 'GitHub request failed' }); });
}));

// Merge PR
router.post('/github/prs/:owner/:repo/:number/merge', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  // Enforcement rules check
  var who = getAdminDisplayName(req);
  var enforcement = checkEnforcementRules('merge_pr', { owner: req.params.owner, repo: req.params.repo, number: req.params.number }, who);
  if (!enforcement.allowed) {
    return res.status(403).json({ error: enforcement.blocks[0].message, enforcement_rule: enforcement.blocks[0].rule_id });
  }
  if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured on server' });
  var body = { merge_method: req.body.merge_method || 'squash' };
  if (req.body.commit_title) body.commit_title = req.body.commit_title;
  if (req.body.commit_message) body.commit_message = req.body.commit_message;
  githubApi('PUT', '/repos/' + req.params.owner + '/' + req.params.repo + '/pulls/' + req.params.number + '/merge', body)
    .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
    .then(function (r) {
      if (r.status !== 200) return res.status(r.status).json({ error: r.data.message || 'Merge failed' });
      res.json({ number: parseInt(req.params.number), sha: r.data.sha, merged: true });
    })
    .catch(function (e) { console.error('[mycelium] GitHub API error:', e.message); res.status(500).json({ error: 'GitHub request failed' }); });
}));

// Create PR
router.post('/github/prs/:owner/:repo', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured on server' });
  var body = { title: req.body.title, head: req.body.head, base: req.body.base, body: req.body.body || '', draft: !!req.body.draft };
  githubApi('POST', '/repos/' + req.params.owner + '/' + req.params.repo + '/pulls', body)
    .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
    .then(function (r) {
      if (r.status !== 201) return res.status(r.status).json({ error: r.data.message || 'Create PR failed' });
      res.json({ number: r.data.number, title: r.data.title, url: r.data.html_url });
    })
    .catch(function (e) { console.error('[mycelium] GitHub API error:', e.message); res.status(500).json({ error: 'GitHub request failed' }); });
}));

// ======== NODE PROFILES (Stand Up Calibration) ========

// List all profiles (admin only)
router.get('/profiles', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var filter = {};
  if (req.query.node_type) filter.node_type = req.query.node_type;
  if (req.query.layer) filter.layer = req.query.layer;
  var profiles = listNodeProfiles(filter);
  res.json({ count: profiles.length, profiles: profiles });
}));

// Resolve profile chain for an agent (admin only)
// NOTE: This route must be before /profiles/:id to avoid matching "resolve" as an ID
router.get('/profiles/resolve/:agentId', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var resolved = resolveProfileChain(req.params.agentId);
  res.json(resolved);
}));

// Get single profile (admin only)
router.get('/profiles/:id', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var profile = getNodeProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
}));

// Create profile (admin only)
router.post('/profiles', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var id = req.body.id;
  if (!id) return res.status(400).json({ error: 'id is required' });
  // Check if profile already exists
  var existing = getNodeProfile(id);
  if (existing) return res.status(409).json({ error: 'Profile already exists: ' + id });
  try {
    var profile = createNodeProfile(id, req.body);
    emitEvent('profile_created', getAdminDisplayName(req), null, 'Profile created: ' + id);
    res.status(201).json(profile);
  } catch (e) {
    console.error('[mycelium] profile creation error:', e.message);
    res.status(500).json({ error: 'Failed to create profile' });
  }
}));

// Update profile (admin only, partial)
router.put('/profiles/:id', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var updated = updateNodeProfile(req.params.id, req.body);
  if (!updated) {
    var existing = getNodeProfile(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    return res.status(403).json({ error: 'Cannot modify platform-layer profiles' });
  }
  emitEvent('profile_updated', getAdminDisplayName(req), null, 'Profile updated: ' + req.params.id);
  res.json(updated);
}));

// Delete profile (admin only, blocked for platform layer)
router.delete('/profiles/:id', asyncHandler(function (req, res) {
  if (!checkAdmin(req, res)) return;
  var deleted = deleteNodeProfile(req.params.id);
  if (!deleted) {
    var existing = getNodeProfile(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    return res.status(403).json({ error: 'Cannot delete platform-layer profiles' });
  }
  emitEvent('profile_deleted', getAdminDisplayName(req), null, 'Profile deleted: ' + req.params.id);
  res.json({ ok: true, deleted: deleted });
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

// ======== HEALTH PATROL ========

function runHealthPatrol() {
  var config = {};
  try {
    var rows = getDB().prepare("SELECT key, value FROM instance_config WHERE key LIKE 'patrol_%'").all();
    for (var r of rows) config[r.key] = r.value;
  } catch (e) { /* use defaults */ }

  var staleAgentMins = parseInt(config.patrol_stale_agent_minutes) || 15;
  var staleTaskMins = parseInt(config.patrol_stale_task_minutes) || 30;
  var staleRequestMins = parseInt(config.patrol_stale_request_minutes) || 60;
  var staleDroneMins = parseInt(config.patrol_stale_drone_minutes) || 30;
  var stalePlanStepMins = parseInt(config.patrol_stale_plan_step_minutes) || 120;

  var results = { stale_agents: 0, stale_tasks: 0, stale_requests: 0, stale_drones: 0, stale_plan_steps: 0, actions: [], run_at: new Date().toISOString() };

  var staleAgents = getStaleAgents(staleAgentMins);
  for (var a of staleAgents) {
    updateAgentHeartbeat(a.id, 'offline', '');
    emitEvent('health_patrol', '__system__', null, 'Agent ' + a.id + ' marked offline (no heartbeat in ' + staleAgentMins + ' min)', { agent_id: a.id, last_heartbeat: a.last_heartbeat });
    results.actions.push({ type: 'agent_offline', agent_id: a.id });
  }
  results.stale_agents = staleAgents.length;

  var staleTasks = getStaleTasks(staleTaskMins);
  for (var t of staleTasks) {
    emitEvent('health_patrol', '__system__', null, 'Task #' + t.id + ' in_progress with no active assignee (>' + staleTaskMins + ' min)', { task_id: t.id, assignee: t.assignee });
    results.actions.push({ type: 'stale_task_warning', task_id: t.id, assignee: t.assignee });
  }
  results.stale_tasks = staleTasks.length;

  var staleReqs = getStaleRequests(staleRequestMins);
  for (var r of staleReqs) {
    emitEvent('health_patrol', '__system__', null, 'Request #' + r.id + ' pending for >' + staleRequestMins + ' min', { request_id: r.id, from: r.from_agent, to: r.to_agent });
    results.actions.push({ type: 'stale_request', request_id: r.id });
  }
  results.stale_requests = staleReqs.length;

  var staleDrns = getStaleDrones(staleDroneMins);
  for (var d of staleDrns) {
    updateAgentHeartbeat(d.id, 'offline', '');
    try { releaseStaleClaimedJobs(d.id); } catch (e) { /* non-critical */ }
    emitEvent('health_patrol', '__system__', null, 'Drone ' + d.id + ' marked offline + jobs released', { drone_id: d.id });
    results.actions.push({ type: 'drone_offline', drone_id: d.id });
  }
  results.stale_drones = staleDrns.length;

  var staleSteps = getStalePlanSteps(stalePlanStepMins);
  for (var s of staleSteps) {
    emitEvent('health_patrol', '__system__', null, 'Plan step #' + s.id + ' in_progress for >' + stalePlanStepMins + ' min', { step_id: s.id, plan_id: s.plan_id, assignee: s.assignee });
    results.actions.push({ type: 'stale_plan_step', step_id: s.id, plan_id: s.plan_id });
  }
  results.stale_plan_steps = staleSteps.length;

  return results;
}

// Config-gated patrol timer (every 5 minutes)
var PATROL_INTERVAL = 5 * 60 * 1000;
setInterval(function () {
  try {
    var enabled = getInstanceConfig('patrol_enabled');
    if (enabled === 'false') return; // defaults to enabled unless explicitly disabled
    runHealthPatrol();
  } catch (e) { console.error('[health_patrol] Error:', e.message); }
}, PATROL_INTERVAL).unref();

// ===== FILE SERVER (WebSocket tunnel to local file drones) ===== (extracted -> ./assets.js)

export default router;
