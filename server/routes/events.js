// Events routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import { listEvents } from '../db.js';

export function registerEventRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkGuardrails,
    escapeHtml, parseLimit, emitEvent,
    sseClients, jwt, JWT_SECRET,
  } = deps;

  // ======== EVENTS ========

  router.get('/events', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      since: req.query.since,
      project_id: req.query.project_id,
      type: req.query.type,
      agent: req.query.agent,
      search: req.query.search || undefined,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    res.json(listEvents(filters));
  }));

  router.post('/events', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'event_emitted', { agent: agentId, project_id: req.body.project_id, type: req.body.type, summary: req.body.summary })) return;
    var type = req.body.type || 'custom';
    var projectId = req.body.project_id || null;
    var summary = escapeHtml(req.body.summary || '');
    // Broadcast to live SSE subscribers in real time (not just persist), so
    // operator-emitted events like display/* reach connected clients at once.
    var id = emitEvent(type, agentId, projectId, summary, req.body.data || {});
    res.json({ id: id });
  }));

  // GET /events/stream — Server-Sent Events stream for live event broadcast
  // Auth: ?token=<jwt> for browser EventSource, or X-Admin-Key/X-Agent-Key headers for API clients
  // Filters (optional): ?project_id=, ?type=, ?agent=
  // On connect: replays last 20 matching events so the client isn't blank
  // Heartbeat: SSE comment every 30s to keep proxies from closing idle connections
  router.get('/events/stream', asyncHandler(function (req, res) {
    // Limit SSE connections per IP to prevent resource exhaustion
    var clientIp = req.ip || req.connection.remoteAddress;
    var sseCount = 0;
    sseClients.forEach(function (c) { if (c.ip === clientIp) sseCount++; });
    if (sseCount >= 5) return res.status(429).json({ error: 'Too many SSE connections from this IP' });

    // Auth must happen before SSE headers are set so we can send error JSON
    var authOk = false;

    // ?token=<jwt> — browser EventSource can't set Authorization headers
    var token = req.query.token;
    if (token) {
      try {
        var decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        // Any studio JWT may stream, but only admin-role users carry the admin
        // flag (mirrors checkAgentOrAdmin — any-JWT-means-admin was a
        // privilege-flattening hole)
        if (decoded && decoded.studioUser) { req._authIsAdmin = decoded.role === 'admin'; authOk = true; }
      } catch (e) { /* invalid token, fall through to header auth */ }
    }

    if (!authOk) {
      var who = checkAgentOrAdmin(req, res);
      if (!who) return; // checkAgentOrAdmin already sent 401/403
      authOk = true;
    }

    // Optional event filters
    var filters = {
      project_id: req.query.project_id || null,
      type: req.query.type || null,
      agent: req.query.agent || null
    };

    // SSE response headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/Railway proxy buffering
    res.flushHeaders();

    // Replay last 20 matching events on connect so dashboard isn't blank
    try {
      var recentFilters = { limit: 20, offset: 0 };
      if (filters.project_id) recentFilters.project_id = filters.project_id;
      if (filters.type) recentFilters.type = filters.type;
      if (filters.agent) recentFilters.agent = filters.agent;
      var recent = listEvents(recentFilters);
      recent.reverse().forEach(function (ev) {
        res.write('data: ' + JSON.stringify(ev) + '\n\n');
      });
      if (res.flush) res.flush();
    } catch (e) { /* non-fatal — stream still opens */ }

    // Register this client
    var client = { res: res, filters: filters, ip: clientIp };
    sseClients.add(client);

    // Keepalive heartbeat every 30s — SSE comment (ignored by EventSource)
    var heartbeat = setInterval(function () {
      try {
        res.write(': keepalive\n\n');
        if (res.flush) res.flush();
      } catch (e) { /* cleaned up below */ }
    }, 30000);

    // Cleanup when client disconnects
    req.on('close', function () {
      clearInterval(heartbeat);
      sseClients.delete(client);
    });
  }));
}
