// Social Posting plugin DB functions — factory receives raw better-sqlite3 handle
export default function createSocialDB(db) {
  var _stmts = {};
  function stmt(key, sql) {
    if (!_stmts[key]) _stmts[key] = db.prepare(sql);
    return _stmts[key];
  }

  return {
    // ── Accounts ──
    createAccount(projectId, platform, accountName, credentials, config) {
      var result = stmt('spCreateAcct',
        `INSERT INTO dv_social_accounts (project_id, platform, account_name, credentials, config)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      ).get(projectId, platform, accountName || '',
        typeof credentials === 'string' ? credentials : JSON.stringify(credentials || {}),
        typeof config === 'string' ? config : JSON.stringify(config || {}));
      return result.id;
    },

    getAccount(id) {
      return stmt('spGetAcct', 'SELECT * FROM dv_social_accounts WHERE id = ?').get(id);
    },

    listAccounts(projectId) {
      if (projectId) {
        return stmt('spListAcctP', 'SELECT * FROM dv_social_accounts WHERE project_id = ? ORDER BY platform').all(projectId);
      }
      return db.prepare('SELECT * FROM dv_social_accounts ORDER BY project_id, platform').all();
    },

    updateAccount(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['account_name', 'credentials', 'config', 'enabled'];
      for (var key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(key + ' = ?');
          values.push(typeof fields[key] === 'object' ? JSON.stringify(fields[key]) : fields[key]);
        }
      }
      values.push(id);
      return db.prepare('UPDATE dv_social_accounts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteAccount(id) {
      return db.prepare('DELETE FROM dv_social_accounts WHERE id = ?').run(id);
    },

    // ── Posts ──
    createPost(fields) {
      var result = db.prepare(
        `INSERT INTO dv_social_posts (project_id, account_id, platform, clip_id, video_session_id,
         event_type, tier, caption, media_url, status, scheduled_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(
        fields.project_id, fields.account_id || null, fields.platform,
        fields.clip_id || null, fields.video_session_id || null,
        fields.event_type || '', fields.tier || 'C',
        fields.caption || '', fields.media_url || '',
        fields.status || 'draft', fields.scheduled_at || null,
        fields.created_by
      );
      return result.id;
    },

    getPost(id) {
      return stmt('spGetPost', 'SELECT * FROM dv_social_posts WHERE id = ?').get(id);
    },

    listPosts(filters) {
      var where = ['1=1']; var params = [];
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.platform) { where.push('platform = ?'); params.push(filters.platform); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      if (filters.video_session_id) { where.push('video_session_id = ?'); params.push(filters.video_session_id); }
      params.push(filters.limit || 50);
      return db.prepare('SELECT * FROM dv_social_posts WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
    },

    updatePost(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['caption', 'media_url', 'status', 'scheduled_at', 'posted_at',
        'drone_job_id', 'result_data', 'error', 'account_id'];
      for (var key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(key + ' = ?');
          values.push(typeof fields[key] === 'object' ? JSON.stringify(fields[key]) : fields[key]);
        }
      }
      values.push(id);
      return db.prepare('UPDATE dv_social_posts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deletePost(id) {
      return db.prepare('DELETE FROM dv_social_posts WHERE id = ?').run(id);
    },

    // ── Scheduling ──
    getScheduledPosts(platform) {
      var where = ["status = 'scheduled'"]; var params = [];
      if (platform) { where.push('platform = ?'); params.push(platform); }
      return db.prepare('SELECT * FROM dv_social_posts WHERE ' + where.join(' AND ') + ' ORDER BY scheduled_at ASC').all(...params);
    },

    getPostHistory(projectId, platform, days) {
      var since = new Date(Date.now() - (days || 7) * 86400000).toISOString().slice(0, 10);
      var where = ['project_id = ?', "posted_at >= ?"]; var params = [projectId, since];
      if (platform) { where.push('platform = ?'); params.push(platform); }
      return db.prepare('SELECT * FROM dv_social_posts WHERE ' + where.join(' AND ') + " AND status = 'posted' ORDER BY posted_at DESC").all(...params);
    },

    getPostStats(projectId) {
      var rows = db.prepare(
        'SELECT platform, status, COUNT(*) as count FROM dv_social_posts WHERE project_id = ? GROUP BY platform, status'
      ).all(projectId);
      var stats = {};
      for (var r of rows) {
        if (!stats[r.platform]) stats[r.platform] = {};
        stats[r.platform][r.status] = r.count;
      }
      return stats;
    }
  };
}
