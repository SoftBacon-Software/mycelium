// Cost Tracker event handlers
// Subscribes to agent heartbeats to auto-record token usage.

import createCostDB from './db.js';

function getWeekStart() {
  var now = new Date();
  var day = now.getDay();
  var diff = now.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(now.getFullYear(), now.getMonth(), diff).toISOString().split('T')[0];
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

export function registerHooks(core) {
  var db = createCostDB(core.db);

  core.onEvent('agent_heartbeat', function (eventData) {
    try {
      var data = eventData.data || {};
      var tokens = data.tokens || data.token_usage;
      if (!tokens) return;
      if (!tokens.input && !tokens.output) return;

      // Get pricing config
      var getConfig = function (key, fallback) {
        var row = core.db.prepare(
          "SELECT value FROM dv_plugin_config WHERE plugin_name = 'cost-tracker' AND key = ?"
        ).get(key);
        return row ? parseFloat(row.value) : fallback;
      };
      var priceInput = getConfig('price_input_mtok', 15) / 1000000;
      var priceOutput = getConfig('price_output_mtok', 75) / 1000000;
      var priceCache = getConfig('price_cache_read_mtok', 1.5) / 1000000;

      var input = parseInt(tokens.input) || 0;
      var output = parseInt(tokens.output) || 0;
      var cache = parseInt(tokens.cache_read) || 0;
      var cost = (input * priceInput) + (output * priceOutput) + (cache * priceCache);

      var agentId = data.agent_id || eventData.agent || '';
      var projectId = data.project_id || eventData.project_id || '';

      db.recordUsage(agentId, projectId, null, input, output, cache, cost, data.session_id || '');

      // Check budgets
      var config = {};
      var rows = core.db.prepare(
        "SELECT key, value FROM dv_plugin_config WHERE plugin_name = 'cost-tracker'"
      ).all();
      for (var r of rows) config[r.key] = r.value;
      checkBudgetAlerts(db, core, config);

      console.log('[cost-tracker] Recorded ' + input + '/' + output + ' tokens for ' + agentId + ' ($' + cost.toFixed(4) + ')');
    } catch (e) {
      console.error('[cost-tracker] Heartbeat hook error:', e.message);
    }
  });
}
