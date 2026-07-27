// Asset routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import fs from 'fs';
import nodePath from 'path';
import {
  listAssets, createAsset, autoTaskFromAsset, getAsset, updateAsset,
  getDroneJob, deleteAsset,
} from '../db.js';

export function registerAssetRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
    escapeHtml, parseLimit, parseIntParam, validateEnum,
    emitEvent, getAdminDisplayName,
    requireAuth, upload,
    ASSET_STATUSES, FILES_DIR, ARTIFACTS_DIR,
  } = deps;

  // ======== ASSETS ========

  router.get('/assets', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      project_id: req.query.project_id,
      type: req.query.type,
      status: req.query.status,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    res.json(listAssets(filters));
  }));

  router.post('/assets', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'asset_registered', { agent: agentId, project_id: req.body.project_id, name: req.body.name })) return;
    var name = escapeHtml(req.body.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    var type = req.body.type || 'sprite';
    var projectId = req.body.project_id || 'shared';
    var status = req.body.status || 'requested';
    if (!validateEnum(res, req.body.status, ASSET_STATUSES, 'status')) return;
    var assetPath = req.body.path || '';
    if (assetPath && (assetPath.indexOf('..') !== -1 || nodePath.isAbsolute(assetPath))) {
      return res.status(400).json({ error: 'invalid asset path' });
    }
    var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
    var id = createAsset(name, type, projectId, status, assetPath, metadata, agentId);
    emitEvent('asset_registered', agentId, projectId, agentId + ' registered asset: ' + name, { asset_id: id });

    var result = { id: id, name: name };

    // Auto-create task for asset requests
    if (status === 'requested') {
      var taskResult = autoTaskFromAsset(id, projectId, agentId);
      if (taskResult) {
        result.task_id = taskResult.task_id;
        result.assigned_to = taskResult.assignee;
        emitEvent('task_created', agentId, projectId, 'Auto-task for asset ' + name + ' assigned to ' + (taskResult.assignee || 'unassigned'), { asset_id: id, task_id: taskResult.task_id });
      }
    }

    res.json(result);
  }));

  router.get('/assets/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var asset = getAsset(parseIntParam(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json(asset);
  }));

  router.put('/assets/:id', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var asset = getAsset(parseIntParam(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!validateEnum(res, req.body.status, ASSET_STATUSES, 'status')) return;
    var fields = {};
    if (req.body.status !== undefined) fields.status = req.body.status;
    if (req.body.path !== undefined) {
      if (typeof req.body.path === 'string' && (req.body.path.indexOf('..') !== -1 || nodePath.isAbsolute(req.body.path))) {
        return res.status(400).json({ error: 'invalid asset path' });
      }
      fields.path = req.body.path;
    }
    if (req.body.metadata !== undefined) fields.metadata = JSON.stringify(req.body.metadata);
    if (req.body.drone_job_id !== undefined) fields.drone_job_id = req.body.drone_job_id;
    if (req.body.assigned_to !== undefined) fields.assigned_to = req.body.assigned_to;
    if (req.body.file_path !== undefined) fields.file_path = req.body.file_path;
    if (req.body.download_url !== undefined) fields.download_url = req.body.download_url;
    if (req.body.prompt !== undefined) fields.prompt = req.body.prompt;
    updateAsset(asset.id, fields);
    if (fields.status) {
      emitEvent('asset_' + fields.status, agentId, asset.project_id, agentId + ' set asset ' + asset.name + ' to ' + fields.status, { asset_id: asset.id });
    }
    res.json({ ok: true, id: asset.id });
  }));

  router.post('/assets/:id/upload', requireAuth, upload.single('file'), asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var asset = getAsset(parseIntParam(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    var filePath = req.file.path;
    var downloadUrl = '/api/mycelium/assets/' + asset.id + '/download';
    updateAsset(asset.id, { status: 'ready', file_path: filePath, download_url: downloadUrl, path: req.file.filename });
    emitEvent('asset_uploaded', who, asset.project_id, 'Asset #' + asset.id + ' (' + asset.name + ') uploaded');
    res.json({ ok: true, asset_id: asset.id, download_url: downloadUrl });
  }));

  router.get('/assets/:id/download', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var asset = getAsset(parseIntParam(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.file_path && !asset.path) return res.status(404).json({ error: 'No file attached to this asset' });

    var filePath = asset.file_path || nodePath.join(FILES_DIR, asset.path);
    var resolved = nodePath.resolve(filePath);
    // Allow ONLY the two upload/artifact dirs — NOT their parent DATA_DIR, which
    // holds mycelium.db (Stripe/webhook secrets, bcrypt password + agent-key
    // hashes). A stored '../mycelium.db' path resolves into DATA_DIR and, with
    // DATA_DIR allowlisted, streamed the whole DB to any agent key (audit 2026-07-02).
    if (!resolved.startsWith(nodePath.resolve(FILES_DIR)) && !resolved.startsWith(nodePath.resolve(ARTIFACTS_DIR))) {
      return res.status(403).json({ error: 'File path outside allowed directory' });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found on disk' });
    res.download(resolved);
  }));

  // Link assets to a drone job (bulk update status + drone_job_id)
  router.put('/assets/link-job', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { asset_ids, drone_job_id, status } = req.body;
    if (!asset_ids || !Array.isArray(asset_ids)) return res.status(400).json({ error: 'asset_ids array required' });
    if (!drone_job_id) return res.status(400).json({ error: 'drone_job_id required' });
    // Validate drone job exists
    var job = getDroneJob(parseIntParam(drone_job_id));
    if (!job) return res.status(404).json({ error: 'Drone job #' + drone_job_id + ' not found' });
    // Validate all asset IDs exist before making any changes
    var missing = asset_ids.filter(function (id) { return !getAsset(parseIntParam(id)); });
    if (missing.length > 0) return res.status(404).json({ error: 'Assets not found: ' + missing.join(', ') });
    if (!validateEnum(res, status, ASSET_STATUSES, 'status')) return;
    var updated = 0;
    for (var id of asset_ids) {
      var fields = { drone_job_id: drone_job_id };
      if (status) fields.status = status;
      var result = updateAsset(parseInt(id), fields);
      if (result.changes) updated++;
    }
    emitEvent('assets_linked_to_job', who, null, updated + ' assets linked to drone job #' + drone_job_id, { asset_ids: asset_ids, drone_job_id: drone_job_id });
    res.json({ ok: true, updated: updated });
  }));

  // Delete asset (admin only)
  router.delete('/assets/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var asset = getAsset(parseIntParam(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    deleteAsset(asset.id);
    emitEvent('asset_deleted', getAdminDisplayName(req), asset.project_id, 'Deleted asset #' + asset.id + ': ' + asset.name, { asset_id: asset.id });
    res.json({ ok: true, id: asset.id });
  }));
}
