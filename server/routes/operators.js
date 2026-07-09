// Operator routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listOperators, getOperator, createOperator, updateOperator, deleteOperator,
  setOperatorAvailability, isNetworkAutonomous, getSleepMode,
  listAgents, createMessage,
} from '../db.js';

export function registerOperatorRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
    getAdminDisplayName, displayName,
  } = deps;

  // ======== OPERATORS (people) ========

  router.get('/operators', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listOperators());
  }));

  router.get('/operators/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var op = getOperator(req.params.id);
    if (!op) return res.status(404).json({ error: 'Operator not found' });
    res.json(op);
  }));

  router.post('/operators', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = getAdminDisplayName(req);
    var { id, display_name, role, responsibilities, email, studio_user_id } = req.body;
    if (!id || !display_name) return res.status(400).json({ error: 'id and display_name required' });
    if (getOperator(id)) return res.status(409).json({ error: 'Operator already exists' });
    createOperator(id, display_name, role, responsibilities, email, studio_user_id);
    emitEvent('operator_created', who, null, 'Operator ' + id + ' created');
    res.json(getOperator(id));
  }));

  router.put('/operators/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = getAdminDisplayName(req);
    var op = getOperator(req.params.id);
    if (!op) return res.status(404).json({ error: 'Operator not found' });
    updateOperator(req.params.id, req.body);
    emitEvent('operator_updated', who, null, 'Operator ' + req.params.id + ' updated');
    res.json(getOperator(req.params.id));
  }));

  router.delete('/operators/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = getAdminDisplayName(req);
    if (!getOperator(req.params.id)) return res.status(404).json({ error: 'Operator not found' });
    deleteOperator(req.params.id);
    emitEvent('operator_deleted', who, null, 'Operator ' + req.params.id + ' deleted');
    res.json({ ok: true });
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
}
