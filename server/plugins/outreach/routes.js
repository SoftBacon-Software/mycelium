// Outreach plugin routes — receives core context, returns Express Router
import { Router } from 'express';
import createOutreachDB from './db.js';

export default function (core) {
  var router = Router();
  var db = createOutreachDB(core.db);

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
    if (!b.project_id && !b.project) return res.status(400).json({ error: 'project_id and name required' });
    var projectId = b.project_id || b.project;
    if (!b.name) return res.status(400).json({ error: 'project_id and name required' });
    var id = db.createCampaign(projectId, b.name, b.persona_prompt, b.project_facts,
      typeof b.templates === 'string' ? b.templates : JSON.stringify(b.templates || {}),
      typeof b.config === 'string' ? b.config : JSON.stringify(b.config || {}), who);
    core.emitEvent('outreach_campaign_created', who, projectId, who + ' created outreach campaign: ' + b.name, { campaign_id: id });
    res.json({ id: id, name: b.name });
  });

  router.put('/campaigns/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var campaign = db.getCampaign(parseInt(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
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
    if (!projectId || !b.name) return res.status(400).json({ error: 'project_id and name required' });
    if (b.email) {
      var existing = db.findContactByEmail(projectId, b.email);
      if (existing) return res.status(409).json({ error: 'Contact with this email already exists', existing_id: existing.id });
    }
    var id = db.createContact({ ...b, project_id: projectId, created_by: who, metadata: b.metadata ? (typeof b.metadata === 'string' ? b.metadata : JSON.stringify(b.metadata)) : '{}' });
    core.emitEvent('outreach_contact_created', who, projectId, who + ' added outreach contact: ' + b.name, { contact_id: id });
    res.json({ id: id });
  });

  router.put('/contacts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    var b = req.body;
    if (b.metadata && typeof b.metadata !== 'string') b.metadata = JSON.stringify(b.metadata);
    db.updateContact(contact.id, b);
    core.emitEvent('outreach_contact_updated', who, contact.project_id, who + ' updated contact #' + contact.id + (b.status ? ' to ' + b.status : ''), { contact_id: contact.id });
    res.json({ ok: true, id: contact.id });
  });

  router.delete('/contacts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    db.deleteContact(contact.id);
    res.json({ ok: true, deleted: contact.id });
  });

  // -- Pipeline actions --

  // Discover contacts (YouTube creators + Hunter.io press)
  router.post('/discover', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var campaignId = req.body.campaign_id;
    if (!campaignId) return res.status(400).json({ error: 'campaign_id required' });
    var campaign = db.getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

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
      res.status(500).json({ error: 'Discovery failed: ' + e.message });
    }
  });

  // Research a contact (fetch latest content)
  router.post('/research/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

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
      res.status(500).json({ error: 'Research failed: ' + e.message });
    }
  });

  // Personalize pitch for a contact (Claude-generated)
  router.post('/personalize/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      if (!campaign) return res.status(400).json({ error: 'Contact has no campaign — cannot personalize' });
      var config = JSON.parse(campaign.config || '{}');
      var apiKey = config.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(400).json({ error: 'anthropic_api_key required in campaign config or ANTHROPIC_API_KEY env' });

      var { personalize } = await import('./lib/personalizer.js');
      var result = await personalize(contact, campaign, apiKey);

      db.updateContact(contact.id, {
        pitch_subject: result.pitch_subject,
        pitch_body: result.pitch_body,
        status: 'draft_ready'
      });

      res.json({ ok: true, id: contact.id, subject: result.pitch_subject, body_preview: (result.pitch_body || '').substring(0, 200) });
    } catch (e) {
      res.status(500).json({ error: 'Personalization failed: ' + e.message });
    }
  });

  // Approve a pitch draft
  router.put('/approve/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.status !== 'draft_ready') return res.status(400).json({ error: 'Contact status must be draft_ready, got ' + contact.status });

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
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.status !== 'approved') return res.status(400).json({ error: 'Contact must be approved before sending' });
    if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      var config = campaign ? JSON.parse(campaign.config || '{}') : {};

      var dryRun = config.dry_run !== undefined ? config.dry_run : true;
      if (req.body.dry_run !== undefined) dryRun = req.body.dry_run;

      // Hard gate: agents cannot send real emails without approval
      if (!dryRun) {
        var gate = core.checkApprovalGate(req, who, 'outreach_send');
        if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
        if (!gate.ok && gate.soft) return res.status(403).json({ error: 'Real email sending requires approval. Use studio_request_approval with action_type=outreach_send first.', approval_required: true });
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
      res.status(500).json({ error: 'Send failed: ' + e.message });
    }
  });

  // Send follow-up email
  router.post('/followup/:id', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var contact = db.getContact(parseInt(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.status !== 'sent') return res.status(400).json({ error: 'Contact must be in sent status for follow-up' });

    try {
      var campaign = contact.campaign_id ? db.getCampaign(contact.campaign_id) : null;
      var config = campaign ? JSON.parse(campaign.config || '{}') : {};
      var templates = {};
      try { templates = JSON.parse(campaign.templates || '{}'); } catch (e) { /* */ }

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
        if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
        if (!gate.ok && gate.soft) return res.status(403).json({ error: 'Real email sending requires approval. Use studio_request_approval with action_type=outreach_send first.', approval_required: true });
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
      res.status(500).json({ error: 'Follow-up failed: ' + e.message });
    }
  });

  // -- Status summary --
  router.get('/status', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var project = req.query.project_id;
    if (!project) return res.status(400).json({ error: 'project_id query param required' });
    var counts = db.countContacts(project);
    var campaigns = db.listCampaigns({ project_id: project, status: 'active' });
    res.json({ project: project, contact_counts: counts, active_campaigns: campaigns.length });
  });

  return router;
}
