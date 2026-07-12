// =============== MYCELIUM — DB entity: admin composites (overview) ===============
// Extracted from server/db.js (Wave 6 of the decomposition — see
// docs/DB-DECOMPOSITION-PLAN.md, §1 db/overview.js / §3 Wave 6). Coupling:
// read-only composite — `getOverview` fans into ~15 sibling modules (agents,
// events, tasks, messages, context, projects, approvals, assets, bugs, plans,
// channels, concepts, orgs, operators, config, drones, plugins, studio-users).
// All of those siblings landed in earlier waves, so this composite can land
// now. Private `timeSince` (with its UTC-normalization comment) moves with
// the module and stays unexported — pinned by `db-timesince.test.js` via the
// slim overview. Bodies moved VERBATIM — bare db.prepare(...) keeps working
// via the ESM live binding (initDBConnection assigns db; nobody else may).
// The barrel server/db.js re-exports these via `export * from
// './db/overview.js'` so no consumer changes a single import.
import { db } from './core.js';
import { listAgents } from './agents.js';
import { listEvents } from './events.js';
import { listTasks, listTasksNeedingApproval } from './tasks.js';
import { listMessages, listTeamChat } from './messages.js';
import { getAllContext, listContextKeys } from './context.js';
import { listProjects, listOrgs } from './projects.js';
import { listAssets } from './assets.js';
import { listBugs, countBugs } from './bugs.js';
import { listPlans } from './plans.js';
import { listChannels, isChannelMember } from './channels.js';
import { listApprovals } from './approvals.js';
import { listConcepts, getConceptProjects } from './concepts.js';
import { listOperators, getActiveStudioUsers } from './operators.js';
import { listInstanceConfig } from './config.js';
import { listDrones, listDroneJobs } from './drones.js';
import { listPluginRecords } from './plugins.js';

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
