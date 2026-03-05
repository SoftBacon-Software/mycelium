// GitHub Sync plugin routes
// Webhook receiver and entity link management.

import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import createGithubDB from './db.js';

function verifySignature(secret, payload, signature) {
  var expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(signature || '')); } catch (e) { return false; }
}

export default function (core) {
  var router = Router();
  var db = createGithubDB(core.db);
  var { apiError, parseIntParam } = core;
  var { checkAgentOrAdmin } = core.auth;

  // ---- Webhook receiver (no auth — uses signature verification) ----

  router.post('/webhook', function (req, res) {
    var secret = getConfig(core.db, 'webhook_secret');
    if (!secret) {
      console.error('[github-sync] No webhook_secret configured');
      return apiError(res, 500, 'Webhook secret not configured');
    }

    // Verify signature.
    // NOTE: This requires req.rawBody to be set by the server (raw body string
    // before JSON parsing). If rawBody is not available, we fall back to
    // JSON.stringify(req.body) which may differ from the original payload in
    // whitespace. For production use, ensure the server preserves rawBody.
    var rawBody = req.rawBody || JSON.stringify(req.body);
    var signature = req.headers['x-hub-signature-256'] || '';

    if (!verifySignature(secret, rawBody, signature)) {
      console.warn('[github-sync] Invalid webhook signature');
      return apiError(res, 401, 'Invalid signature');
    }

    var eventType = req.headers['x-github-event'] || 'unknown';
    var payload = req.body || {};
    var action = payload.action || '';
    var repo = (payload.repository && payload.repository.full_name) || '';

    // Log the event
    var eventId = db.logEvent(eventType, action, repo, payload);
    console.log('[github-sync] Received ' + eventType + '.' + action + ' from ' + repo + ' (event #' + eventId + ')');

    // Process by event type
    try {
      switch (eventType) {
        case 'pull_request':
          handlePullRequest(core, db, payload, action, repo, eventId);
          break;
        case 'issues':
          handleIssue(core, db, payload, action, repo, eventId);
          break;
        case 'check_suite':
          handleCheckSuite(core, db, payload, action, repo, eventId);
          break;
        case 'workflow_run':
          handleWorkflowRun(core, db, payload, action, repo, eventId);
          break;
        case 'push':
          handlePush(core, db, payload, repo, eventId);
          break;
        case 'issue_comment':
          handleIssueComment(core, db, payload, action, repo, eventId);
          break;
        default:
          // Log but don't process unknown event types
          break;
      }
      db.markProcessed(eventId);
    } catch (e) {
      console.error('[github-sync] Error processing ' + eventType + '.' + action + ':', e.message);
    }

    res.json({ ok: true, event_id: eventId });
  });

  // ---- Events CRUD (auth required) ----

  router.get('/events', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listEvents({
      event_type: req.query.event_type || undefined,
      repo: req.query.repo || undefined,
      processed: req.query.processed !== undefined ? req.query.processed === 'true' : undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  router.get('/events/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var event = db.getEvent(parseIntParam(req.params.id));
    if (!event) return apiError(res, 404, 'Event not found');
    res.json(event);
  });

  // ---- Links CRUD (auth required) ----

  router.get('/links', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listLinks({
      repo: req.query.repo || undefined,
      github_type: req.query.github_type || undefined,
      mycelium_type: req.query.mycelium_type || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  router.post('/links', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var b = req.body;
    if (!b.github_repo || !b.github_number || !b.github_type || !b.mycelium_type || !b.mycelium_id) {
      return apiError(res, 400, 'Required: github_repo, github_number, github_type, mycelium_type, mycelium_id');
    }
    if (!['pr', 'issue', 'check'].includes(b.github_type)) {
      return apiError(res, 400, 'github_type must be pr, issue, or check');
    }
    if (!['task', 'bug'].includes(b.mycelium_type)) {
      return apiError(res, 400, 'mycelium_type must be task or bug');
    }

    // Check for existing link
    var existing = db.getLink(b.github_type, b.github_repo, b.github_number);
    if (existing) {
      return apiError(res, 409, 'Link already exists', { existing: existing });
    }

    var linkId = db.createLink(b.github_type, b.github_repo, b.github_number, b.mycelium_type, b.mycelium_id);

    core.emitEvent('github_link_created', who, null,
      who + ' linked ' + b.github_repo + '#' + b.github_number + ' (' + b.github_type + ') to ' + b.mycelium_type + ' #' + b.mycelium_id,
      { link_id: linkId, github_type: b.github_type, github_repo: b.github_repo, github_number: b.github_number, mycelium_type: b.mycelium_type, mycelium_id: b.mycelium_id });

    res.json({ ok: true, link_id: linkId });
  });

  router.delete('/links/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    db.deleteLink(id);
    res.json({ ok: true });
  });

  // ---- Stats ----

  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.getStats());
  });

  // ---- Dashboard widgets ----

  router.get('/widgets/pr-status', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    // Count open PRs from recent events
    var openPRs = db.listEvents({ event_type: 'pull_request', limit: 200 });
    var prState = {}; // repo#number -> latest state
    for (var i = openPRs.length - 1; i >= 0; i--) {
      var ev = openPRs[i];
      var pr = ev.payload.pull_request || ev.payload;
      var key = ev.repo + '#' + (pr.number || ev.payload.number || 0);
      prState[key] = {
        repo: ev.repo,
        number: pr.number || ev.payload.number || 0,
        title: pr.title || '',
        state: ev.action,
        updated: ev.created_at
      };
    }

    var open = [];
    var recentMerges = [];
    for (var k in prState) {
      var p = prState[k];
      if (p.state === 'opened' || p.state === 'synchronize' || p.state === 'reopened') {
        open.push(p);
      } else if (p.state === 'closed') {
        recentMerges.push(p);
      }
    }

    res.json({
      open_prs: open.length,
      open: open.slice(0, 10),
      recent_merges: recentMerges.slice(0, 10)
    });
  });

  router.get('/widgets/ci-status', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var checkEvents = db.listEvents({ event_type: 'check_suite', limit: 20 });
    var workflowEvents = db.listEvents({ event_type: 'workflow_run', limit: 20 });

    var runs = [];
    for (var ev of checkEvents) {
      var suite = ev.payload.check_suite || {};
      runs.push({
        type: 'check_suite',
        repo: ev.repo,
        conclusion: suite.conclusion || ev.action,
        branch: suite.head_branch || '',
        created_at: ev.created_at
      });
    }
    for (var ev of workflowEvents) {
      var wf = ev.payload.workflow_run || {};
      runs.push({
        type: 'workflow_run',
        repo: ev.repo,
        name: wf.name || '',
        conclusion: wf.conclusion || ev.action,
        branch: wf.head_branch || '',
        created_at: ev.created_at
      });
    }

    runs.sort(function (a, b) { return b.created_at < a.created_at ? -1 : 1; });

    res.json({
      runs: runs.slice(0, 20),
      latest_pass: runs.find(function (r) { return r.conclusion === 'success'; }) || null,
      latest_fail: runs.find(function (r) { return r.conclusion === 'failure'; }) || null
    });
  });

  return router;
}

