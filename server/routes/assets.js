// Assets + Files + File-server + Widgets routes — extracted verbatim from
// mycelium.js (god-file decomposition, Phase 3, 2026-07-12; see
// docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs and pinned
// by test/unit/assets-files-widgets-characterization.test.js.
//
// NOTE: route registration ORDER within this module is load-bearing.
// PUT /assets/link-job is registered BEFORE PUT /assets/:id so the literal
// 'link-job' path wins. Registering it after /:id lets ':id'='link-job' shadow
// it (parseIntParam → null → 404), making the bulk link endpoint unreachable
// dead code. Keep link-job ahead of the /assets/:id family.
import fs from 'fs';
import nodePath from 'path';
import {
  listWidgets, createWidget, updateWidget, deleteWidget,
  listAssets, createAsset, autoTaskFromAsset, getAsset, updateAsset,
  deleteAsset, getDroneJob,
} from '../db.js';

export function registerAssetRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails, emitEvent,
    escapeHtml, parseIntParam, parseLimit, validateEnum, getAdminDisplayName,
    requireAuth, upload, ASSET_STATUSES, FILES_DIR, ARTIFACTS_DIR, FILE_TTL_MS,
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
    var updated = updateWidget(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'widget not found' });
    res.json(updated);
  }));

  router.delete('/widgets/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    deleteWidget(req.params.id);
    res.json({ ok: true });
  }));

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

  // Link assets to a drone job (bulk update status + drone_job_id).
  // Registered BEFORE PUT /assets/:id — see the ORDER note atop this file.
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
    if (!asset) {
      // multer has already written the upload to disk by the time we reach the
      // handler; a 404 here used to orphan it in FILES_DIR (only the 24h TTL
      // sweep collected it). Delete the just-written temp file first.
      if (req.file && req.file.path) {
        try { fs.unlinkSync(req.file.path); } catch (e) { /* already gone */ }
      }
      return res.status(404).json({ error: 'Asset not found' });
    }
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

  // Delete asset (admin only)
  router.delete('/assets/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var asset = getAsset(parseIntParam(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    deleteAsset(asset.id);
    emitEvent('asset_deleted', getAdminDisplayName(req), asset.project_id, 'Deleted asset #' + asset.id + ': ' + asset.name, { asset_id: asset.id });
    res.json({ ok: true, id: asset.id });
  }));

  // ======== FILES (temp uploads, 24h TTL) ========

  // POST /files — upload a temp file (multipart form, field name: "file")
  // curl -X POST -H "X-Agent-Key: <key>" -F "file=@myimage.png" https://mycelium.fyi/api/mycelium/files
  // Files auto-delete after 24 hours. Download with wget/curl before then.
  router.post('/files', requireAuth, upload.single('file'), asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart form with field name "file"' });
    var protocol = req.headers['x-forwarded-proto'] || req.protocol;
    var host = req.headers['x-forwarded-host'] || req.get('host');
    var baseUrl = protocol + '://' + host;
    var url = '/api/mycelium/files/' + req.file.filename;
    var fullUrl = baseUrl + url;
    var expiresAt = new Date(Date.now() + FILE_TTL_MS).toISOString();
    emitEvent('file_uploaded', who, null, who + ' uploaded ' + req.file.originalname + ' (' + Math.round(req.file.size / 1024) + 'KB)', { filename: req.file.filename });
    res.json({ ok: true, filename: req.file.filename, url: fullUrl, size: req.file.size, expires_at: expiresAt });
  }));

  // GET /files/:filename — download a file (auth required)
  router.get('/files/:filename', asyncHandler(function (req, res) {
    if (!checkAgentOrAdmin(req, res)) return;
    var filename = req.params.filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
    var filePath = nodePath.join(FILES_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or expired' });
    res.download(filePath, filename);
  }));

  // GET /files — list available files
  router.get('/files', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var now = Date.now();
    var files = [];
    try {
      files = fs.readdirSync(FILES_DIR).map(function (f) {
        var stat = fs.statSync(nodePath.join(FILES_DIR, f));
        var expiresIn = Math.max(0, Math.round((FILE_TTL_MS - (now - stat.mtimeMs)) / 1000));
        var protocol = req.headers['x-forwarded-proto'] || req.protocol;
        var host = req.headers['x-forwarded-host'] || req.get('host');
        return { filename: f, size: stat.size, uploaded: stat.mtime.toISOString(), expires_in_seconds: expiresIn, url: protocol + '://' + host + '/api/mycelium/files/' + f };
      });
    } catch (e) { /* empty */ }
    res.json(files);
  }));

  // ===== FILE SERVER (WebSocket tunnel to local file drones) =====

  // Find first online file drone, or a specific one by ID
  function findFileDrone(req, droneId) {
    var fileDrones = req.app.locals.fileDrones;
    if (!fileDrones) return null;
    if (droneId) {
      var d = fileDrones.get(droneId);
      return (d && d.ws.readyState === 1) ? droneId : null;
    }
    // Find first connected file drone
    for (var [id, drone] of fileDrones) {
      if (drone.ws.readyState === 1) return id;
    }
    return null;
  }

  // GET /file-server/status — check if a file drone is online
  router.get('/file-server/status', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var droneId = findFileDrone(req, req.query.drone_id);
    if (!droneId) return res.json({ online: false, message: 'No file drone connected' });
    var drone = req.app.locals.fileDrones.get(droneId);
    res.json({
      online: true,
      drone_id: droneId,
      info: drone.info || {},
    });
  }));

  // POST /file-server/browse — list directory contents
  router.post('/file-server/browse', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var droneId = findFileDrone(req, req.body.drone_id);
    if (!droneId) return res.status(503).json({ error: 'No file drone connected' });
    try {
      var result = await req.app.locals.sendFileDroneRequest(droneId, 'file_list', {
        path: req.body.path || '/'
      });
      res.json(result);
    } catch (e) {
      res.status(504).json({ error: e.message });
    }
  }));

  // POST /file-server/search — search for files
  router.post('/file-server/search', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var droneId = findFileDrone(req, req.body.drone_id);
    if (!droneId) return res.status(503).json({ error: 'No file drone connected' });
    try {
      var result = await req.app.locals.sendFileDroneRequest(droneId, 'file_search', {
        query: req.body.query || '*',
        path: req.body.path || '/'
      }, 30000);
      res.json(result);
    } catch (e) {
      res.status(504).json({ error: e.message });
    }
  }));

  // POST /file-server/info — get file/directory info
  router.post('/file-server/info', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var droneId = findFileDrone(req, req.body.drone_id);
    if (!droneId) return res.status(503).json({ error: 'No file drone connected' });
    try {
      var result = await req.app.locals.sendFileDroneRequest(droneId, 'file_info', {
        path: req.body.path || '/'
      });
      res.json(result);
    } catch (e) {
      res.status(504).json({ error: e.message });
    }
  }));

  // GET /file-server/download-folder — zip and stream a folder
  router.get('/file-server/download-folder', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var droneId = findFileDrone(req, req.query.drone_id);
    if (!droneId) return res.status(503).json({ error: 'No file drone connected' });
    var folderPath = req.query.path;
    if (!folderPath) return res.status(400).json({ error: 'path query parameter required' });
    try {
      await req.app.locals.streamFileDroneDownload(droneId, { path: folderPath }, res, 'folder_download');
    } catch (e) {
      if (!res.headersSent) {
        res.status(504).json({ error: e.message });
      }
    }
  }));

  // GET /file-server/download — stream file download
  router.get('/file-server/download', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var droneId = findFileDrone(req, req.query.drone_id);
    if (!droneId) return res.status(503).json({ error: 'No file drone connected' });
    var filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path query parameter required' });
    try {
      await req.app.locals.streamFileDroneDownload(droneId, { path: filePath }, res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(504).json({ error: e.message });
      }
    }
  }));
}
