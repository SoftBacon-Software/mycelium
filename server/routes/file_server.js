// File-server routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers/middleware arrive via `deps`
// (dependency injection); the local findFileDrone helper moved with the routes
// (it was used only by these handlers). The route contract is identical to
// before extraction — enforced by test/refactor/route-manifest.mjs.

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

export function registerFileServerRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin,
  } = deps;

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
