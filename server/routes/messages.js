// Messages / events / team-chat / inbox routes — extracted verbatim from
// mycelium.js (god-file decomposition, Phase 3, 2026-07-12; see
// docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs and pinned
// by test/unit/messages-channels-characterization.test.js.
import {
  listEvents,
  createMessage, getMessage, acknowledgeMessage, resolveMessage,
  listMessages, listThreads, bulkDeleteMessages,
  listTeamChat, createTeamChat,
  createInboxItem, createInboxItemForAllOperators,
  getInboxItem, listInboxItems, markInboxItemRead, markInboxItemActioned,
  dismissInboxItem, countUnreadInbox, countAllUnreadInbox,
  getAgent, getOrCreateDmChannel, getChannelBySlug,
  dispatchWebhook, getDB,
} from '../db.js';

export function registerMessageRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
    escapeHtml, parseIntParam, parseLimit, emitEvent, apiError,
    validateStringLength, MAX_CONTENT, checkEnforcementRules,
    agentWriteLimiter, getStudioUser, isAdminKey, displayName,
    jwt, JWT_SECRET, sseClients,
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

  // ======== MESSAGES ========

  router.get('/messages', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      from_agent: req.query.from,
      to_agent: req.query.to,
      thread_id: req.query.thread,
      project_id: req.query.project_id,
      since: req.query.since,
      msg_type: req.query.msg_type,
      status: req.query.status,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0,
      channel_id: req.query.channel_id ? parseIntParam(req.query.channel_id) : undefined
    };
    res.json(listMessages(filters));
  }));

  router.post('/messages', agentWriteLimiter, asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'message_sent', { agent: agentId, to_agent: req.body.to, content: (req.body.content || '').substring(0, 200) })) return;
    var content = req.body.content;
    if (!content) return res.status(400).json({ error: 'content is required' });
    if (!validateStringLength(res, content, MAX_CONTENT, 'content')) return;

    // Enforcement rules check
    var enforcement = checkEnforcementRules('send_message', { content: content, to_agent: req.body.to_agent || req.body.to }, agentId);
    if (!enforcement.allowed) {
      return res.status(403).json({ error: enforcement.blocks[0].message, enforcement_rule: enforcement.blocks[0].rule_id });
    }

    // Only admin and operators can send directives — privilege is derived from
    // AUTH (req._authIsAdmin flag + the caller's role), NEVER from the
    // client-supplied req.body.from, which is trivially spoofable (e.g. a regular
    // agent posting from: '__admin__' used to sail straight through).
    var msgType = req.body.msg_type || 'message';
    if (msgType === 'directive') {
      var directiveStudioUser = getStudioUser(req);
      var callerIsOperator = false;
      if (directiveStudioUser) {
        callerIsOperator = directiveStudioUser.role === 'operator';
      } else {
        var callerAgent = getAgent(agentId);
        callerIsOperator = !!(callerAgent && callerAgent.role === 'operator');
      }
      if (!req._authIsAdmin && !callerIsOperator) {
        return res.status(403).json({ error: 'Only admin or operators can send directives' });
      }
    }

    var toAgent = req.body.to_agent || req.body.to || null;
    var threadId = req.body.thread_id || null;
    var projectId = req.body.project_id || null;
    var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
    // Route to channel
    var channelId = req.body.channel_id ? parseIntParam(req.body.channel_id) : null;
    if (!channelId && toAgent) {
      // DM: auto-create DM channel
      channelId = getOrCreateDmChannel(agentId, toAgent, 'agent', 'agent');
    }
    if (!channelId && !toAgent) {
      // Broadcast: route to #general
      var general = getChannelBySlug('general');
      if (general) channelId = general.id;
    }
    var msgPriority = req.body.priority || 'normal';
    var id = createMessage(agentId, toAgent, threadId, projectId, content, metadata, msgType, channelId, msgPriority);
    // Skip events/webhooks for system-to-system telemetry (runner health pings etc)
    if (!(agentId === '__system__' && toAgent === '__system__')) {
      var target = toAgent ? ' to ' + displayName(toAgent) : ' (broadcast)';
      emitEvent('message_sent', agentId, projectId, displayName(agentId) + ' sent message' + target, { message_id: id });
      // Recipient-tagged push event so SSE subscribers filtering on `agent=<me>`
      // get notified when something arrives FOR them. This is what enables real-
      // time push to agents (Jarvis, Clara, Jetson) without polling. Event type
      // is parallel to message_sent so dashboards still get sender events.
      if (toAgent) {
        emitEvent('message_received', toAgent, projectId,
          displayName(agentId) + ' → ' + displayName(toAgent),
          { message_id: id, from: agentId, msg_type: msgType, priority: msgPriority });
        dispatchWebhook('message_sent', toAgent, { message_id: id, from: agentId, content: content.substring(0, 200) });
      }
      // Requests route to the target agent's operator inbox (so operators can respond)
      if (msgType === 'request' && toAgent) {
        var targetAgent = getAgent(toAgent);
        if (targetAgent && targetAgent.operator_id) {
          try {
            createInboxItem(targetAgent.operator_id, 'message', 'message', String(id),
              'Request from ' + displayName(agentId),
              content.substring(0, 120) + (content.length > 120 ? '...' : ''),
              { message_id: id, from: agentId, to: toAgent, msg_type: 'request', project_id: projectId }, 'urgent');
          } catch (e) { /* operator may not exist — skip silently */ }
        }
      }
      // Directives always land in inbox for all operators
      if (msgType === 'directive') {
        var dirTitle = content.substring(0, 80) + (content.length > 80 ? '...' : '');
        createInboxItemForAllOperators('message', 'message', String(id), 'Directive from ' + displayName(agentId), dirTitle, { message_id: id, from: agentId, msg_type: 'directive' }, 'urgent');
      }
      // @mention detection — @operatorId patterns (e.g. @hijack, @greatness)
      var mentionRe = /@([a-z0-9_-]+)/gi;
      var mentionMatch;
      var notifiedOps = new Set();
      while ((mentionMatch = mentionRe.exec(content)) !== null) {
        var mentionedId = mentionMatch[1].toLowerCase();
        if (!notifiedOps.has(mentionedId)) {
          try {
            createInboxItem(mentionedId, 'mention', 'message', String(id),
              displayName(agentId) + ' mentioned you',
              content.substring(0, 120) + (content.length > 120 ? '...' : ''),
              { message_id: id, from: agentId, project_id: projectId }, 'normal');
            notifiedOps.add(mentionedId);
          } catch (e) { /* operator may not exist — skip silently */ }
        }
      }
    }
    res.json({ id: id });
  }));

  router.put('/messages/:id/ack', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var msg = getMessage(parseIntParam(req.params.id));
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    acknowledgeMessage(msg.id);
    emitEvent('request_acknowledged', agentId, msg.project_id, agentId + ' acknowledged request #' + msg.id, { message_id: msg.id });
    res.json({ ok: true, id: msg.id, status: 'acknowledged' });
  }));

  router.put('/messages/:id/resolve', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var msg = getMessage(parseIntParam(req.params.id));
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    // If auth is __system__ (admin without X-Acting-As), use the message's to_agent as responder
    var responderId = (agentId === '__system__' && msg.to_agent) ? msg.to_agent : agentId;
    resolveMessage(msg.id, responderId);
    emitEvent('request_resolved', responderId, msg.project_id, responderId + ' resolved request #' + msg.id, { message_id: msg.id });
    // Notify the original sender via their SSE stream so they see the
    // resolution in real time (without polling). agent-tagged to from_agent.
    if (msg.from_agent && msg.from_agent !== responderId) {
      emitEvent('message_resolved_for_sender', msg.from_agent, msg.project_id,
        responderId + ' resolved your message #' + msg.id,
        { message_id: msg.id, resolved_by: responderId });
    }

    var result = { ok: true, id: msg.id, status: 'resolved' };

    // Optionally send a response message back
    if (req.body.response) {
      var responseId = createMessage(responderId, msg.from_agent, msg.thread_id, msg.project_id, req.body.response, '{}');
      result.response_id = responseId;
      // Recipient-tagged push event for the original sender — they get the
      // reply pushed to their SSE stream immediately.
      if (msg.from_agent) {
        emitEvent('message_received', msg.from_agent, msg.project_id,
          responderId + ' → ' + msg.from_agent,
          { message_id: responseId, from: responderId, msg_type: 'message',
            in_reply_to: msg.id });
      }
    }

    res.json(result);
  }));

  router.get('/messages/threads', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listThreads(parseLimit(req.query.limit, 20)));
  }));

  // Admin-only bulk message cleanup
  router.delete('/messages/bulk', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var from = req.query.from;
    var to = req.query.to;
    var content_like = req.query.content_like;
    if (!from && !to && !content_like) return res.status(400).json({ error: 'Specify at least one filter: from, to, content_like' });
    var deleted = bulkDeleteMessages({ from: from, to: to, content_like: content_like });
    res.json({ deleted: deleted });
  }));

  // ======== TEAM CHAT (human-only) ========

  // GET /team-chat — list human chat messages
  router.get('/team-chat', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    if (!user) {
      // Also allow admin key
      var key = req.headers['x-admin-key'];
      if (!isAdminKey(key)) return res.status(403).json({ error: 'Studio login required' });
    }
    var limit = parseLimit(req.query.limit, 50);
    res.json(listTeamChat(limit));
  }));

  // POST /team-chat — send a chat message (studio users only)
  router.post('/team-chat', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    if (!user) return res.status(403).json({ error: 'Studio login required' });
    var content = (req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content is required' });
    var sender = '__user:' + (user.displayName || user.username);
    var id = createTeamChat(sender, escapeHtml(content));
    res.json({ ok: true, id: id });
  }));

  // ======== OPERATOR INBOX ========
  // Human-facing message layer — keeps operator traffic separate from agent chatter.

  // GET /inbox — list inbox items for an operator (by ?operator_id or JWT user)
  router.get('/inbox', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    // Operators get their own inbox via JWT; admin can query any operator
    var operatorId = req.query.operator_id;
    if (!operatorId) {
      if (!user) return apiError(res, 400, 'operator_id is required');
      // Resolve operator from studio_user_id
      var op = getDB().prepare('SELECT id FROM operators WHERE studio_user_id = ?').get(user.userId);
      if (!op) return apiError(res, 404, 'No operator linked to this account');
      operatorId = op.id;
    }
    var filters = {
      operator_id: operatorId,
      status: req.query.status || undefined,
      type: req.query.type || undefined,
      entity_type: req.query.entity_type || undefined,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    var items = listInboxItems(filters);
    items.forEach(function (item) {
      try { item.data = JSON.parse(item.data); } catch (e) { item.data = {}; }
    });
    res.json(items);
  }));

  // GET /inbox/count — unread badge count per operator
  router.get('/inbox/count', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var operatorId = req.query.operator_id;
    if (!operatorId && user) {
      var op = getDB().prepare('SELECT id FROM operators WHERE studio_user_id = ?').get(user.userId);
      if (op) operatorId = op.id;
    }
    if (operatorId) {
      var unreadCount = countUnreadInbox(operatorId);
      res.json({ operator_id: operatorId, unread: unreadCount, count: unreadCount });
    } else {
      res.json(countAllUnreadInbox());
    }
  }));

  // GET /inbox/:id — get single inbox item
  router.get('/inbox/:id', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    try { item.data = JSON.parse(item.data); } catch (e) { item.data = {}; }
    res.json(item);
  }));

  // POST /inbox — create inbox item (admin/system use)
  router.post('/inbox', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var { operator_id, type, entity_type, entity_id, title, summary, data, priority, all_operators } = req.body;
    if (all_operators) {
      var ids = createInboxItemForAllOperators(type, entity_type, entity_id, title, summary, data, priority);
      return res.json({ ok: true, ids: ids });
    }
    if (!operator_id) return apiError(res, 400, 'operator_id or all_operators required');
    var id = createInboxItem(operator_id, type, entity_type, entity_id, title, summary, data, priority);
    emitEvent('inbox_item_created', '__system__', null, 'Inbox item for ' + operator_id + ': ' + (title || ''), { inbox_id: id, operator_id: operator_id, type: type });
    res.json({ ok: true, id: id });
  }));

  // PUT /inbox/:id/read — mark item read
  router.put('/inbox/:id/read', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    markInboxItemRead(item.id);
    res.json({ ok: true });
  }));

  // PUT /inbox/:id/action — mark item actioned (e.g. after approve/reject)
  router.put('/inbox/:id/action', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    markInboxItemActioned(item.id);
    res.json({ ok: true });
  }));

  // DELETE /inbox/:id — dismiss item
  router.delete('/inbox/:id', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var item = getInboxItem(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Inbox item not found');
    dismissInboxItem(item.id);
    res.json({ ok: true });
  }));

  // POST /inbox/bulk-dismiss — dismiss multiple items at once
  router.post('/inbox/bulk-dismiss', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    var adminKey = req.headers['x-admin-key'];
    if (!user && !isAdminKey(adminKey)) return apiError(res, 401, 'Authentication required');
    var ids = req.body.ids;
    var all = req.body.all;
    var operatorId = req.body.operator_id;
    if (!operatorId && user) {
      var op = getDB().prepare('SELECT id FROM operators WHERE studio_user_id = ?').get(user.userId);
      if (op) operatorId = op.id;
    }
    var dismissed = 0;
    if (all && operatorId) {
      // Dismiss all non-dismissed items for this operator
      var result = getDB().prepare("UPDATE operator_inbox SET status = 'dismissed' WHERE operator_id = ? AND status != 'dismissed'").run(operatorId);
      dismissed = result.changes;
    } else if (Array.isArray(ids) && ids.length > 0) {
      for (var i = 0; i < ids.length; i++) {
        dismissInboxItem(ids[i]);
        dismissed++;
      }
    } else {
      return apiError(res, 400, 'ids array or all=true required');
    }
    res.json({ ok: true, dismissed: dismissed });
  }));
}
