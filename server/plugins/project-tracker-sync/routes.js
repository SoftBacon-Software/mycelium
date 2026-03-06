// Project Tracker Sync — Routes
// Webhook receiver, link management, status mapping, sync log, and widgets.

import { Router } from 'express';
import createTrackerDB from './db.js';

function createLinearIssue(apiKey, teamId, title, description) {
  var query = 'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }';
  return fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, variables: { input: { teamId: teamId, title: title, description: description || '' } } })
  }).then(function (r) { return r.json(); });
}

function createJiraIssue(domain, email, apiToken, projectKey, summary, description) {
  var auth = Buffer.from(email + ':' + apiToken).toString('base64');
  return fetch('https://' + domain + '/rest/api/3/issue', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary: summary,
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: description || '' }] }]
        },
        issuetype: { name: 'Task' }
      }
    })
  }).then(function (r) { return r.json(); });
}

function fetchLinearIssue(apiKey, issueId) {
  var query = 'query GetIssue($id: String!) { issue(id: $id) { id identifier title description state { name } assignee { name } } }';
  return fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, variables: { id: issueId } })
  }).then(function (r) { return r.json(); });
}

function fetchJiraIssue(domain, email, apiToken, issueId) {
  var auth = Buffer.from(email + ':' + apiToken).toString('base64');
  return fetch('https://' + domain + '/rest/api/3/issue/' + issueId, {
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' }
  }).then(function (r) { return r.json(); });
}

