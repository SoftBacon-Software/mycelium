// Plugin DB helpers — rename table references to match your schema.sql

export default function createTemplateDB(db) {
  return {
    create(title, data, createdBy) {
      var r = db.prepare(
        'INSERT INTO dv_template_items (title, data, created_by) VALUES (?, ?, ?) RETURNING id'
      ).get(title || '', JSON.stringify(data || {}), createdBy || '');
      return r.id;
    },

    get(id) {
      var row = db.prepare('SELECT * FROM dv_template_items WHERE id = ?').get(id);
      if (row) {
        try { row.data = JSON.parse(row.data); } catch (e) { row.data = {}; }
      }
      return row;
    },

    list(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      params.push(limit, offset);
      var rows = db.prepare(
        'SELECT * FROM dv_template_items WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(...params);
      return rows.map(function (row) {
        try { row.data = JSON.parse(row.data); } catch (e) { row.data = {}; }
        return row;
      });
    },

    update(id, fields) {
      var sets = [];
      var values = [];
      if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.data !== undefined) { sets.push('data = ?'); values.push(JSON.stringify(fields.data)); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE dv_template_items SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    delete(id) {
      db.prepare('DELETE FROM dv_template_items WHERE id = ?').run(id);
    }
  };
}
