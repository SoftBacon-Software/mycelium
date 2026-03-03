// =============== MYCELIUM — Distributed Development Platform ===============
// The printing press of ideas.
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { initDB, getDB, resolveStaleRequests, pruneWebhookDeliveries } from './db.js';
import myceliumRoutes, { initPlugins } from './routes/mycelium.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = process.env.PORT || 3002;

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
initDB();

// Load plugins (after DB init, before routes are used)
await initPlugins();

var app = express();

app.use(compression());

// CORS — permissive for API usage
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Agent-Key']
}));

app.use(express.json({ limit: '1mb' }));

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

// Landing page at GET / (after static so it doesn't shadow favicon/assets above)
if (fs.existsSync(landingPage)) {
  app.get('/', function (req, res) {
    res.sendFile(landingPage);
  });
}

// ---- Health check (public, no auth) ----
var serverStartTime = Date.now();
app.get('/health', function (req, res) {
  var dbOk = false;
  try { getDB().prepare('SELECT 1').get(); dbOk = true; } catch (e) { /* */ }
  var agentsOnline = 0;
  try { agentsOnline = getDB().prepare("SELECT COUNT(*) as c FROM dv_agents WHERE status = 'online'").get().c; } catch (e) { /* */ }
  var mem = process.memoryUsage();
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    uptime_seconds: Math.floor((Date.now() - serverStartTime) / 1000),
    db_ok: dbOk,
    agents_online: agentsOnline,
    memory_usage_mb: Math.round(mem.rss / 1024 / 1024),
    version: '1.0.0'
  });
});

// ---- Public downloads (setup scripts, etc.) ----
var publicRoot = path.join(__dirname, '..', 'public');
app.get('/setup-admin.ps1', function (req, res) {
  res.type('text/plain').sendFile(path.join(publicRoot, 'setup-admin.ps1'));
});

// ---- API routes ----
app.use('/api/mycelium', myceliumRoutes);
app.use('/api/dioverse', myceliumRoutes); // backward compat

// ---- Voice REST endpoints ----
var voicePeers = new Map();

app.get('/api/voice/peers', function (req, res) {
  var peers = [];
  voicePeers.forEach(function (p) {
    peers.push({ id: p.id, name: p.name, muted: p.muted });
  });
  res.json({ peers: peers, count: peers.length });
});

app.get('/api/voice/turn-credentials', function (req, res) {
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
  console.log('Mycelium running on port ' + PORT + ' — mycelium.fyi');

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
  } catch (e) {
    console.error('[daily] Maintenance error:', e.message);
  }
}, 24 * 60 * 60 * 1000);

// ---- Voice chat signaling (WebRTC) ----
import { WebSocketServer } from 'ws';

var wss = new WebSocketServer({ server: server, path: '/voice' });
var peerCounter = 0;

wss.on('connection', function (ws) {
  ws.isAlive = true;
  var peerId = 'peer_' + (++peerCounter);
  voicePeers.set(ws, { id: peerId, name: 'User ' + peerCounter, muted: false });

  ws.send(JSON.stringify({ type: 'welcome', id: peerId, peers: Array.from(voicePeers.values()).filter(function (p) { return p.id !== peerId; }) }));
  broadcast({ type: 'peer_joined', peer: voicePeers.get(ws) }, ws);

  ws.on('pong', function () { ws.isAlive = true; });

  ws.on('message', function (raw) {
    ws.isAlive = true;
    try {
      var msg = JSON.parse(raw);
      var me = voicePeers.get(ws);
      if (!me) return;

      if (msg.type === 'set_name') {
        me.name = String(msg.name || '').substring(0, 30) || me.name;
        broadcast({ type: 'peer_updated', peer: me }, null);
      } else if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
        var target = findPeerWs(msg.to);
        if (target) target.send(JSON.stringify({ type: msg.type, from: me.id, sdp: msg.sdp, candidate: msg.candidate }));
      } else if (msg.type === 'mute') {
        me.muted = !!msg.muted;
        broadcast({ type: 'peer_updated', peer: me }, null);
      }
    } catch (e) { console.warn('[mycelium] WebSocket JSON parse failed (peer: ' + peerId + '):', e.message); }
  });

  ws.on('close', function () {
    var me = voicePeers.get(ws);
    voicePeers.delete(ws);
    if (me) broadcast({ type: 'peer_left', id: me.id }, null);
  });

  ws.on('error', function () {
    var me = voicePeers.get(ws);
    voicePeers.delete(ws);
    if (me) broadcast({ type: 'peer_left', id: me.id }, null);
  });
});

setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (!ws.isAlive) {
      var me = voicePeers.get(ws);
      voicePeers.delete(ws);
      if (me) broadcast({ type: 'peer_left', id: me.id }, null);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

function broadcast(msg, exclude) {
  var data = JSON.stringify(msg);
  wss.clients.forEach(function (client) {
    if (client !== exclude && client.readyState === 1) client.send(data);
  });
}

function findPeerWs(peerId) {
  for (var [ws, peer] of voicePeers) {
    if (peer.id === peerId) return ws;
  }
  return null;
}
