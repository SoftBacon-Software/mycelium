// Guardrails event handlers
// Subscribes to all events and evaluates guardrail rules against them.

import createGuardrailsDB from './db.js';
import { evaluateCondition } from './evaluate.js';

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
