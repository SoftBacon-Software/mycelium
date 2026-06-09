// Workflows plugin DB helpers.
// State machine + atomic claim live HERE so every route shares one guard.
// Spec: docs/specs/2026-06-09-workflow-intent-endpoint.md

export var RESULT_CAP = 32000;
export var TRUNCATION_MARKER = '\n...[truncated at ' + RESULT_CAP + ' chars]';

// Legal status transitions. An enum mismatch must FAIL LOUDLY (400), never
// silently stick — the squad-bridge lesson (jarvis bug #3).
var TRANSITIONS = {
  pending:    ['claimed', 'cancelled'],
  claimed:    ['running', 'failed', 'cancelled'],
  running:    ['completed', 'failed', 'cancelling'],
  cancelling: ['cancelled', 'completed', 'failed'],
  completed:  [],
  failed:     [],
  cancelled:  []
};

export var EVENT_KINDS = [
  'created', 'claimed', 'risk_assessed', 'wave_started',
  'invocation_started', 'invocation_finished', 'invocation_failed',
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

export default function createWorkflowsDB(db) {
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
      ).all(id).reverse();
      return wf;
    },

    listWorkflows(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      // Runner polls oldest-first (?order=asc) so workflows execute in fire order.
      var order = filters.order === 'asc' ? 'ASC' : 'DESC';
      var limit = Math.min(filters.limit || 50, 500);
      params.push(limit);
      return db.prepare(
        'SELECT * FROM workflows WHERE ' + where.join(' AND ') +
        ' ORDER BY id ' + order + ' LIMIT ?'
      ).all(...params).map(parseRow);
    },

    // Atomic claim: single UPDATE guarded on status='pending' — two racing
    // runners get exactly one winner (changes === 1); the loser sees ok:false.
    claimWorkflow(id, runnerId) {
      var info = db.prepare(
        "UPDATE workflows SET status = 'claimed', claimed_by = ? WHERE id = ? AND status = 'pending'"
      ).run(runnerId, id);
      if (info.changes !== 1) return { ok: false };
      addEvent(id, 'claimed', { claimed_by: runnerId });
      return { ok: true, workflow: api.getWorkflow(id) };
    },

    // Transition-guarded status update. Returns {ok} or {ok:false, error, from}.
    // started_at stamps on entering 'running'; finished_at on any terminal state.
    // Terminal transitions auto-append their event so the log is complete even
    // if the runner forgets to post one.
    updateWorkflowStatus(id, newStatus, fields) {
      fields = fields || {};
      var wf = api.getWorkflow(id);
      if (!wf) return { ok: false, error: 'not found' };
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
      if (sets.length === 0) return { ok: true, workflow: wf };
      values.push(id);
      db.prepare('UPDATE workflows SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
      if (newStatus && newStatus !== wf.status &&
          ['completed', 'failed', 'cancelled'].indexOf(newStatus) !== -1) {
        addEvent(id, newStatus, fields.error ? { error: fields.error } : {});
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
