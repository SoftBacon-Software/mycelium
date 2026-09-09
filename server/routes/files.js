// File routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers/middleware arrive via `deps`
// (dependency injection); Node builtins (fs, path) are imported directly. The
// route contract is identical to before extraction — enforced by
// test/refactor/route-manifest.mjs.
//
// Task 177 (2026-09-09): files-surface uploads moved from FILES_DIR root to
// FILES_UPLOADS_DIR (<FILES_DIR>/uploads), and the 24h TTL sweeper now sweeps
// ONLY that subdir. FILES_DIR root is SHARED with the assets surface
// (POST /assets/:id/upload stores there) — the old root-scoped sweeper deleted
// every asset file older than 24h while its DB row survived as status=ready
// (all 13 jetson assets were lost this way). Assets keep writing to FILES_DIR
// root; only /files is swept. HTTP contracts (URLs, response shapes) unchanged.
import fs from 'fs';
import nodePath from 'path';

export function registerFileRoutes(router, deps) {
  const {
    requireAuth, uploadFiles, asyncHandler, checkAgentOrAdmin, emitEvent,
    FILES_UPLOADS_DIR, FILE_TTL_MS,
  } = deps;

  // POST /files — upload a temp file (multipart form, field name: "file")
  // curl -X POST -H "X-Agent-Key: <key>" -F "file=@myimage.png" https://mycelium.fyi/api/mycelium/files
  // Files auto-delete after 24 hours. Download with wget/curl before then.
  router.post('/files', requireAuth, uploadFiles.single('file'), asyncHandler(function (req, res) {
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
    var filePath = nodePath.join(FILES_UPLOADS_DIR, filename);
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
      files = fs.readdirSync(FILES_UPLOADS_DIR).map(function (f) {
        var stat = fs.statSync(nodePath.join(FILES_UPLOADS_DIR, f));
        var expiresIn = Math.max(0, Math.round((FILE_TTL_MS - (now - stat.mtimeMs)) / 1000));
        var protocol = req.headers['x-forwarded-proto'] || req.protocol;
        var host = req.headers['x-forwarded-host'] || req.get('host');
        return { filename: f, size: stat.size, uploaded: stat.mtime.toISOString(), expires_in_seconds: expiresIn, url: protocol + '://' + host + '/api/mycelium/files/' + f };
      });
    } catch (e) { /* empty */ }
    res.json(files);
  }));
}

// Sweep expired files-surface uploads (the 24h TTL garbage collector; the
// mycelium.js interval is a thin wrapper around this so it stays testable).
// Scoped to `dir` (FILES_UPLOADS_DIR) — it must NEVER see FILES_DIR root,
// which the assets surface shares. Best-effort like the interval it replaced:
// returns the removed filenames, or null if the dir is unreadable.
export function sweepExpiredFiles(opts) {
  var dir = opts && opts.dir;
  var ttlMs = (opts && opts.ttlMs) || 24 * 60 * 60 * 1000;
  var now = (opts && opts.nowMs) || Date.now();
  var removed = [];
  try {
    var files = fs.readdirSync(dir);
    for (var f of files) {
      var fp = nodePath.join(dir, f);
      var stat = fs.statSync(fp);
      if (now - stat.mtimeMs > ttlMs) {
        fs.unlinkSync(fp);
        removed.push(f);
      }
    }
  } catch (e) {
    return null; /* cleanup is best-effort */
  }
  return removed;
}
