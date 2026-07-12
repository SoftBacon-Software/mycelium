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
  dispatchWebhook,
  pruneWebhookDeliveries,
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
  getDB,
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
import { loadPlugins, callEventHooks, registerEventHook } from '../plugins.js';

import { broadcast, addClient, clientCount } from '../eventBus.js';
import { registerBugRoutes } from './bugs.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerChannelRoutes } from './channels.js';
import { registerContextRoutes } from './context.js';
import { registerAgentRoutes } from './agents.js';
import { registerMessageRoutes } from './messages.js';
import { registerConceptRoutes } from './concepts.js';
import { registerAssetRoutes } from './assets.js';
import { registerDroneRoutes } from './drones.js';
import { registerTeamRoutes } from './teams.js';
import { registerPlansRoutes } from './plans.js';
import { registerTaskRoutes } from './tasks.js';
import { registerAdminRoutes } from './admin.js';
import { registerPluginRoutes } from './plugins.js';
import { registerMiscRoutes } from './misc.js';

var ADMIN_KEY = process.env.ADMIN_KEY;
function isAdminKey(key) {
  if (!ADMIN_KEY || !key) return false;
  return key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
}
var JWT_SECRET = process.env.JWT_SECRET;
var STUDIO_JWT_EXPIRY = '7d';

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

// Map a better-sqlite3 constraint error to a clean HTTP response so raw SQLite
// internals ("UNIQUE constraint failed: ...", "FOREIGN KEY constraint failed")
// never reach the client. Mirrors POST /skills' UNIQUE→409 mapping
// (err.message includes 'UNIQUE'); adds FK→404 for the missing-parent case.
// `label` names the entity for the UNIQUE (duplicate) message; `fkLabel`
// (defaults to `label`) names the referenced entity for the FK message.
// Returns { status, error } for a constraint error, or null so the caller
// falls back to its existing error handling / rethrow.
function mapSqliteConstraintError(err, label, fkLabel) {
  var msg = err && err.message ? String(err.message) : '';
  if (msg.includes('UNIQUE')) return { status: 409, error: (label || 'Resource') + ' already exists' };
  if (msg.includes('FOREIGN KEY')) return { status: 404, error: (fkLabel || label || 'Resource') + ' not found' };
  return null;
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
export { _studioSeenCache, touchStudioUserSeenDebounce };

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

// ======== TASKS ======== (extracted -> ./tasks.js)

// ======== SPEND + RUNS + VOICE ======== (extracted -> ./misc.js)

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

// ======== AGENTS (boot / work / agents / agent-templates) ======== (extracted -> ./agents.js)
registerAgentRoutes(router, {
  asyncHandler, checkAgent, checkAgentOrAdmin, checkAdmin, validateEnum,
  parseLimit, emitEvent, apiError, getAdminDisplayName, getInstanceUrl,
  buildMcpConfig, isAdminKey, invalidateAgentKeyCache, dispatchWorkToIdleAgents,
  AGENT_STATUSES,
});

// ======== SPEND + RUNS + VOICE + GITHUB PROXY ======== (extracted -> ./misc.js)
registerMiscRoutes(router, {
  asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
  checkAdminOrOperator, checkProjectScope, emitEvent,
  getAdminDisplayName, checkEnforcementRules, mapSqliteConstraintError,
});

// ======== ADMIN (overview/config/kill-switch/health/reconciliation/stats) ======== (extracted -> ./admin.js)
registerAdminRoutes(router, {
  asyncHandler, checkAdmin, checkAgentOrAdmin, emitEvent, getAdminDisplayName,
  validateEnum, adminWriteLimiter, AGENT_STATUSES,
  getInstanceUrl, buildMcpConfig, displayName, getStudioUser,
  clearAgentKeyCache, invalidateAgentKeyCache, runHealthPatrol, computeHealthReport,
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
  emitEvent, getAdminDisplayName, apiError, mapSqliteConstraintError,
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

// ======== WEBHOOKS + PLUGINS ======== (extracted -> ./plugins.js)
registerPluginRoutes(router, {
  asyncHandler, checkAdmin, checkAgentOrAdmin, emitEvent, getAdminDisplayName,
  parseIntParam, parseLimit,
});

// ======== DRONES ======== (extracted -> ./drones.js)
registerDroneRoutes(router, {
  asyncHandler, checkAgent, checkAgentOrAdmin, checkAdmin, checkGuardrails,
  escapeHtml, apiError, parseLimit, parseIntParam, validateEnum, emitEvent,
  getAdminDisplayName, isAdminKey, getStudioUser, DRONE_JOB_STATUSES,
  requireAuth, artifactUpload, agentWriteLimiter, ARTIFACTS_DIR,
});

// =============== APPROVALS =============== (extracted -> ./plans.js)

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
// Plugin registry pin lives in ./plugins.js now; re-exported so
// test/unit/registry-commit-pin.test.js still resolves routesMod.REGISTRY_URL
// (and REGISTRY_COMMIT) from this module's public surface.
export { REGISTRY_COMMIT, REGISTRY_URL } from './plugins.js';

// ======== GITHUB PROXY ======== (extracted -> ./misc.js)

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

// Pure read-only PREVIEW of what runHealthPatrol() would do — same stale-detection
// queries, same config thresholds, same result shape, but NO mutation and NO event
// emission. GET /admin/health uses this so a plain read stays safe/idempotent;
// POST /admin/health/run is the one that actually calls runHealthPatrol() above.
function computeHealthReport() {
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

  var results = { stale_agents: 0, stale_tasks: 0, stale_requests: 0, stale_drones: 0, stale_plan_steps: 0, actions: [], run_at: new Date().toISOString(), dry_run: true };

  var staleAgents = getStaleAgents(staleAgentMins);
  for (var a of staleAgents) {
    results.actions.push({ type: 'agent_offline', agent_id: a.id });
  }
  results.stale_agents = staleAgents.length;

  var staleTasks = getStaleTasks(staleTaskMins);
  for (var t of staleTasks) {
    results.actions.push({ type: 'stale_task_warning', task_id: t.id, assignee: t.assignee });
  }
  results.stale_tasks = staleTasks.length;

  var staleReqs = getStaleRequests(staleRequestMins);
  for (var r2 of staleReqs) {
    results.actions.push({ type: 'stale_request', request_id: r2.id });
  }
  results.stale_requests = staleReqs.length;

  var staleDrns = getStaleDrones(staleDroneMins);
  for (var d of staleDrns) {
    results.actions.push({ type: 'drone_offline', drone_id: d.id });
  }
  results.stale_drones = staleDrns.length;

  var staleSteps2 = getStalePlanSteps(stalePlanStepMins);
  for (var s2 of staleSteps2) {
    results.actions.push({ type: 'stale_plan_step', step_id: s2.id, plan_id: s2.plan_id });
  }
  results.stale_plan_steps = staleSteps2.length;

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
