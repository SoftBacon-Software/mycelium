// Guardrails plugin routes
// Rule management, violation tracking, manual checks, and dashboard widgets.

import { Router } from 'express';
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
      return { violated: false, detail: 'Custom expressions are disabled for security reasons' };
    default:
      return { violated: false };
  }
}

export default function (core) {
  var router = Router();
  var db = createGuardrailsDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError } = core;

  // GET /guardrails/rules — List rules
  router.get('/rules', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var filters = {};
    if (req.query.enabled !== undefined) filters.enabled = parseInt(req.query.enabled);
    if (req.query.trigger_event) filters.trigger_event = req.query.trigger_event;
    if (req.query.project_id) filters.project_id = req.query.project_id;

    var rules = db.listRules(filters);
    res.json(rules);
  });

  // POST /guardrails/rules — Create rule (admin only)
  router.post('/rules', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var name = req.body.name;
    var triggerEvent = req.body.trigger_event;
    if (!name || !triggerEvent) {
      return apiError(res, 400, 'name and trigger_event are required');
    }

    var conditions = req.body.conditions || {};
    if (conditions.type === 'custom') {
      return apiError(res, 400, 'Custom expression rules are disabled for security reasons. Use built-in types: require_field, max_value, require_approval, block_agent');
    }
    var enforcement = req.body.enforcement || 'warn';
    if (enforcement !== 'warn' && enforcement !== 'block') {
      return apiError(res, 400, 'enforcement must be "warn" or "block"');
    }

    var id = db.createRule(
      name,
      req.body.description || '',
      triggerEvent,
      conditions,
      enforcement,
      req.body.project_id || null,
      who
    );
    var rule = db.getRule(id);
    res.json({ ok: true, rule: rule });
  });

  // GET /guardrails/rules/:id — Get rule
  router.get('/rules/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var rule = db.getRule(parseInt(req.params.id));
    if (!rule) return apiError(res, 404, 'Rule not found');
    res.json(rule);
  });

  // PUT /guardrails/rules/:id — Update rule (admin only)
  router.put('/rules/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var rule = db.getRule(parseInt(req.params.id));
    if (!rule) return apiError(res, 404, 'Rule not found');

    var fields = {};
    if (req.body.name !== undefined) fields.name = req.body.name;
    if (req.body.description !== undefined) fields.description = req.body.description;
    if (req.body.conditions !== undefined) fields.conditions = req.body.conditions;
    if (req.body.enforcement !== undefined) {
      if (req.body.enforcement !== 'warn' && req.body.enforcement !== 'block') {
        return apiError(res, 400, 'enforcement must be "warn" or "block"');
      }
      fields.enforcement = req.body.enforcement;
    }
    if (req.body.enabled !== undefined) fields.enabled = req.body.enabled ? 1 : 0;
    if (req.body.trigger_event !== undefined) fields.trigger_event = req.body.trigger_event;
    if (req.body.project_id !== undefined) fields.project_id = req.body.project_id;

    db.updateRule(parseInt(req.params.id), fields);
    var updated = db.getRule(parseInt(req.params.id));
    res.json({ ok: true, rule: updated });
  });

  // DELETE /guardrails/rules/:id — Delete rule (admin only)
  router.delete('/rules/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var rule = db.getRule(parseInt(req.params.id));
    if (!rule) return apiError(res, 404, 'Rule not found');

    db.deleteRule(parseInt(req.params.id));
    res.json({ ok: true, deleted: parseInt(req.params.id) });
  });

  // GET /guardrails/violations — List violations
  router.get('/violations', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var violations = db.listViolations({
      rule_id: req.query.rule_id ? parseInt(req.query.rule_id) : undefined,
      agent_id: req.query.agent_id || undefined,
      project_id: req.query.project_id || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });
    res.json(violations);
  });

  // GET /guardrails/violations/:id — Get violation
  router.get('/violations/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var violation = db.getViolation(parseInt(req.params.id));
    if (!violation) return apiError(res, 404, 'Violation not found');
    res.json(violation);
  });

  // POST /guardrails/violations/:id/override — Override a violation (admin only, gated)
  router.post('/violations/:id/override', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var violation = db.getViolation(parseInt(req.params.id));
    if (!violation) return apiError(res, 404, 'Violation not found');
    if (violation.overridden) return apiError(res, 400, 'Violation already overridden');

    db.overrideViolation(parseInt(req.params.id), who);
    var updated = db.getViolation(parseInt(req.params.id));
    res.json({ ok: true, violation: updated });
  });

  // GET /guardrails/stats — Violation statistics
  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var stats = db.getStats();
    stats.top_violators = db.getTopViolators(10);
    res.json(stats);
  });

  // POST /guardrails/check — Manually check an event against all rules
  router.post('/check', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var eventType = req.body.event_type;
    if (!eventType) return apiError(res, 400, 'event_type is required');

    var eventData = {
      type: eventType,
      data: req.body.data || {},
      agent: req.body.agent || who,
      project_id: req.body.project_id || ''
    };

    var rules = db.listRules({ enabled: 1 });
    var results = [];

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.trigger_event !== '*' && rule.trigger_event !== eventType) continue;
      if (rule.project_id && rule.project_id !== (eventData.project_id || '')) continue;

      var result = evaluateCondition(rule.conditions, eventData);
      results.push({
        rule_id: rule.id,
        rule_name: rule.name,
        enforcement: rule.enforcement,
        violated: result.violated,
        detail: result.detail || null
      });
    }

    res.json({ event_type: eventType, results: results });
  });

  // GET /guardrails/widgets/violations — Widget: violation count last 24h
  router.get('/widgets/violations', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var stats = db.getStats();
    var blockCount = 0;
    var warnCount = 0;
    for (var i = 0; i < stats.by_enforcement.length; i++) {
      if (stats.by_enforcement[i].enforcement === 'block') blockCount = stats.by_enforcement[i].count;
      if (stats.by_enforcement[i].enforcement === 'warn') warnCount = stats.by_enforcement[i].count;
    }

    var color = blockCount > 0 ? 'red' : stats.last_24h > 0 ? 'yellow' : 'green';

    res.json({
      type: 'stat',
      value: String(stats.last_24h),
      label: 'Violations (24h)',
      trend: blockCount + ' blocked, ' + warnCount + ' warnings (all time)',
      color: color
    });
  });

  return router;
}
