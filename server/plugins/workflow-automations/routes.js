// Workflow Automations plugin routes
// CRUD for automation rules, execution log, templates, and manual triggers.

import { Router } from 'express';
import createAutomationDB from './db.js';
import { evaluateConditions, executeAction } from './handlers.js';

export default function (core) {
  var router = Router();
  var db = createAutomationDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  // GET /automations/rules — list rules
  router.get('/rules', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {};
    if (req.query.enabled !== undefined) filters.enabled = req.query.enabled === 'true' || req.query.enabled === '1' ? 1 : 0;
    if (req.query.trigger_event) filters.trigger_event = req.query.trigger_event;
    if (req.query.project_id) filters.project_id = req.query.project_id;
    res.json(db.listRules(filters));
  });

  // POST /automations/rules — create rule
  router.post('/rules', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    if (!req.body.name || !req.body.trigger_event) {
      return apiError(res, 400, 'name and trigger_event are required');
    }
    var id = db.createRule(
      req.body.name,
      req.body.description || '',
      req.body.trigger_event,
      req.body.conditions || {},
      req.body.actions || [],
      req.body.project_id || null,
      who
    );
    core.emitEvent('automation_rule_created', who, req.body.project_id || '',
      who + ' created automation rule: ' + req.body.name, { rule_id: id });
    res.json({ ok: true, id: id, rule: db.getRule(id) });
  });

  // GET /automations/rules/:id — get rule
  router.get('/rules/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var rule = db.getRule(parseIntParam(req.params.id));
    if (!rule) return apiError(res, 404, 'Rule not found');
    res.json(rule);
  });

  // PUT /automations/rules/:id — update rule
  router.put('/rules/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.getRule(id)) return apiError(res, 404, 'Rule not found');
    var updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.trigger_event !== undefined) updates.trigger_event = req.body.trigger_event;
    if (req.body.conditions !== undefined) updates.conditions = req.body.conditions;
    if (req.body.actions !== undefined) updates.actions = req.body.actions;
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
    if (req.body.project_id !== undefined) updates.project_id = req.body.project_id;
    db.updateRule(id, updates);
    res.json({ ok: true, rule: db.getRule(id) });
  });

  // DELETE /automations/rules/:id — delete rule
  router.delete('/rules/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var rule = db.getRule(id);
    if (!rule) return apiError(res, 404, 'Rule not found');
    db.deleteRule(id);
    core.emitEvent('automation_rule_deleted', who, rule.project_id || '',
      who + ' deleted automation rule: ' + rule.name, { rule_id: id });
    res.json({ ok: true });
  });

  // POST /automations/rules/:id/test — test rule against sample event data
  router.post('/rules/:id/test', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var rule = db.getRule(parseIntParam(req.params.id));
    if (!rule) return apiError(res, 404, 'Rule not found');
    var eventData = req.body.event_data || {};
    if (!eventData.type) eventData.type = rule.trigger_event;
    var matched = evaluateConditions(rule.conditions, eventData);
    res.json({
      ok: true,
      rule_id: rule.id,
      rule_name: rule.name,
      matched: matched,
      conditions: rule.conditions,
      event_data: eventData,
      actions_count: rule.actions.length,
      note: matched ? 'Conditions matched — actions would execute' : 'Conditions did not match — no actions would execute'
    });
  });

  // POST /automations/rules/:id/trigger — manually trigger a rule
  router.post('/rules/:id/trigger', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var rule = db.getRule(parseIntParam(req.params.id));
    if (!rule) return apiError(res, 404, 'Rule not found');
    var eventData = req.body.event_data || {};
    if (!eventData.type) eventData.type = rule.trigger_event;
    if (!eventData.agent) eventData.agent = who;

    var actionResults = [];
    var status = 'success';
    var error = '';
    var actions = rule.actions || [];

    for (var i = 0; i < actions.length; i++) {
      try {
        var result = executeAction(actions[i], eventData, core);
        actionResults.push(result);
      } catch (e) {
        actionResults.push({ type: actions[i].type, error: e.message });
        status = 'error';
        error = e.message;
      }
    }

    db.incrementRunCount(rule.id);
    db.logExecution(rule.id, rule.name, eventData.type || rule.trigger_event, 1, actionResults, eventData, status, error, 0);

    core.emitEvent('automation_triggered', who, eventData.project_id || '',
      'Automation "' + rule.name + '" manually triggered by ' + who,
      { rule_id: rule.id, rule_name: rule.name, actions: actionResults.length, manual: true });

    res.json({ ok: true, rule_id: rule.id, status: status, actions: actionResults, error: error || undefined });
  });

  // GET /automations/log — execution log
  router.get('/log', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listLog({
      rule_id: req.query.rule_id ? parseInt(req.query.rule_id) : undefined,
      status: req.query.status || undefined,
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /automations/stats — execution stats
  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.getLogStats());
  });

  // GET /automations/templates — list built-in templates
  router.get('/templates', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listTemplates(req.query.category || undefined));
  });

  // POST /automations/rules/from-template/:templateId — create rule from template
  router.post('/rules/from-template/:templateId', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var template = db.getTemplate(parseIntParam(req.params.templateId));
    if (!template) return apiError(res, 404, 'Template not found');
    var id = db.createRule(
      req.body.name || template.name,
      req.body.description || template.description,
      template.trigger_event,
      req.body.conditions || template.conditions,
      req.body.actions || template.actions,
      req.body.project_id || null,
      who
    );
    core.emitEvent('automation_rule_created', who, req.body.project_id || '',
      who + ' created automation rule from template: ' + template.name, { rule_id: id, template_id: template.id });
    res.json({ ok: true, id: id, rule: db.getRule(id), template_id: template.id });
  });

  // GET /automations/widgets/activity — widget data: automations triggered last 24h
  router.get('/widgets/activity', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var stats = db.getLogStats();
    var recentLogs = db.listLog({ limit: 10 });
    res.json({
      triggered_last_24h: stats.last_24h,
      by_status: stats.by_status,
      top_rules: stats.by_rule.slice(0, 5),
      recent: recentLogs
    });
  });

  return router;
}
