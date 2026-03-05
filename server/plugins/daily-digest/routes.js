// Daily Digest plugin routes
// Generate, view, and deliver daily/weekly swarm activity summaries.

import { Router } from 'express';
import createDigestDB from './db.js';

function gatherDigestData(db, coreDb, periodStart, periodEnd) {
  // Query dv_tasks for completed tasks in period
  var tasks = coreDb.prepare(
    "SELECT * FROM dv_tasks WHERE status = 'done' AND updated_at BETWEEN ? AND ?"
  ).all(periodStart, periodEnd);

  // Query dv_bugs for fixed bugs
  var bugs = coreDb.prepare(
    "SELECT * FROM dv_bugs WHERE status = 'fixed' AND updated_at BETWEEN ? AND ?"
  ).all(periodStart, periodEnd);

  // Query dv_plan_steps for completed steps
  var steps = coreDb.prepare(
    "SELECT ps.*, p.title as plan_title FROM dv_plan_steps ps JOIN dv_plans p ON ps.plan_id = p.id WHERE ps.status = 'completed' AND ps.updated_at BETWEEN ? AND ?"
  ).all(periodStart, periodEnd);

  // Query dv_agents for agent activity (heartbeat counts)
  var agents = coreDb.prepare(
    "SELECT id, display_name, status, working_on, last_heartbeat FROM dv_agents"
  ).all();

  // Query messages sent in period
  var messageCount = coreDb.prepare(
    "SELECT COUNT(*) as count FROM dv_messages WHERE created_at BETWEEN ? AND ?"
  ).get(periodStart, periodEnd).count;

  // Build per-agent stats
  var agentStats = {};
  for (var t of tasks) {
    var a = t.assignee || 'unassigned';
    if (!agentStats[a]) agentStats[a] = { tasks: 0, bugs: 0, steps: 0 };
    agentStats[a].tasks++;
  }
  for (var b of bugs) {
    var a2 = b.assignee || 'unassigned';
    if (!agentStats[a2]) agentStats[a2] = { tasks: 0, bugs: 0, steps: 0 };
    agentStats[a2].bugs++;
  }
  for (var s of steps) {
    var a3 = s.assignee || 'unassigned';
    if (!agentStats[a3]) agentStats[a3] = { tasks: 0, bugs: 0, steps: 0 };
    agentStats[a3].steps++;
  }

  return {
    period: { start: periodStart, end: periodEnd },
    tasks_completed: tasks.length,
    bugs_fixed: bugs.length,
    plan_steps_completed: steps.length,
    messages_sent: messageCount,
    agent_count: agents.length,
    agents_online: agents.filter(function (a) { return a.status === 'online'; }).length,
    agent_stats: agentStats,
    tasks: tasks.map(function (t) { return { id: t.id, title: t.title, assignee: t.assignee }; }),
    bugs: bugs.map(function (b) { return { id: b.id, title: b.title, assignee: b.assignee }; }),
    steps: steps.map(function (s) { return { id: s.id, title: s.title, plan_title: s.plan_title, assignee: s.assignee }; })
  };
}

function buildSummary(data) {
  var lines = [];
  lines.push('Period: ' + data.period.start + ' to ' + data.period.end);
  lines.push('');
  lines.push('Tasks completed: ' + data.tasks_completed);
  lines.push('Bugs fixed: ' + data.bugs_fixed);
  lines.push('Plan steps advanced: ' + data.plan_steps_completed);
  lines.push('Messages sent: ' + data.messages_sent);
  lines.push('Agents: ' + data.agents_online + '/' + data.agent_count + ' online');

  if (Object.keys(data.agent_stats).length > 0) {
    lines.push('');
    lines.push('Agent breakdown:');
    for (var agent in data.agent_stats) {
      var s = data.agent_stats[agent];
      lines.push('  ' + agent + ': ' + s.tasks + ' tasks, ' + s.bugs + ' bugs, ' + s.steps + ' steps');
    }
  }
  return lines.join('\n');
}

function getPeriodRange(type) {
  var now = new Date();
  var end = now.toISOString().replace('T', ' ').substring(0, 19);
  var start;
  if (type === 'weekly') {
    var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    start = weekAgo.toISOString().replace('T', ' ').substring(0, 19);
  } else {
    var dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    start = dayAgo.toISOString().replace('T', ' ').substring(0, 19);
  }
  return { start: start, end: end };
}

function getPeriodLabel(periodStart, periodEnd) {
  return periodStart.substring(0, 10) + ' to ' + periodEnd.substring(0, 10);
}

