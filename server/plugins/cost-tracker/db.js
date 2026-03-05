// Cost Tracker plugin DB helpers

export default function createCostDB(db) {
  return {
    recordUsage(agentId, projectId, taskId, inputTokens, outputTokens, cacheReadTokens, costUsd, sessionId) {
      var r = db.prepare(
        'INSERT INTO dv_cost_entries (agent_id, project_id, task_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        agentId || '', projectId || '', taskId || null,
        inputTokens || 0, outputTokens || 0, cacheReadTokens || 0,
        costUsd || 0, sessionId || ''
      );

      // Upsert daily aggregate
      var today = new Date().toISOString().split('T')[0];
      db.prepare(
        "INSERT INTO dv_cost_daily (date, agent_id, project_id, total_input, total_output, total_cache, total_cost, entry_count) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1) " +
        "ON CONFLICT(date, agent_id, project_id) DO UPDATE SET " +
        "total_input = total_input + excluded.total_input, " +
        "total_output = total_output + excluded.total_output, " +
        "total_cache = total_cache + excluded.total_cache, " +
        "total_cost = total_cost + excluded.total_cost, " +
        "entry_count = entry_count + 1, " +
        "updated_at = datetime('now')"
      ).run(today, agentId || '', projectId || '', inputTokens || 0, outputTokens || 0, cacheReadTokens || 0, costUsd || 0);

      return r.id;
    },

    getEntry(id) {
      return db.prepare('SELECT * FROM dv_cost_entries WHERE id = ?').get(id);
    },

    listEntries(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.agent_id) { where.push('agent_id = ?'); params.push(filters.agent_id); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.date_from) { where.push('recorded_at >= ?'); params.push(filters.date_from); }
      if (filters.date_to) { where.push('recorded_at <= ?'); params.push(filters.date_to + 'T23:59:59'); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      params.push(limit, offset);
      return db.prepare(
        'SELECT * FROM dv_cost_entries WHERE ' + where.join(' AND ') +
        ' ORDER BY recorded_at DESC LIMIT ? OFFSET ?'
      ).all.apply(
        db.prepare('SELECT * FROM dv_cost_entries WHERE ' + where.join(' AND ') + ' ORDER BY recorded_at DESC LIMIT ? OFFSET ?'),
        params
      );
    },

    getDailySummary(date) {
      return db.prepare('SELECT * FROM dv_cost_daily WHERE date = ?').all(date);
    },

    getAgentCosts(agentId, dateFrom, dateTo) {
      var where = ['agent_id = ?'];
      var params = [agentId];
      if (dateFrom) { where.push('date >= ?'); params.push(dateFrom); }
      if (dateTo) { where.push('date <= ?'); params.push(dateTo); }
      return db.prepare(
        'SELECT * FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' ORDER BY date DESC'
      ).all.apply(
        db.prepare('SELECT * FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' ORDER BY date DESC'),
        params
      );
    },

    getProjectCosts(projectId, dateFrom, dateTo) {
      var where = ['project_id = ?'];
      var params = [projectId];
      if (dateFrom) { where.push('date >= ?'); params.push(dateFrom); }
      if (dateTo) { where.push('date <= ?'); params.push(dateTo); }
      return db.prepare(
        'SELECT * FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' ORDER BY date DESC'
      ).all.apply(
        db.prepare('SELECT * FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' ORDER BY date DESC'),
        params
      );
    },

    getTotalCosts(dateFrom, dateTo) {
      var where = ['1=1'];
      var params = [];
      if (dateFrom) { where.push('date >= ?'); params.push(dateFrom); }
      if (dateTo) { where.push('date <= ?'); params.push(dateTo); }
      var row = db.prepare(
        'SELECT COALESCE(SUM(total_input), 0) as total_input, COALESCE(SUM(total_output), 0) as total_output, ' +
        'COALESCE(SUM(total_cache), 0) as total_cache, COALESCE(SUM(total_cost), 0) as total_cost, ' +
        'COALESCE(SUM(entry_count), 0) as entry_count FROM dv_cost_daily WHERE ' + where.join(' AND ')
      ).get.apply(
        db.prepare('SELECT COALESCE(SUM(total_input), 0) as total_input, COALESCE(SUM(total_output), 0) as total_output, ' +
          'COALESCE(SUM(total_cache), 0) as total_cache, COALESCE(SUM(total_cost), 0) as total_cost, ' +
          'COALESCE(SUM(entry_count), 0) as entry_count FROM dv_cost_daily WHERE ' + where.join(' AND ')),
        params
      );
      return row;
    },

    getSpendToday() {
      var today = new Date().toISOString().split('T')[0];
      var row = db.prepare(
        'SELECT COALESCE(SUM(total_cost), 0) as spend FROM dv_cost_daily WHERE date = ?'
      ).get(today);
      return row.spend;
    },

    getSpendThisWeek() {
      var weekStart = getWeekStart();
      var row = db.prepare(
        'SELECT COALESCE(SUM(total_cost), 0) as spend FROM dv_cost_daily WHERE date >= ?'
      ).get(weekStart);
      return row.spend;
    },

    getDailyTrend(days) {
      var d = days || 14;
      return db.prepare(
        'SELECT date, SUM(total_input) as total_input, SUM(total_output) as total_output, ' +
        'SUM(total_cache) as total_cache, SUM(total_cost) as total_cost, SUM(entry_count) as entry_count ' +
        'FROM dv_cost_daily WHERE date >= date("now", "-" || ? || " days") ' +
        'GROUP BY date ORDER BY date ASC'
      ).all(d);
    },

    getTopAgents(dateFrom, dateTo, limit) {
      var where = ['1=1'];
      var params = [];
      if (dateFrom) { where.push('date >= ?'); params.push(dateFrom); }
      if (dateTo) { where.push('date <= ?'); params.push(dateTo); }
      var lim = limit || 10;
      params.push(lim);
      return db.prepare(
        'SELECT agent_id, SUM(total_input) as total_input, SUM(total_output) as total_output, ' +
        'SUM(total_cache) as total_cache, SUM(total_cost) as total_cost, SUM(entry_count) as entry_count ' +
        'FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' GROUP BY agent_id ORDER BY total_cost DESC LIMIT ?'
      ).all.apply(
        db.prepare('SELECT agent_id, SUM(total_input) as total_input, SUM(total_output) as total_output, ' +
          'SUM(total_cache) as total_cache, SUM(total_cost) as total_cost, SUM(entry_count) as entry_count ' +
          'FROM dv_cost_daily WHERE ' + where.join(' AND ') + ' GROUP BY agent_id ORDER BY total_cost DESC LIMIT ?'),
        params
      );
    },

    logAlert(alertType, thresholdPct, currentSpend, budgetLimit) {
      db.prepare(
        'INSERT INTO dv_cost_alerts (alert_type, threshold_pct, current_spend, budget_limit) VALUES (?, ?, ?, ?)'
      ).run(alertType, thresholdPct, currentSpend, budgetLimit);
    },

    getAlerts(limit) {
      var lim = limit || 20;
      return db.prepare(
        'SELECT * FROM dv_cost_alerts ORDER BY triggered_at DESC LIMIT ?'
      ).all(lim);
    }
  };
}

function getWeekStart() {
  var now = new Date();
  var day = now.getDay();
  var diff = now.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(now.getFullYear(), now.getMonth(), diff).toISOString().split('T')[0];
}
