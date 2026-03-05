// Error Monitor plugin DB helpers — factory receives raw better-sqlite3 handle

export default function createErrorDB(db) {
  var _stmts = {};
  function stmt(key, sql) {
    if (!_stmts[key]) _stmts[key] = db.prepare(sql);
    return _stmts[key];
  }

  return {
    logError(provider, errorKey, title, message, stackTrace, url, payload) {
      var existing = stmt('emGetByKey',
        'SELECT id, occurrences FROM dv_error_events WHERE error_key = ?'
      ).get(errorKey);

      if (existing) {
        stmt('emBump',
          "UPDATE dv_error_events SET occurrences = occurrences + 1, last_seen = datetime('now'), payload = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(payload || {}), existing.id);
        return { id: existing.id, is_new: false, occurrences: existing.occurrences + 1 };
      }

      var r = stmt('emInsert',
        'INSERT INTO dv_error_events (provider, error_key, title, message, stack_trace, url, payload) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        provider || '', errorKey || '', title || '', message || '',
        stackTrace || '', url || '', JSON.stringify(payload || {})
      );
      return { id: r.id, is_new: true, occurrences: 1 };
    },

    getError(id) {
      var row = stmt('emGet', 'SELECT * FROM dv_error_events WHERE id = ?').get(id);
      if (row) {
        try { row.payload = JSON.parse(row.payload); } catch (e) { row.payload = {}; }
      }
      return row;
    },

    getErrorByKey(errorKey) {
      var row = stmt('emGetByKey2', 'SELECT * FROM dv_error_events WHERE error_key = ?').get(errorKey);
      if (row) {
        try { row.payload = JSON.parse(row.payload); } catch (e) { row.payload = {}; }
      }
      return row;
    },

    listErrors(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.provider) { where.push('provider = ?'); params.push(filters.provider); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      params.push(limit, offset);
      var rows = db.prepare(
        'SELECT * FROM dv_error_events WHERE ' + where.join(' AND ') +
        ' ORDER BY last_seen DESC LIMIT ? OFFSET ?'
      ).all(...params);
      return rows.map(function (row) {
        try { row.payload = JSON.parse(row.payload); } catch (e) { row.payload = {}; }
        return row;
      });
    },

    updateError(id, fields) {
      var sets = [];
      var values = [];
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.bug_id !== undefined) { sets.push('bug_id = ?'); values.push(fields.bug_id); }
      if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
      if (fields.message !== undefined) { sets.push('message = ?'); values.push(fields.message); }
      if (fields.stack_trace !== undefined) { sets.push('stack_trace = ?'); values.push(fields.stack_trace); }
      if (fields.url !== undefined) { sets.push('url = ?'); values.push(fields.url); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE dv_error_events SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    muteError(id) {
      stmt('emMute',
        "UPDATE dv_error_events SET status = 'muted', updated_at = datetime('now') WHERE id = ?"
      ).run(id);
    },

    resolveError(id) {
      stmt('emResolve',
        "UPDATE dv_error_events SET status = 'resolved', updated_at = datetime('now') WHERE id = ?"
      ).run(id);
    },

    getStats() {
      var byProvider = db.prepare(
        'SELECT provider, COUNT(*) as count FROM dv_error_events GROUP BY provider'
      ).all();
      var byStatus = db.prepare(
        'SELECT status, COUNT(*) as count FROM dv_error_events GROUP BY status'
      ).all();
      var last24h = db.prepare(
        "SELECT COUNT(*) as count FROM dv_error_events WHERE last_seen >= datetime('now', '-1 day')"
      ).get();
      return {
        by_provider: byProvider,
        by_status: byStatus,
        last_24h: last24h ? last24h.count : 0
      };
    },

    getTopErrors(limit) {
      var rows = db.prepare(
        'SELECT * FROM dv_error_events ORDER BY occurrences DESC LIMIT ?'
      ).all(limit || 10);
      return rows.map(function (row) {
        try { row.payload = JSON.parse(row.payload); } catch (e) { row.payload = {}; }
        return row;
      });
    }
  };
}
