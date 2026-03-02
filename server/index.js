// =============== MYCELIUM — Distributed Development Platform ===============
// The printing press of ideas.
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { initDB, resolveStaleRequests, pruneWebhookDeliveries } from './db.js';
import myceliumRoutes from './routes/mycelium.js';

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

// Initialize database
initDB();

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

// ---- Mycelium Dashboard ----
var dashboardPath = path.join(__dirname, '..', 'public', 'studio');
if (fs.existsSync(dashboardPath)) {
  // Serve dashboard at root and /studio for backward compat
  app.use('/', express.static(dashboardPath));
  app.use('/studio', express.static(dashboardPath));
}

// ---- API routes ----
app.use('/api/mycelium', myceliumRoutes);
app.use('/api/dioverse', myceliumRoutes);  // backward compat alias

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
  var secret = 'openrelayprojectsecret';
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

// Dashboard catch-all (SPA)
if (fs.existsSync(dashboardPath)) {
  app.get('*', function (req, res) {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(dashboardPath, 'index.html'));
  });
}

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
    } catch (e) { /* ignore */ }
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
