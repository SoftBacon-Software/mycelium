// Daily Digest plugin DB helpers

export default function createDigestDB(db) {
  return {
    createReport(type, periodStart, periodEnd, content, summary) {
      var r = db.prepare(
        'INSERT INTO dv_digest_reports (digest_type, period_start, period_end, content, summary) VALUES (?, ?, ?, ?, ?) RETURNING id'
      ).get(type, periodStart, periodEnd, JSON.stringify(content), summary);
      return r.id;
    },

    getReport(id) {
      var row = db.prepare('SELECT * FROM dv_digest_reports WHERE id = ?').get(id);
      if (!row) return null;
      try { row.content = JSON.parse(row.content); } catch (e) { row.content = {}; }
      try { row.delivered_to = JSON.parse(row.delivered_to); } catch (e) { row.delivered_to = []; }
      return row;
    },

    listReports(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.type) { where.push('digest_type = ?'); params.push(filters.type); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      var rows = db.prepare(
        'SELECT * FROM dv_digest_reports WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(...params, limit, offset);
      return rows.map(function (row) {
        try { row.content = JSON.parse(row.content); } catch (e) { row.content = {}; }
        try { row.delivered_to = JSON.parse(row.delivered_to); } catch (e) { row.delivered_to = []; }
        return row;
      });
    },

    getLatestReport(type) {
      var row = db.prepare(
        'SELECT * FROM dv_digest_reports WHERE digest_type = ? ORDER BY created_at DESC LIMIT 1'
      ).get(type);
      if (!row) return null;
      try { row.content = JSON.parse(row.content); } catch (e) { row.content = {}; }
      try { row.delivered_to = JSON.parse(row.delivered_to); } catch (e) { row.delivered_to = []; }
      return row;
    },

    updateReportDelivery(id, deliveredTo) {
      db.prepare('UPDATE dv_digest_reports SET delivered_to = ? WHERE id = ?').run(
        JSON.stringify(deliveredTo), id
      );
    },

    recordMetric(metricType, metricKey, value, period) {
      db.prepare(
        'INSERT INTO dv_digest_metrics (metric_type, metric_key, value, period) VALUES (?, ?, ?, ?)'
      ).run(metricType, metricKey, value, period);
    },

    getMetrics(metricType, period) {
      return db.prepare(
        'SELECT * FROM dv_digest_metrics WHERE metric_type = ? AND period = ? ORDER BY recorded_at DESC'
      ).all(metricType, period);
    },

    getTrends(metricType, limit) {
      return db.prepare(
        'SELECT period, SUM(value) as total FROM dv_digest_metrics WHERE metric_type = ? GROUP BY period ORDER BY period DESC LIMIT ?'
      ).all(metricType, limit || 14);
    }
  };
}
