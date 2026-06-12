// Outreach plugin routes — receives core context, returns Express Router
import { Router } from 'express';
import createOutreachDB from './db.js';

var CAMPAIGN_STATUSES = ['active', 'paused', 'completed'];
var CONTACT_STATUSES = ['discovered', 'researched', 'draft_ready', 'approved', 'sent', 'followed_up', 'replied', 'covered', 'closed'];

export default function (core) {
  var router = Router();
  var db = createOutreachDB(core.db);
  // Use shared helpers from core — single source of truth for error format.
  var { apiError, parseIntParam, validateEnum } = core;

  // -- Campaigns --
  router.get('/campaigns', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listCampaigns({ project_id: req.query.project_id, status: req.query.status }));
  });

  router.post('/campaigns', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var b = req.body;
    if (!b.project_id && !b.project) return apiError(res, 400, 'project_id and name required');
    var projectId = b.project_id || b.project;
    if (!b.name) return apiError(res, 400, 'project_id and name required');
    var id = db.createCampaign(projectId, b.name, b.persona_prompt, b.project_facts,
      typeof b.templates === 'string' ? b.templates : JSON.stringify(b.templates || {}),
      typeof b.config === 'string' ? b.config : JSON.stringify(b.config || {}), who);
    core.emitEvent('outreach_campaign_created', who, projectId, who + ' created outreach campaign: ' + b.name, { campaign_id: id });
    res.json({ id: id, name: b.name });
  });

  router.put('/campaigns/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var campaign = db.getCampaign(parseIntParam(req.params.id));
    if (!campaign) return apiError(res, 404, 'Campaign not found');
    if (!validateEnum(res, req.body.status, CAMPAIGN_STATUSES, 'status')) return;
    var fields = {};
    for (var k of ['name', 'persona_prompt', 'project_facts', 'status']) {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    }
    if (req.body.templates !== undefined) fields.templates = typeof req.body.templates === 'string' ? req.body.templates : JSON.stringify(req.body.templates);
    if (req.body.config !== undefined) fields.config = typeof req.body.config === 'string' ? req.body.config : JSON.stringify(req.body.config);
    db.updateCampaign(campaign.id, fields);
    res.json({ ok: true, id: campaign.id });
  });

  // -- Contacts --
  router.get('/contacts', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listContacts({
      project_id: req.query.project_id,
      status: req.query.status,
      type: req.query.type,
      campaign_id: req.query.campaign_id ? parseInt(req.query.campaign_id) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit) : 50,
      offset: req.query.offset ? parseInt(req.query.offset) : 0
    }));
  });

  router.post('/contacts', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var b = req.body;
    var projectId = b.project_id || b.project;
    if (!projectId || !b.name) return apiError(res, 400, 'project_id and name required');
    if (b.email) {
      var existing = db.findContactByEmail(projectId, b.email);
      if (existing) return apiError(res, 409, 'Contact with this email already exists', { existing_id: existing.id });
    }
    var id = db.createContact({ ...b, project_id: projectId, created_by: who, metadata: b.metadata ? (typeof b.metadata === 'string' ? b.metadata : JSON.stringify(b.metadata)) : '{}' });
    core.emitEvent('outreach_contact_created', who, projectId, who + ' added outreach contact: ' + b.name, { contact_id: id });
    res.json({ id: id });
  });

  router.put('/contacts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');
    if (!validateEnum(res, req.body.status, CONTACT_STATUSES, 'status')) return;
    var b = req.body;
    if (b.metadata && typeof b.metadata !== 'string') b.metadata = JSON.stringify(b.metadata);
    db.updateContact(contact.id, b);
    core.emitEvent('outreach_contact_updated', who, contact.project_id, who + ' updated contact #' + contact.id + (b.status ? ' to ' + b.status : ''), { contact_id: contact.id });
    res.json({ ok: true, id: contact.id });
  });

  router.delete('/contacts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');
    db.deleteContact(contact.id);
    res.json({ ok: true, deleted: contact.id });
  });

  // -- Pipeline actions --

  // Discover contacts (YouTube creators + Hunter.io press)
  router.post('/discover', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var campaignId = req.body.campaign_id;
    if (!campaignId) return apiError(res, 400, 'campaign_id required');
    var campaign = db.getCampaign(campaignId);
    if (!campaign) return apiError(res, 404, 'Campaign not found');

    try {
      var config = JSON.parse(campaign.config || '{}');
      var { discoverCreators, discoverPress } = await import('./lib/discoverer.js');

      var findExisting = function (key) {
        var contacts = db.listContacts({ project_id: campaign.project_id, limit: 1000 });
        return contacts.some(function (c) { return c.notes === key || c.email === key; });
      };

      var creators = [];
      if (config.youtube_api_key && config.queries) {
        creators = await discoverCreators(config, findExisting);
      }

      var press = [];
      if (config.hunter_api_key && config.press_targets) {
        press = await discoverPress(config, findExisting);
      }

      var created = 0;
      for (var contact of [...creators, ...press]) {
        db.createContact({ ...contact, project_id: campaign.project_id, campaign_id: campaignId, created_by: who });
        created++;
      }

      core.emitEvent('outreach_discover', who, campaign.project_id,
        who + ' discovered ' + created + ' contacts (' + creators.length + ' creators, ' + press.length + ' press)', { campaign_id: campaignId });
      res.json({ ok: true, creators: creators.length, press: press.length, total: created });
    } catch (e) {
      apiError(res, 500, 'Discovery failed: ' + e.message);
    }
  });

  // Research a contact (fetch latest content)
  router.post('/research/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      var config = campaign ? JSON.parse(campaign.config || '{}') : {};
      var { researchCreator, researchPress } = await import('./lib/researcher.js');

      var updates = contact.type === 'creator'
        ? await researchCreator(contact, config.youtube_api_key)
        : await researchPress(contact);

      updates.status = 'researched';
      db.updateContact(contact.id, updates);
      res.json({ ok: true, id: contact.id, updates: updates });
    } catch (e) {
      apiError(res, 500, 'Research failed: ' + e.message);
    }
  });

  // Personalize pitch for a contact (Claude-generated)
  router.post('/personalize/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      if (!campaign) return apiError(res, 400, 'Contact has no campaign — cannot personalize');
      var config = JSON.parse(campaign.config || '{}');
      var apiKey = config.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return apiError(res, 400, 'anthropic_api_key required in campaign config or ANTHROPIC_API_KEY env');

      var { personalize } = await import('./lib/personalizer.js');
      var result = await personalize(contact, campaign, apiKey);

      db.updateContact(contact.id, {
        pitch_subject: result.pitch_subject,
        pitch_body: result.pitch_body,
        status: 'draft_ready'
      });

      res.json({ ok: true, id: contact.id, subject: result.pitch_subject, body_preview: (result.pitch_body || '').substring(0, 200) });
    } catch (e) {
      apiError(res, 500, 'Personalization failed: ' + e.message);
    }
  });

  // Approve a pitch draft
  router.put('/approve/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');
    if (contact.status !== 'draft_ready') return apiError(res, 400, 'Contact status must be draft_ready, got ' + contact.status);

    var fields = { status: 'approved' };
    if (req.body.pitch_subject) fields.pitch_subject = req.body.pitch_subject;
    if (req.body.pitch_body) fields.pitch_body = req.body.pitch_body;
    db.updateContact(contact.id, fields);
    res.json({ ok: true, id: contact.id, status: 'approved' });
  });

  // Send approved pitch via Gmail
  router.post('/send/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');
    if (contact.status !== 'approved') return apiError(res, 400, 'Contact must be approved before sending');
    if (!contact.email) return apiError(res, 400, 'Contact has no email address');

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      var config = campaign ? JSON.parse(campaign.config || '{}') : {};

      var dryRun = config.dry_run !== undefined ? config.dry_run : true;
      if (req.body.dry_run !== undefined) dryRun = req.body.dry_run;

      // Hard gate: agents cannot send real emails without approval
      if (!dryRun) {
        var gate = core.checkApprovalGate(req, who, 'outreach_send');
        if (!gate.ok && !gate.soft) return apiError(res, 403, gate.error, { approval_required: true });
        if (!gate.ok && gate.soft) return apiError(res, 403, 'Real email sending requires approval. Use mycelium_request_approval with action_type=outreach_send first.', { approval_required: true });
      }

      if (dryRun) {
        db.updateContact(contact.id, {
          status: 'sent',
          pitch_sent_at: new Date().toISOString(),
          followup_due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
        });
        return res.json({ ok: true, id: contact.id, dry_run: true, would_send_to: contact.email });
      }

      var { sendEmail } = await import('./lib/mailer.js');
      var msgId = await sendEmail(config, contact.email, contact.pitch_subject, contact.pitch_body, config.sender_email);

      db.updateContact(contact.id, {
        status: 'sent',
        pitch_sent_at: new Date().toISOString(),
        followup_due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
      });

      core.emitEvent('outreach_pitch_sent', who, contact.project_id, who + ' sent pitch to ' + contact.name, { contact_id: contact.id, gmail_id: msgId });
      res.json({ ok: true, id: contact.id, gmail_id: msgId });
    } catch (e) {
      apiError(res, 500, 'Send failed: ' + e.message);
    }
  });

  // Send follow-up email
  router.post('/followup/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseIntParam(req.params.id));
    if (!contact) return apiError(res, 404, 'Contact not found');
    if (contact.status !== 'sent') return apiError(res, 400, 'Contact must be in sent status for follow-up');

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      var config = campaign ? JSON.parse(campaign.config || '{}') : {};
      var templates = {};
      try { templates = JSON.parse(campaign.templates || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for campaign.templates (campaign: ' + (campaign && campaign.id) + '):', e.message); }

      var followupTemplate = templates.followup || { subject: 'Re: ' + contact.pitch_subject, body: '' };
      var firstName = contact.name ? contact.name.split(' ')[0] : '';
      var subject = followupTemplate.subject.replace('{original_subject}', contact.pitch_subject);
      var body = followupTemplate.body
        .replace('{first_name}', firstName)
        .replace('{sender_name}', config.sender_name || '');

      var dryRun = config.dry_run !== undefined ? config.dry_run : true;
      if (req.body.dry_run !== undefined) dryRun = req.body.dry_run;

      if (!dryRun) {
        var gate = core.checkApprovalGate(req, who, 'outreach_send');
        if (!gate.ok && !gate.soft) return apiError(res, 403, gate.error, { approval_required: true });
        if (!gate.ok && gate.soft) return apiError(res, 403, 'Real email sending requires approval. Use mycelium_request_approval with action_type=outreach_send first.', { approval_required: true });
      }

      if (!dryRun && contact.email) {
        var { sendEmail } = await import('./lib/mailer.js');
        await sendEmail(config, contact.email, subject, body, config.sender_email);
      }

      db.updateContact(contact.id, {
        status: 'followed_up',
        followup_sent_at: new Date().toISOString()
      });

      res.json({ ok: true, id: contact.id, dry_run: dryRun, status: 'followed_up' });
    } catch (e) {
      apiError(res, 500, 'Follow-up failed: ' + e.message);
    }
  });

  // -- Status summary --
  router.get('/status', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var project = req.query.project_id;
    if (!project) return apiError(res, 400, 'project_id query param required');
    var counts = db.countContacts(project);
    var campaigns = db.listCampaigns({ project_id: project, status: 'active' });
    res.json({ project: project, contact_counts: counts, active_campaigns: campaigns.length });
  });

  return router;
}
