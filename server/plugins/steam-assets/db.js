// Steam Assets plugin DB functions — factory receives raw better-sqlite3 handle
export default function createSteamDB(db) {
  var _stmts = {};
  function stmt(key, sql) {
    if (!_stmts[key]) _stmts[key] = db.prepare(sql);
    return _stmts[key];
  }

  return {
    createAsset(projectId, assetType, title, config, createdBy) {
      var result = stmt('saCreate',
        `INSERT INTO dv_steam_assets (project_id, asset_type, title, config, created_by)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      ).get(projectId, assetType, title,
        typeof config === 'string' ? config : JSON.stringify(config || {}), createdBy);
      return result.id;
    },

    getAsset(id) {
      return stmt('saGet', 'SELECT * FROM dv_steam_assets WHERE id = ?').get(id);
    },

    listAssets(filters) {
      var where = ['1=1']; var params = [];
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.asset_type) { where.push('asset_type = ?'); params.push(filters.asset_type); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      params.push(filters.limit || 50);
      return db.prepare('SELECT * FROM dv_steam_assets WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
    },

    updateAsset(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['title', 'status', 'drone_job_id', 'config', 'result_data', 'result_url'];
      for (var key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(key + ' = ?');
          values.push(typeof fields[key] === 'object' ? JSON.stringify(fields[key]) : fields[key]);
        }
      }
      values.push(id);
      return db.prepare('UPDATE dv_steam_assets SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteAsset(id) {
      return db.prepare('DELETE FROM dv_steam_assets WHERE id = ?').run(id);
    }
  };
}
