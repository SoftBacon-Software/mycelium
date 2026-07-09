// Approvals routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  createApproval, getApproval, listApprovals, decideApproval,
  markApprovalExecuted, castApprovalVote, getApprovalVotes, countApprovalVotes,
  createMessage, getAgent, listOperators,
  createInboxItem, createInboxItemForAllOperators,
  isNetworkAutonomous, getSleepMode, appendSleepLog,
  dispatchWebhook, GATED_ACTIONS,
} from '../db.js';

// Notify requesting agent when approval is decided (message + inbox)
function notifyApprovalDecision(approval, status, decidedBy, reason) {
  var agentId = approval.requested_by;
  if (!agentId || agentId === '__admin__' || agentId === '__system__') return;
  try {
    var statusLabel = status === 'approved' ? 'APPROVED' : 'DENIED';
    var content = statusLabel + ': [' + approval.action_type + '] ' + approval.title;
    if (reason) content += ' — ' + reason;
    // 1. Send message to agent
    createMessage('__system__', agentId, null, approval.project_id || approval.project || 'mycelium', content, '{}', 'info');
    // 2. Create inbox item for agent's operator
    var agent = getAgent(agentId);
    if (agent && agent.operator_id) {
      var operators = listOperators();
      var op = operators.find(function (o) { return o.id === agent.operator_id; });
      if (op) {
        createInboxItem(op.id, 'approval_' + status, 'approval', String(approval.id), content, approval.project_id || approval.project || 'mycelium');
      }
    }
  } catch (e) {
    console.error('[approvals] notify failed:', e.message);
  }
}

