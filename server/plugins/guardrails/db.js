// Guardrails plugin DB helpers
import { evaluateCondition } from './evaluate.js';

// better-sqlite3 can only bind string/number/bigint/buffer/null — NOT objects or
// booleans. Actor identity (checkAdmin/checkAgentOrAdmin may return an object or a
// truthy flag, not a string) must be coerced before it hits a TEXT column.
function bindStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.id || v.name || v.agent_id || v.agent || 'admin';
  return v === true ? 'admin' : String(v);
}

export default function createGuardrailsDB(db) {
  // Migrate: add new columns if missing
  try { db.prepare("ALTER TABLE guardrail_rules ADD COLUMN version INTEGER DEFAULT 1").run(); } catch (e) { /* column exists */ }
  try { db.prepare("ALTER TABLE guardrail_rules ADD COLUMN severity TEXT DEFAULT 'medium'").run(); } catch (e) { /* column exists */ }
  try { db.prepare("ALTER TABLE guardrail_rules ADD COLUMN cooldown_seconds INTEGER DEFAULT 0").run(); } catch (e) { /* column exists */ }

  // Create rule history table
  db.prepare("CREATE TABLE IF NOT EXISTS guardrail_rule_history (id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER NOT NULL, version INTEGER NOT NULL, conditions TEXT NOT NULL, enforcement TEXT NOT NULL, changed_by TEXT DEFAULT '', changed_at TEXT DEFAULT (datetime('now')))").run();
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_guardrail_rule_history ON guardrail_rule_history(rule_id)').run(); } catch (e) {}

  return {
    createRule(name, description, triggerEvent, conditions, enforcement, projectId, createdBy) {
      var conditionsJson = typeof conditions === 'string' ? conditions : JSON.stringify(conditions);
      var r = db.prepare(
        'INSERT INTO guardrail_rules (name, description, trigger_event, conditions, enforcement, project_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        name, description || '', triggerEvent, conditionsJson,
        enforcement || 'warn', projectId || null, bindStr(createdBy)
      );
      return r.id;
    },

    getRule(id) {
      var row = db.prepare('SELECT * FROM guardrail_rules WHERE id = ?').get(id);
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

      var sql = 'SELECT * FROM guardrail_rules WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC';
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
      // Save current version to history before updating
      var current = this.getRule(id);
      if (current) {
        db.prepare(
          'INSERT INTO guardrail_rule_history (rule_id, version, conditions, enforcement, changed_by) VALUES (?, ?, ?, ?, ?)'
        ).run(id, current.version || 1, JSON.stringify(current.conditions), current.enforcement, bindStr(fields.changed_by));
      }

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
      if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
      if (fields.trigger_event !== undefined) { sets.push('trigger_event = ?'); params.push(fields.trigger_event); }
      if (fields.project_id !== undefined) { sets.push('project_id = ?'); params.push(fields.project_id); }
      if (sets.length === 0) return;

      sets.push('version = COALESCE(version, 1) + 1');
      sets.push("updated_at = datetime('now')");
      params.push(id);
      var sql = 'UPDATE guardrail_rules SET ' + sets.join(', ') + ' WHERE id = ?';
      var stmt = db.prepare(sql);
      stmt.run.apply(stmt, params);
    },

    deleteRule(id) {
      db.prepare('DELETE FROM guardrail_rules WHERE id = ?').run(id);
    },

    logViolation(ruleId, ruleName, triggerEvent, agentId, projectId, enforcement, eventData, violationDetail) {
      var eventDataJson = typeof eventData === 'string' ? eventData : JSON.stringify(eventData);
      var r = db.prepare(
        'INSERT INTO guardrail_violations (rule_id, rule_name, trigger_event, agent_id, project_id, enforcement, event_data, violation_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(
        ruleId, ruleName, triggerEvent, bindStr(agentId), projectId || '',
        enforcement, eventDataJson, violationDetail || ''
      );
      return r.id;
    },

    getViolation(id) {
      var row = db.prepare('SELECT * FROM guardrail_violations WHERE id = ?').get(id);
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

      var sql = 'SELECT * FROM guardrail_violations WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
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
        'UPDATE guardrail_violations SET overridden = 1, overridden_by = ? WHERE id = ?'
      ).run(overriddenBy || '', id);
    },

    getStats() {
      var byEnforcement = db.prepare(
        'SELECT enforcement, COUNT(*) as count FROM guardrail_violations GROUP BY enforcement'
      ).all();

      var byRule = db.prepare(
        'SELECT rule_id, rule_name, enforcement, COUNT(*) as count FROM guardrail_violations GROUP BY rule_id, rule_name, enforcement ORDER BY count DESC'
      ).all();

      var last24h = db.prepare(
        "SELECT COUNT(*) as count FROM guardrail_violations WHERE created_at >= datetime('now', '-1 day')"
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
        'SELECT agent_id, COUNT(*) as violation_count FROM guardrail_violations WHERE agent_id != \'\' GROUP BY agent_id ORDER BY violation_count DESC LIMIT ?'
      ).all(lim);
    },

    checkAction(eventType, eventData) {
      var rules = this.listRules({ enabled: 1 });
      var blocked = [];
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.trigger_event !== '*' && rule.trigger_event !== eventType) continue;
        if (rule.project_id && rule.project_id !== (eventData.project_id || '')) continue;

        var result = evaluateCondition(rule.conditions, eventData);
        if (!result.violated) continue;
        if (rule.enforcement === 'block') {
          blocked.push({ rule_id: rule.id, rule_name: rule.name, detail: result.detail });
        }
      }
      return { allowed: blocked.length === 0, violations: blocked };
    }
  };
}
