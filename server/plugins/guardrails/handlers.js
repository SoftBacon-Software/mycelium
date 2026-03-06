// Guardrails event handlers
// Subscribes to all events and evaluates guardrail rules against them.

import createGuardrailsDB from './db.js';

function evaluateCondition(conditions, eventData) {
  var data = eventData.data || {};
  switch (conditions.type) {
    case 'require_field':
      if (!data[conditions.field]) return { violated: true, detail: conditions.message || 'Missing required field: ' + conditions.field };
      return { violated: false };
    case 'max_value':
      var val = parseInt(data[conditions.field]) || 0;
      if (val > (conditions.max || 0)) return { violated: true, detail: conditions.message || conditions.field + ' exceeds max (' + val + ' > ' + conditions.max + ')' };
      return { violated: false };
    case 'require_approval':
      if (!data.approval_id) return { violated: true, detail: conditions.message || 'Approval required for ' + conditions.action_type };
      return { violated: false };
    case 'block_agent':
      if ((eventData.agent || '') === conditions.agent_id) return { violated: true, detail: conditions.message || 'Agent ' + conditions.agent_id + ' is restricted' };
      return { violated: false };
    case 'custom':
      // SECURITY: custom expressions disabled — arbitrary code execution risk.
      // Use built-in condition types instead (require_field, max_value, require_approval, block_agent).
      return { violated: false, detail: 'Custom expressions are disabled for security reasons' };
    default:
      return { violated: false };
  }
}

export function registerHooks(core) {
  var db = createGuardrailsDB(core.db);

  core.onEvent('*', function (eventData) {
    try {
      var eventType = eventData.type || eventData.event_type || '';
      if (!eventType) return;
      if (eventType.startsWith('guardrail_')) return;

      var rules = db.listRules({ enabled: 1 });
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.trigger_event !== '*' && rule.trigger_event !== eventType) continue;
        if (rule.project_id && rule.project_id !== (eventData.project_id || '')) continue;

        var result = evaluateCondition(rule.conditions, eventData);
        if (!result.violated) continue;

        var agentId = eventData.agent || '';
        var projectId = eventData.project_id || '';

        db.logViolation(rule.id, rule.name, eventType, agentId, projectId, rule.enforcement, eventData, result.detail);

        core.emitEvent('guardrail_violation', '__system__', projectId,
          rule.enforcement.toUpperCase() + ': ' + rule.name + ' — ' + result.detail,
          { rule_id: rule.id, rule_name: rule.name, enforcement: rule.enforcement, agent: agentId, detail: result.detail });

        if (rule.enforcement === 'block') {
          core.emitEvent('guardrail_blocked', '__system__', projectId,
            'BLOCKED by rule "' + rule.name + '": ' + result.detail,
            { rule_id: rule.id, agent: agentId });
        }

        var notifyConfig = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'guardrails' AND key = 'notify_on_violation'").get();
        if (!notifyConfig || notifyConfig.value !== 'false') {
          core.inbox.createInboxItemForAllOperators(
            'guardrail_violation', 'guardrail_rule', String(rule.id),
            (rule.enforcement === 'block' ? 'BLOCKED' : 'WARNING') + ': ' + rule.name,
            result.detail + ' (agent: ' + agentId + ', event: ' + eventType + ')',
            { rule_id: rule.id, violation_detail: result.detail, agent: agentId, event_type: eventType },
            rule.enforcement === 'block' ? 'urgent' : 'normal'
          );
        }
      }
    } catch (e) {
      console.error('[guardrails] Error evaluating rules:', e.message);
    }
  });
}
