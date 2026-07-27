// =============== MYCELIUM — DB entity: run log + runner spawns ===============
// Extracted from server/db.js (Wave 2 of the decomposition). Zero coupling: the
// functions below use only the live `db` binding from ./core.js (no `stmt`, no
// `buildUpdate`, no sibling db/* imports). The private RUN_UPDATABLE /
// RUN_LIST_COLS consts move with the module and stay unexported. Bodies moved
// VERBATIM — bare db.prepare(...) keeps working via the ESM live binding
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/runs.js'` so no consumer changes a
// single import.
//
// NOTE: the five *RunnerSpawn functions have no callers anywhere in server/ or
// routes/ — likely dead exports from the pre-workflow swarm design. Kept + moved
// verbatim (surface preservation); retiring them is a separate decision.
import { db } from './core.js';

// ---- Runs (the run-log) ----

export function createRun(run) {
  var status = run.status || 'running';
  // started_at is the EXECUTION start: a run recorded as already-running starts now;
  // a pending/queued run (a rerun) leaves it NULL until a worker claims it. created_at
  // (the queue/record time) is always set by the column default.
  db.prepare(
    'INSERT INTO runs (id, agent_id, model, project_id, workflow_id, brief, status, rerun_of, started_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'running' THEN datetime('now') ELSE NULL END)"
  ).run(
    run.id, run.agent_id, run.model || '', run.project_id || '',
    run.workflow_id || null, run.brief || '', status, run.rerun_of || null, status
  );
  return getRun(run.id);
}

var RUN_UPDATABLE = ['model', 'status', 'turns', 'tool_calls', 'tokens_in', 'tokens_out',
                     'energy_joules', 'artifacts', 'result', 'error', 'finished_at', 'duration_ms'];

export function updateRun(id, fields) {
  var cols = [], params = [];
  for (var k of RUN_UPDATABLE) {
    if (fields[k] !== undefined) { cols.push(k + ' = ?'); params.push(fields[k]); }
  }
  if (!cols.length) return getRun(id);
  params.push(id);
  db.prepare('UPDATE runs SET ' + cols.join(', ') + ' WHERE id = ?').run(...params);
  return getRun(id);
}

export function getRun(id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

// The run-LOG list omits the heavy fields (result, tool_calls) so GET /runs stays
// scannable even when a single result is 44K chars. The full body comes from
// getRun(id) detail.
var RUN_LIST_COLS = 'id, agent_id, model, project_id, workflow_id, brief, status, claimed_by, ' +
                    'turns, tokens_in, tokens_out, energy_joules, artifacts, ' +
                    'created_at, started_at, finished_at, duration_ms, rerun_of';

export function listRuns(opts) {
  var where = ['1=1'], params = [];
  if (opts && opts.agent_id) { where.push('agent_id = ?'); params.push(opts.agent_id); }
  if (opts && opts.project_id) { where.push('project_id = ?'); params.push(opts.project_id); }
  if (opts && opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts && opts.since) { where.push('started_at >= ?'); params.push(opts.since); }
  var limit = (opts && opts.limit) || 50;
  params.push(limit);
  return db.prepare(
    // rowid DESC tiebreaks same-second runs so "newest-first" is deterministic.
    'SELECT ' + RUN_LIST_COLS + ' FROM runs WHERE ' + where.join(' AND ') +
    ' ORDER BY created_at DESC, rowid DESC LIMIT ?'
  ).all(...params);
}

// Atomic claim of the oldest PENDING run (optionally for a specific agent), drone-job
// style: the `WHERE status='pending'` guard means two workers can't grab the same run.
// Sets claimed_by + the execution start (started_at). Returns the claimed run, or null
// if nothing pending matched.
export function claimRun(workerId, opts) {
  var where = ["status = 'pending'"], params = [];
  if (opts && opts.agent_id) { where.push('agent_id = ?'); params.push(opts.agent_id); }
  // FIFO by queue time; loop a few candidates to skip rows another worker claimed mid-race.
  var candidates = db.prepare(
    'SELECT id FROM runs WHERE ' + where.join(' AND ') + ' ORDER BY created_at ASC, rowid ASC LIMIT 10'
  ).all(...params);
  for (var c of candidates) {
    var r = db.prepare(
      "UPDATE runs SET status='claimed', claimed_by=?, started_at=datetime('now') WHERE id=? AND status='pending'"
    ).run(workerId, c.id);
    if (r.changes === 1) return getRun(c.id);   // we won the claim
  }
  return null;
}

// Stale-claim recovery (drone_jobs.releaseStaleClaimedJobs analog): a run claimed/running
// longer than staleMinutes with no completion is auto-failed, so a dead worker can't
// strand a run forever. Returns the number of runs reaped.
export function releaseStaleClaimedRuns(staleMinutes) {
  var mins = parseInt(staleMinutes, 10) || 60;
  var result = db.prepare(
    "UPDATE runs SET status='failed', " +
    "error='[stale_timeout] claimed/running too long with no completion; auto-failed', " +
    "finished_at=datetime('now') " +
    "WHERE status IN ('claimed','running') AND started_at IS NOT NULL " +
    "AND started_at < datetime('now', '-' || ? || ' minutes')"
  ).run(mins);
  return result.changes;
}

// ======== RUNNER SPAWNS (dynamic agent swarm) ========

export function createRunnerSpawn(tier, model, cwd, maxTurns, title, workContext, requestedBy) {
  var result = db.prepare(
    'INSERT INTO runner_spawns (tier, model, cwd, max_turns, title, work_context, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(tier || 'agent', model || '', cwd || '', maxTurns || 50, title || '', JSON.stringify(workContext || {}), requestedBy || '');
  return result.id;
}

export function getRunnerSpawn(id) {
  var row = db.prepare('SELECT * FROM runner_spawns WHERE id = ?').get(id);
  if (row) { try { row.work_context = JSON.parse(row.work_context); } catch (e) { row.work_context = {}; } }
  return row;
}

export function listRunnerSpawns(status) {
  var rows = status
    ? db.prepare("SELECT * FROM runner_spawns WHERE status = ? ORDER BY created_at DESC LIMIT 100").all(status)
    : db.prepare("SELECT * FROM runner_spawns ORDER BY created_at DESC LIMIT 100").all();
  return rows.map(function (r) {
    try { r.work_context = JSON.parse(r.work_context); } catch (e) { r.work_context = {}; }
    return r;
  });
}

export function claimRunnerSpawn(id, runnerId) {
  db.prepare("UPDATE runner_spawns SET status = 'claimed', runner_id = ?, claimed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(runnerId || 'runner', id);
}

export function doneRunnerSpawn(id, result, status) {
  db.prepare("UPDATE runner_spawns SET status = ?, result = ?, done_at = datetime('now') WHERE id = ?").run(status || 'done', result || '', id);
}
