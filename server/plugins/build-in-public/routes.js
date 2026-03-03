// Build-in-Public plugin routes
// Manage social content drafts: list, edit, approve/reject.

import { Router } from 'express';
import createBipDB from './db.js';

var DRAFT_STATUSES = ['pending', 'approved', 'rejected', 'published', 'skipped'];

export default function (core) {
  var router = Router();
  var db = createBipDB(core.db);
  var { apiError, parseIntParam, checkApprovalGate } = core;
  var { checkAgentOrAdmin, checkAdmin } = core.auth;

  // GET /bip/drafts — list drafts
  router.get('/drafts', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listDrafts({
      status: req.query.status || undefined,
      trigger_event: req.query.trigger_event || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  // GET /bip/drafts/:id — get single draft
  router.get('/drafts/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var draft = db.getDraft(parseIntParam(req.params.id));
    if (!draft) return apiError(res, 404, 'Draft not found');
    res.json(draft);
  });

  // PUT /bip/drafts/:id — edit draft content/title/platforms
  router.put('/drafts/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.getDraft(id)) return apiError(res, 404, 'Draft not found');
    var updates = {};
    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.content !== undefined) updates.content = req.body.content;
    if (req.body.platforms !== undefined) updates.platforms = req.body.platforms;
    db.updateDraft(id, updates);
    res.json({ ok: true, draft: db.getDraft(id) });
  });

  // POST /bip/drafts/:id/approve — approve draft (routes to social-posting for publishing)
  router.post('/drafts/:id/approve', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var draft = db.getDraft(parseIntParam(req.params.id));
    if (!draft) return apiError(res, 404, 'Draft not found');
    if (draft.status !== 'pending') return apiError(res, 400, 'Draft is ' + draft.status + ', not pending');

    // Check approval gate
    var gate = checkApprovalGate(req, who, 'bip_post_publish');
    if (gate && !gate.ok) {
      return apiError(res, 403, gate.error || 'Publishing requires approval', { approval_required: true });
    }

    db.updateDraft(draft.id, { status: 'approved' });

    // Mark linked inbox items as actioned
    if (Array.isArray(draft.inbox_item_id)) {
      for (var inboxId of draft.inbox_item_id) {
        try { core.db.prepare("UPDATE dv_operator_inbox SET status = 'actioned' WHERE id = ?").run(inboxId); } catch (e) {}
      }
    }

    core.emitEvent('bip_draft_approved', who, null,
      who + ' approved BIP draft #' + draft.id + ': ' + draft.title,
      { draft_id: draft.id, title: draft.title });

    // Hand off to social-posting plugin if available
    var socialPlugin = core.db.prepare("SELECT enabled FROM dv_plugins WHERE name = 'social-posting'").get();
    if (socialPlugin && socialPlugin.enabled) {
      res.json({
        ok: true,
        draft_id: draft.id,
        status: 'approved',
        next_step: 'Use social-posting plugin to publish (POST /social/posts then /publish)',
        content: draft.content,
        platforms: draft.platforms
      });
    } else {
      res.json({ ok: true, draft_id: draft.id, status: 'approved', content: draft.content, platforms: draft.platforms });
    }
  });

  // POST /bip/drafts/:id/reject — reject draft
  router.post('/drafts/:id/reject', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var draft = db.getDraft(parseIntParam(req.params.id));
    if (!draft) return apiError(res, 404, 'Draft not found');
    if (draft.status !== 'pending') return apiError(res, 400, 'Draft is ' + draft.status + ', not pending');

    db.updateDraft(draft.id, {
      status: 'rejected',
      rejection_note: req.body.note || ''
    });

    // Mark linked inbox items as actioned
    if (Array.isArray(draft.inbox_item_id)) {
      for (var inboxId of draft.inbox_item_id) {
        try { core.db.prepare("UPDATE dv_operator_inbox SET status = 'actioned' WHERE id = ?").run(inboxId); } catch (e) {}
      }
    }

    core.emitEvent('bip_draft_rejected', who, null,
      who + ' rejected BIP draft #' + draft.id + ': ' + draft.title,
      { draft_id: draft.id, title: draft.title, note: req.body.note || '' });

    res.json({ ok: true, draft_id: draft.id, status: 'rejected' });
  });

  // DELETE /bip/drafts/:id — delete draft
  router.delete('/drafts/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.getDraft(id)) return apiError(res, 404, 'Draft not found');
    db.deleteDraft(id);
    res.json({ ok: true });
  });

  // GET /bip/stats — draft counts by status
  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.countByStatus());
  });

  return router;
}
