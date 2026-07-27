// Request routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listPendingRequests, createRequest, createTask, updateTask,
  getMessage, acknowledgeMessage, resolveMessage, createMessage,
  dispatchWebhook,
} from '../db.js';

export function registerRequestRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkGuardrails,
    escapeHtml, parseIntParam, emitEvent,
  } = deps;

  // ======== REQUESTS ========

  router.get('/requests/pending', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    // Admin can query any agent's pending requests via ?agent_id=
    var targetAgent = req.query.agent_id || agentId;
    res.json(listPendingRequests(targetAgent));
  }));

  router.post('/requests', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'request_created', { agent: agentId, project_id: req.body.project_id, to_agent: req.body.to_agent, content: (req.body.content || '').substring(0, 200) })) return;
    var content = req.body.content;
    if (!content) return res.status(400).json({ error: 'content is required' });
    var toAgent = req.body.to_agent || null;
    if (!toAgent) return res.status(400).json({ error: 'to_agent is required for requests — use POST /messages for broadcasts' });
    var threadId = req.body.thread_id || null;
    var projectId = req.body.project_id || null;
    var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
    var id = createRequest(agentId, toAgent, threadId, projectId, content, metadata);
    var target = toAgent ? ' to ' + toAgent : ' (broadcast)';
    emitEvent('request_created', agentId, projectId, agentId + ' sent request' + target, { message_id: id });
    if (toAgent) {
      // Recipient-tagged push event for real-time delivery to the target agent.
      emitEvent('request_received', toAgent, projectId,
        agentId + ' → ' + toAgent,
        { message_id: id, from: agentId, blocking: true });
      dispatchWebhook('request_created', toAgent, { message_id: id, from: agentId, content: content.substring(0, 200) });
    }

    var result = { id: id };

    // Auto-create task if requested
    if (req.body.auto_task && toAgent) {
      var title = escapeHtml(req.body.task_title || content.substring(0, 80));
      var taskId = createTask(title, content, projectId || '', agentId, req.body.priority || 'normal', '[]');
      updateTask(taskId, { assignee: toAgent, request_id: id });
      result.task_id = taskId;
      emitEvent('task_created', agentId, projectId, 'Auto-task from request: ' + title + ' \u2192 ' + toAgent, { task_id: taskId, message_id: id });
    }

    res.json(result);
  }));

  router.put('/requests/:id', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var msg = getMessage(parseIntParam(req.params.id));
    if (!msg) return res.status(404).json({ error: 'Request not found' });
    if (msg.msg_type !== 'request') return res.status(400).json({ error: 'Message #' + msg.id + ' is not a request' });

    var status = req.body.status;
    if (!status) return res.status(400).json({ error: 'status is required (acknowledged, resolved, completed)' });

    if (status === 'acknowledged' || status === 'ack') {
      acknowledgeMessage(msg.id);
      emitEvent('request_acknowledged', agentId, msg.project_id, agentId + ' acknowledged request #' + msg.id, { message_id: msg.id });
      return res.json({ ok: true, id: msg.id, status: 'acknowledged' });
    }

    if (status === 'resolved' || status === 'completed' || status === 'done') {
      // If auth is __system__ (admin without X-Acting-As), use the request's to_agent as responder
      var responderId = (agentId === '__system__' && msg.to_agent) ? msg.to_agent : agentId;
      resolveMessage(msg.id, responderId);
      emitEvent('request_resolved', responderId, msg.project_id, responderId + ' resolved request #' + msg.id, { message_id: msg.id });
      var result = { ok: true, id: msg.id, status: 'resolved' };
      if (req.body.response) {
        var responseId = createMessage(responderId, msg.from_agent, msg.thread_id, msg.project_id, req.body.response, '{}');
        result.response_id = responseId;
      }
      return res.json(result);
    }

    res.status(400).json({ error: 'Invalid status. Use: acknowledged, resolved, completed' });
  }));
}
