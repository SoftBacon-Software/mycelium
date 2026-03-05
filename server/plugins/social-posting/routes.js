import { Router } from 'express';
import createSocialDB from './db.js';
import { createDroneJob, getDroneJob } from '../../db.js';

var POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'];

var WORKER_REPO = 'https://github.com/SoftBacon-Software/wsac-agent';

// Default system prompt for caption generation — override via plugin config (caption_persona)
var DEFAULT_CAPTION_PROMPT =
  'You are the voice of this project on social media. ' +
  'Write a short social media caption (2-4 lines) for a highlight clip. ' +
  'Be witty, concise, and in-character. Never use generic marketing language. ' +
  'Do not include hashtags — those will be added separately.';

var HASHTAGS = {
  tiktok: '\n#indiegame #indiedev #gaming',
  instagram: '\n#indiegame #indiedev #gaming',
  twitter: '',
  youtube_shorts: '\n#indiegame #shorts'
};

var PLATFORM_NOTES = {
  tiktok: 'TikTok: Keep it punchy, 2-3 lines max. Hook in first line.',
  instagram: 'Instagram Reels: 2-4 lines. Can be slightly longer. Emotional hooks work.',
  twitter: 'X/Twitter: Conversational, 1-2 sentences. No hashtags. Can be dry/deadpan.',
  youtube_shorts: 'YouTube Shorts: 1-2 lines, engaging. Include a hook.'
};

// Posting schedule defaults (hour:minute in local time)
var DEFAULT_WINDOWS = {
  tiktok: '19:00',
  instagram: '12:00',
  twitter: '10:00',
  youtube_shorts: '17:00'
};

function getConfigValue(core, key) {
  try {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'social-posting' AND key = ?").get(key);
    return row ? row.value : null;
  } catch (e) { return null; }
}

