// Build-in-Public plugin DB helpers

export default function createBipDB(db) {
  return {
    createDraft(triggerEvent, triggerData, title, content, platforms) {
      var r = db.prepare(
        'INSERT INTO dv_bip_drafts (trigger_event, trigger_data, title, content, platforms) VALUES (?, ?, ?, ?, ?) RETURNING id'
      ).get(
        triggerEvent || '',
        JSON.stringify(triggerData || {}),
        title || '',
        content || '',
        JSON.stringify(platforms || ['twitter'])
      );
      return r.id;
    },

    getDraft(id) {
      var row = db.prepare('SELECT * FROM dv_bip_drafts WHERE id = ?').get(id);
      if (!row) return null;
      try { row.trigger_data = JSON.parse(row.trigger_data); } catch (e) { row.trigger_data = {}; }
      try { row.platforms = JSON.parse(row.platforms); } catch (e) { row.platforms = ['twitter']; }
      try { row.post_ids = JSON.parse(row.post_ids); } catch (e) { row.post_ids = {}; }
      try { row.inbox_item_id = JSON.parse(row.inbox_item_id); } catch (e) { row.inbox_item_id = []; }
      return row;
    },

    listDrafts(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      if (filters.trigger_event) { where.push('trigger_event = ?'); params.push(filters.trigger_event); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      var rows = db.prepare(
        'SELECT * FROM dv_bip_drafts WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(...params, limit, offset);
      return rows.map(function (row) {
        try { row.trigger_data = JSON.parse(row.trigger_data); } catch (e) { row.trigger_data = {}; }
        try { row.platforms = JSON.parse(row.platforms); } catch (e) { row.platforms = ['twitter']; }
        try { row.post_ids = JSON.parse(row.post_ids); } catch (e) { row.post_ids = {}; }
        try { row.inbox_item_id = JSON.parse(row.inbox_item_id); } catch (e) { row.inbox_item_id = []; }
        return row;
      });
    },

    updateDraft(id, fields) {
      var sets = [];
      var values = [];
      if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
      if (fields.content !== undefined) { sets.push('content = ?'); values.push(fields.content); }
      if (fields.platforms !== undefined) { sets.push('platforms = ?'); values.push(JSON.stringify(fields.platforms)); }
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.approval_id !== undefined) { sets.push('approval_id = ?'); values.push(fields.approval_id); }
      if (fields.inbox_item_id !== undefined) { sets.push('inbox_item_id = ?'); values.push(JSON.stringify(fields.inbox_item_id)); }
      if (fields.rejection_note !== undefined) { sets.push('rejection_note = ?'); values.push(fields.rejection_note); }
      if (fields.posted_at !== undefined) { sets.push('posted_at = ?'); values.push(fields.posted_at); }
      if (fields.post_ids !== undefined) { sets.push('post_ids = ?'); values.push(JSON.stringify(fields.post_ids)); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE dv_bip_drafts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteDraft(id) {
      db.prepare('DELETE FROM dv_bip_drafts WHERE id = ?').run(id);
    },

    countByStatus() {
      return db.prepare('SELECT status, COUNT(*) as count FROM dv_bip_drafts GROUP BY status').all();
    }
  };
}