// ---- Event handlers ----

function handlePullRequest(core, db, payload, action, repo, eventId) {
  var pr = payload.pull_request || {};
  var number = pr.number || 0;
  var title = pr.title || '';
  var defaultProject = getConfig(core.db, 'default_project');

  // Check for existing link
  var link = db.getLink('pr', repo, number);

  if (action === 'opened') {
    // Notify operator inbox about new PR
    if (core.inbox) {
      core.inbox.createInboxItemForAllOperators(
        'github_pr',
        'github_pr',
        repo + '#' + number,
        'PR opened: ' + title,
        repo + '#' + number + ' — ' + (pr.user && pr.user.login || 'unknown') + ': ' + title,
        { repo: repo, number: number, title: title, url: pr.html_url || '', event_id: eventId },
        'normal'
      );
    }
    core.emitEvent('github_pr_opened', '__system__', defaultProject,
      'PR opened: ' + repo + '#' + number + ' — ' + title,
      { repo: repo, number: number, title: title, url: pr.html_url || '' });
  } else if (action === 'closed' && pr.merged) {
    // PR was merged
    if (link) {
      // Update linked Mycelium entity
      core.emitEvent('github_pr_merged', '__system__', defaultProject,
        'PR merged: ' + repo + '#' + number + ' — linked to ' + link.mycelium_type + ' #' + link.mycelium_id,
        { repo: repo, number: number, title: title, link: link });
    } else {
      core.emitEvent('github_pr_merged', '__system__', defaultProject,
        'PR merged: ' + repo + '#' + number + ' — ' + title,
        { repo: repo, number: number, title: title });
    }
  } else if (action === 'closed') {
    core.emitEvent('github_pr_closed', '__system__', defaultProject,
      'PR closed: ' + repo + '#' + number + ' — ' + title,
      { repo: repo, number: number, title: title });
  }
}

