import { Router } from 'express';
import createVideoDB from './db.js';
import { createDroneJob, getDroneJob } from '../../db.js';

var SESSION_STATUSES = ['pending', 'detecting', 'assembling', 'exporting', 'completed', 'failed'];
var CLIP_STATUSES = ['detected', 'assembled', 'exported'];

var WORKER_REPO = 'https://github.com/SoftBacon-Software/wsac-agent';
var WORKER_SETUP = 'pip install anthropic pyyaml requests';

export default function (core) {
  var router = Router();
  var db = createVideoDB(core.db);
  // Use shared helpers from core — single source of truth for error format.
  var { apiError, parseIntParam, validateEnum } = core;

  // ── Session CRUD ──

  // POST / — Create a new video processing session
  router.post('/sessions', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var { project_id, title, footage_url, event_log_url, config } = req.body;
    if (!project_id || !title) return apiError(res, 400, 'project_id and title required');
    var id = db.createSession(project_id, title, footage_url, event_log_url, config, who);
    core.emitEvent('video_session_created', who, project_id, 'Created video session: ' + title, { session_id: id });
    res.json({ ok: true, id: id });
  });

  // GET /sessions — List sessions
  router.get('/sessions', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listSessions({ project_id: req.query.project_id, status: req.query.status, limit: parseInt(req.query.limit) || 50 }));
  });

  // GET /sessions/:id — Get session details
  router.get('/sessions/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var session = db.getSession(parseIntParam(req.params.id));
    if (!session) return apiError(res, 404, 'Session not found');
    session.clips = db.listClips(session.id, {});
    session.stats = db.getSessionStats(session.id);
    res.json(session);
  });

  // PUT /sessions/:id — Update session
  router.put('/sessions/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    if (!validateEnum(res, req.body.status, SESSION_STATUSES, 'status')) return;
    db.updateSession(id, req.body);
    res.json({ ok: true });
  });

  // DELETE /sessions/:id — Delete session and clips
  router.delete('/sessions/:id', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    db.deleteSession(id);
    res.json({ ok: true });
  });

  // ── Clips ──

  // GET /sessions/:id/clips — List clips for a session
  router.get('/sessions/:id/clips', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    res.json(db.listClips(id, { tier: req.query.tier, status: req.query.status }));
  });

  // POST /sessions/:id/clips — Bulk add clips (from detection results)
  router.post('/sessions/:id/clips', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    var clips = req.body.clips;
    if (!Array.isArray(clips)) return apiError(res, 400, 'clips array required');
    var count = db.bulkCreateClips(id, clips);
    res.json({ ok: true, count: count });
  });

  // PUT /clips/:id — Update a clip
  router.put('/clips/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    if (!validateEnum(res, req.body.status, CLIP_STATUSES, 'status')) return;
    db.updateClip(id, req.body);
    res.json({ ok: true });
  });

  // ── Pipeline Stages (drone job submission) ──

  // POST /sessions/:id/detect — Submit detection drone job
  router.post('/sessions/:id/detect', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var session = db.getSession(parseIntParam(req.params.id));
    if (!session) return apiError(res, 404, 'Session not found');

    var useVision = req.body.use_vision !== false;
    var jobId = createDroneJob(
      'Video detect: ' + session.title,
      useVision
        ? 'python -c "from detect.vision_detector import *; from detect.event_parser import *; from detect.clip_extractor import *; import json, sys; ' +
          'events = parse_events(\\"$EVENT_LOG\\"); clips = classify_highlights(events); ' +
          'print(json.dumps(clips))"'
        : 'python -c "from detect.event_parser import *; from detect.clip_extractor import *; import json; ' +
          'events = parse_events(\\"$EVENT_LOG\\"); clips = classify_highlights(events); ' +
          'print(json.dumps(clips))"',
      {
        session_id: session.id,
        footage_url: session.footage_url,
        event_log_url: session.event_log_url,
        use_vision: useVision,
        callback_url: '/api/mycelium/video/sessions/' + session.id + '/clips'
      },
      useVision ? ['cpu', 'gpu'] : ['cpu'],
      who,
      req.body.priority || 5,
      WORKER_REPO,
      'master'
    );

    db.updateSession(session.id, { detect_job_id: jobId, status: 'detecting' });
    core.emitEvent('video_detect_started', who, session.project_id,
      'Started detection for session: ' + session.title, { session_id: session.id, job_id: jobId });
    res.json({ ok: true, job_id: jobId });
  });

  // POST /sessions/:id/assemble — Submit assembly drone job
  router.post('/sessions/:id/assemble', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var session = db.getSession(parseIntParam(req.params.id));
    if (!session) return apiError(res, 404, 'Session not found');

    var clips = db.listClips(session.id, { status: 'detected' });
    if (clips.length === 0) return apiError(res, 400, 'No detected clips to assemble');

    var jobId = createDroneJob(
      'Video assemble: ' + session.title + ' (' + clips.length + ' clips)',
      'python -c "from assemble.assembler import *; import json, os; ' +
        'clips = json.loads(os.environ[\'MYCELIUM_JOB_INPUT\'])[\'clips\']; ' +
        'assemble_clips(clips)"',
      {
        session_id: session.id,
        footage_url: session.footage_url,
        clips: clips.map(function (c) { return { clip_id: c.clip_id, tier: c.tier, event_type: c.event_type, start_sec: c.start_sec, end_sec: c.end_sec, metadata: c.metadata }; }),
        tts_url: req.body.tts_url || 'http://127.0.0.1:5099/tts'
      },
      ['cpu'],
      who,
      req.body.priority || 5,
      WORKER_REPO,
      'master'
    );

    db.updateSession(session.id, { assemble_job_id: jobId, status: 'assembling' });
    core.emitEvent('video_assemble_started', who, session.project_id,
      'Started assembly for session: ' + session.title, { session_id: session.id, job_id: jobId });
    res.json({ ok: true, job_id: jobId });
  });

  // POST /sessions/:id/export — Submit export drone job
  router.post('/sessions/:id/export', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var session = db.getSession(parseIntParam(req.params.id));
    if (!session) return apiError(res, 404, 'Session not found');

    var platforms = req.body.platforms || ['tiktok', 'twitter', 'youtube_shorts'];
    var jobId = createDroneJob(
      'Video export: ' + session.title + ' → ' + platforms.join(', '),
      'python -c "from export.exporter import *; import json, os; ' +
        'data = json.loads(os.environ[\'MYCELIUM_JOB_INPUT\']); ' +
        'export_session(data[\'session_id\'], data[\'platforms\'])"',
      {
        session_id: session.id,
        platforms: platforms,
        footage_url: session.footage_url
      },
      ['cpu'],
      who,
      req.body.priority || 5,
      WORKER_REPO,
      'master'
    );

    db.updateSession(session.id, { export_job_id: jobId, status: 'exporting' });
    core.emitEvent('video_export_started', who, session.project_id,
      'Started export for session: ' + session.title, { session_id: session.id, job_id: jobId });
    res.json({ ok: true, job_id: jobId });
  });

  // ── Lightweight In-Process Operations ──

  // POST /sessions/:id/captions — Generate captions for clips (Claude API, runs in-process)
  router.post('/sessions/:id/captions', async function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var session = db.getSession(parseIntParam(req.params.id));
    if (!session) return apiError(res, 404, 'Session not found');

    var clips = db.listClips(session.id, { status: req.body.clip_status || 'detected' });
    var platform = req.body.platform || 'tiktok';

    // Return clip IDs — actual caption generation requires Anthropic SDK key in environment
    // Agents can call this to get clip list, then generate captions via their own Claude access
    var clipData = clips.map(function (c) {
      return {
        id: c.id,
        clip_id: c.clip_id,
        tier: c.tier,
        event_type: c.event_type,
        metadata: c.metadata,
        platform: platform
      };
    });

    res.json({ ok: true, clips: clipData, platform: platform, count: clipData.length });
  });

  // GET /sessions/:id/status — Get session status including drone job progress
  router.get('/sessions/:id/status', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var session = db.getSession(parseIntParam(req.params.id));
    if (!session) return apiError(res, 404, 'Session not found');

    var status = {
      session_id: session.id,
      session_status: session.status,
      stats: db.getSessionStats(session.id)
    };

    if (session.detect_job_id) {
      var dj = getDroneJob(session.detect_job_id);
      status.detect_job = dj ? { id: dj.id, status: dj.status, error: dj.error } : null;
    }
    if (session.assemble_job_id) {
      var aj = getDroneJob(session.assemble_job_id);
      status.assemble_job = aj ? { id: aj.id, status: aj.status, error: aj.error } : null;
    }
    if (session.export_job_id) {
      var ej = getDroneJob(session.export_job_id);
      status.export_job = ej ? { id: ej.id, status: ej.status, error: ej.error } : null;
    }

    res.json(status);
  });

  return router;
}