export default function (core) {
  var router = Router();
  var db = createDigestDB(core.db);
  var { apiError, parseIntParam } = core;
  var { checkAgentOrAdmin, checkAdmin } = core.auth;

  // GET /digest/reports — list digest reports
  router.get('/reports', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listReports({
      type: req.query.type || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    }));
  });

  // GET /digest/reports/:id — get single report
  router.get('/reports/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var report = db.getReport(parseIntParam(req.params.id));
    if (!report) return apiError(res, 404, 'Report not found');
    res.json(report);
  });

  // POST /digest/generate — manually trigger digest generation
  router.post('/generate', async function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var digestType = req.body.type || 'daily';
    if (digestType !== 'daily' && digestType !== 'weekly') {
      return apiError(res, 400, 'type must be daily or weekly');
    }

    try {
      var range = getPeriodRange(digestType);
      var data = gatherDigestData(db, core.db, range.start, range.end);
      var summary = buildSummary(data);
      var periodLabel = getPeriodLabel(range.start, range.end);

      // Store report
      var reportId = db.createReport(digestType, range.start, range.end, data, summary);

      // Record aggregate metrics
      var today = new Date().toISOString().substring(0, 10);
      db.recordMetric('tasks_completed', 'total', data.tasks_completed, today);
      db.recordMetric('bugs_fixed', 'total', data.bugs_fixed, today);
      db.recordMetric('plan_steps_completed', 'total', data.plan_steps_completed, today);
      db.recordMetric('messages_sent', 'total', data.messages_sent, today);

      // Deliver to operator inbox
      var deliveredTo = ['inbox'];
      core.inbox.createInboxItemForAllOperators(
        'digest_report', 'digest', String(reportId),
        digestType + ' digest — ' + periodLabel,
        summary.substring(0, 300),
        { report_id: reportId, digest_type: digestType, tasks_completed: data.tasks_completed, bugs_fixed: data.bugs_fixed },
        'normal'
      );

      // Optional Slack delivery
      var slackWebhook = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'daily-digest' AND key = 'slack_webhook'").get();
      if (slackWebhook && slackWebhook.value) {
        try {
          await fetch(slackWebhook.value, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '*' + digestType + ' Digest*\n' + summary })
          });
          deliveredTo.push('slack');
        } catch (e) {
          console.error('[daily-digest] Slack delivery failed:', e.message);
        }
      }

      // Update delivery record
      db.updateReportDelivery(reportId, deliveredTo);

      core.emitEvent('digest_generated', who, null,
        who + ' generated ' + digestType + ' digest #' + reportId,
        { report_id: reportId, digest_type: digestType });

      res.json({ ok: true, report_id: reportId, digest_type: digestType, summary: summary, delivered_to: deliveredTo });
    } catch (e) {
      console.error('[daily-digest] Generation failed:', e.message);
      return apiError(res, 500, 'Digest generation failed: ' + e.message);
    }
  });

  // GET /digest/preview — preview what the next digest would contain
  router.get('/preview', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var digestType = req.query.type || 'daily';
    if (digestType !== 'daily' && digestType !== 'weekly') {
      return apiError(res, 400, 'type must be daily or weekly');
    }

    try {
      var range = getPeriodRange(digestType);
      var data = gatherDigestData(db, core.db, range.start, range.end);
      var summary = buildSummary(data);
      res.json({ digest_type: digestType, data: data, summary: summary });
    } catch (e) {
      console.error('[daily-digest] Preview failed:', e.message);
      return apiError(res, 500, 'Preview failed: ' + e.message);
    }
  });

  // POST /digest/deliver/:id — re-deliver a report to inbox/slack
  router.post('/deliver/:id', async function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var report = db.getReport(parseIntParam(req.params.id));
    if (!report) return apiError(res, 404, 'Report not found');

    try {
      var periodLabel = getPeriodLabel(report.period_start, report.period_end);
      var deliveredTo = ['inbox'];

      // Re-deliver to operator inbox
      core.inbox.createInboxItemForAllOperators(
        'digest_report', 'digest', String(report.id),
        report.digest_type + ' digest — ' + periodLabel,
        report.summary.substring(0, 300),
        { report_id: report.id, digest_type: report.digest_type, tasks_completed: report.content.tasks_completed, bugs_fixed: report.content.bugs_fixed },
        'normal'
      );

      // Optional Slack re-delivery
      var slackWebhook = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'daily-digest' AND key = 'slack_webhook'").get();
      if (slackWebhook && slackWebhook.value) {
        try {
          await fetch(slackWebhook.value, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '*' + report.digest_type + ' Digest (re-sent)*\n' + report.summary })
          });
          deliveredTo.push('slack');
        } catch (e) {
          console.error('[daily-digest] Slack re-delivery failed:', e.message);
        }
      }

      db.updateReportDelivery(report.id, deliveredTo);
      res.json({ ok: true, report_id: report.id, delivered_to: deliveredTo });
    } catch (e) {
      console.error('[daily-digest] Re-delivery failed:', e.message);
      return apiError(res, 500, 'Re-delivery failed: ' + e.message);
    }
  });

  // GET /digest/trends — get trend data for dashboard charts
  router.get('/trends', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var metric = req.query.metric || 'tasks_completed';
    var validMetrics = ['tasks_completed', 'bugs_fixed', 'plan_steps_completed', 'messages_sent'];
    if (validMetrics.indexOf(metric) === -1) {
      return apiError(res, 400, 'metric must be one of: ' + validMetrics.join(', '));
    }

    var periods = parseInt(req.query.periods) || 14;
    var trends = db.getTrends(metric, periods);
    res.json({ metric: metric, periods: periods, data: trends });
  });

  // GET /digest/widgets/velocity — widget data: today's velocity
  router.get('/widgets/velocity', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var today = new Date().toISOString().substring(0, 10);
    var tasksMetrics = db.getMetrics('tasks_completed', today);
    var bugsMetrics = db.getMetrics('bugs_fixed', today);

    var tasksDone = 0;
    for (var tm of tasksMetrics) { tasksDone += tm.value; }
    var bugsDone = 0;
    for (var bm of bugsMetrics) { bugsDone += bm.value; }

    res.json({ date: today, tasks_completed: tasksDone, bugs_fixed: bugsDone });
  });

  return router;
}