export default function (core) {
  var router = Router();
  var db = createSocialDB(core.db);
  // Use shared helpers from core — single source of truth for error format.
  var { apiError, parseIntParam, validateEnum } = core;

  // ── Account Management ──

  // POST /accounts — Register a social media account
  router.post('/accounts', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    var { project_id, platform, account_name, credentials, config } = req.body;
    if (!project_id || !platform) return apiError(res, 400, 'project_id and platform required');
    var id = db.createAccount(project_id, platform, account_name, credentials, config);
    res.json({ ok: true, id: id });
  });

  // GET /accounts — List accounts
  router.get('/accounts', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    var accounts = db.listAccounts(req.query.project_id);
    // Redact credentials in listing
    res.json(accounts.map(function (a) {
      var safe = Object.assign({}, a);
      safe.credentials = '***';
      return safe;
    }));
  });

  // PUT /accounts/:id — Update account
  router.put('/accounts/:id', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    db.updateAccount(id, req.body);
    res.json({ ok: true });
  });

  // DELETE /accounts/:id — Delete account
  router.delete('/accounts/:id', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    db.deleteAccount(id);
    res.json({ ok: true });
  });

  // ── Caption Generation (in-process, returns prompt for Claude API) ──

  // POST /captions/generate — Build a character-voiced caption prompt
  router.post('/captions/generate', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var { event_type, metadata, platform } = req.body;
    if (!event_type || !platform) return apiError(res, 400, 'event_type and platform required');

    var metaStr = Object.entries(metadata || {}).map(function (e) { return e[0] + ': ' + e[1]; }).join(', ');
    var prompt = 'Write a caption for a ' + event_type + ' highlight clip.\n' +
      'Event metadata: ' + metaStr + '\n' +
      'Platform: ' + (PLATFORM_NOTES[platform] || platform) + '\n';

    var suffix = HASHTAGS[platform] || '';

    res.json({
      ok: true,
      system_prompt: getConfigValue(core, 'caption_persona') || DEFAULT_CAPTION_PROMPT,
      user_prompt: prompt,
      hashtag_suffix: suffix,
      instructions: 'Send system_prompt + user_prompt to Claude API (sonnet, 256 tokens). Append hashtag_suffix to result.'
    });
  });

  // ── Post Queue Management ──

  // POST /posts — Create a post (draft or scheduled)
  router.post('/posts', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var fields = req.body;
    if (!fields.project_id || !fields.platform) return apiError(res, 400, 'project_id and platform required');
    fields.created_by = who;
    var id = db.createPost(fields);
    core.emitEvent('social_post_created', who, fields.project_id,
      'Created ' + fields.platform + ' post: ' + (fields.caption || '').slice(0, 50), { post_id: id });
    res.json({ ok: true, id: id });
  });

  // GET /posts — List posts
  router.get('/posts', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listPosts({
      project_id: req.query.project_id,
      platform: req.query.platform,
      status: req.query.status,
      video_session_id: req.query.video_session_id ? parseInt(req.query.video_session_id) : undefined,
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /posts/:id — Get post
  router.get('/posts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var post = db.getPost(parseIntParam(req.params.id));
    if (!post) return apiError(res, 404, 'Post not found');
    if (post.drone_job_id) {
      var job = getDroneJob(post.drone_job_id);
      if (job) post.drone_job = { id: job.id, status: job.status, error: job.error };
    }
    res.json(post);
  });

  // PUT /posts/:id — Update post
  router.put('/posts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    if (!validateEnum(res, req.body.status, POST_STATUSES, 'status')) return;
    db.updatePost(id, req.body);
    res.json({ ok: true });
  });

  // DELETE /posts/:id — Delete post
  router.delete('/posts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    db.deletePost(id);
    res.json({ ok: true });
  });

  // ── Scheduling ──

  // GET /schedule — Get scheduled posts queue
  router.get('/schedule', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.getScheduledPosts(req.query.platform));
  });

  // POST /posts/:id/schedule — Schedule a draft post
  router.post('/posts/:id/schedule', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var post = db.getPost(parseIntParam(req.params.id));
    if (!post) return apiError(res, 404, 'Post not found');
    if (post.status !== 'draft') return apiError(res, 400, 'Only draft posts can be scheduled');

    var scheduledAt = req.body.scheduled_at;
    if (!scheduledAt) {
      // Auto-schedule: next available window for this platform
      var window = DEFAULT_WINDOWS[post.platform] || '19:00';
      var parts = window.split(':');
      var target = new Date();
      target.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
      if (target <= new Date()) target.setDate(target.getDate() + 1);
      scheduledAt = target.toISOString();
    }

    db.updatePost(post.id, { status: 'scheduled', scheduled_at: scheduledAt });
    core.emitEvent('social_post_scheduled', who, post.project_id,
      'Scheduled ' + post.platform + ' post for ' + scheduledAt, { post_id: post.id });
    res.json({ ok: true, scheduled_at: scheduledAt });
  });

  // ── Publishing (drone job — handles file upload + API calls) ──

  // POST /posts/:id/publish — Submit a publishing drone job
  router.post('/posts/:id/publish', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var post = db.getPost(parseIntParam(req.params.id));
    if (!post) return apiError(res, 404, 'Post not found');
    if (!post.caption) return apiError(res, 400, 'Post has no caption');
    if (!post.media_url) return apiError(res, 400, 'Post has no media_url');

    // Check approval gate for publishing
    var gate = core.checkApprovalGate(req, who, 'social_publish');
    if (gate && !gate.ok) {
      var gateMsg = gate.soft
        ? 'Social publishing requires approval. Use mycelium_request_approval with action_type=social_publish first.'
        : (gate.error || 'Publishing not permitted');
      return apiError(res, 403, gateMsg, { approval_required: true });
    }

    // Get account credentials
    var account = post.account_id ? db.getAccount(post.account_id) : null;
    var creds = account ? JSON.parse(account.credentials) : {};

    var jobId = createDroneJob(
      'Social post: ' + post.platform + ' — ' + (post.caption || '').slice(0, 40),
      'python -c "' +
        'import json, os, sys; ' +
        'data = json.loads(os.environ[\'MYCELIUM_JOB_INPUT\']); ' +
        'platform = data[\'platform\']; ' +
        (post.platform === 'instagram'
          ? 'from post.instagram_client import InstagramClient; ' +
            'client = InstagramClient(data[\'credentials\'][\'access_token\'], data[\'credentials\'][\'ig_user_id\']); ' +
            'ok = client.schedule_post(platform, data[\'caption\'], data[\'media_url\'], data.get(\'scheduled_at\', \'\')); '
          : 'from post.buffer_client import BufferClient; ' +
            'client = BufferClient(data[\'credentials\'][\'token\'], data[\'credentials\'][\'profile_ids\']); ' +
            'ok = client.schedule_post(platform, data[\'caption\'], data[\'media_url\'], data.get(\'scheduled_at\', \'\')); ') +
        'print(json.dumps({\'ok\': ok}))"',
      {
        post_id: post.id,
        platform: post.platform,
        caption: post.caption,
        media_url: post.media_url,
        scheduled_at: post.scheduled_at || '',
        credentials: creds,
        callback_url: '/api/mycelium/social/posts/' + post.id
      },
      ['cpu'],
      who,
      req.body.priority || 3,
      WORKER_REPO,
      'master'
    );

    db.updatePost(post.id, { status: 'publishing', drone_job_id: jobId });
    core.emitEvent('social_post_publishing', who, post.project_id,
      'Publishing to ' + post.platform, { post_id: post.id, job_id: jobId });
    res.json({ ok: true, job_id: jobId });
  });

  // ── Stats ──

  // GET /stats — Post stats by platform/status
  router.get('/stats', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var projectId = req.query.project_id || '';
    res.json(db.getPostStats(projectId));
  });

  // GET /history — Recent post history
  router.get('/history', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var projectId = req.query.project_id || '';
    res.json(db.getPostHistory(projectId, req.query.platform, parseInt(req.query.days) || 7));
  });

  return router;
}
