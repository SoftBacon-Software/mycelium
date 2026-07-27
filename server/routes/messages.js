// Message routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listMessages, createMessage, getMessage,
  acknowledgeMessage, resolveMessage,
  listThreads, bulkDeleteMessages,
  getOrCreateDmChannel, getChannelBySlug,
  getAgent, createInboxItem, createInboxItemForAllOperators,
  dispatchWebhook,
} from '../db.js';

export function registerMessageRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
    agentWriteLimiter, parseLimit, parseIntParam, validateStringLength,
    MAX_CONTENT, checkEnforcementRules, getStudioUser, displayName,
    emitEvent,
  } = deps;

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
}
