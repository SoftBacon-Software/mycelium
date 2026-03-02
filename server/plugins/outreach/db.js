// Outreach plugin DB functions — factory receives raw better-sqlite3 handle
export default function createOutreachDB(db) {
  // Prepared statement cache
  var _stmts = {};
  function stmt(key, sql) {
    if (!_stmts[key]) _stmts[key] = db.prepare(sql);
    return _stmts[key];
  }

  return {
    createCampaign(projectId, name, personaPrompt, projectFacts, templates, config, createdBy) {
      var result = stmt('orCreateCampaign', `INSERT INTO dv_outreach_campaigns (project_id, name, persona_prompt, project_facts, templates, config, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(projectId, name, personaPrompt || '', projectFacts || '', templates || '{}', config || '{}', createdBy || '');
      return result.id;
    },

    getCampaign(id) {
      return stmt('orGetCampaign', 'SELECT * FROM dv_outreach_campaigns WHERE id = ?').get(id);
    },

    listCampaigns(filters) {
      var where = ['1=1']; var params = [];
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      params.push(filters.limit || 50);
      return db.prepare('SELECT * FROM dv_outreach_campaigns WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
    },

    updateCampaign(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      for (var key of ['name', 'persona_prompt', 'project_facts', 'templates', 'config', 'status']) {
        if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
      }
      values.push(id);
      return db.prepare('UPDATE dv_outreach_campaigns SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    createContact(fields) {
      var result = db.prepare(`INSERT INTO dv_outreach_contacts
        (project_id, campaign_id, type, name, email, outlet, tier, archetype, subscriber_count, status, last_content, notes, metadata, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
        fields.project_id, fields.campaign_id || null, fields.type || 'creator', fields.name,
        fields.email || '', fields.outlet || '', fields.tier || '', fields.archetype || '',
        fields.subscriber_count || 0, fields.status || 'discovered', fields.last_content || '',
        fields.notes || '', fields.metadata || '{}', fields.created_by || ''
      );
      return result.id;
    },

    getContact(id) {
      return stmt('orGetContact', 'SELECT * FROM dv_outreach_contacts WHERE id = ?').get(id);
    },

    listContacts(filters) {
      var where = ['1=1']; var params = [];
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      if (filters.type) { where.push('type = ?'); params.push(filters.type); }
      if (filters.campaign_id) { where.push('campaign_id = ?'); params.push(filters.campaign_id); }
      var limit = filters.limit || 50;
      var offset = filters.offset || 0;
      params.push(limit, offset);
      return db.prepare('SELECT * FROM dv_outreach_contacts WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
    },

    updateContact(id, fields) {
      var sets = ["updated_at = datetime('now')"]; var values = [];
      var allowed = ['name', 'email', 'outlet', 'tier', 'archetype', 'subscriber_count', 'status',
        'pitch_subject', 'pitch_body', 'last_content', 'key_assigned', 'pitch_sent_at',
        'followup_due_at', 'followup_sent_at', 'response_at', 'outcome', 'notes', 'metadata', 'campaign_id'];
      for (var key of allowed) {
        if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
      }
      values.push(id);
      return db.prepare('UPDATE dv_outreach_contacts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteContact(id) {
      return db.prepare('DELETE FROM dv_outreach_contacts WHERE id = ?').run(id);
    },

    countContacts(projectId) {
      var rows = db.prepare(
        'SELECT status, COUNT(*) as count FROM dv_outreach_contacts WHERE project_id = ? GROUP BY status'
      ).all(projectId);
      var counts = {};
      for (var r of rows) counts[r.status] = r.count;
      return counts;
    },

    findContactByEmail(projectId, email) {
      return db.prepare('SELECT * FROM dv_outreach_contacts WHERE project_id = ? AND email = ?').get(projectId, email);
    }
  };
}
