// Cost Tracker plugin routes
// Record token usage, view spend summaries, budget alerts, and dashboard widgets.

import { Router } from 'express';
import createCostDB from './db.js';

function getWeekStart() {
  var now = new Date();
  var day = now.getDay();
  var diff = now.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(now.getFullYear(), now.getMonth(), diff).toISOString().split('T')[0];
}

function getConfigValue(coreDb, key, fallback) {
  var row = coreDb.prepare(
    "SELECT value FROM dv_plugin_config WHERE plugin_name = 'cost-tracker' AND key = ?"
  ).get(key);
  return row ? parseFloat(row.value) : fallback;
}

function getAllConfig(coreDb) {
  var config = {};
  var rows = coreDb.prepare(
    "SELECT key, value FROM dv_plugin_config WHERE plugin_name = 'cost-tracker'"
  ).all();
  for (var r of rows) config[r.key] = r.value;
  return config;
}

function checkBudgetAlerts(db, core, config) {
  var alertThreshold = parseFloat(config.alert_threshold_pct || 80) / 100;

  // Daily budget check
  var dailyBudget = parseFloat(config.budget_daily || 0);
  if (dailyBudget > 0) {
    var todaySpend = db.getSpendToday();
    var pct = todaySpend / dailyBudget;
    if (pct >= alertThreshold) {
      var today = new Date().toISOString().split('T')[0];
      var existing = core.db.prepare(
        "SELECT id FROM dv_cost_alerts WHERE alert_type = 'daily_budget' AND triggered_at >= ?"
      ).get(today);
      if (!existing) {
        db.logAlert('daily_budget', pct * 100, todaySpend, dailyBudget);
        core.inbox.createInboxItemForAllOperators(
          'cost_alert', 'cost_alert', 'daily_' + today,
          'Daily budget alert: $' + todaySpend.toFixed(2) + ' / $' + dailyBudget.toFixed(2),
          Math.round(pct * 100) + '% of daily budget used',
          { spend: todaySpend, budget: dailyBudget, pct: Math.round(pct * 100) },
          pct >= 1.0 ? 'urgent' : 'normal'
        );
      }
    }
  }

  // Weekly budget check
  var weeklyBudget = parseFloat(config.budget_weekly || 0);
  if (weeklyBudget > 0) {
    var weekSpend = db.getSpendThisWeek();
    var weekPct = weekSpend / weeklyBudget;
    if (weekPct >= alertThreshold) {
      var weekStart = getWeekStart();
      var existingWeek = core.db.prepare(
        "SELECT id FROM dv_cost_alerts WHERE alert_type = 'weekly_budget' AND triggered_at >= ?"
      ).get(weekStart);
      if (!existingWeek) {
        db.logAlert('weekly_budget', weekPct * 100, weekSpend, weeklyBudget);
        core.inbox.createInboxItemForAllOperators(
          'cost_alert', 'cost_alert', 'weekly_' + weekStart,
          'Weekly budget alert: $' + weekSpend.toFixed(2) + ' / $' + weeklyBudget.toFixed(2),
          Math.round(weekPct * 100) + '% of weekly budget used',
          { spend: weekSpend, budget: weeklyBudget, pct: Math.round(weekPct * 100) },
          weekPct >= 1.0 ? 'urgent' : 'normal'
        );
      }
    }
  }
}

