// Runs routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import crypto from 'crypto';
import {
  createRun, updateRun, getRun, listRuns, claimRun, releaseStaleClaimedRuns,
} from '../db.js';

export function registerRunRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkGuardrails,
    checkAdminOrOperator, checkProjectScope,
  } = deps;

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
}