export function registerApprovalRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkProjectScope,
    emitEvent, getAdminDisplayName, parseLimit, parseIntParam,
  } = deps;

  // =============== APPROVALS ===============

  // Request approval for a gated action
  router.post('/approvals', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var actionType = req.body.action_type;
    if (!actionType || GATED_ACTIONS.indexOf(actionType) === -1) {
      return res.status(400).json({ error: 'action_type must be one of: ' + GATED_ACTIONS.join(', ') });
    }
    var title = req.body.title;
    if (!title) return res.status(400).json({ error: 'title is required' });
    var payload = req.body.payload;
    if (!payload) return res.status(400).json({ error: 'payload is required' });
    var project = req.body.project || 'mycelium';
    var riskTier = req.body.risk_tier;
    var requiredApprovals = req.body.required_approvals;
    var id = createApproval(actionType, who, title, payload, project, riskTier, requiredApprovals);
    emitEvent('approval_requested', who, project,
      who + ' requested approval: [' + actionType + '] ' + title, JSON.stringify({ approval_id: id, action_type: actionType }));
    dispatchWebhook('approval_requested', who, { approval_id: id, action_type: actionType, title: title, risk_tier: riskTier, requested_by: who });
    // Route approval to operator inbox
    var approvalPriority = (riskTier === 'critical' || riskTier === 'high') ? 'urgent' : 'normal';
    createInboxItemForAllOperators('approval', 'approval', String(id),
      '[' + actionType + '] ' + title,
      'Requested by ' + who + (riskTier ? ' · ' + riskTier + ' risk' : ''),
      { approval_id: id, action_type: actionType, requested_by: who, risk_tier: riskTier || 'medium' },
      approvalPriority);

    // In autonomous mode, queue high/critical approvals for morning instead of blocking
    var effectiveRiskTier = riskTier || 'medium';
    if (isNetworkAutonomous() && (effectiveRiskTier === 'high' || effectiveRiskTier === 'critical')) {
      var sleepConfig = getSleepMode();
      if (sleepConfig.active && sleepConfig.approval_policy === 'queue_high') {
        appendSleepLog('approvals_queued', { id: id, action_type: actionType, title: title, requested_by: who, time: new Date().toISOString() });
        return res.json({ id: id, status: 'queued_for_morning', queued: true, message: 'Queued for operator review — all operators are away. Continue with other work.' });
      }
    }

    res.json({ id: id, status: 'pending', approval_required: true });
  }));

  // List approvals
  router.get('/approvals', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      status: req.query.status || undefined,
      action_type: req.query.action_type || undefined,
      requested_by: req.query.requested_by || undefined,
      // listApprovals reads filters.project_id (db.js); accept either query key
      project_id: req.query.project_id || req.query.project || undefined,
      limit: parseLimit(req.query.limit, 50)
    };
    var approvals = listApprovals(filters);
    approvals.forEach(function (a) { try { a.payload = JSON.parse(a.payload); } catch (e) { console.warn('[mycelium] JSON parse failed for approval.payload (id: ' + a.id + '):', e.message); } });
    res.json(approvals);
  }));

  // Get single approval
  router.get('/approvals/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var approval = getApproval(parseIntParam(req.params.id));
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    try { approval.payload = JSON.parse(approval.payload); } catch (e) { console.warn('[mycelium] JSON parse failed for approval.payload (id: ' + approval.id + '):', e.message); }
    res.json(approval);
  }));

  // Approve or deny (admin only)
  router.put('/approvals/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var approval = getApproval(parseIntParam(req.params.id));
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (!checkProjectScope(req, res, approval.project_id || approval.project)) return;
    if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval already ' + approval.status });
    var newStatus = req.body.status;
    if (newStatus !== 'approved' && newStatus !== 'denied') {
      return res.status(400).json({ error: 'status must be approved or denied' });
    }
    var reason = req.body.reason || '';
    var decidedBy = getAdminDisplayName(req);
    decideApproval(approval.id, newStatus, decidedBy, reason);
    emitEvent('approval_' + newStatus, decidedBy, approval.project,
      decidedBy + ' ' + newStatus + ' [' + approval.action_type + '] ' + approval.title,
      JSON.stringify({ approval_id: approval.id, action_type: approval.action_type }));
    // Notify requesting agent: message + inbox item
    notifyApprovalDecision(approval, newStatus, decidedBy, reason);
    res.json({ ok: true, id: approval.id, status: newStatus });
  }));

  // Mark approved action as executed
  router.put('/approvals/:id/executed', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var approval = getApproval(parseIntParam(req.params.id));
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'approved') return res.status(400).json({ error: 'Approval is ' + approval.status + ', not approved' });
    markApprovalExecuted(approval.id);
    emitEvent('approval_executed', who, approval.project,
      who + ' executed [' + approval.action_type + '] ' + approval.title,
      JSON.stringify({ approval_id: approval.id }));
    res.json({ ok: true, id: approval.id, status: 'executed' });
  }));

  // Vote on an approval (quorum-based)
  router.put('/approvals/:id/vote', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = req.headers['x-admin-key'] ? '__admin__' : 'studio_user';
    var approval = getApproval(parseIntParam(req.params.id));
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval is already ' + approval.status });

    var vote = req.body.vote || 'approve';
    var notes = req.body.notes || '';
    if (vote !== 'approve' && vote !== 'deny') return res.status(400).json({ error: 'vote must be approve or deny' });

    // Any single deny = instant denial
    if (vote === 'deny') {
      castApprovalVote(approval.id, who, 'deny', notes);
      decideApproval(approval.id, 'denied', who, notes || 'Denied by ' + who);
      emitEvent('approval_denied', who, approval.project_id, who + ' denied approval #' + approval.id + ': ' + approval.title,
        JSON.stringify({ approval_id: approval.id, action_type: approval.action_type }));
      notifyApprovalDecision(approval, 'denied', who, notes);
      return res.json({ ok: true, status: 'denied', message: 'Approval denied.' });
    }

    // Cast approve vote
    castApprovalVote(approval.id, who, 'approve', notes);
    var counts = countApprovalVotes(approval.id);

    // Check if quorum reached
    if (counts.approves >= approval.required_approvals) {
      decideApproval(approval.id, 'approved', who, 'Quorum reached (' + counts.approves + '/' + approval.required_approvals + ')');
      emitEvent('approval_approved', who, approval.project_id, who + ' approved #' + approval.id + ': ' + approval.title + ' (quorum reached)',
        JSON.stringify({ approval_id: approval.id, action_type: approval.action_type }));
      notifyApprovalDecision(approval, 'approved', who, 'Quorum reached');
      return res.json({ ok: true, status: 'approved', votes: counts, message: 'Quorum reached. Approval granted.' });
    }

    emitEvent('approval_vote', who, null, who + ' voted approve on #' + approval.id + ' (' + counts.approves + '/' + approval.required_approvals + ')');
    res.json({ ok: true, status: 'pending', votes: counts, remaining: approval.required_approvals - counts.approves });
  }));

  router.get('/approvals/:id/votes', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(getApprovalVotes(parseIntParam(req.params.id)));
  }));
}
