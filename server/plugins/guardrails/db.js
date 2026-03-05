// Guardrails plugin DB helpers

export default function createGuardrailsDB(db) {
  return {
    createRule(name, description, triggerEvent, conditions, enforcement, projectId, createdBy) {
      var conditionsJson = typeof conditions === 'string' ? conditions : JSON.stringify(conditions);
      var r = db.prepare(
        'INSERT INTO dv_guardrail_rules (name, description, trigger_event, conditions, enforcement, project_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        name, description || '', triggerEvent, conditionsJson,
        enforcement || 'warn', projectId || null, createdBy || ''
      );
      return r.id;
    },

    getRule(id) {
      var row = db.prepare('SELECT * FROM dv_guardrail_rules WHERE id = ?').get(id);
      if (row && row.conditions) {
        try { row.conditions = JSON.parse(row.conditions); } catch (e) { /* keep as string */ }
      }
      return row;
    },

    listRules(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.enabled !== undefined) { where.push('enabled = ?'); params.push(filters.enabled); }
      if (filters.trigger_event) { where.push('trigger_event = ?'); params.push(filters.trigger_event); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }

      var sql = 'SELECT * FROM dv_guardrail_rules WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC';
      var stmt = db.prepare(sql);
      var rows = params.length > 0 ? stmt.all.apply(stmt, params) : stmt.all();

      for (var i = 0; i < rows.length; i++) {
        if (rows[i].conditions) {
          try { rows[i].conditions = JSON.parse(rows[i].conditions); } catch (e) { /* keep as string */ }
        }
      }
      return rows;
    },

    updateRule(id, fields) {
      var sets = [];
      var params = [];
      if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
      if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
      if (fields.conditions !== undefined) {
        var conditionsJson = typeof fields.conditions === 'string' ? fields.conditions : JSON.stringify(fields.conditions);
        sets.push('conditions = ?');
        params.push(conditionsJson);
      }
      if (fields.enforcement !== undefined) { sets.push('enforcement = ?'); params.push(fields.enforcement); }
      if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled); }
      if (fields.trigger_event !== undefined) { sets.push('trigger_event = ?'); params.push(fields.trigger_event); }
      if (fields.project_id !== undefined) { sets.push('project_id = ?'); params.push(fields.project_id); }
      if (sets.length === 0) return;

      sets.push("updated_at = datetime('now')");
      params.push(id);
      var sql = 'UPDATE dv_guardrail_rules SET ' + sets.join(', ') + ' WHERE id = ?';
      var stmt = db.prepare(sql);
      stmt.run.apply(stmt, params);
    },

    deleteRule(id) {
      db.prepare('DELETE FROM dv_guardrail_rules WHERE id = ?').run(id);
    },

    logViolation(ruleId, ruleName, triggerEvent, agentId, projectId, enforcement, eventData, violationDetail) {
      var eventDataJson = typeof eventData === 'string' ? eventData : JSON.stringify(eventData);
      var r = db.prepare(
        'INSERT INTO dv_guardrail_violations (rule_id, rule_name, trigger_event, agent_id, project_id, enforcement, event_data, violation_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        ruleId, ruleName, triggerEvent, agentId || '', projectId || '',
        enforcement, eventDataJson, violationDetail || ''
      );
      return r.id;
    },

    getViolation(id) {
      var row = db.prepare('SELECT * FROM dv_guardrail_violations WHERE id = ?').get(id);
      if (row && row.event_data) {
        try { row.event_data = JSON.parse(row.event_data); } catch (e) { /* keep as string */ }
      }
      return row;
    },

    listViolations(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.rule_id) { where.push('rule_id = ?'); params.push(filters.rule_id); }
      if (filters.agent_id) { where.push('agent_id = ?'); params.push(filters.agent_id); }
      if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }

      var limit = Math.min(filters.limit || 50, 200);
      var offset = filters.offset || 0;
      params.push(limit, offset);

      var sql = 'SELECT * FROM dv_guardrail_violations WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      var stmt = db.prepare(sql);
      var rows = stmt.all.apply(stmt, params);

      for (var i = 0; i < rows.length; i++) {
        if (rows[i].event_data) {
          try { rows[i].event_data = JSON.parse(rows[i].event_data); } catch (e) { /* keep as string */ }
        }
      }
      return rows;
    },

    overrideViolation(id, overriddenBy) {
      db.prepare(
        'UPDATE dv_guardrail_violations SET overridden = 1, overridden_by = ? WHERE id = ?'
      ).run(overriddenBy || '', id);
    },

    getStats() {
      var byEnforcement = db.prepare(
        'SELECT enforcement, COUNT(*) as count FROM dv_guardrail_violations GROUP BY enforcement'
      ).all();

      var byRule = db.prepare(
        'SELECT rule_id, rule_name, enforcement, COUNT(*) as count FROM dv_guardrail_violations GROUP BY rule_id, rule_name, enforcement ORDER BY count DESC'
      ).all();

      var last24h = db.prepare(
        "SELECT COUNT(*) as count FROM dv_guardrail_violations WHERE created_at >= datetime('now', '-1 day')"
      ).get();

      return {
        by_enforcement: byEnforcement,
        by_rule: byRule,
        last_24h: last24h ? last24h.count : 0
      };
    },

    getTopViolators(limit) {
      var lim = limit || 10;
      return db.prepare(
        'SELECT agent_id, COUNT(*) as violation_count FROM dv_guardrail_violations WHERE agent_id != \'\' GROUP BY agent_id ORDER BY violation_count DESC LIMIT ?'
      ).all(lim);
    }
  };
}
