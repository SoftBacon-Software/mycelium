// X/Twitter Posting plugin DB functions
export default function createXDB(db) {
  var _stmts = {};
  function stmt(key, sql) {
    if (!_stmts[key]) _stmts[key] = db.prepare(sql);
    return _stmts[key];
  }

  return {
    createPost(fields) {
      var result = stmt('xCreate',
        "INSERT INTO dv_x_posts (project_id, tweet_text, thread_id, thread_position, source, source_id, status, posted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
      ).get(
        fields.project_id || '',
        fields.tweet_text || '',
        fields.thread_id || null,
        fields.thread_position || null,
        fields.source || 'manual',
        fields.source_id || null,
        fields.status || 'draft',
        fields.posted_by || ''
      );
      return result.id;
    },

    getPost(id) {
      return stmt('xGet', 'SELECT * FROM dv_x_posts WHERE id = ?').get(id);
    },

    listPosts(filters) {
      var where = ['1=1']; var params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.thread_id) { where.push('thread_id = ?'); params.push(filters.thread_id); }
      if (filters.source) { where.push('source = ?'); params.push(filters.source); }
      params.push(filters.limit || 50);
      return db.prepare('SELECT * FROM dv_x_posts WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all.apply(
        db.prepare('SELECT * FROM dv_x_posts WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'),
        params
      );
    },

    updatePost(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['tweet_text', 'tweet_id', 'tweet_url', 'thread_id', 'thread_position', 'status', 'error', 'posted_at'];
      for (var i = 0; i < allowed.length; i++) {
        var key = allowed[i];
        if (fields[key] !== undefined) {
          sets.push(key + ' = ?');
          values.push(fields[key]);
        }
      }
      values.push(id);
      return db.prepare('UPDATE dv_x_posts SET ' + sets.join(', ') + ' WHERE id = ?').run.apply(
        db.prepare('UPDATE dv_x_posts SET ' + sets.join(', ') + ' WHERE id = ?'),
        values
      );
    },

    deletePost(id) {
      return db.prepare('DELETE FROM dv_x_posts WHERE id = ?').run(id);
    },

    getStats(projectId) {
      var where = projectId ? 'WHERE project_id = ?' : '';
      var params = projectId ? [projectId] : [];
      var rows = db.prepare('SELECT status, COUNT(*) as count FROM dv_x_posts ' + where + ' GROUP BY status').all.apply(
        db.prepare('SELECT status, COUNT(*) as count FROM dv_x_posts ' + where + ' GROUP BY status'),
        params
      );
      var stats = {};
      for (var i = 0; i < rows.length; i++) {
        stats[rows[i].status] = rows[i].count;
      }
      return stats;
    },

    getThread(threadId) {
      return db.prepare('SELECT * FROM dv_x_posts WHERE thread_id = ? ORDER BY thread_position ASC').all(threadId);
    }
  };
}
