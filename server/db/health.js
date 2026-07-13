// =============== MYCELIUM — DB entity: health patrol + reconciliation ===============
// Extracted from server/db.js (Wave 3 of the decomposition). Cross-entity
// **read-only** raw SQL (bugs/tasks/plan_steps/agents/messages) — no sibling
// db/* imports, moves clean despite the fan-in of tables. The six functions
// below use only the live `db` binding from ./core.js. Bodies moved VERBATIM —
// bare db.prepare(...) keeps working via the ESM live binding (initDBConnection
// assigns db; nobody else may). The barrel server/db.js re-exports these via
// `export * from './db/health.js'` so no consumer changes a single import.
import { db } from './core.js';

// -- Health Patrol --

// Reconciliation read-surface (A7 — state-desync visibility).
//
// Health Patrol's getStaleTasks/getStalePlanSteps key staleness off the
// ASSIGNEE'S heartbeat — they answer "is the worker gone?". Reconciliation
// answers a different question: "has this RECORD itself drifted from reality?"
// i.e. it has sat in_progress past a threshold with no edits, regardless of
// whether any agent is online. That's the silently-stuck case — e.g. all 12
// bugs sitting in_progress including #10 (fixed-in-code) — that corrupts
// greenlight decisions and training labels.
//
// READ-ONLY. Returns candidate records; never mutates. The operator decides
// what to reconcile. thresholdMinutes defaults to 24h (1440).
export function getReconciliationCandidates(thresholdMinutes) {
  thresholdMinutes = thresholdMinutes || (24 * 60);
  var cutoffClause = "updated_at < datetime('now', '-' || ? || ' minutes')";

  var bugs = db.prepare(
    "SELECT id, project_id, title, status, assignee, updated_at FROM bugs " +
    "WHERE status = 'in_progress' AND " + cutoffClause + " ORDER BY updated_at ASC"
  ).all(thresholdMinutes);

  var tasks = db.prepare(
    "SELECT id, project_id, title, status, assignee, updated_at FROM tasks " +
    "WHERE status = 'in_progress' AND " + cutoffClause + " ORDER BY updated_at ASC"
  ).all(thresholdMinutes);

  var planSteps = db.prepare(
    "SELECT s.id, s.plan_id, s.title, s.status, s.assignee, s.updated_at FROM plan_steps s " +
    "WHERE s.status = 'in_progress' AND s." + cutoffClause + " ORDER BY s.updated_at ASC"
  ).all(thresholdMinutes);

  return {
    threshold_minutes: thresholdMinutes,
    generated_at: db.prepare("SELECT datetime('now') as now").get().now,
    counts: { bugs: bugs.length, tasks: tasks.length, plan_steps: planSteps.length,
              total: bugs.length + tasks.length + planSteps.length },
    bugs: bugs,
    tasks: tasks,
    plan_steps: planSteps
  };
}

export function getStaleAgents(thresholdMinutes) {
  thresholdMinutes = thresholdMinutes || 15;
  return db.prepare(
    "SELECT id, name, status, working_on, last_heartbeat FROM agents WHERE status IN ('online', 'idle', 'busy') AND last_heartbeat < datetime('now', '-' || ? || ' minutes') AND role != 'drone'"
  ).all(thresholdMinutes);
}

export function getStaleTasks(thresholdMinutes) {
  thresholdMinutes = thresholdMinutes || 30;
  return db.prepare(
    "SELECT t.id, t.title, t.assignee, t.updated_at FROM tasks t LEFT JOIN agents a ON t.assignee = a.id WHERE t.status = 'in_progress' AND (a.last_heartbeat IS NULL OR a.last_heartbeat < datetime('now', '-' || ? || ' minutes'))"
  ).all(thresholdMinutes);
}

export function getStaleRequests(thresholdMinutes) {
  thresholdMinutes = thresholdMinutes || 60;
  return db.prepare(
    "SELECT id, from_agent, to_agent, content, created_at FROM messages WHERE msg_type = 'request' AND status IN ('sent', 'pending') AND created_at < datetime('now', '-' || ? || ' minutes')"
  ).all(thresholdMinutes);
}

export function getStaleDrones(thresholdMinutes) {
  thresholdMinutes = thresholdMinutes || 30;
  return db.prepare(
    "SELECT id, name, status, last_heartbeat FROM agents WHERE (role = 'drone' OR project_id = 'drone') AND status IN ('online', 'idle') AND last_heartbeat < datetime('now', '-' || ? || ' minutes')"
  ).all(thresholdMinutes);
}

export function getStalePlanSteps(thresholdMinutes) {
  thresholdMinutes = thresholdMinutes || 120;
  return db.prepare(
    "SELECT s.id, s.title, s.assignee, s.plan_id, s.updated_at FROM plan_steps s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'in_progress' AND p.status = 'active' AND s.updated_at < datetime('now', '-' || ? || ' minutes')"
  ).all(thresholdMinutes);
}
