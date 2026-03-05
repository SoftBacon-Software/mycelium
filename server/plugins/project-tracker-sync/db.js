// Project Tracker Sync — DB helpers
// Manages sync links, status mappings, and sync logs between Mycelium and external trackers.

var DEFAULT_LINEAR_MAP = [
  { mycelium: 'open', external: 'Todo' },
  { mycelium: 'in_progress', external: 'In Progress' },
  { mycelium: 'review', external: 'In Review' },
  { mycelium: 'done', external: 'Done' },
  { mycelium: 'cancelled', external: 'Canceled' }
];

var DEFAULT_JIRA_MAP = [
  { mycelium: 'open', external: 'To Do' },
  { mycelium: 'in_progress', external: 'In Progress' },
  { mycelium: 'review', external: 'In Review' },
  { mycelium: 'done', external: 'Done' }
];

function ensureDefaults(db, provider) {
  var count = db.prepare('SELECT COUNT(*) as c FROM dv_tracker_status_map WHERE provider = ?').get(provider);
  if (count && count.c > 0) return;

  var defaults = provider === 'jira' ? DEFAULT_JIRA_MAP : DEFAULT_LINEAR_MAP;
  var stmt = db.prepare('INSERT INTO dv_tracker_status_map (provider, mycelium_status, external_status) VALUES (?, ?, ?)');
  for (var i = 0; i < defaults.length; i++) {
    stmt.run(provider, defaults[i].mycelium, defaults[i].external);
  }
}

export default function createTrackerDB(db) {
  return {
    // --- Links ---

    createLink(provider, externalId, externalKey, myceliumType, myceliumId) {
      var r = db.prepare(
        'INSERT INTO dv_tracker_links (provider, external_id, external_key, mycelium_type, mycelium_id) VALUES (?, ?, ?, ?, ?) RETURNING id'
      ).get(provider, externalId, externalKey || '', myceliumType || 'task', myceliumId);
      return r.id;
    },

    getLink(id) {
      var row = db.prepare('SELECT * FROM dv_tracker_links WHERE id = ?').get(id);
      if (row) {
        try { row.conflict_data = JSON.parse(row.conflict_data); } catch (e) { row.conflict_data = {}; }
      }
      return row;
    },

    getLinkByExternal(provider, externalId) {
      var row = db.prepare('SELECT * FROM dv_tracker_links WHERE provider = ? AND external_id = ?').get(provider, externalId);
      if (row) {
        try { row.conflict_data = JSON.parse(row.conflict_data); } catch (e) { row.conflict_data = {}; }
      }
      return row;
    },

    getLinkByMycelium(myceliumType, myceliumId) {
      var row = db.prepare('SELECT * FROM dv_tracker_links WHERE mycelium_type = ? AND mycelium_id = ?').get(myceliumType, myceliumId);
      if (row) {
        try { row.conflict_data = JSON.parse(row.conflict_data); } catch (e) { row.conflict_data = {}; }
      }
      return row;
    },

    listLinks(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.provider) { where.push('provider = ?'); params.push(filters.provider); }
      if (filters.sync_status) { where.push('sync_status = ?'); params.push(filters.sync_status); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      params.push(limit, offset);
      var rows = db.prepare(
        'SELECT * FROM dv_tracker_links WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(...params);
      return rows.map(function (row) {
        try { row.conflict_data = JSON.parse(row.conflict_data); } catch (e) { row.conflict_data = {}; }
        return row;
      });
    },

    updateLink(id, fields) {
      var sets = [];
      var values = [];
      if (fields.sync_status !== undefined) { sets.push('sync_status = ?'); values.push(fields.sync_status); }
      if (fields.conflict_data !== undefined) { sets.push('conflict_data = ?'); values.push(JSON.stringify(fields.conflict_data)); }
      if (fields.last_synced !== undefined) { sets.push('last_synced = ?'); values.push(fields.last_synced); }
      if (sets.length === 0) return;
      values.push(id);
      db.prepare('UPDATE dv_tracker_links SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteLink(id) {
      db.prepare('DELETE FROM dv_tracker_links WHERE id = ?').run(id);
    },

    // --- Sync Log ---

    logSync(provider, direction, action, myceliumId, externalId, status, detail) {
      var r = db.prepare(
        'INSERT INTO dv_tracker_sync_log (provider, direction, action, mycelium_id, external_id, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(provider, direction, action, myceliumId || null, externalId || '', status || 'success', detail || '');
      return r.id;
    },

    listSyncLog(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.provider) { where.push('provider = ?'); params.push(filters.provider); }
      if (filters.direction) { where.push('direction = ?'); params.push(filters.direction); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      var limit = Math.min(filters.limit || 50, 200);
      params.push(limit);
      var rows = db.prepare(
        'SELECT * FROM dv_tracker_sync_log WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ?'
      ).all(...params);
      return rows;
    },

    // --- Status Mappings ---

    createStatusMap(provider, myceliumStatus, externalStatus) {
      var r = db.prepare(
        'INSERT INTO dv_tracker_status_map (provider, mycelium_status, external_status) VALUES (?, ?, ?) RETURNING id'
      ).get(provider, myceliumStatus, externalStatus);
      return r.id;
    },

    getStatusMaps(provider) {
      return db.prepare('SELECT * FROM dv_tracker_status_map WHERE provider = ? ORDER BY id').all(provider);
    },

    mapToExternal(provider, myceliumStatus) {
      ensureDefaults(db, provider);
      var row = db.prepare('SELECT external_status FROM dv_tracker_status_map WHERE provider = ? AND mycelium_status = ?').get(provider, myceliumStatus);
      return row ? row.external_status : null;
    },

    mapToMycelium(provider, externalStatus) {
      ensureDefaults(db, provider);
      var row = db.prepare('SELECT mycelium_status FROM dv_tracker_status_map WHERE provider = ? AND external_status = ?').get(provider, externalStatus);
      return row ? row.mycelium_status : null;
    },

    deleteStatusMap(id) {
      db.prepare('DELETE FROM dv_tracker_status_map WHERE id = ?').run(id);
    },

    // --- Stats ---

    getStats() {
      var linkCounts = db.prepare(
        'SELECT provider, sync_status, COUNT(*) as count FROM dv_tracker_links GROUP BY provider, sync_status'
      ).all();

      var logCounts = db.prepare(
        'SELECT status, COUNT(*) as count FROM dv_tracker_sync_log GROUP BY status'
      ).all();

      var lastSync = db.prepare(
        'SELECT MAX(last_synced) as last_synced FROM dv_tracker_links'
      ).get();

      var conflictCount = db.prepare(
        "SELECT COUNT(*) as count FROM dv_tracker_links WHERE sync_status = 'conflict'"
      ).get();

      return {
        links: linkCounts,
        sync_log: logCounts,
        last_synced: lastSync ? lastSync.last_synced : null,
        conflicts: conflictCount ? conflictCount.count : 0
      };
    }
  };
}
