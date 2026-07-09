// Widget routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listWidgets, createWidget, getWidget, updateWidget, deleteWidget,
} from '../db.js';

export function registerWidgetRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, emitEvent, checkProjectScope,
  } = deps;

  // ======== WIDGETS ========

  router.get('/widgets', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var widgets = listWidgets({
      agent_id: req.query.agent_id,
      project_id: req.query.project_id
    });
    res.json(widgets);
  }));

  router.post('/widgets', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var b = req.body;
    if (!b.title) return res.status(400).json({ error: 'title required' });
    var agentId = (who === '__admin__' || who === '__system__') ? (b.agent_id || who) : who;
    var result = createWidget(agentId, b.project_id, b.title, b.widget_type, b.data);
    emitEvent('widget_created', agentId, b.project_id || '', b.title, { widget_id: result.id, widget_type: b.widget_type || 'status' });
    res.status(201).json(result);
  }));

  router.put('/widgets/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var widget = getWidget(req.params.id);
    if (!widget) return res.status(404).json({ error: 'widget not found' });
    if (!checkProjectScope(req, res, widget.project_id)) return;
    var updated = updateWidget(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'widget not found' });
    res.json(updated);
  }));

  router.delete('/widgets/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var widget = getWidget(req.params.id);
    if (!widget) return res.status(404).json({ error: 'widget not found' });
    if (!checkProjectScope(req, res, widget.project_id)) return;
    deleteWidget(req.params.id);
    res.json({ ok: true });
  }));
}
