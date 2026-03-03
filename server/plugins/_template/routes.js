// Plugin routes — rename and customize for your plugin

import { Router } from 'express';
import createTemplateDB from './db.js';

export default function (core) {
  var router = Router();
  var db = createTemplateDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  // GET /template/items — list items
  router.get('/items', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.list({
      status: req.query.status || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  // GET /template/items/:id — get single item
  router.get('/items/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var item = db.get(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Item not found');
    res.json(item);
  });

  // POST /template/items — create item
  router.post('/items', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = db.create(req.body.title || '', req.body.data, who);
    core.emitEvent('template_item_created', who, null,
      who + ' created template item #' + id, { item_id: id });
    res.json({ id: id });
  });

  // PUT /template/items/:id — update item
  router.put('/items/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.get(id)) return apiError(res, 404, 'Item not found');
    var updates = {};
    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.data !== undefined) updates.data = req.body.data;
    db.update(id, updates);
    res.json({ ok: true, item: db.get(id) });
  });

  // DELETE /template/items/:id — delete item (admin only)
  router.delete('/items/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.get(id)) return apiError(res, 404, 'Item not found');
    db.delete(id);
    core.emitEvent('template_item_deleted', who, null,
      who + ' deleted template item #' + id, { item_id: id });
    res.json({ ok: true });
  });

  return router;
}