export default function (core) {
  var router = Router();
  var db = createTrackerDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  function getConfig(key) {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'project-tracker-sync' AND key = ?").get(key);
    return row ? row.value : '';
  }

  // POST /tracker/webhook — Inbound webhook from Linear or Jira (requires webhook_secret or admin auth)
  router.post('/webhook', function (req, res) {
    // Verify webhook auth — check secret or fall back to admin key
    var webhookSecret = getConfig('webhook_secret');
    if (webhookSecret) {
      var provided = req.headers['x-webhook-secret'] || req.query.secret;
      if (!provided || provided !== webhookSecret) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }
    } else {
      var who = checkAdmin(req, res);
      if (!who) return;
    }

    try {
      var provider = getConfig('provider');
      var direction = getConfig('sync_direction');
      if (direction === 'outbound') {
        return res.json({ ok: true, skipped: true, reason: 'outbound-only mode' });
      }

      if (provider === 'linear') {
        handleLinearWebhook(req.body);
      } else if (provider === 'jira') {
        handleJiraWebhook(req.body);
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('[project-tracker-sync] Webhook error:', e.message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  function handleLinearWebhook(body) {
    var action = body.action;
    var type = body.type;
    if (type !== 'Issue') return;

    var data = body.data || {};
    var externalId = data.id;
    if (!externalId) return;

    var link = db.getLinkByExternal('linear', externalId);

    if (action === 'create' && !link) {
      // Inbound create: make a Mycelium task
      var defaultProject = getConfig('default_project');
      if (!defaultProject) return;

      var taskRow = core.db.prepare(
        'INSERT INTO dv_tasks (title, description, project_id, status) VALUES (?, ?, ?, ?) RETURNING id'
      ).get(data.title || 'Untitled', data.description || '', defaultProject, 'open');

      if (taskRow) {
        var externalKey = data.identifier || '';
        db.createLink('linear', externalId, externalKey, 'task', taskRow.id);
        db.logSync('linear', 'inbound', 'create', taskRow.id, externalId, 'success', 'Created task from ' + externalKey);
        core.emitEvent('task_created', '__system__', defaultProject,
          'Task created from Linear ' + externalKey, { task_id: taskRow.id, id: taskRow.id });
      }
    } else if ((action === 'update') && link) {
      // Inbound update: sync status and title
      var task = core.db.prepare('SELECT * FROM dv_tasks WHERE id = ?').get(link.mycelium_id);
      if (!task) return;

      var updates = [];
      var updateValues = [];

      if (data.title && data.title !== task.title) {
        updates.push('title = ?');
        updateValues.push(data.title);
      }

      if (data.state && data.state.name) {
        var myceliumStatus = db.mapToMycelium('linear', data.state.name);
        if (myceliumStatus && myceliumStatus !== task.status) {
          updates.push('status = ?');
          updateValues.push(myceliumStatus);
        }
      }

      if (updates.length > 0) {
        updateValues.push(link.mycelium_id);
        core.db.prepare('UPDATE dv_tasks SET ' + updates.join(', ') + ' WHERE id = ?').run(...updateValues);
        db.updateLink(link.id, { last_synced: new Date().toISOString(), sync_status: 'synced' });
        db.logSync('linear', 'inbound', 'update', link.mycelium_id, externalId, 'success', 'Updated from Linear');
      }
    } else if (action === 'remove' && link) {
      db.updateLink(link.id, { sync_status: 'orphaned' });
      db.logSync('linear', 'inbound', 'remove', link.mycelium_id, externalId, 'success', 'External issue removed');
    }
  }

  function handleJiraWebhook(body) {
    var event = body.webhookEvent;
    var issue = body.issue;
    if (!issue || !issue.id) return;

    var externalId = String(issue.id);
    var externalKey = issue.key || '';
    var fields = issue.fields || {};
    var link = db.getLinkByExternal('jira', externalId);

    if (event === 'jira:issue_created' && !link) {
      // Inbound create
      var defaultProject = getConfig('default_project');
      if (!defaultProject) return;

      var desc = '';
      if (fields.description && fields.description.content) {
        // Extract plain text from Jira ADF
        desc = fields.description.content.map(function (block) {
          if (block.content) {
            return block.content.map(function (c) { return c.text || ''; }).join('');
          }
          return '';
        }).join('\n');
      }

      var taskRow = core.db.prepare(
        'INSERT INTO dv_tasks (title, description, project_id, status) VALUES (?, ?, ?, ?) RETURNING id'
      ).get(fields.summary || 'Untitled', desc, defaultProject, 'open');

      if (taskRow) {
        db.createLink('jira', externalId, externalKey, 'task', taskRow.id);
        db.logSync('jira', 'inbound', 'create', taskRow.id, externalId, 'success', 'Created task from ' + externalKey);
        core.emitEvent('task_created', '__system__', defaultProject,
          'Task created from Jira ' + externalKey, { task_id: taskRow.id, id: taskRow.id });
      }
    } else if (event === 'jira:issue_updated' && link) {
      // Inbound update
      var task = core.db.prepare('SELECT * FROM dv_tasks WHERE id = ?').get(link.mycelium_id);
      if (!task) return;

      var updates = [];
      var updateValues = [];

      if (fields.summary && fields.summary !== task.title) {
        updates.push('title = ?');
        updateValues.push(fields.summary);
      }

      if (fields.status && fields.status.name) {
        var myceliumStatus = db.mapToMycelium('jira', fields.status.name);
        if (myceliumStatus && myceliumStatus !== task.status) {
          updates.push('status = ?');
          updateValues.push(myceliumStatus);
        }
      }

      if (updates.length > 0) {
        updateValues.push(link.mycelium_id);
        core.db.prepare('UPDATE dv_tasks SET ' + updates.join(', ') + ' WHERE id = ?').run(...updateValues);
        db.updateLink(link.id, { last_synced: new Date().toISOString(), sync_status: 'synced' });
        db.logSync('jira', 'inbound', 'update', link.mycelium_id, externalId, 'success', 'Updated from Jira');
      }
    }
  }

  // GET /tracker/links — List sync links
  router.get('/links', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listLinks({
      provider: req.query.provider || undefined,
      sync_status: req.query.sync_status || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  // POST /tracker/links — Manually link a Mycelium task to an external issue
  router.post('/links', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var provider = getConfig('provider');
    if (!provider) return apiError(res, 400, 'No provider configured');

    var externalId = req.body.external_id;
    var externalKey = req.body.external_key || '';
    var myceliumType = req.body.mycelium_type || 'task';
    var myceliumId = req.body.mycelium_id;

    if (!externalId || !myceliumId) return apiError(res, 400, 'external_id and mycelium_id required');

    // Check for existing link
    var existing = db.getLinkByMycelium(myceliumType, myceliumId);
    if (existing) return apiError(res, 409, 'Mycelium item already linked to ' + existing.external_key + ' (' + existing.external_id + ')');

    var id = db.createLink(provider, externalId, externalKey, myceliumType, myceliumId);
    db.logSync(provider, 'manual', 'link', myceliumId, externalId, 'success', 'Manual link by ' + who);
    core.emitEvent('tracker_link_created', who, null,
      who + ' linked ' + myceliumType + ' #' + myceliumId + ' to ' + provider + ' ' + (externalKey || externalId),
      { link_id: id, provider: provider, mycelium_id: myceliumId, external_id: externalId });

    res.json({ ok: true, id: id });
  });

  // DELETE /tracker/links/:id — Remove link
  router.delete('/links/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var link = db.getLink(id);
    if (!link) return apiError(res, 404, 'Link not found');
    db.deleteLink(id);
    db.logSync(link.provider, 'manual', 'unlink', link.mycelium_id, link.external_id, 'success', 'Unlinked by ' + who);
    res.json({ ok: true });
  });

  // POST /tracker/sync/:id — Force re-sync a linked item
  router.post('/sync/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var link = db.getLink(id);
    if (!link) return apiError(res, 404, 'Link not found');

    var provider = link.provider;
    var apiKey = getConfig('api_key');
    if (!apiKey) return apiError(res, 400, 'No API key configured');

    var task = core.db.prepare('SELECT * FROM dv_tasks WHERE id = ?').get(link.mycelium_id);
    if (!task) return apiError(res, 404, 'Linked Mycelium task not found');

    db.updateLink(id, { sync_status: 'syncing' });

    if (provider === 'linear') {
      fetchLinearIssue(apiKey, link.external_id).then(function (result) {
        var issue = result && result.data && result.data.issue;
        if (!issue) {
          db.updateLink(id, { sync_status: 'error' });
          db.logSync(provider, 'inbound', 'force_sync', link.mycelium_id, link.external_id, 'error', 'Issue not found in Linear');
          return;
        }
        reconcileFromExternal(link, task, {
          title: issue.title,
          description: issue.description || '',
          status: issue.state ? issue.state.name : null,
          assignee: issue.assignee ? issue.assignee.name : null
        });
      }).catch(function (e) {
        db.updateLink(id, { sync_status: 'error' });
        db.logSync(provider, 'inbound', 'force_sync', link.mycelium_id, link.external_id, 'error', e.message);
      });
    } else if (provider === 'jira') {
      var jiraDomain = getConfig('jira_domain');
      var jiraEmail = getConfig('jira_email');
      fetchJiraIssue(jiraDomain, jiraEmail, apiKey, link.external_id).then(function (result) {
        if (!result || !result.fields) {
          db.updateLink(id, { sync_status: 'error' });
          db.logSync(provider, 'inbound', 'force_sync', link.mycelium_id, link.external_id, 'error', 'Issue not found in Jira');
          return;
        }
        var fields = result.fields;
        reconcileFromExternal(link, task, {
          title: fields.summary,
          description: '',
          status: fields.status ? fields.status.name : null,
          assignee: fields.assignee ? fields.assignee.displayName : null
        });
      }).catch(function (e) {
        db.updateLink(id, { sync_status: 'error' });
        db.logSync(provider, 'inbound', 'force_sync', link.mycelium_id, link.external_id, 'error', e.message);
      });
    }

    res.json({ ok: true, message: 'Sync initiated for link #' + id });
  });

  function reconcileFromExternal(link, task, external) {
    var updates = [];
    var updateValues = [];

    if (external.title && external.title !== task.title) {
      updates.push('title = ?');
      updateValues.push(external.title);
    }

    if (external.status) {
      var myceliumStatus = db.mapToMycelium(link.provider, external.status);
      if (myceliumStatus && myceliumStatus !== task.status) {
        updates.push('status = ?');
        updateValues.push(myceliumStatus);
      }
    }

    if (updates.length > 0) {
      updateValues.push(link.mycelium_id);
      core.db.prepare('UPDATE dv_tasks SET ' + updates.join(', ') + ' WHERE id = ?').run(...updateValues);
    }

    db.updateLink(link.id, { last_synced: new Date().toISOString(), sync_status: 'synced' });
    db.logSync(link.provider, 'inbound', 'force_sync', link.mycelium_id, link.external_id, 'success', 'Reconciled from external');
  }

  // GET /tracker/status-map — Get status mappings
  router.get('/status-map', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var provider = req.query.provider || getConfig('provider');
    if (!provider) return apiError(res, 400, 'No provider specified or configured');
    res.json(db.getStatusMaps(provider));
  });

  // POST /tracker/status-map — Create status mapping
  router.post('/status-map', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var provider = req.body.provider || getConfig('provider');
    if (!provider) return apiError(res, 400, 'No provider specified or configured');
    if (!req.body.mycelium_status || !req.body.external_status) {
      return apiError(res, 400, 'mycelium_status and external_status required');
    }
    var id = db.createStatusMap(provider, req.body.mycelium_status, req.body.external_status);
    res.json({ ok: true, id: id });
  });

  // DELETE /tracker/status-map/:id — Remove mapping
  router.delete('/status-map/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    db.deleteStatusMap(parseIntParam(req.params.id));
    res.json({ ok: true });
  });

  // GET /tracker/log — Sync log
  router.get('/log', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listSyncLog({
      provider: req.query.provider || undefined,
      direction: req.query.direction || undefined,
      status: req.query.status || undefined,
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /tracker/stats — Sync stats
  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.getStats());
  });

  // GET /tracker/widgets/sync-status — Widget data for dashboard
  router.get('/widgets/sync-status', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var stats = db.getStats();
    var totalLinks = 0;
    for (var i = 0; i < stats.links.length; i++) {
      totalLinks += stats.links[i].count;
    }
    res.json({
      linked_items: totalLinks,
      last_sync: stats.last_synced,
      conflicts: stats.conflicts,
      provider: getConfig('provider') || 'none'
    });
  });

  return router;
}
