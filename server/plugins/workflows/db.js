// Workflows plugin DB helpers.
// State machine + atomic claim live HERE so every route shares one guard.

export var RESULT_CAP = 32000;
export var TRUNCATION_MARKER = '\n...[truncated at ' + RESULT_CAP + ' chars]';

// Legal status transitions. An enum mismatch must FAIL LOUDLY (400), never
// silently stick — the squad-bridge lesson (jarvis bug #3).
var TRANSITIONS = {
  pending:    ['claimed', 'cancelled'],
  claimed:    ['running', 'failed', 'cancelled'],
  running:    ['completed', 'failed', 'cancelling', 'awaiting_approval'],
  awaiting_approval: ['running', 'failed', 'cancelled'],
  cancelling: ['cancelled', 'completed', 'failed'],
  completed:  [],
  failed:     [],
  cancelled:  []
};

export var EVENT_KINDS = [
  'created', 'claimed', 'claim_released', 'stalled', 'risk_assessed', 'wave_started',
  'invocation_started', 'invocation_finished', 'invocation_failed',
  'awaiting_approval', 'resumed', 'cancelling',
  'completed', 'failed', 'cancelled'
];

var INVOCATION_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'];

// Validate spec.invocations — the same checks workflow_scheduler.schedule
// raises on (duplicate ids, unknown deps, cycles), enforced at POST time so a
// runner never claims an unschedulable workflow. Returns null when valid,
// else a human-readable error string.
export function validateInvocations(invocations) {
  if (!Array.isArray(invocations) || invocations.length === 0) {
    return 'spec.invocations must be a non-empty array';
  }
  var ids = new Set();
  for (var iv of invocations) {
    if (!iv || typeof iv.id !== 'string' || !iv.id) {
      return 'every invocation needs a string id';
    }
    if (ids.has(iv.id)) return 'duplicate invocation id: ' + iv.id;
    ids.add(iv.id);
    if (typeof iv.agent !== 'string' || !iv.agent) {
      return 'invocation ' + iv.id + ' needs a string agent';
    }
    if (iv.deps !== undefined && !Array.isArray(iv.deps)) {
      return 'invocation ' + iv.id + ' deps must be an array';
    }
  }
  for (var iv2 of invocations) {
    for (var d of (iv2.deps || [])) {
      if (!ids.has(d)) return 'invocation ' + iv2.id + ' depends on unknown ' + d;
    }
  }
  // Cycle check (Kahn's): repeatedly remove invocations whose deps are done.
  var done = new Set();
  var remaining = invocations.slice();
  while (remaining.length > 0) {
    var ready = remaining.filter(function (iv3) {
      return (iv3.deps || []).every(function (d2) { return done.has(d2); });
    });
    if (ready.length === 0) {
      return 'cyclic deps among: ' + remaining.map(function (r) { return r.id; }).join(', ');
    }
    for (var r of ready) done.add(r.id);
    remaining = remaining.filter(function (iv4) { return !done.has(iv4.id); });
  }
  return null;
}

function capResult(result) {
  if (typeof result !== 'string') result = JSON.stringify(result);
  if (result.length <= RESULT_CAP) return result;
  return result.slice(0, RESULT_CAP) + TRUNCATION_MARKER;
}

function parseRow(row) {
  if (!row) return null;
  try { row.spec = JSON.parse(row.spec); } catch (e) { /* keep raw */ }
  return row;
}

function parseInvocation(row) {
  if (!row) return null;
  try { row.deps = JSON.parse(row.deps); } catch (e) { row.deps = []; }
  return row;
}

// Events are stored JSON.stringify(payload) in addEvent; parse it back so the
// app gets an object, not an escaped JSON string (mirrors parseInvocation).
function parseEvent(row) {
  if (!row) return null;
  try { row.payload = JSON.parse(row.payload); } catch (e) { /* keep raw */ }
  return row;
}

