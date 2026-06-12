// Workflows plugin routes — the workflow INTENT surface.
// An operator/app/head POSTs a fully-expanded invocation DAG; a dormant runner
// claims it, executes under admit-control, and PUTs results/events back.
// The platform is storage + state machine ONLY: no shape logic, no crew
// knowledge, no RAM knowledge (risk is runner-computed from agent records).

import { Router } from 'express';
import createWorkflowsDB, { validateInvocations, EVENT_KINDS } from './db.js';

export default function (core) {
  var router = Router();
  var db = createWorkflowsDB(core.db);
  var { checkAgentOrAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  function getWorkflowOr404(req, res) {
    var id = parseIntParam(req.params.id);
    if (id === null) { apiError(res, 400, 'invalid workflow id'); return null; }
    var wf = db.getWorkflow(id);
    if (!wf) { apiError(res, 404, 'Workflow not found'); return null; }
    return wf;
  }

  // POST /workflows — fire a workflow. Body: { name, spec:{invocations:[...]},
  // shape?, project_id? }. Validation mirrors workflow_scheduler.schedule
  // (duplicate ids / unknown deps / cycles) so a runner never claims an
  // unschedulable record.
  router.post('/', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var name = req.body.name;
    // Accept {spec:{invocations}} (the canonical shape) OR top-level
    // {invocations} (MCP-tool convenience — flat args pass through as body).
    var spec = req.body.spec ||
      (req.body.invocations ? { invocations: req.body.invocations, params: req.body.params } : null);
    if (!name || typeof name !== 'string') return apiError(res, 400, 'name is required');
    if (!spec || typeof spec !== 'object') return apiError(res, 400, 'spec object (or top-level invocations array) is required');
    var invalid = validateInvocations(spec.invocations);
    if (invalid) return apiError(res, 400, invalid);
    var id = db.createWorkflow(name, req.body.shape, spec, req.body.project_id, who);
    core.emitEvent('workflow_created', who, req.body.project_id || '',
      who + ' fired workflow: ' + name + ' (' + spec.invocations.length + ' invocations)',
      { workflow_id: id });
    res.json({ ok: true, workflow: db.getWorkflowFull(id) });
  });

  // GET /workflows — list. Filters: status, project_id, order=asc|desc, limit.
  // The runner's poll is ?status=pending&order=asc (oldest fired runs first).
  router.get('/', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listWorkflows({
      status: req.query.status,
      project_id: req.query.project_id,
      order: req.query.order,
      limit: parseIntParam(req.query.limit) || undefined
    }));
  });

  // GET /workflows/:id — workflow + invocations + last 50 events (app detail view).
  router.get('/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var wf = id === null ? null : db.getWorkflowFull(id);
    if (!wf) return apiError(res, 404, 'Workflow not found');
    res.json(wf);
  });

  // POST /workflows/:id/claim — atomic pending->claimed. Two racing runners:
  // exactly one 200, the rest 409 (single guarded UPDATE; SQLite serializes).
  router.post('/:id/claim', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var wf = getWorkflowOr404(req, res);
    if (!wf) return;
    var runnerId = req.body.runner_id || who;
    var r = db.claimWorkflow(wf.id, runnerId);
    if (!r.ok) return apiError(res, 409, 'Workflow not claimable (status: ' + db.getWorkflow(wf.id).status + ')');
    core.emitEvent('workflow_claimed', runnerId, wf.project_id || '',
      runnerId + ' claimed workflow #' + wf.id + ': ' + wf.name, { workflow_id: wf.id });
    res.json({ ok: true, workflow: r.workflow });
  });

  // PUT /workflows/:id — status transition (guarded) + risk + error.
  // Illegal transitions 400 LOUDLY with the allowed list (never silently stick).
  router.put('/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var wf = getWorkflowOr404(req, res);
    if (!wf) return;
    var r = db.updateWorkflowStatus(wf.id, req.body.status,
      { risk: req.body.risk, error: req.body.error });
    if (!r.ok) return apiError(res, 400, r.error, { from: r.from });
    if (req.body.status && ['completed', 'failed', 'cancelled'].indexOf(req.body.status) !== -1) {
      core.emitEvent('workflow_' + req.body.status, who, wf.project_id || '',
        'workflow #' + wf.id + ' (' + wf.name + ') ' + req.body.status,
        { workflow_id: wf.id, error: req.body.error });
    }
    res.json({ ok: true, workflow: r.workflow });
  });

  // PUT /workflows/:id/invocations/:invId — invocation status / result /
  // transcript_path. Results cap at 32000 chars with a LOUD truncation marker.
  router.put('/:id/invocations/:invId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var wf = getWorkflowOr404(req, res);
    if (!wf) return;
    var r = db.updateInvocation(wf.id, req.params.invId, {
      status: req.body.status,
      result: req.body.result,
      transcript_path: req.body.transcript_path
    });
    if (!r.ok) return apiError(res, r.error === 'invocation not found' ? 404 : 400, r.error);
    res.json({ ok: true, invocation: r.invocation });
  });

  // POST /workflows/:id/events — append a lifecycle event (runner-posted:
  // risk_assessed, wave_started, invocation_*). Re-emitted on the platform
  // event stream as workflow_<kind> so the app/cockpit animates live.
  router.post('/:id/events', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var wf = getWorkflowOr404(req, res);
    if (!wf) return;
    var kind = req.body.kind;
    if (!kind || EVENT_KINDS.indexOf(kind) === -1) {
      return apiError(res, 400, 'kind must be one of: ' + EVENT_KINDS.join(', '));
    }
    var eventId = db.addEvent(wf.id, kind, req.body.payload || {});
    core.emitEvent('workflow_' + kind, who, wf.project_id || '',
      'workflow #' + wf.id + ': ' + kind, Object.assign(
        { workflow_id: wf.id }, req.body.payload || {}));
    res.json({ ok: true, event_id: eventId });
  });

  // POST /workflows/:id/cancel — pending/claimed die now; running goes
  // 'cancelling' and the runner finishes the current wave then marks
  // 'cancelled' (cooperative stop). Terminal -> 409.
  router.post('/:id/cancel', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var wf = getWorkflowOr404(req, res);
    if (!wf) return;
    var r = db.cancelWorkflow(wf.id);
    if (!r.ok) return apiError(res, 409, r.error);
    core.emitEvent('workflow_cancel_requested', who, wf.project_id || '',
      who + ' cancelled workflow #' + wf.id + ' (' + r.status + ')',
      { workflow_id: wf.id, status: r.status });
    res.json({ ok: true, status: r.status });
  });

  return router;
}
