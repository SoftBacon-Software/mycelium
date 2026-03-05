// Workflow Automations plugin DB helpers

export default function createAutomationDB(db) {
  return {
    createRule(name, description, triggerEvent, conditions, actions, projectId, createdBy) {
      var r = db.prepare(
        'INSERT INTO dv_automation_rules (name, description, trigger_event, conditions, actions, project_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        name || '',
        description || '',
        triggerEvent || '',
        JSON.stringify(conditions || {}),
        JSON.stringify(actions || []),
        projectId || null,
        createdBy || ''
      );
      return r.id;
    },

    getRule(id) {
      var row = db.prepare('SELECT * FROM dv_automation_rules WHERE id = ?').get(id);
      if (!row) return null;
      try { row.conditions = JSON.parse(row.conditions); } catch (e) { row.conditions = {}; }
      try { row.actions = JSON.parse(row.actions); } catch (e) { row.actions = []; }
      return row;
    },

    listRules(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.enabled !== undefined) { where.push('enabled = ?'); params.push(filters.enabled); }
      if (filters.trigger_event) { where.push('trigger_event = ?'); params.push(filters.trigger_event); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
      var limit = Math.min(filters.limit || 100, 500);
      var offset = filters.offset || 0;
      params.push(limit, offset);
      var rows = db.prepare(
        'SELECT * FROM dv_automation_rules WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(...params);
      return rows.map(function (row) {
        try { row.conditions = JSON.parse(row.conditions); } catch (e) { row.conditions = {}; }
        try { row.actions = JSON.parse(row.actions); } catch (e) { row.actions = []; }
        return row;
      });
    },

    updateRule(id, fields) {
      var sets = [];
      var values = [];
      if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
      if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
      if (fields.trigger_event !== undefined) { sets.push('trigger_event = ?'); values.push(fields.trigger_event); }
      if (fields.conditions !== undefined) { sets.push('conditions = ?'); values.push(JSON.stringify(fields.conditions)); }
      if (fields.actions !== undefined) { sets.push('actions = ?'); values.push(JSON.stringify(fields.actions)); }
      if (fields.enabled !== undefined) { sets.push('enabled = ?'); values.push(fields.enabled ? 1 : 0); }
      if (fields.project_id !== undefined) { sets.push('project_id = ?'); values.push(fields.project_id); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE dv_automation_rules SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteRule(id) {
      db.prepare('DELETE FROM dv_automation_rules WHERE id = ?').run(id);
    },

    incrementRunCount(id) {
      db.prepare("UPDATE dv_automation_rules SET run_count = run_count + 1, last_run = datetime('now') WHERE id = ?").run(id);
    },

    logExecution(ruleId, ruleName, triggerEvent, matched, actionsTaken, eventData, status, error, dryRun) {
      db.prepare(
        'INSERT INTO dv_automation_log (rule_id, rule_name, trigger_event, matched, actions_taken, event_data, status, error, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ruleId,
        ruleName || '',
        triggerEvent || '',
        matched ? 1 : 0,
        JSON.stringify(actionsTaken || []),
        JSON.stringify(eventData || {}),
        status || 'success',
        error || '',
        dryRun ? 1 : 0
      );
    },

    listLog(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.rule_id) { where.push('rule_id = ?'); params.push(filters.rule_id); }
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      var limit = Math.min(filters.limit || 50, 500);
      params.push(limit);
      var rows = db.prepare(
        'SELECT * FROM dv_automation_log WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ?'
      ).all(...params);
      return rows.map(function (row) {
        try { row.actions_taken = JSON.parse(row.actions_taken); } catch (e) { row.actions_taken = []; }
        try { row.event_data = JSON.parse(row.event_data); } catch (e) { row.event_data = {}; }
        return row;
      });
    },

    getLogStats() {
      var byStatus = db.prepare(
        'SELECT status, COUNT(*) as count FROM dv_automation_log GROUP BY status'
      ).all();
      var byRule = db.prepare(
        'SELECT rule_id, rule_name, COUNT(*) as count FROM dv_automation_log GROUP BY rule_id, rule_name ORDER BY count DESC LIMIT 20'
      ).all();
      var last24h = db.prepare(
        "SELECT COUNT(*) as count FROM dv_automation_log WHERE created_at >= datetime('now', '-24 hours')"
      ).get();
      return {
        by_status: byStatus,
        by_rule: byRule,
        last_24h: last24h ? last24h.count : 0
      };
    },

    createTemplate(name, description, triggerEvent, conditions, actions, category) {
      var r = db.prepare(
        'INSERT INTO dv_automation_templates (name, description, trigger_event, conditions, actions, category) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        name || '',
        description || '',
        triggerEvent || '',
        JSON.stringify(conditions || {}),
        JSON.stringify(actions || []),
        category || 'general'
      );
      return r.id;
    },

    listTemplates(category) {
      var sql = 'SELECT * FROM dv_automation_templates';
      var params = [];
      if (category) {
        sql += ' WHERE category = ?';
        params.push(category);
      }
      sql += ' ORDER BY category, name';
      var rows = db.prepare(sql).all(...params);
      return rows.map(function (row) {
        try { row.conditions = JSON.parse(row.conditions); } catch (e) { row.conditions = {}; }
        try { row.actions = JSON.parse(row.actions); } catch (e) { row.actions = []; }
        return row;
      });
    },

    getTemplate(id) {
      var row = db.prepare('SELECT * FROM dv_automation_templates WHERE id = ?').get(id);
      if (!row) return null;
      try { row.conditions = JSON.parse(row.conditions); } catch (e) { row.conditions = {}; }
      try { row.actions = JSON.parse(row.actions); } catch (e) { row.actions = []; }
      return row;
    }
  };
}
