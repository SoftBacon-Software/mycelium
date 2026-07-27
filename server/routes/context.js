// Context routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  searchContextKeys, listContextKeys, getContextKey, upsertContextKey,
  deleteContextKey, bulkDeleteContextKeys, getContextHistory, getContextHistoryEntry,
  rollbackContextKey, contextKeyStats, getAllContext, getContext,
  upsertContext,
} from '../db.js';

export function registerContextRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
    checkProjectScope, agentCanAccessProject,
  } = deps;

  // ======== CONTEXT ========
  //
  // F1 (red-team): context keys are now project-scoped. NULL project_id = shared/
  // global (legacy swarm-readable state — enforcement rules, api limits, standups,
  // anything written without a project). A key written through the agent HTTP path
  // is stamped with the writer's project, after which a cross-project agent can no
  // longer read, overwrite, dump history, or roll it back — the same 403 a
  // cross-project task write already gets. Reads are strict-scoped too because
  // context keys can hold secrets (unlike tasks/plans, which stay read-shared).

  // Project filter for context list/search: undefined (no filter → see all) for
  // admins/studio; the agent's own project (possibly null → shared-only) for agents.
  function contextListProjectFilter(req) {
    if (req._authIsAdmin || !req._authAgentId) return undefined;
    return (req._authProjectId !== undefined) ? req._authProjectId : null;
  }

  // Namespaced context (must be before :projectId param route)
  router.get('/context/keys', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var namespace = req.query.namespace;
    var projectId = contextListProjectFilter(req);
    // If search/filter params present, use searchContextKeys
    if (req.query.search || req.query.category || req.query.updated_by) {
      return res.json(searchContextKeys({
        namespace: namespace || undefined,
        search: req.query.search || undefined,
        category: req.query.category || undefined,
        updated_by: req.query.updated_by || undefined,
        projectId: projectId
      }));
    }
    res.json(listContextKeys(namespace, projectId));
  }));

  router.get('/context/keys/:namespace', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listContextKeys(req.params.namespace, contextListProjectFilter(req)));
  }));

  router.get('/context/keys/:namespace/:key', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var ctx = getContextKey(req.params.namespace, req.params.key);
    if (!ctx) return res.status(404).json({ error: 'Context key not found' });
    // F1: context keys can hold secrets — scope reads like writes (strictRead).
    if (!checkProjectScope(req, res, ctx.project_id, null, { strictRead: true })) return;
    res.json(ctx);
  }));

  router.put('/context/keys/:namespace/:key', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var data = req.body.data;
    if (data === undefined) return res.status(400).json({ error: 'data field is required' });
    // F1: if the key already exists, only its owning project (or admin) may
    // overwrite it — same 403 a cross-project task write already gets. A new key
    // is stamped with the writer's project (opts.projectId) below.
    var existing = getContextKey(req.params.namespace, req.params.key);
    if (existing && !checkProjectScope(req, res, existing.project_id)) return;
    var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    var opts = { projectId: req._authProjectId || null };
    if (req.body.category) opts.category = req.body.category;
    if (req.body.ttl) opts.ttl = parseInt(req.body.ttl, 10);
    if (req.body.expires_at) opts.expires_at = req.body.expires_at;
    upsertContextKey(req.params.namespace, req.params.key, dataStr, agentId, opts);
    emitEvent('context_key_updated', agentId, req.params.namespace, agentId + ' updated context ' + req.params.namespace + ':' + req.params.key);
    res.json({ ok: true, namespace: req.params.namespace, key: req.params.key });
  }));

  // Admin-only — checkAdmin is a stricter gate than project scope (admins bypass
  // scope anyway), so no agent can reach this path cross-project. Left as-is.
  router.delete('/context/keys/:namespace/:key', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    deleteContextKey(req.params.namespace, req.params.key);
    res.json({ ok: true, deleted: req.params.namespace + ':' + req.params.key });
  }));

  // Bulk delete context keys by IDs (admin only — see DELETE note above)
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
    // F1: history leaks overwritten secrets — scope it like a read. The latest
    // entry carries the key's project (stamped on every write); empty history is
    // returned as-is. Data is fetched server-side but only sent once scope passes.
    if (history.length > 0 && !checkProjectScope(req, res, history[0].project_id, null, { strictRead: true })) return;
    res.json(history);
  }));

  // Context key rollback — restore a previous version by history ID
  router.post('/context/keys/rollback/:historyId', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var historyId = parseInt(req.params.historyId);
    if (!historyId) return res.status(400).json({ error: 'Invalid history ID' });
    // F1: scope the rollback (a write) against the target's project BEFORE
    // restoring — fetch the history entry (carries project_id) and check scope.
    var entry = getContextHistoryEntry(historyId);
    if (!entry) return res.status(404).json({ error: 'History entry not found' });
    if (!checkProjectScope(req, res, entry.project_id)) return;
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
      // F1: per-key scope — a cross-project overwrite is rejected for that entry
      // only (pure check; we record a per-entry error rather than 403 the batch).
      var existing = getContextKey(entry.namespace, entry.key);
      if (existing && !agentCanAccessProject(req, existing.project_id)) {
        results.push({ namespace: entry.namespace, key: entry.key, error: 'forbidden: cross-project' });
        continue;
      }
      var dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
      var opts = { projectId: req._authProjectId || null };
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
