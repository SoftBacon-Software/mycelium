// Error Monitor plugin routes — receives core context, returns Express Router

import { Router } from 'express';
import createErrorDB from './db.js';

function getConfig(db, key) {
  var row = db.prepare(
    "SELECT value FROM dv_plugin_config WHERE plugin_name = 'error-monitor' AND key = ?"
  ).get(key);
  return row ? row.value : null;
}

function getAllConfig(db) {
  var rows = db.prepare(
    "SELECT key, value FROM dv_plugin_config WHERE plugin_name = 'error-monitor'"
  ).all();
  var config = {};
  for (var row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

function autoFileBug(core, db, errorRecord, config) {
  var projectId = config.default_project || 'mycelium';
  var severity = config.default_severity || 'normal';

  var result = core.db.prepare(
    "INSERT INTO dv_bugs (title, description, project_id, severity, status, reporter) VALUES (?, ?, ?, ?, 'open', '__system__') RETURNING id"
  ).get(
    '[' + errorRecord.provider + '] ' + errorRecord.title,
    'Auto-filed from error monitor.\n\nMessage: ' + errorRecord.message + '\n\nStack trace:\n' + (errorRecord.stack_trace || 'N/A') + '\n\nLink: ' + (errorRecord.url || 'N/A') + '\n\nOccurrences: ' + errorRecord.occurrences,
    projectId,
    severity
  );

  if (result) {
    db.updateError(errorRecord.id, { bug_id: result.id });
    core.emitEvent('error_bug_filed', '__system__', projectId,
      'Auto-filed bug #' + result.id + ' from error: ' + errorRecord.title,
      { bug_id: result.id, error_id: errorRecord.id, provider: errorRecord.provider });

    core.inbox.createInboxItemForAllOperators(
      'error_bug', 'bug', String(result.id),
      'Bug auto-filed: ' + errorRecord.title,
      errorRecord.provider + ' error with ' + errorRecord.occurrences + ' occurrences',
      { bug_id: result.id, error_id: errorRecord.id },
      severity === 'critical' ? 'urgent' : 'normal'
    );
  }
  return result;
}

function autoAssignBug(core, bugId, projectId) {
  // Find most recently active agent on the project
  var agent = core.db.prepare(
    "SELECT agent_id FROM dv_agents WHERE last_heartbeat >= datetime('now', '-1 hour') ORDER BY last_heartbeat DESC LIMIT 1"
  ).get();
  if (agent) {
    core.db.prepare('UPDATE dv_bugs SET assignee = ? WHERE id = ?').run(agent.agent_id, bugId);
  }
  return agent ? agent.agent_id : null;
}

function processWebhook(core, db, provider, errorKey, title, message, stackTrace, url, payload, res) {
  try {
    var config = getAllConfig(core.db);
    var result = db.logError(provider, errorKey, title, message, stackTrace, url, payload);
    var threshold = parseInt(config.auto_file_threshold || '1', 10);

    // Auto-file bug if threshold met and no bug linked yet
    if (result.occurrences >= threshold) {
      var errorRecord = db.getError(result.id);
      if (errorRecord && !errorRecord.bug_id && errorRecord.status !== 'muted') {
        var bugResult = autoFileBug(core, db, errorRecord, config);
        if (bugResult && config.auto_assign === 'true') {
          var projectId = config.default_project || 'mycelium';
          autoAssignBug(core, bugResult.id, projectId);
        }
      }
    }

    // Send inbox notification for new errors
    if (result.is_new) {
      core.inbox.createInboxItemForAllOperators(
        'error_received', 'error_event', String(result.id),
        'New ' + provider + ' error: ' + title,
        message || title,
        { error_id: result.id, provider: provider },
        'normal'
      );
    }

    // Emit event
    core.emitEvent('error_received', '__system__', config.default_project || null,
      provider + ' error: ' + title,
      { error_id: result.id, provider: provider, is_new: result.is_new, occurrences: result.occurrences });

    res.json({ ok: true, error_id: result.id, is_new: result.is_new, occurrences: result.occurrences });
  } catch (e) {
    console.error('[error-monitor] Webhook processing failed:', e.message);
    res.status(500).json({ error: 'Processing failed: ' + e.message });
  }
}

export default function (core) {
  var router = Router();
  var db = createErrorDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  // ---- Webhook endpoints (signature-verified or admin-authed) ----

  function verifyWebhookAuth(req, res) {
    // Check for webhook_secret in query param or X-Webhook-Secret header
    var secret = getConfig(core.db, 'webhook_secret');
    if (!secret) {
      // No secret configured — require admin auth as fallback
      var who = checkAdmin(req, res);
      return !!who;
    }
    var provided = req.headers['x-webhook-secret'] || req.query.secret;
    if (!provided || provided !== secret) {
      res.status(403).json({ error: 'Invalid webhook secret' });
      return false;
    }
    return true;
  }

  // POST /errors/webhook/sentry
  router.post('/webhook/sentry', function (req, res) {
    if (!verifyWebhookAuth(req, res)) return;
    var issue = req.body.data && req.body.data.issue;
    var errorKey = 'sentry:' + (issue && issue.id);
    var title = issue && issue.title;
    var message = issue && issue.metadata && issue.metadata.value;
    var url = issue && issue.permalink;
    var stackTrace = '';
    processWebhook(core, db, 'sentry', errorKey, title || '', message || '', stackTrace, url || '', req.body, res);
  });

  // POST /errors/webhook/bugsnag
  router.post('/webhook/bugsnag', function (req, res) {
    if (!verifyWebhookAuth(req, res)) return;
    var error = req.body.error;
    var errorKey = 'bugsnag:' + (error && error.exceptionClass) + ':' + (error && error.message || '').substring(0, 100);
    var title = error && error.exceptionClass;
    var message = error && error.message;
    var stackTrace = error && error.stackTrace || '';
    var url = error && error.url || '';
    if (typeof stackTrace !== 'string') stackTrace = JSON.stringify(stackTrace);
    processWebhook(core, db, 'bugsnag', errorKey, title || '', message || '', stackTrace, url, req.body, res);
  });

  // POST /errors/webhook/datadog
  router.post('/webhook/datadog', function (req, res) {
    if (!verifyWebhookAuth(req, res)) return;
    var errorKey = 'datadog:' + req.body.id;
    var title = req.body.title || '';
    var message = req.body.text || '';
    var url = req.body.url || '';
    var tags = req.body.tags || [];
    processWebhook(core, db, 'datadog', errorKey, title, message, '', url, req.body, res);
  });

  // ---- Authenticated endpoints ----

  // GET /errors/events — list errors
  router.get('/events', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listErrors({
      provider: req.query.provider || undefined,
      status: req.query.status || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  // GET /errors/events/:id — get single error
  router.get('/events/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var error = db.getError(parseIntParam(req.params.id));
    if (!error) return apiError(res, 404, 'Error event not found');
    res.json(error);
  });

  // PUT /errors/events/:id — update error (mute, resolve, link bug)
  router.put('/events/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var error = db.getError(id);
    if (!error) return apiError(res, 404, 'Error event not found');
    var updates = {};
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.bug_id !== undefined) updates.bug_id = req.body.bug_id;
    db.updateError(id, updates);
    res.json({ ok: true, error: db.getError(id) });
  });

  // POST /errors/events/:id/file-bug — manually file a bug from an error (admin only)
  router.post('/events/:id/file-bug', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var error = db.getError(id);
    if (!error) return apiError(res, 404, 'Error event not found');
    if (error.bug_id) return apiError(res, 400, 'Error already linked to bug #' + error.bug_id);

    var config = getAllConfig(core.db);
    var bugResult = autoFileBug(core, db, error, config);
    if (!bugResult) return apiError(res, 500, 'Failed to create bug');

    if (config.auto_assign === 'true') {
      var projectId = config.default_project || 'mycelium';
      autoAssignBug(core, bugResult.id, projectId);
    }

    res.json({ ok: true, bug_id: bugResult.id, error_id: id });
  });

  // GET /errors/stats — error counts, top errors, by-provider breakdown
  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var stats = db.getStats();
    stats.top_errors = db.getTopErrors(10);
    res.json(stats);
  });

  // GET /errors/widgets/error-count — widget data
  router.get('/widgets/error-count', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var stats = db.getStats();
    var count = stats.last_24h;
    res.json({
      type: 'stat',
      value: count,
      label: 'Errors (24h)',
      color: count > 10 ? 'red' : 'green'
    });
  });

  return router;
}
