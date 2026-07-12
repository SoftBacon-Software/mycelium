// =============== MYCELIUM — DB entity: work queue + auto-dispatch ===============
// Extracted from server/db.js (Wave 5 of the decomposition — see
// docs/DB-DECOMPOSITION-PLAN.md, §1 db/workqueue.js / §3 Wave 5). Coupling:
// `getTeamProjectIdsForAgent` imports `getTeamsForUser` (teams) — teams
// landed earlier in this same wave, so this module can land now. The
// planner-triage-first routing + step-ordering rule live here; the
// directive-deprecation comment block travels with `buildWorkQueue`.
// Auto-dispatch reads agents/tasks/plan_steps raw. Private `_capsHave` /
// `agentIsPlanner` / `scopeHasOnlinePlanner` / `_planPriorsComplete` move
// with the module and stay unexported. Bodies moved VERBATIM — bare
// db.prepare(...) keeps working via the ESM live binding (initDBConnection
// assigns db; nobody else may). The barrel server/db.js re-exports these via
// `export * from './db/workqueue.js'` so no consumer changes a single
// import.
import { db } from './core.js';
import { getTeamsForUser } from './teams.js';

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
