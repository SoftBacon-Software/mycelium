// Workflow Automations event handlers
// Subscribes to all platform events and evaluates automation rules.

import createAutomationDB from './db.js';

function evaluateConditions(conditions, eventData) {
  var data = eventData.data || {};

  // Project filter
  if (conditions.project_id && (eventData.project_id || '') !== conditions.project_id) return false;

  // Agent filter
  if (conditions.agent_id && (eventData.agent || '') !== conditions.agent_id) return false;

  // Field equals
  if (conditions.field_equals) {
    for (var field in conditions.field_equals) {
      if (String(data[field] || '') !== String(conditions.field_equals[field])) return false;
    }
  }

  // Field contains
  if (conditions.field_contains) {
    for (var f in conditions.field_contains) {
      if (String(data[f] || '').indexOf(conditions.field_contains[f]) === -1) return false;
    }
  }

  // Field exists
  if (conditions.field_exists) {
    for (var i = 0; i < conditions.field_exists.length; i++) {
      if (data[conditions.field_exists[i]] === undefined || data[conditions.field_exists[i]] === null) return false;
    }
  }

  return true;
}

function executeAction(action, eventData, core) {
  var data = eventData.data || {};
  var agent = eventData.agent || '';

  // Template variable replacement in strings
  function interpolate(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{(\w+)\}\}/g, function (m, key) {
      if (key === 'agent') return agent;
      if (key === 'event_type') return eventData.type || '';
      if (key === 'project') return eventData.project_id || '';
      if (key === 'summary') return eventData.summary || '';
      return data[key] !== undefined ? String(data[key]) : m;
    });
  }

  switch (action.type) {
    case 'create_task': {
      var result = core.db.prepare(
        "INSERT INTO dv_tasks (title, description, project_id, assignee, status) VALUES (?, ?, ?, ?, 'open') RETURNING id"
      ).get(interpolate(action.title), interpolate(action.description || ''), action.project_id || eventData.project_id || '', action.assignee || '');
      core.emitEvent('task_created', '__system__', action.project_id || eventData.project_id || '',
        'Automation created task: ' + interpolate(action.title), { task_id: result.id });
      return { type: 'create_task', task_id: result.id };
    }
    case 'send_message': {
      core.db.prepare(
        "INSERT INTO dv_messages (from_agent, to_agent, content, msg_type, project_id) VALUES ('__system__', ?, ?, 'message', ?)"
      ).run(action.to || '', interpolate(action.content), action.project_id || eventData.project_id || '');
      return { type: 'send_message', to: action.to };
    }
    case 'file_bug': {
      var bugResult = core.db.prepare(
        "INSERT INTO dv_bugs (title, description, project_id, severity, status, reporter) VALUES (?, ?, ?, ?, 'open', '__system__') RETURNING id"
      ).get(interpolate(action.title), interpolate(action.description || ''), action.project_id || eventData.project_id || '', action.severity || 'normal');
      core.emitEvent('bug_filed', '__system__', action.project_id || eventData.project_id || '',
        'Automation filed bug: ' + interpolate(action.title), { bug_id: bugResult.id });
      return { type: 'file_bug', bug_id: bugResult.id };
    }
    case 'assign_agent': {
      if (data.task_id || data.id) {
        core.db.prepare("UPDATE dv_tasks SET assignee = ? WHERE id = ?").run(action.agent_id, data.task_id || data.id);
        return { type: 'assign_agent', agent: action.agent_id, task_id: data.task_id || data.id };
      }
      return { type: 'assign_agent', skipped: true };
    }
    case 'send_webhook': {
      // SSRF protection: block internal/private URLs
      var webhookUrl = action.url || '';
      try {
        var parsed = new URL(webhookUrl);
        var host = parsed.hostname.toLowerCase();
        var blocked = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
          host === '::1' || host === '[::1]' || host === '169.254.169.254' ||
          host.endsWith('.internal') || host.endsWith('.local') ||
          host.startsWith('10.') || host.startsWith('192.168.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        if (blocked || parsed.protocol === 'file:') {
          console.warn('[workflow-automations] Blocked SSRF attempt to:', webhookUrl);
          return { type: 'send_webhook', blocked: true, reason: 'Internal/private URL not allowed' };
        }
      } catch (e) {
        return { type: 'send_webhook', blocked: true, reason: 'Invalid URL' };
      }
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventData.type, agent: agent, data: data, summary: eventData.summary })
      }).catch(function (e) { console.error('[workflow-automations] Webhook failed:', e.message); });
      return { type: 'send_webhook', url: webhookUrl };
    }
    case 'inbox_notify': {
      core.inbox.createInboxItemForAllOperators(
        'automation', 'automation_rule', String(action.rule_id || 0),
        interpolate(action.title || 'Automation notification'),
        interpolate(action.summary || eventData.summary || ''),
        { event_type: eventData.type, agent: agent },
        action.priority || 'normal'
      );
      return { type: 'inbox_notify' };
    }
    default:
      return { type: action.type, skipped: true, reason: 'unknown action type' };
  }
}

export { evaluateConditions, executeAction };

export function registerHooks(core) {
  var db = createAutomationDB(core.db);
  var actionCounts = {}; // minute -> count

  function getConfig(key, fallback) {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'workflow-automations' AND key = ?").get(key);
    return row ? row.value : (fallback || '');
  }

  function checkRateLimit() {
    var maxPerMin = parseInt(getConfig('max_actions_per_minute', '30')) || 0;
    if (maxPerMin <= 0) return true;
    var minute = Math.floor(Date.now() / 60000);
    if (!actionCounts[minute]) actionCounts[minute] = 0;
    // Clean old entries
    for (var k in actionCounts) { if (parseInt(k) < minute - 1) delete actionCounts[k]; }
    if (actionCounts[minute] >= maxPerMin) return false;
    actionCounts[minute]++;
    return true;
  }

  core.onEvent('*', function (eventData) {
    try {
      var eventType = eventData.type || eventData.event_type || '';
      if (!eventType || eventType.startsWith('automation_')) return;

      var rules = db.listRules({ enabled: 1 });
      var dryRun = getConfig('dry_run', 'false') === 'true';

      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.trigger_event !== '*' && rule.trigger_event !== eventType) continue;

        var matched = evaluateConditions(rule.conditions, eventData);
        if (!matched) continue;

        if (!checkRateLimit()) {
          db.logExecution(rule.id, rule.name, eventType, 1, [], eventData, 'rate_limited', 'Exceeded max actions per minute', dryRun ? 1 : 0);
          continue;
        }

        var actionResults = [];
        var status = 'success';
        var error = '';

        if (!dryRun) {
          var actions = rule.actions || [];
          for (var j = 0; j < actions.length; j++) {
            try {
              var result = executeAction(actions[j], eventData, core);
              actionResults.push(result);
            } catch (e) {
              actionResults.push({ type: actions[j].type, error: e.message });
              status = 'error';
              error = e.message;
            }
          }
        }

        db.incrementRunCount(rule.id);
        db.logExecution(rule.id, rule.name, eventType, 1, actionResults, eventData, status, error, dryRun ? 1 : 0);

        core.emitEvent('automation_triggered', '__system__', eventData.project_id || '',
          'Automation "' + rule.name + '" triggered by ' + eventType + (dryRun ? ' (dry run)' : ''),
          { rule_id: rule.id, rule_name: rule.name, actions: actionResults.length, dry_run: dryRun });
      }
    } catch (e) {
      console.error('[workflow-automations] Error:', e.message);
    }
  });
}
