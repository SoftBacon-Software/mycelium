// =============== MYCELIUM — Distributed Development Platform ===============

// Crash diagnostics — ensure unhandled errors always print before exit
process.on('uncaughtException', (err) => {
  process.stdout.write('[FATAL] uncaughtException: ' + (err?.stack || err?.message || String(err)) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stdout.write('[FATAL] unhandledRejection: ' + (reason?.stack || reason?.message || String(reason)) + '\n');
  process.exit(1);
});

process.stdout.write('[boot] Node ' + process.version + ' PORT=' + (process.env.PORT || '(not set, will use 3002)') + '\n');

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { initDB, getDB, resolveStaleRequests, pruneWebhookDeliveries, purgeExpiredContextKeys, cleanupContextHistory, cleanupSavepoints } from './db.js';
import myceliumRoutes, { initPlugins } from './routes/mycelium.js';
import { initEmail } from './email.js';

// Lightweight auth check for voice endpoints (reuses JWT_SECRET/ADMIN_KEY from env)
function isAdminKey(key) {
  var expected = process.env.ADMIN_KEY;
  return key && expected && key.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
}
function checkVoiceAuth(req, res) {
  var adminKey = req.headers['x-admin-key'];
  if (isAdminKey(adminKey)) return true;
  var auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    try { jwt.verify(auth.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] }); return true; } catch (e) { /* invalid */ }
  }
  var agentKey = req.headers['x-agent-key'];
  if (agentKey) {
    var keyHash = crypto.createHash('sha256').update(agentKey).digest('hex');
    var db = getDB();
    var match = db.prepare("SELECT id FROM agents WHERE api_key_hash = ?").get(keyHash);
    if (match) return true;
  }
  res.status(401).json({ error: 'Authentication required' });
  return false;
}

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = process.env.PORT || 3002;
var pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
var APP_VERSION = pkgJson.version || '0.0.0';

// ---- Startup validation ----
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required.');
  process.exit(1);
}
if (!process.env.ADMIN_KEY) {
  console.error('FATAL: ADMIN_KEY environment variable is required.');
  process.exit(1);
}
if (!process.env.TURN_SECRET) {
  console.warn('[mycelium] TURN_SECRET not set — using default OpenRelay secret. Set TURN_SECRET env var for production.');
}

// Initialize database
process.stdout.write('[boot] initializing DB...\n');
initDB();

// Migrate: add category + expires_at columns to context_keys if missing
try {
  var _db = getDB();
  var cols = _db.pragma('table_info(context_keys)').map(function(c) { return c.name; });
  if (!cols.includes('category')) {
    _db.prepare("ALTER TABLE context_keys ADD COLUMN category TEXT NOT NULL DEFAULT 'durable'").run();
    process.stdout.write('[boot] migrated context_keys: added category column\n');
  }
  if (!cols.includes('expires_at')) {
    _db.prepare("ALTER TABLE context_keys ADD COLUMN expires_at TEXT").run();
    process.stdout.write('[boot] migrated context_keys: added expires_at column\n');
  }
} catch (e) {
  process.stdout.write('[boot] context_keys migration note: ' + e.message + '\n');
}

// Purge expired context keys on boot
var purged = purgeExpiredContextKeys();
if (purged > 0) process.stdout.write('[boot] purged ' + purged + ' expired context keys\n');

process.stdout.write('[boot] DB ready\n');

// Initialize email (after DB, before routes — non-fatal if RESEND_KEY missing)
initEmail();

// Load plugins (after DB init, before routes are used)
process.stdout.write('[boot] loading plugins...\n');
await initPlugins();
process.stdout.write('[boot] plugins loaded\n');

var app = express();

// Railway runs behind a reverse proxy — trust X-Forwarded-For for real client IPs.
// Required for rate limiting to work correctly (otherwise req.ip = proxy IP).
app.set('trust proxy', true);

app.use(compression());

// CORS — allow dashboard, localhost dev, and MCP/agent API calls
var ALLOWED_ORIGINS = [
  'https://mycelium.fyi',
  'https://www.mycelium.fyi',
  'http://localhost:3002',
  'http://localhost:5173'
];
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (MCP servers, curl, agents, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Agent-Key']
}));