function handleIssue(core, db, payload, action, repo, eventId) {
  var issue = payload.issue || {};
  var number = issue.number || 0;
  var title = issue.title || '';
  var body = issue.body || '';
  var defaultProject = getConfig(core.db, 'default_project');
  var autoCreateBugs = getConfigBool(core.db, 'auto_create_bugs', true);

  if (action === 'opened' && autoCreateBugs) {
    // Auto-create a Mycelium bug from the GitHub issue
    try {
      var bugResult = core.db.prepare(
        "INSERT INTO dv_bugs (title, description, project_id, category, severity, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
      ).get(
        '[GH] ' + title,
        body + '\n\n---\nSource: ' + repo + '#' + number + (issue.html_url ? '\n' + issue.html_url : ''),
        defaultProject || 'mycelium',
        'other',
        'normal',
        'open'
      );

      if (bugResult) {
        // Create the link
        db.createLink('issue', repo, number, 'bug', bugResult.id);
        console.log('[github-sync] Auto-created bug #' + bugResult.id + ' from ' + repo + '#' + number);

        core.emitEvent('github_issue_synced', '__system__', defaultProject,
          'GitHub issue ' + repo + '#' + number + ' synced as bug #' + bugResult.id + ': ' + title,
          { repo: repo, number: number, bug_id: bugResult.id, title: title });
      }
    } catch (e) {
      console.error('[github-sync] Failed to create bug from issue:', e.message);
    }
  } else if (action === 'labeled') {
    // Emit event for label changes (useful for triage)
    var labels = (issue.labels || []).map(function (l) { return l.name; });
    core.emitEvent('github_issue_labeled', '__system__', defaultProject,
      'Issue ' + repo + '#' + number + ' labeled: ' + labels.join(', '),
      { repo: repo, number: number, title: title, labels: labels });
  }
}

function handleCheckSuite(core, db, payload, action, repo, eventId) {
  var suite = payload.check_suite || {};
  var conclusion = suite.conclusion || '';
  var branch = suite.head_branch || '';
  var defaultProject = getConfig(core.db, 'default_project');
  var ciNotifications = getConfigBool(core.db, 'ci_notifications', true);

  if (action === 'completed' && conclusion === 'failure' && ciNotifications) {
    if (core.inbox) {
      core.inbox.createInboxItemForAllOperators(
        'github_ci',
        'github_ci',
        repo + '/check_suite/' + (suite.id || eventId),
        'CI failed: ' + repo + ' (' + branch + ')',
        'Check suite failed on ' + branch + ' in ' + repo,
        { repo: repo, branch: branch, conclusion: conclusion, event_id: eventId },
        'high'
      );
    }
    core.emitEvent('github_ci_failed', '__system__', defaultProject,
      'CI check suite failed: ' + repo + ' branch ' + branch,
      { repo: repo, branch: branch, conclusion: conclusion });
  }
}

function handleWorkflowRun(core, db, payload, action, repo, eventId) {
  var run = payload.workflow_run || {};
  var conclusion = run.conclusion || '';
  var branch = run.head_branch || '';
  var name = run.name || '';
  var defaultProject = getConfig(core.db, 'default_project');
  var ciNotifications = getConfigBool(core.db, 'ci_notifications', true);

  if (action === 'completed' && conclusion === 'failure' && ciNotifications) {
    if (core.inbox) {
      core.inbox.createInboxItemForAllOperators(
        'github_ci',
        'github_ci',
        repo + '/workflow_run/' + (run.id || eventId),
        'Workflow failed: ' + name + ' (' + repo + ')',
        'Workflow "' + name + '" failed on ' + branch + ' in ' + repo,
        { repo: repo, branch: branch, workflow: name, conclusion: conclusion, event_id: eventId, url: run.html_url || '' },
        'high'
      );
    }
    core.emitEvent('github_workflow_failed', '__system__', defaultProject,
      'Workflow "' + name + '" failed: ' + repo + ' branch ' + branch,
      { repo: repo, branch: branch, workflow: name, conclusion: conclusion });
  }
}

function handlePush(core, db, payload, repo, eventId) {
  var ref = payload.ref || '';
  var branch = ref.replace('refs/heads/', '');
  var commits = payload.commits || [];
  var defaultProject = getConfig(core.db, 'default_project');

  core.emitEvent('github_push', '__system__', defaultProject,
    'Push to ' + repo + '/' + branch + ': ' + commits.length + ' commit(s)',
    { repo: repo, branch: branch, commit_count: commits.length, head_commit: payload.head_commit || {} });
}

function handleIssueComment(core, db, payload, action, repo, eventId) {
  var issue = payload.issue || {};
  var comment = payload.comment || {};
  var number = issue.number || 0;
  var defaultProject = getConfig(core.db, 'default_project');

  if (action === 'created') {
    core.emitEvent('github_comment', '__system__', defaultProject,
      'Comment on ' + repo + '#' + number + ' by ' + (comment.user && comment.user.login || 'unknown'),
      { repo: repo, number: number, body: (comment.body || '').substring(0, 500), user: comment.user && comment.user.login || '' });
  }
}

function getConfig(db, key) {
  var row = db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'github-sync' AND key = ?").get(key);
  return row ? row.value : null;
}

function getConfigBool(db, key, defaultVal) {
  var val = getConfig(db, key);
  if (val === null) return defaultVal;
  return val === 'true' || val === '1';
}