export default function createWorkflowsDB(db) {
  // Migration: the approval-gate link — an awaiting_approval workflow references
  // the approval it's paused on. Idempotent: check the column exists first so a
  // real error (disk I/O, db-locked) is NOT swallowed by a blanket try/catch.
  var hasApprovalId = db.prepare('PRAGMA table_info(workflows)').all()
    .some(function (col) { return col.name === 'approval_id'; });
  if (!hasApprovalId) {
    db.exec('ALTER TABLE workflows ADD COLUMN approval_id INTEGER');
  }

  // Migration: claim timestamps (task 200) — the stale-claim sweep ages a claim
  // by claimed_at; without it a runner that died mid-claim held the workflow
  // 'claimed' forever (the receipt's await-timeouts). Idempotent, same as the
  // approval_id check above: a real error is NOT swallowed.
  var hasClaimedAt = db.prepare('PRAGMA table_info(workflows)').all()
    .some(function (col) { return col.name === 'claimed_at'; });
  if (!hasClaimedAt) {
    db.exec('ALTER TABLE workflows ADD COLUMN claimed_at TEXT');
  }

  function addEvent(workflowId, kind, payload) {
    return db.prepare(
      'INSERT INTO workflow_events (workflow_id, kind, payload) VALUES (?, ?, ?) RETURNING id'
    ).get(workflowId, kind, JSON.stringify(payload || {})).id;
  }

  var api = {
    // Insert workflow + its invocation rows in ONE transaction, so the app can
    // render the full DAG the moment POST returns. The 'created' event is part
    // of the same transaction — the event log never misses a lifecycle edge.
    createWorkflow(name, shape, spec, projectId, requestedBy) {
      var tx = db.transaction(function () {
        var wf = db.prepare(
          'INSERT INTO workflows (name, shape, spec, project_id, requested_by) VALUES (?, ?, ?, ?, ?) RETURNING id'
        ).get(name, shape || 'custom', JSON.stringify(spec), projectId || null, requestedBy || '');
        var ins = db.prepare(
          'INSERT INTO workflow_invocations (workflow_id, inv_id, agent_id, model, brief, deps) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (var iv of spec.invocations) {
          ins.run(wf.id, iv.id, iv.agent, iv.model || '', iv.brief || '',
                  JSON.stringify(iv.deps || []));
        }
        addEvent(wf.id, 'created', { name: name, shape: shape || 'custom',
                                     invocations: spec.invocations.length });
        return wf.id;
      });
      return tx();
    },

    getWorkflow(id) {
      return parseRow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(id));
    },

    getWorkflowFull(id) {
      var wf = api.getWorkflow(id);
      if (!wf) return null;
      wf.invocations = db.prepare(
        'SELECT * FROM workflow_invocations WHERE workflow_id = ? ORDER BY id'
      ).all(id).map(parseInvocation);
      wf.events = db.prepare(
        'SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 50'
      ).all(id).map(parseEvent).reverse();
      return wf;
    },

    // The shared WHERE for list + count — one filter definition, so the
    // envelope's total can never silently diverge from the items' filters.
    _workflowWhere(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      return { where: where, params: params };
    },

    countWorkflows(filters) {
      var w = api._workflowWhere(filters);
      return db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE ' + w.where.join(' AND ')).get(...w.params).n;
    },

    listWorkflows(filters) {
      var w = api._workflowWhere(filters);
      var params = w.params.slice();
      // Runner polls oldest-first (?order=asc) so workflows execute in fire order.
      var order = filters.order === 'asc' ? 'ASC' : 'DESC';
      var limit = Math.min(filters.limit || 50, 500);
      var offset = Math.max(filters.offset || 0, 0);
      params.push(limit, offset);
      return db.prepare(
        'SELECT * FROM workflows WHERE ' + w.where.join(' AND ') +
        ' ORDER BY id ' + order + ' LIMIT ? OFFSET ?'
      ).all(...params).map(parseRow);
    },

    // Atomic claim: single UPDATE guarded on status='pending' — two racing
    // runners get exactly one winner (changes === 1); the loser sees ok:false.
    // claimed_at stamps the claim for the stale-claim sweep (task 200).
    claimWorkflow(id, runnerId) {
      var info = db.prepare(
        "UPDATE workflows SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(runnerId, id);
      if (info.changes !== 1) return { ok: false };
      addEvent(id, 'claimed', { claimed_by: runnerId });
      return { ok: true, workflow: api.getWorkflow(id) };
    },

    // Stale-claim release (task 200, clockwork audit §5): a runner that died
    // mid-claim used to hold its workflow 'claimed' forever. The sweep releases
    // a claim when the CLAIMING RUNNER's own heartbeat has gone silent past the
    // TTL — positive evidence of death. A claimant with no agents row (never
    // heartbeated) is UNKNOWN, not dead, and is deliberately left alone: every
    // platform runner heartbeats via POST /agents/heartbeat as its runner id,
    // so absence of a row means absence of a runner we ever knew.
    // A RUNNING workflow is NEVER released by this rule — an invocation started
    // is live work. It earns a 'stalled' event, once per claim episode, and the
    // head decides what to do with it.
    // The claimed→pending edge is sweep-authoritative and done as a guarded
    // atomic UPDATE (mirroring claimWorkflow), NOT through updateWorkflowStatus —
    // the TRANSITIONS map stays the operator/runner-facing contract. The guard
    // re-checks status AND claimed_by so a racing cancel or re-claim between
    // SELECT and UPDATE wins and the release no-ops.
    releaseStaleClaims(ttlMinutes) {
      var mins = Math.max(parseInt(ttlMinutes, 10) || 30, 1);
      var rows = db.prepare(
        "SELECT w.*, a.last_heartbeat AS runner_last_heartbeat " +
        "FROM workflows w JOIN agents a ON a.id = w.claimed_by " +
        "WHERE w.status IN ('claimed', 'running') " +
        "AND a.last_heartbeat < datetime('now', '-' || ? || ' minutes')"
      ).all(mins);
      var released = [];
      var stalled = [];
      for (var row of rows) {
        if (row.status === 'claimed') {
          var info = db.prepare(
            "UPDATE workflows SET status = 'pending', claimed_by = NULL, claimed_at = NULL " +
            "WHERE id = ? AND status = 'claimed' AND claimed_by = ?"
          ).run(row.id, row.claimed_by);
          if (info.changes === 1) {
            addEvent(row.id, 'claim_released', {
              reason: 'runner_stale',
              claimed_by: row.claimed_by,
              runner_last_heartbeat: row.runner_last_heartbeat
            });
            released.push(row);
          }
        } else {
          // Once per claim episode: skip if a stalled event already exists
          // after the latest claimed event (a released-then-reclaimed workflow
          // earns a fresh stalled verdict).
          var dup = db.prepare(
            "SELECT id FROM workflow_events WHERE workflow_id = ? AND kind = 'stalled' " +
            "AND id > (SELECT COALESCE(MAX(id), 0) FROM workflow_events WHERE workflow_id = ? AND kind = 'claimed')"
          ).get(row.id, row.id);
          if (!dup) {
            addEvent(row.id, 'stalled', {
              reason: 'runner_stale',
              claimed_by: row.claimed_by,
              runner_last_heartbeat: row.runner_last_heartbeat
            });
            stalled.push(row);
          }
        }
      }
      return { released: released, stalled: stalled };
    },

    // Transition-guarded status update. Returns {ok} or {ok:false, error, from}.
    // started_at stamps on entering 'running'; finished_at on any terminal state.
    // Terminal transitions auto-append their event so the log is complete even
    // if the runner forgets to post one.
    updateWorkflowStatus(id, newStatus, fields) {
      fields = fields || {};
      var wf = api.getWorkflow(id);
      if (!wf) return { ok: false, error: 'not found' };
      // Terminal states cannot be modified at all — not even field-only updates
      // (a PUT {risk:'red'} with no status used to bypass the transition guard
      // because newStatus was falsy). Block everything once it's finished.
      if (['completed', 'failed', 'cancelled'].indexOf(wf.status) !== -1) {
        return { ok: false, error: 'cannot modify terminal state: ' + wf.status };
      }
      var allowed = TRANSITIONS[wf.status] || [];
      if (newStatus && newStatus !== wf.status && allowed.indexOf(newStatus) === -1) {
        return { ok: false, from: wf.status,
                 error: 'illegal transition ' + wf.status + ' -> ' + newStatus +
                        ' (allowed: ' + (allowed.join(', ') || 'none') + ')' };
      }
      var sets = [];
      var values = [];
      if (newStatus && newStatus !== wf.status) {
        sets.push('status = ?'); values.push(newStatus);
        if (newStatus === 'running') sets.push("started_at = datetime('now')");
        if (['completed', 'failed', 'cancelled'].indexOf(newStatus) !== -1) {
          sets.push("finished_at = datetime('now')");
        }
      }
      if (fields.risk !== undefined) { sets.push('risk = ?'); values.push(fields.risk); }
      if (fields.error !== undefined) { sets.push('error = ?'); values.push(fields.error); }
      // The approval-gate link: set when pausing on a gate, cleared (null) on resume.
      if (fields.approval_id !== undefined) { sets.push('approval_id = ?'); values.push(fields.approval_id); }
      if (sets.length === 0) return { ok: true, workflow: wf };
      values.push(id);
      db.prepare('UPDATE workflows SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
      if (newStatus && newStatus !== wf.status) {
        if (['completed', 'failed', 'cancelled'].indexOf(newStatus) !== -1) {
          addEvent(id, newStatus, fields.error ? { error: fields.error } : {});
        } else if (newStatus === 'awaiting_approval') {
          addEvent(id, 'awaiting_approval', { approval_id: fields.approval_id });
        } else if (newStatus === 'running' && wf.status === 'awaiting_approval') {
          addEvent(id, 'resumed', {});
        }
      }
      return { ok: true, workflow: api.getWorkflow(id) };
    },

    // Cancel semantics: pending/claimed die immediately; running goes
    // 'cancelling' and the RUNNER marks 'cancelled' between waves (cooperative
    // stop — converges with plan #179). Terminal states are a no-op.
    cancelWorkflow(id) {
      var wf = api.getWorkflow(id);
      if (!wf) return { ok: false, error: 'not found' };
      if (wf.status === 'pending' || wf.status === 'claimed') {
        db.prepare("UPDATE workflows SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(id);
        addEvent(id, 'cancelled', { was: wf.status });
        return { ok: true, status: 'cancelled' };
      }
      if (wf.status === 'running') {
        db.prepare("UPDATE workflows SET status = 'cancelling' WHERE id = ?").run(id);
        addEvent(id, 'cancelling', { was: wf.status });
        return { ok: true, status: 'cancelling' };
      }
      if (wf.status === 'cancelling') return { ok: true, status: 'cancelling' };
      return { ok: false, error: 'workflow already ' + wf.status, status: wf.status };
    },

    // Update one invocation. Result is capped LOUDLY (truncation marker), never
    // silently (the 8000-char silent-truncation lesson, jarvis bug #4).
    updateInvocation(workflowId, invId, fields) {
      var row = db.prepare(
        'SELECT * FROM workflow_invocations WHERE workflow_id = ? AND inv_id = ?'
      ).get(workflowId, invId);
      if (!row) return { ok: false, error: 'invocation not found' };
      var sets = [];
      var values = [];
      if (fields.status !== undefined) {
        if (INVOCATION_STATUSES.indexOf(fields.status) === -1) {
          return { ok: false, error: 'invocation status must be one of: ' + INVOCATION_STATUSES.join(', ') };
        }
        sets.push('status = ?'); values.push(fields.status);
        if (fields.status === 'running') sets.push("started_at = datetime('now')");
        if (['completed', 'failed', 'skipped'].indexOf(fields.status) !== -1) {
          sets.push("finished_at = datetime('now')");
        }
      }
      if (fields.result !== undefined) { sets.push('result = ?'); values.push(capResult(fields.result)); }
      if (fields.transcript_path !== undefined) { sets.push('transcript_path = ?'); values.push(fields.transcript_path); }
      if (sets.length === 0) return { ok: false, error: 'no recognized fields (status, result, transcript_path)' };
      values.push(row.id);
      db.prepare('UPDATE workflow_invocations SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
      return { ok: true, invocation: parseInvocation(
        db.prepare('SELECT * FROM workflow_invocations WHERE id = ?').get(row.id)) };
    },

    addEvent: addEvent,

    listEvents(workflowId, limit) {
      return db.prepare(
        'SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT ?'
      ).all(workflowId, Math.min(limit || 50, 500)).reverse();
    }
  };
  return api;
}