// Security headers
app.use(function (req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '0');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({
  limit: '1mb',
  verify: function (req, res, buf) {
    // Capture raw body for all webhook endpoints that need signature verification
    if (req.url.includes('/webhook')) {
      req.rawBody = buf;
    }
  }
}));

// Catch malformed JSON from body parser (Bug #89 — return 400 not 500)
app.use(function (err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

// Ensure all JSON responses use UTF-8 charset
app.use(function (req, res, next) {
  var origJson = res.json.bind(res);
  res.json = function (data) {
    res.set('Content-Type', 'application/json; charset=utf-8');
    return origJson(data);
  };
  next();
});

// ---- Landing page (marketing) at root ----
// The landing page is served at GET / — everything else at root falls through
// to the studio static middleware so SPA asset paths (/assets/, /favicon.svg) still resolve.
var publicPath = path.join(__dirname, '..', 'public');
var landingPage = path.join(publicPath, 'index.html');

// ---- Mycelium Dashboard ----
// Primary: /studio/ — also serves root paths so absolute asset URLs (/assets/*, /favicon.svg) work.
var dashboardPath = path.join(__dirname, '..', 'public', 'studio');
if (fs.existsSync(dashboardPath)) {
  // Serve at /studio/
  app.use('/studio', express.static(dashboardPath));
  // Also serve studio assets at root so the Vite-built SPA absolute paths resolve
  app.use('/', express.static(dashboardPath, { index: false }));
}

// ---- Local LLM Advisor (public, static) — the web acquisition funnel ----
var advisorPath = path.join(__dirname, '..', 'public', 'advisor');
if (fs.existsSync(advisorPath)) {
  app.use('/advisor', express.static(advisorPath));
}

// ---- mycelium.fyi static site (multi-page: landing + Field Notes + Programs) ----
// Serve the built static export from public/ so /, /notes/, /programs/, and the
// /_next/ assets all resolve. (Was a single-file landing; now a full static site.)
app.use(express.static(publicPath));

// Landing page at GET / (after static so it doesn't shadow favicon/assets above)
if (fs.existsSync(landingPage)) {
  app.get('/', function (req, res) {
    res.sendFile(landingPage);
  });
}

// One-liner install script: curl -fsSL https://mycelium.fyi/install.sh | bash
var installScript = path.join(__dirname, '..', 'tools', 'install.sh');
if (fs.existsSync(installScript)) {
  app.get('/install.sh', function (req, res) {
    res.type('text/plain').sendFile(installScript);
  });
}

// ---- Live activity dashboard (public, no auth) ----
var livePage = path.join(publicPath, 'live.html');
if (fs.existsSync(livePage)) {
  app.get('/live', function (req, res) {
    res.sendFile(livePage);
  });
}

// ---- Health check (public, no auth) ----
var serverStartTime = Date.now();
app.get('/health', function (req, res) {
  var dbOk = false;
  try { getDB().prepare('SELECT 1').get(); dbOk = true; } catch (e) { /* */ }
  var agentsOnline = 0;
  try { agentsOnline = getDB().prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'online'").get().c; } catch (e) { /* */ }
  var mem = process.memoryUsage();
  var statusCode = dbOk ? 200 : 503;
  res.status(statusCode).json({
    status: dbOk ? 'ok' : 'degraded',
    uptime_seconds: Math.floor((Date.now() - serverStartTime) / 1000),
    db_ok: dbOk,
    agents_online: agentsOnline,
    memory_usage_mb: Math.round(mem.rss / 1024 / 1024),
    version: APP_VERSION
  });
});

// ---- Public downloads (setup scripts, etc.) ----
var publicRoot = path.join(__dirname, '..', 'public');
app.get('/setup-admin.ps1', function (req, res) {
  res.type('text/plain').sendFile(path.join(publicRoot, 'setup-admin.ps1'));
});

// ---- A2A Agent Card (public, no auth) ----
app.get('/.well-known/agent.json', function (req, res) {
  // Proxy to the a2a-gateway plugin's agent card endpoint
  req.url = '/api/mycelium/a2a/agent-card';
  app.handle(req, res);
});

// ---- A2A JSON-RPC endpoint (public with API key auth) ----
app.post('/a2a', function (req, res) {
  req.url = '/api/mycelium/a2a/rpc';
  app.handle(req, res);
});

// ---- API routes ----
app.use('/api/mycelium', myceliumRoutes);

// ---- Voice REST endpoints ----
var voicePeers = new Map();

app.get('/api/voice/peers', function (req, res) {
  if (!checkVoiceAuth(req, res)) return;
  var channelFilter = req.query.channel;
  var peers = [];
  voicePeers.forEach(function (p) {
    if (!channelFilter || p.channel === channelFilter) {
      peers.push({ id: p.id, name: p.name, muted: p.muted, channel: p.channel || '' });
    }
  });
  res.json({ peers: peers, count: peers.length });
});

app.get('/api/voice/turn-credentials', function (req, res) {
  if (!checkVoiceAuth(req, res)) return;
  var secret = process.env.TURN_SECRET || 'openrelayprojectsecret';
  var expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  var username = expiry + ':studiouser';
  var hmac = crypto.createHmac('sha1', secret);
  hmac.update(username);
  var credential = hmac.digest('base64');
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:staticauth.openrelay.metered.ca:80' },
      { urls: 'turn:staticauth.openrelay.metered.ca:80', username: username, credential: credential },
      { urls: 'turn:staticauth.openrelay.metered.ca:80?transport=tcp', username: username, credential: credential },
      { urls: 'turn:staticauth.openrelay.metered.ca:443', username: username, credential: credential },
      { urls: 'turns:staticauth.openrelay.metered.ca:443?transport=tcp', username: username, credential: credential }
    ]
  });
});

