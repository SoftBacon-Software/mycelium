// Inbox routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  getDB,
  listInboxItems, countUnreadInbox, countAllUnreadInbox,
  getInboxItem, createInboxItem, createInboxItemForAllOperators,
  markInboxItemRead, markInboxItemActioned, dismissInboxItem,
} from '../db.js';

export function registerInboxRoutes(router, deps) {
  const {
    asyncHandler, getStudioUser, isAdminKey, apiError,
    parseLimit, parseIntParam, checkAdmin, emitEvent,
  } = deps;

  router.get('/inbox', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    // Operators get their own inbox via JWT; admin can query any operator
    var operatorId = req.query.operator_id;
    if (!operatorId) {
      if (!user) return apiError(res, 400, 'operator_id is required');
      // Resolve operator from studio_user_id
      var op = getDB().prepare('SELECT id FROM operators WHERE studio_user_id = ?').get(user.userId);
      if (!op) return apiError(res, 404, 'No operator linked to this account');
      operatorId = op.id;
    }
    var filters = {
      operator_id: operatorId,
      status: req.query.status || undefined,
      type: req.query.type || undefined,
      entity_type: req.query.entity_type || undefined,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    var items = listInboxItems(filters);
    items.forEach(function (item) {
      try { item.data = JSON.parse(item.data); } catch (e) { item.data = {}; }
    });
    res.json(items);
  }));

  // GET /inbox/count — unread badge count per operator
  router.get('/inbox/count', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var operatorId = req.query.operator_id;
    if (!operatorId && user) {
      var op = getDB().prepare('SELECT id FROM operators WHERE studio_user_id = ?').get(user.userId);
      if (op) operatorId = op.id;
    }
    if (operatorId) {
      var unreadCount = countUnreadInbox(operatorId);
      res.json({ operator_id: operatorId, unread: unreadCount, count: unreadCount });
    } else {
      res.json(countAllUnreadInbox());
    }
  }));

  // GET /inbox/:id — get single inbox item
  router.get('/inbox/:id', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    try { item.data = JSON.parse(item.data); } catch (e) { item.data = {}; }
    res.json(item);
  }));

  // POST /inbox — create inbox item (admin/system use)
  router.post('/inbox', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var { operator_id, type, entity_type, entity_id, title, summary, data, priority, all_operators } = req.body;
    if (all_operators) {
      var ids = createInboxItemForAllOperators(type, entity_type, entity_id, title, summary, data, priority);
      return res.json({ ok: true, ids: ids });
    }
    if (!operator_id) return apiError(res, 400, 'operator_id or all_operators required');
    var id = createInboxItem(operator_id, type, entity_type, entity_id, title, summary, data, priority);
    emitEvent('inbox_item_created', '__system__', null, 'Inbox item for ' + operator_id + ': ' + (title || ''), { inbox_id: id, operator_id: operator_id, type: type });
    res.json({ ok: true, id: id });
  }));

  // PUT /inbox/:id/read — mark item read
  router.put('/inbox/:id/read', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    markInboxItemRead(item.id);
    res.json({ ok: true });
  }));

  // PUT /inbox/:id/action — mark item actioned (e.g. after approve/reject)
  router.put('/inbox/:id/action', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    markInboxItemActioned(item.id);
    res.json({ ok: true });
  }));

  // DELETE /inbox/:id — dismiss item
  router.delete('/inbox/:id', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    dismissInboxItem(item.id);
    res.json({ ok: true });
  }));

  // POST /inbox/bulk-dismiss — dismiss multiple items at once
  router.post('/inbox/bulk-dismiss', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var ids = req.body.ids;
    var all = req.body.all;
    var operatorId = req.body.operator_id;
    if (!operatorId && user) {
      var op = getDB().prepare('SELECT id FROM operators WHERE studio_user_id = ?').get(user.userId);
      if (op) operatorId = op.id;
    }
    var dismissed = 0;
    if (all && operatorId) {
      // Dismiss all non-dismissed items for this operator
      var result = getDB().prepare("UPDATE operator_inbox SET status = 'dismissed' WHERE operator_id = ? AND status != 'dismissed'").run(operatorId);
      dismissed = result.changes;
    } else if (Array.isArray(ids) && ids.length > 0) {
      for (var i = 0; i < ids.length; i++) {
        dismissInboxItem(ids[i]);
        dismissed++;
      }
    } else {
      return apiError(res, 400, 'ids array or all=true required');
    }
    res.json({ ok: true, dismissed: dismissed });
  }));
}
