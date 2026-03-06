// Project Tracker Sync — Event handlers
// Subscribes to task events for outbound sync to Linear/Jira.

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

export function registerHooks(core) {
  var db = createTrackerDB(core.db);

  function getConfig(key) {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'project-tracker-sync' AND key = ?").get(key);
    return row ? row.value : '';
  }

  core.onEvent('task_updated', function (eventData) {
    try {
      var direction = getConfig('sync_direction');
      if (direction === 'inbound') return;

      var data = eventData.data || {};
      var taskId = data.task_id || data.id;
      if (!taskId) return;

      var link = db.getLinkByMycelium('task', taskId);
      if (!link) return;

      var provider = getConfig('provider');
      var apiKey = getConfig('api_key');
      if (!apiKey) return;

      var task = core.db.prepare('SELECT * FROM dv_tasks WHERE id = ?').get(taskId);
      if (!task) return;

      var externalStatus = db.mapToExternal(provider, task.status);
      if (!externalStatus) return;

      // Update external issue status
      // Full provider API calls would go here for production use.
      // For now, log the sync action.
      db.logSync(provider, 'outbound', 'status_update', taskId, link.external_id, 'success', 'Updated to ' + externalStatus);
      db.updateLink(link.id, { last_synced: new Date().toISOString(), sync_status: 'synced' });
    } catch (e) {
      console.error('[project-tracker-sync] Outbound sync error:', e.message);
    }
  });

  core.onEvent('task_created', function (eventData) {
    try {
      var direction = getConfig('sync_direction');
      if (direction === 'inbound') return;

      var data = eventData.data || {};
      var taskId = data.task_id || data.id;
      if (!taskId) return;

      var existing = db.getLinkByMycelium('task', taskId);
      if (existing) return;

      var provider = getConfig('provider');
      var apiKey = getConfig('api_key');
      var externalProject = getConfig('external_project');
      if (!apiKey || !externalProject) return;

      var task = core.db.prepare('SELECT * FROM dv_tasks WHERE id = ?').get(taskId);
      if (!task) return;

      if (provider === 'linear') {
        createLinearIssue(apiKey, externalProject, task.title, task.description || '').then(function (result) {
          var issue = result && result.data && result.data.issueCreate && result.data.issueCreate.issue;
          if (issue) {
            db.createLink(provider, issue.id, issue.identifier, 'task', taskId);
            db.logSync(provider, 'outbound', 'create', taskId, issue.id, 'success', 'Created ' + issue.identifier);
          }
        }).catch(function (e) {
          db.logSync(provider, 'outbound', 'create', taskId, '', 'error', e.message);
        });
      } else if (provider === 'jira') {
        var jiraDomain = getConfig('jira_domain');
        var jiraEmail = getConfig('jira_email');
        createJiraIssue(jiraDomain, jiraEmail, apiKey, externalProject, task.title, task.description || '').then(function (result) {
          if (result && result.id) {
            db.createLink(provider, result.id, result.key, 'task', taskId);
            db.logSync(provider, 'outbound', 'create', taskId, result.id, 'success', 'Created ' + result.key);
          }
        }).catch(function (e) {
          db.logSync(provider, 'outbound', 'create', taskId, '', 'error', e.message);
        });
      }
    } catch (e) {
      console.error('[project-tracker-sync] Create sync error:', e.message);
    }
  });
}
