// GitHub Sync plugin DB helpers

export default function createGithubDB(db) {
  return {
    logEvent(eventType, action, repo, payload) {
      var r = db.prepare(
        'INSERT INTO dv_github_events (event_type, action, repo, payload) VALUES (?, ?, ?, ?) RETURNING id'
      ).get(
        eventType || '',
        action || '',
        repo || '',
        JSON.stringify(payload || {})
      );
      return r.id;
    },

    getEvent(id) {
      var row = db.prepare('SELECT * FROM dv_github_events WHERE id = ?').get(id);
      if (!row) return null;
      try { row.payload = JSON.parse(row.payload); } catch (e) { row.payload = {}; }
      return row;
    },

    listEvents(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.event_type) { where.push('event_type = ?'); params.push(filters.event_type); }
      if (filters.repo) { where.push('repo = ?'); params.push(filters.repo); }
      if (filters.processed !== undefined) { where.push('processed = ?'); params.push(filters.processed ? 1 : 0); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      var rows = db.prepare(
        'SELECT * FROM dv_github_events WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(...params, limit, offset);
      return rows.map(function (row) {
        try { row.payload = JSON.parse(row.payload); } catch (e) { row.payload = {}; }
        return row;
      });
    },

    markProcessed(id) {
      db.prepare('UPDATE dv_github_events SET processed = 1 WHERE id = ?').run(id);
    },

    createLink(githubType, githubRepo, githubNumber, myceliumType, myceliumId) {
      var r = db.prepare(
        'INSERT INTO dv_github_links (github_type, github_repo, github_number, mycelium_type, mycelium_id) VALUES (?, ?, ?, ?, ?) RETURNING id'
      ).get(
        githubType || '',
        githubRepo || '',
        githubNumber || 0,
        myceliumType || '',
        myceliumId || 0
      );
      return r.id;
    },

    getLink(githubType, githubRepo, githubNumber) {
      return db.prepare(
        'SELECT * FROM dv_github_links WHERE github_type = ? AND github_repo = ? AND github_number = ?'
      ).get(githubType, githubRepo, githubNumber) || null;
    },

    getLinkByMycelium(myceliumType, myceliumId) {
      return db.prepare(
        'SELECT * FROM dv_github_links WHERE mycelium_type = ? AND mycelium_id = ?'
      ).get(myceliumType, myceliumId) || null;
    },

    listLinks(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.repo) { where.push('github_repo = ?'); params.push(filters.repo); }
      if (filters.github_type) { where.push('github_type = ?'); params.push(filters.github_type); }
      if (filters.mycelium_type) { where.push('mycelium_type = ?'); params.push(filters.mycelium_type); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      return db.prepare(
        'SELECT * FROM dv_github_links WHERE ' + where.join(' AND ') + ' ORDER BY synced_at DESC LIMIT ? OFFSET ?'
      ).all(...params, limit, offset);
    },

    deleteLink(id) {
      db.prepare('DELETE FROM dv_github_links WHERE id = ?').run(id);
    },

    getStats() {
      var eventCounts = db.prepare(
        'SELECT event_type, COUNT(*) as count FROM dv_github_events GROUP BY event_type'
      ).all();
      var linkCounts = db.prepare(
        'SELECT github_type, COUNT(*) as count FROM dv_github_links GROUP BY github_type'
      ).all();
      var totalEvents = db.prepare('SELECT COUNT(*) as count FROM dv_github_events').get().count;
      var totalLinks = db.prepare('SELECT COUNT(*) as count FROM dv_github_links').get().count;
      var unprocessed = db.prepare('SELECT COUNT(*) as count FROM dv_github_events WHERE processed = 0').get().count;
      return {
        total_events: totalEvents,
        total_links: totalLinks,
        unprocessed_events: unprocessed,
        events_by_type: eventCounts,
        links_by_type: linkCounts
      };
    }
  };
}
