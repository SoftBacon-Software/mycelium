// Video Pipeline plugin DB functions — factory receives raw better-sqlite3 handle
export default function createVideoDB(db) {
  var _stmts = {};
  function stmt(key, sql) {
    if (!_stmts[key]) _stmts[key] = db.prepare(sql);
    return _stmts[key];
  }

  return {
    // ── Sessions ──
    createSession(projectId, title, footageUrl, eventLogUrl, config, createdBy) {
      var result = stmt('vpCreateSession',
        `INSERT INTO dv_video_sessions (project_id, title, footage_url, event_log_url, config, created_by)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(projectId, title, footageUrl || '', eventLogUrl || '',
        typeof config === 'string' ? config : JSON.stringify(config || {}), createdBy);
      return result.id;
    },

    getSession(id) {
      return stmt('vpGetSession', 'SELECT * FROM dv_video_sessions WHERE id = ?').get(id);
    },

    listSessions(filters) {
      var where = ['1=1']; var params = [];
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      params.push(filters.limit || 50);
      return db.prepare('SELECT * FROM dv_video_sessions WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
    },

    updateSession(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['title', 'footage_url', 'event_log_url', 'status', 'detect_job_id',
        'assemble_job_id', 'export_job_id', 'clip_count', 'config', 'result_data'];
      for (var key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(key + ' = ?');
          values.push(typeof fields[key] === 'object' ? JSON.stringify(fields[key]) : fields[key]);
        }
      }
      values.push(id);
      return db.prepare('UPDATE dv_video_sessions SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteSession(id) {
      db.prepare('DELETE FROM dv_video_clips WHERE session_id = ?').run(id);
      return db.prepare('DELETE FROM dv_video_sessions WHERE id = ?').run(id);
    },

    // ── Clips ──
    createClip(sessionId, clipId, tier, eventType, startSec, endSec, metadata) {
      var result = stmt('vpCreateClip',
        `INSERT INTO dv_video_clips (session_id, clip_id, tier, event_type, start_sec, end_sec, duration_sec, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(sessionId, clipId, tier || 'C', eventType, startSec, endSec, endSec - startSec,
        typeof metadata === 'string' ? metadata : JSON.stringify(metadata || {}));
      return result.id;
    },

    getClip(id) {
      return stmt('vpGetClip', 'SELECT * FROM dv_video_clips WHERE id = ?').get(id);
    },

    listClips(sessionId, filters) {
      var where = ['session_id = ?']; var params = [sessionId];
      if (filters && filters.tier) { where.push('tier = ?'); params.push(filters.tier); }
      if (filters && filters.status) { where.push('status = ?'); params.push(filters.status); }
      return db.prepare('SELECT * FROM dv_video_clips WHERE ' + where.join(' AND ') + ' ORDER BY start_sec ASC').all(...params);
    },

    updateClip(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['tier', 'status', 'platforms', 'caption_data', 'metadata', 'result_url'];
      for (var key of allowed) {
        if (fields[key] !== undefined) {
          sets.push(key + ' = ?');
          values.push(typeof fields[key] === 'object' ? JSON.stringify(fields[key]) : fields[key]);
        }
      }
      values.push(id);
      return db.prepare('UPDATE dv_video_clips SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    bulkCreateClips(sessionId, clips) {
      var insert = db.prepare(
        `INSERT INTO dv_video_clips (session_id, clip_id, tier, event_type, start_sec, end_sec, duration_sec, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      var insertMany = db.transaction(function (rows) {
        for (var c of rows) {
          insert.run(sessionId, c.clip_id || c.id, c.tier || 'C', c.event_type,
            c.start_sec, c.end_sec, (c.end_sec - c.start_sec),
            typeof c.metadata === 'string' ? c.metadata : JSON.stringify(c.metadata || {}));
        }
      });
      insertMany(clips);
      // Update session clip count
      stmt('vpUpdateClipCount',
        'UPDATE dv_video_sessions SET clip_count = (SELECT COUNT(*) FROM dv_video_clips WHERE session_id = ?), updated_at = datetime(\'now\') WHERE id = ?'
      ).run(sessionId, sessionId);
      return clips.length;
    },

    getSessionStats(sessionId) {
      var tiers = db.prepare(
        'SELECT tier, COUNT(*) as count FROM dv_video_clips WHERE session_id = ? GROUP BY tier'
      ).all(sessionId);
      var statuses = db.prepare(
        'SELECT status, COUNT(*) as count FROM dv_video_clips WHERE session_id = ? GROUP BY status'
      ).all(sessionId);
      return { tiers: Object.fromEntries(tiers.map(function (r) { return [r.tier, r.count]; })),
               statuses: Object.fromEntries(statuses.map(function (r) { return [r.status, r.count]; })) };
    }
  };
}