export default function (core) {
  var router = Router();
  var db = createCostDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError } = core;

  // POST /costs/record — Record token usage (agent auth)
  router.post('/record', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var inputTokens = parseInt(req.body.input_tokens) || 0;
    var outputTokens = parseInt(req.body.output_tokens) || 0;
    var cacheReadTokens = parseInt(req.body.cache_read_tokens) || 0;
    var taskId = req.body.task_id ? parseInt(req.body.task_id) : null;
    var sessionId = req.body.session_id || '';

    if (inputTokens === 0 && outputTokens === 0) {
      return apiError(res, 400, 'At least input_tokens or output_tokens must be > 0');
    }

    // Calculate cost from config pricing
    var priceInput = getConfigValue(core.db, 'price_input_mtok', 15) / 1000000;
    var priceOutput = getConfigValue(core.db, 'price_output_mtok', 75) / 1000000;
    var priceCache = getConfigValue(core.db, 'price_cache_read_mtok', 1.5) / 1000000;
    var costUsd = (inputTokens * priceInput) + (outputTokens * priceOutput) + (cacheReadTokens * priceCache);

    // Determine agent and project from auth context
    var agentId = req.agentId || who;
    var projectId = req.body.project_id || req.projectId || '';

    var id = db.recordUsage(agentId, projectId, taskId, inputTokens, outputTokens, cacheReadTokens, costUsd, sessionId);

    // Check budget alerts
    var config = getAllConfig(core.db);
    checkBudgetAlerts(db, core, config);

    res.json({ ok: true, id: id, cost_usd: costUsd });
  });

  // GET /costs/summary — Current period summary
  router.get('/summary', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var todaySpend = db.getSpendToday();
    var weekSpend = db.getSpendThisWeek();
    var dailyBudget = getConfigValue(core.db, 'budget_daily', 0);
    var weeklyBudget = getConfigValue(core.db, 'budget_weekly', 0);
    var today = new Date().toISOString().split('T')[0];
    var topAgents = db.getTopAgents(today, today, 5);

    res.json({
      today: {
        spend: todaySpend,
        budget: dailyBudget,
        pct: dailyBudget > 0 ? Math.round((todaySpend / dailyBudget) * 100) : null
      },
      week: {
        spend: weekSpend,
        budget: weeklyBudget,
        pct: weeklyBudget > 0 ? Math.round((weekSpend / weeklyBudget) * 100) : null
      },
      top_agents: topAgents
    });
  });

  // GET /costs/by-agent — Cost breakdown by agent
  router.get('/by-agent', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var dateFrom = req.query.date_from || null;
    var dateTo = req.query.date_to || null;
    var agents = db.getTopAgents(dateFrom, dateTo, 100);
    res.json({ date_from: dateFrom, date_to: dateTo, agents: agents });
  });

  // GET /costs/by-project — Cost breakdown by project
  router.get('/by-project', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var dateFrom = req.query.date_from || null;
    var dateTo = req.query.date_to || null;
    var where = ['1=1'];
    var params = [];
    if (dateFrom) { where.push('date >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('date <= ?'); params.push(dateTo); }
    var projects = core.db.prepare(
      'SELECT project_id, SUM(total_input) as total_input, SUM(total_output) as total_output, ' +
      'SUM(total_cache) as total_cache, SUM(total_cost) as total_cost, SUM(entry_count) as entry_count ' +
      'FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' GROUP BY project_id ORDER BY total_cost DESC'
    ).all.apply(
      core.db.prepare('SELECT project_id, SUM(total_input) as total_input, SUM(total_output) as total_output, ' +
        'SUM(total_cache) as total_cache, SUM(total_cost) as total_cost, SUM(entry_count) as entry_count ' +
        'FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' GROUP BY project_id ORDER BY total_cost DESC'),
      params
    );
    res.json({ date_from: dateFrom, date_to: dateTo, projects: projects });
  });

  // GET /costs/trends — Daily cost trend data
  router.get('/trends', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var days = parseInt(req.query.days) || 14;
    var trend = db.getDailyTrend(days);
    res.json({ days: days, data: trend });
  });

  // GET /costs/entries — Raw cost entries (admin only)
  router.get('/entries', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var entries = db.listEntries({
      agent_id: req.query.agent_id || undefined,
      project_id: req.query.project_id || undefined,
      date_from: req.query.date_from || undefined,
      date_to: req.query.date_to || undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });
    res.json(entries);
  });

  // GET /costs/alerts — Recent budget alerts
  router.get('/alerts', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var limit = parseInt(req.query.limit) || 20;
    var alerts = db.getAlerts(limit);
    res.json(alerts);
  });

  // GET /costs/widgets/spend-today — Widget data for today's spend
  router.get('/widgets/spend-today', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var todaySpend = db.getSpendToday();
    var dailyBudget = getConfigValue(core.db, 'budget_daily', 0);
    var overBudget = dailyBudget > 0 && todaySpend >= dailyBudget;

    // Calculate yesterday's spend for trend
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var yesterdayStr = yesterday.toISOString().split('T')[0];
    var yesterdaySummary = db.getDailySummary(yesterdayStr);
    var yesterdaySpend = 0;
    for (var s of yesterdaySummary) { yesterdaySpend += s.total_cost; }
    var diff = todaySpend - yesterdaySpend;
    var trend = (diff >= 0 ? '+$' : '-$') + Math.abs(diff).toFixed(2) + ' vs yesterday';

    res.json({
      type: 'stat',
      value: '$' + todaySpend.toFixed(2),
      label: 'Spend Today',
      trend: trend,
      color: overBudget ? 'red' : 'green'
    });
  });

  // GET /costs/widgets/budget-status — Widget data for budget usage percentage
  router.get('/widgets/budget-status', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var todaySpend = db.getSpendToday();
    var dailyBudget = getConfigValue(core.db, 'budget_daily', 0);

    if (dailyBudget <= 0) {
      return res.json({
        type: 'stat',
        value: 'No limit',
        label: 'Daily Budget Used',
        color: 'green'
      });
    }

    var pct = Math.round((todaySpend / dailyBudget) * 100);
    var color = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green';

    res.json({
      type: 'stat',
      value: pct + '%',
      label: 'Daily Budget Used',
      color: color
    });
  });

  return router;
}
