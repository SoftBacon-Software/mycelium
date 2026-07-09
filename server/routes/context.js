// Context routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  searchContextKeys, listContextKeys, getContextKey, upsertContextKey,
  deleteContextKey, bulkDeleteContextKeys, getContextHistory,
  rollbackContextKey, contextKeyStats, getAllContext, getContext,
  upsertContext,
} from '../db.js';

export function registerContextRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
  } = deps;

  // ======== CONTEXT ========

  // Namespaced context (must be before :projectId param route)
  router.get('/context/keys', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var namespace = req.query.namespace;
    // If search/filter params present, use searchContextKeys
    if (req.query.search || req.query.category || req.query.updated_by) {
      return res.json(searchContextKeys({
        namespace: namespace || undefined,
        search: req.query.search || undefined,
        category: req.query.category || undefined,
        updated_by: req.query.updated_by || undefined
      }));
    }
    res.json(listContextKeys(namespace));
  }));

  router.get('/context/keys/:namespace', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listContextKeys(req.params.namespace));
  }));

  router.get('/context/keys/:namespace/:key', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var ctx = getContextKey(req.params.namespace, req.params.key);
    if (!ctx) return res.status(404).json({ error: 'Context key not found' });
    res.json(ctx);
  }));

  router.put('/context/keys/:namespace/:key', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var data = req.body.data;
    if (data === undefined) return res.status(400).json({ error: 'data field is required' });
    var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    var opts = {};
    if (req.body.category) opts.category = req.body.category;
    if (req.body.ttl) opts.ttl = parseInt(req.body.ttl, 10);
    if (req.body.expires_at) opts.expires_at = req.body.expires_at;
    upsertContextKey(req.params.namespace, req.params.key, dataStr, agentId, opts);
    emitEvent('context_key_updated', agentId, req.params.namespace, agentId + ' updated context ' + req.params.namespace + ':' + req.params.key);
    res.json({ ok: true, namespace: req.params.namespace, key: req.params.key });
  }));

  router.delete('/context/keys/:namespace/:key', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    deleteContextKey(req.params.namespace, req.params.key);
    res.json({ ok: true, deleted: req.params.namespace + ':' + req.params.key });
  }));

  // Bulk delete context keys by IDs (admin only)
  router.post('/context/keys/bulk-delete', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 keys per bulk delete' });
    }
    var deleted = bulkDeleteContextKeys(ids);
    emitEvent('context_keys_bulk_delete', 'admin', null, 'Admin bulk-deleted ' + deleted + ' context keys');
    res.json({ ok: true, deleted: deleted });
  }));

  // Context key history — view previous versions
  router.get('/context/keys/:namespace/:key/history', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var limit = parseInt(req.query.limit) || 20;
    if (limit > 100) limit = 100;
    var history = getContextHistory(req.params.namespace, req.params.key, limit);
    res.json(history);
  }));

  // Context key rollback — restore a previous version by history ID
  router.post('/context/keys/rollback/:historyId', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var historyId = parseInt(req.params.historyId);
    if (!historyId) return res.status(400).json({ error: 'Invalid history ID' });
    var restored = rollbackContextKey(historyId, agentId);
    if (!restored) return res.status(404).json({ error: 'History entry not found' });
    emitEvent('context_key_rollback', agentId, restored.namespace, agentId + ' rolled back ' + restored.namespace + ':' + restored.key + ' to version #' + historyId);
    res.json({ ok: true, namespace: restored.namespace, key: restored.key, restored_from: historyId });
  }));

  // Bulk context key operations — set multiple keys in one call
  router.post('/context/keys/bulk', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var keys = req.body.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'keys array is required' });
    }
    if (keys.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 keys per batch' });
    }
    var results = [];
    for (var entry of keys) {
      if (!entry.namespace || !entry.key || entry.data === undefined) {
        results.push({ namespace: entry.namespace, key: entry.key, error: 'namespace, key, and data are required' });
        continue;
      }
      var dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
      var opts = {};
      if (entry.category) opts.category = entry.category;
      if (entry.ttl) opts.ttl = parseInt(entry.ttl, 10);
      if (entry.expires_at) opts.expires_at = entry.expires_at;
      try {
        upsertContextKey(entry.namespace, entry.key, dataStr, agentId, opts);
        results.push({ namespace: entry.namespace, key: entry.key, ok: true });
      } catch (e) {
        results.push({ namespace: entry.namespace, key: entry.key, error: e.message });
      }
    }
    emitEvent('context_keys_bulk', agentId, null, agentId + ' bulk-updated ' + results.filter(function (r) { return r.ok; }).length + ' context keys');
    res.json({ ok: true, results: results });
  }));

  router.get('/context/stats', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json(contextKeyStats());
  }));

  // Legacy per-project context
  router.get('/context', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(getAllContext());
  }));

  router.get('/context/:projectId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var ctx = getContext(req.params.projectId);
    if (!ctx) return res.json({ project_id: req.params.projectId, data: '{}', updated_at: null, updated_by: '' });
    res.json(ctx);
  }));

  router.put('/context/:projectId', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var data = req.body.data;
    if (data === undefined) return res.status(400).json({ error: 'data field is required' });
    var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    upsertContext(req.params.projectId, dataStr, agentId);
    emitEvent('context_updated', agentId, req.params.projectId, agentId + ' updated context for ' + req.params.projectId);
    res.json({ ok: true, project_id: req.params.projectId });
  }));
}