// Dashboard SPA catch-all: only for /studio/* paths
if (fs.existsSync(dashboardPath)) {
  app.get('/studio/*', function (req, res) {
    res.sendFile(path.join(dashboardPath, 'index.html'));
  });
}

// ---- Global error handler ----
// Catches unhandled errors from sync and async route handlers.
// Returns generic 500 to clients (no stack trace leak).
app.use(function (err, req, res, _next) {
  console.error('[ERROR]', req.method, req.originalUrl, '-', err.stack || err.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

var server = app.listen(PORT, function () {
  console.log('Mycelium running on port ' + PORT);

  // Startup maintenance: clean stale requests and prune old webhook delivery logs
  try {
    var staleResolved = resolveStaleRequests(72);
    if (staleResolved > 0) console.log('Resolved ' + staleResolved + ' stale requests (>72h)');
    var pruned = pruneWebhookDeliveries(7);
    if (pruned > 0) console.log('Pruned ' + pruned + ' old webhook delivery logs (>7d)');
  } catch (e) {
    console.error('Startup maintenance error:', e.message);
  }
});

// ---- Graceful shutdown: stop worker plugins, close DB ----
import { stopAllWorkers } from './plugins.js';
function gracefulShutdown(signal) {
  console.log('[shutdown] ' + signal + ' received, stopping workers...');
  stopAllWorkers();
  server.close(function () {
    try { getDB().close(); console.log('[shutdown] DB closed'); } catch (e) { /* */ }
    process.exit(0);
  });
  // Force exit after 10s if server.close hangs (e.g. long-lived SSE/WS connections)
  setTimeout(function () {
    console.warn('[shutdown] Forced exit after 10s timeout');
    try { getDB().close(); } catch (e) { /* */ }
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', function () { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function () { gracefulShutdown('SIGINT'); });

// ---- SQLite backup system ----
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
var BACKUP_DIR = path.join(DATA_DIR, 'backups');
var MAX_BACKUPS = 10;

async function runBackup() {
  try {
    // Ensure backup directory exists (async, non-blocking)
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    var now = new Date();
    var ts = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    var backupPath = path.join(BACKUP_DIR, 'mycelium_' + ts + '.db');
    await getDB().backup(backupPath);
    console.log('[backup] Created: ' + backupPath);
    // Prune old backups (keep last MAX_BACKUPS) — all async, non-blocking
    try {
      var files = (await fs.promises.readdir(BACKUP_DIR))
        .filter(function (f) { return f.startsWith('mycelium_') && f.endsWith('.db'); })
        .sort();
      while (files.length > MAX_BACKUPS) {
        var oldest = files.shift();
        await fs.promises.unlink(path.join(BACKUP_DIR, oldest));
        console.log('[backup] Pruned: ' + oldest);
      }
    } catch (e) {
      console.error('[backup] Prune error:', e.message);
    }
  } catch (e) {
    console.error('[backup] Error:', e.message);
  }
}

// Backup on startup
runBackup();
// Backup every 6 hours
setInterval(runBackup, 6 * 60 * 60 * 1000);

// Daily maintenance: stale requests + webhook log pruning (runs every 24h)
setInterval(function () {
  try {
    var staleResolved = resolveStaleRequests(72);
    if (staleResolved > 0) console.log('[daily] Resolved ' + staleResolved + ' stale requests');
    var pruned = pruneWebhookDeliveries(7);
    if (pruned > 0) console.log('[daily] Pruned ' + pruned + ' old webhook delivery logs');
    var ctxPurged = purgeExpiredContextKeys();
    if (ctxPurged > 0) console.log('[daily] Purged ' + ctxPurged + ' expired context keys');
    // Clean expired password reset tokens (older than 1 day)
    try {
      var tokensPurged = getDB().prepare("DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')").run().changes;
      if (tokensPurged > 0) console.log('[daily] Purged ' + tokensPurged + ' expired password reset tokens');
    } catch (e) { /* table may not exist yet — non-fatal */ }
    // Retention cleanup: context history + savepoints
    try {
      cleanupContextHistory(90);
      cleanupSavepoints(50);
    } catch (e) {
      console.error('[health] Retention cleanup error:', e.message);
    }
  } catch (e) {
    console.error('[daily] Maintenance error:', e.message);
  }
}, 24 * 60 * 60 * 1000);

// ---- Voice chat signaling (WebRTC) ----
import { WebSocketServer } from 'ws';

var wss = new WebSocketServer({ noServer: true });
var peerCounter = 0;

wss.on('connection', function (ws, req) {
  // Authenticate via ?token= query param (JWT)
  var url = new URL(req.url, 'http://localhost');
  var token = url.searchParams.get('token');
  if (!token) { ws.close(4401, 'Authentication required'); return; }
  try { jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }); } catch (e) { ws.close(4403, 'Invalid token'); return; }

  ws.isAlive = true;
  var peerId = 'peer_' + (++peerCounter);
  voicePeers.set(ws, { id: peerId, name: 'User ' + peerCounter, muted: false, channel: '' });

  // Send welcome with peers in same channel (empty channel = lobby)
  ws.send(JSON.stringify({ type: 'welcome', id: peerId, peers: getPeersInChannel('').filter(function (p) { return p.id !== peerId; }) }));
  broadcastToChannel({ type: 'peer_joined', peer: voicePeers.get(ws) }, '', ws);

  ws.on('pong', function () { ws.isAlive = true; });

  ws.on('message', function (raw) {
    ws.isAlive = true;
    try {
      var msg = JSON.parse(raw);
      var me = voicePeers.get(ws);
      if (!me) return;

      if (msg.type === 'set_name') {
        me.name = String(msg.name || '').substring(0, 30) || me.name;
        broadcastToChannel({ type: 'peer_updated', peer: me }, me.channel, null);
      } else if (msg.type === 'join_channel') {
        var oldChannel = me.channel;
        var newChannel = String(msg.channel || '').substring(0, 50);
        // Leave old channel
        if (oldChannel !== newChannel) {
          broadcastToChannel({ type: 'peer_left', id: me.id }, oldChannel, ws);
        }
        me.channel = newChannel;
        // Send welcome for new channel peers
        ws.send(JSON.stringify({ type: 'welcome', id: peerId, channel: newChannel, peers: getPeersInChannel(newChannel).filter(function (p) { return p.id !== peerId; }) }));
        broadcastToChannel({ type: 'peer_joined', peer: me }, newChannel, ws);
      } else if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
        // Only relay within same channel
        var target = findPeerWs(msg.to);
        if (target) {
          var targetPeer = voicePeers.get(target);
          if (targetPeer && targetPeer.channel === me.channel) {
            target.send(JSON.stringify({ type: msg.type, from: me.id, sdp: msg.sdp, candidate: msg.candidate }));
          }
        }
      } else if (msg.type === 'mute') {
        me.muted = !!msg.muted;
        broadcastToChannel({ type: 'peer_updated', peer: me }, me.channel, null);
      }
    } catch (e) { console.warn('[mycelium] WebSocket JSON parse failed (peer: ' + peerId + '):', e.message); }
  });

  ws.on('close', function () {
    var me = voicePeers.get(ws);
    voicePeers.delete(ws);
    if (me) broadcastToChannel({ type: 'peer_left', id: me.id }, me.channel, null);
  });

  ws.on('error', function () {
    var me = voicePeers.get(ws);
    voicePeers.delete(ws);
    if (me) broadcastToChannel({ type: 'peer_left', id: me.id }, me.channel, null);
  });
});

setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (!ws.isAlive) {
      var me = voicePeers.get(ws);
      voicePeers.delete(ws);
      if (me) broadcastToChannel({ type: 'peer_left', id: me.id }, me.channel, null);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

function getPeersInChannel(channel) {
  var peers = [];
  voicePeers.forEach(function (p) {
    if (p.channel === channel) peers.push(p);
  });
  return peers;
}

function broadcastToChannel(msg, channel, exclude) {
  var data = JSON.stringify(msg);
  for (var [client, peer] of voicePeers) {
    if (client !== exclude && peer.channel === channel && client.readyState === 1) {
      client.send(data);
    }
  }
}

function findPeerWs(peerId) {
  for (var [ws, peer] of voicePeers) {
    if (peer.id === peerId) return ws;
  }
  return null;
}

// ---- File Drone WebSocket Tunnel ----
// Local file drones connect via WebSocket and serve filesystem to the network.
// HTTP routes in mycelium.js send requests through this tunnel.

var fileDrones = new Map(); // droneId -> { ws, info, pendingRequests }
app.locals.fileDrones = fileDrones; // Expose to routes

var fileDroneWss = new WebSocketServer({ noServer: true });
var _fileDroneReqCounter = 0;

fileDroneWss.on('connection', function (ws, req) {
  var url = new URL(req.url, 'http://localhost');
  var agentKey = url.searchParams.get('key');
  var droneId = url.searchParams.get('drone_id');

  // Authenticate via agent key (same SHA-256 lookup as checkVoiceAuth)
  if (!agentKey || !droneId) {
    ws.close(4401, 'Missing key or drone_id');
    return;
  }
  var keyHash = crypto.createHash('sha256').update(agentKey).digest('hex');
  var db = getDB();
  var match = db.prepare("SELECT id FROM agents WHERE api_key_hash = ?").get(keyHash);
  if (!match || match.id !== droneId) {
    ws.close(4403, 'Invalid credentials');
    return;
  }

  console.log('[file-drone] Connected: ' + droneId);
  ws.isAlive = true;

  var drone = { ws: ws, info: {}, pendingRequests: new Map() };
  fileDrones.set(droneId, drone);

  // Update agent status
  try {
    db.prepare("UPDATE agents SET status = 'online', last_heartbeat = datetime('now') WHERE id = ?").run(droneId);
  } catch (e) { /* non-fatal */ }

  ws.on('pong', function () { ws.isAlive = true; });

  ws.on('message', function (raw) {
    ws.isAlive = true;
    try {
      var msg = JSON.parse(raw);

      // Initial status message from drone
      if (msg.type === 'status') {
        drone.info = msg.data || {};
        return;
      }

      // Pong response
      if (msg.type === 'pong') return;

      // Response to a pending request (result, file_start, file_chunk, file_end, error)
      var reqId = msg.id;
      if (reqId && drone.pendingRequests.has(reqId)) {
        var pending = drone.pendingRequests.get(reqId);
        if (pending.onMessage) pending.onMessage(msg);
      }
    } catch (e) {
      console.warn('[file-drone] Parse error from ' + droneId + ':', e.message);
    }
  });

  ws.on('close', function () {
    console.log('[file-drone] Disconnected: ' + droneId);
    // Reject all pending requests
    for (var [id, pending] of drone.pendingRequests) {
      if (pending.reject) pending.reject(new Error('Drone disconnected'));
    }
    drone.pendingRequests.clear();
    fileDrones.delete(droneId);
    try {
      db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(droneId);
    } catch (e) { /* non-fatal */ }
  });

  ws.on('error', function (err) {
    console.warn('[file-drone] Error from ' + droneId + ':', err.message);
  });
});

// Heartbeat for file drones
setInterval(function () {
  fileDroneWss.clients.forEach(function (ws) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// ---- Manual WebSocket upgrade routing (required for multiple WSS on one HTTP server) ----
server.on('upgrade', function (request, socket, head) {
  var pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/voice') {
    wss.handleUpgrade(request, socket, head, function (ws) {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/file-drone') {
    fileDroneWss.handleUpgrade(request, socket, head, function (ws) {
      fileDroneWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Helper: send a request to a file drone and wait for response
// Used by HTTP routes in mycelium.js via app.locals.sendFileDroneRequest
app.locals.sendFileDroneRequest = function (droneId, type, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var drone = fileDrones.get(droneId);
    if (!drone || drone.ws.readyState !== 1) {
      return reject(new Error('File drone not connected: ' + droneId));
    }
    var reqId = 'freq_' + (++_fileDroneReqCounter);
    var timer = setTimeout(function () {
      drone.pendingRequests.delete(reqId);
      reject(new Error('Request timed out'));
    }, timeoutMs || 15000);

    drone.pendingRequests.set(reqId, {
      resolve: resolve,
      reject: reject,
      onMessage: function (msg) {
        if (msg.type === 'result' || msg.type === 'error') {
          clearTimeout(timer);
          drone.pendingRequests.delete(reqId);
          if (msg.type === 'error') {
            reject(new Error((msg.data && msg.data.error) || 'Drone error'));
          } else {
            resolve(msg.data);
          }
        }
        // file_start, file_chunk, file_end handled by streaming version
      }
    });

    drone.ws.send(JSON.stringify({ id: reqId, type: type, params: params }));
  });
};

// Helper: stream a file download from drone, piping to HTTP response
app.locals.streamFileDroneDownload = function (droneId, params, res, requestType) {
  return new Promise(function (resolve, reject) {
    var drone = fileDrones.get(droneId);
    if (!drone || drone.ws.readyState !== 1) {
      return reject(new Error('File drone not connected: ' + droneId));
    }
    var reqId = 'freq_' + (++_fileDroneReqCounter);
    var timer = setTimeout(function () {
      drone.pendingRequests.delete(reqId);
      reject(new Error('Download timed out'));
    }, 300000); // 5 min timeout for downloads
    var headersSent = false;

    drone.pendingRequests.set(reqId, {
      resolve: resolve,
      reject: reject,
      onMessage: function (msg) {
        if (msg.type === 'error') {
          clearTimeout(timer);
          drone.pendingRequests.delete(reqId);
          reject(new Error((msg.data && msg.data.error) || 'Download error'));
        } else if (msg.type === 'file_start') {
          headersSent = true;
          res.setHeader('Content-Type', msg.data.mime || 'application/octet-stream');
          res.setHeader('Content-Length', msg.data.size);
          res.setHeader('Content-Disposition', 'attachment; filename="' + (msg.data.name || 'file').replace(/"/g, '_') + '"');
        } else if (msg.type === 'file_chunk') {
          var buf = Buffer.from(msg.data, 'base64');
          res.write(buf);
        } else if (msg.type === 'file_end') {
          clearTimeout(timer);
          drone.pendingRequests.delete(reqId);
          res.end();
          resolve();
        }
      }
    });

    drone.ws.send(JSON.stringify({ id: reqId, type: requestType || 'file_download', params: params }));
  });
};
