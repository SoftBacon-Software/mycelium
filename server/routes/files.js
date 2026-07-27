// File routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers/middleware arrive via `deps`
// (dependency injection); Node builtins (fs, path) are imported directly. The
// route contract is identical to before extraction — enforced by
// test/refactor/route-manifest.mjs.
import fs from 'fs';
import nodePath from 'path';

export function registerFileRoutes(router, deps) {
  const {
    requireAuth, upload, asyncHandler, checkAgentOrAdmin, emitEvent,
    FILES_DIR, FILE_TTL_MS,
  } = deps;

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
}
