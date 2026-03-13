// Auto-Memory DB helpers

export default function createAutoMemoryDB(db) {
  return {
    // -- Config --
    getConfig(key) {
      var row = db.prepare('SELECT value FROM am_config WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setConfig(key, value) {
      db.prepare('INSERT OR REPLACE INTO am_config (key, value) VALUES (?, ?)').run(key, value);
    },

    getAllConfig() {
      var rows = db.prepare('SELECT key, value FROM am_config').all();
      var config = {};
      for (var r of rows) config[r.key] = r.value;
      return config;
    },

    // -- Facts --
    createFact(agentId, projectId, category, factText, confidence, sourceType, sourceId) {
      var result = db.prepare(
        'INSERT INTO am_facts (agent_id, project_id, category, fact_text, confidence, source_type, source_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(agentId || null, projectId || null, category || 'general', factText, confidence || 0.8, sourceType || null, sourceId || null);
      return result.id;
    },

    getFact(id) {
      return db.prepare('SELECT * FROM am_facts WHERE id = ?').get(id);
    },

    listFacts(opts) {
      opts = opts || {};
      var where = ['superseded_by IS NULL']; // only show current facts
      var params = [];
      if (opts.agent_id) { where.push('agent_id = ?'); params.push(opts.agent_id); }
      if (opts.project_id) { where.push('project_id = ?'); params.push(opts.project_id); }
      if (opts.category) { where.push('category = ?'); params.push(opts.category); }
      if (opts.min_confidence) { where.push('confidence >= ?'); params.push(opts.min_confidence); }
      var limit = Math.min(opts.limit || 50, 500);
      var offset = opts.offset || 0;
      params.push(limit, offset);
      return db.prepare(
        'SELECT * FROM am_facts WHERE ' + where.join(' AND ') + ' ORDER BY confidence DESC, updated_at DESC LIMIT ? OFFSET ?'
      ).all(...params);
    },

    deleteFact(id) {
      db.prepare('DELETE FROM am_facts WHERE id = ?').run(id);
    },

    supersedeFact(oldId, newId) {
      db.prepare('UPDATE am_facts SET superseded_by = ? WHERE id = ?').run(newId, oldId);
    },

    updateFactConfidence(id, confidence) {
      db.prepare("UPDATE am_facts SET confidence = ?, updated_at = datetime('now') WHERE id = ?").run(confidence, id);
    },

    // -- Consolidation --
    logConsolidation(factsProcessed, factsMerged, factsSuperseded, durationMs) {
      db.prepare(
        'INSERT INTO am_consolidation_log (facts_processed, facts_merged, facts_superseded, duration_ms) VALUES (?, ?, ?, ?)'
      ).run(factsProcessed, factsMerged, factsSuperseded, durationMs);
    },

    getConsolidationHistory(limit) {
      return db.prepare('SELECT * FROM am_consolidation_log ORDER BY run_at DESC LIMIT ?').all(limit || 20);
    },

    getLastConsolidation() {
      return db.prepare('SELECT * FROM am_consolidation_log ORDER BY run_at DESC LIMIT 1').get();
    },

    // -- Stats --
    stats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by IS NULL').get().c;
      var superseded = db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by IS NOT NULL').get().c;
      var byCategory = db.prepare('SELECT category, COUNT(*) as count FROM am_facts WHERE superseded_by IS NULL GROUP BY category ORDER BY count DESC').all();
      var byAgent = db.prepare('SELECT agent_id, COUNT(*) as count FROM am_facts WHERE superseded_by IS NULL AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY count DESC LIMIT 20').all();
      var consolidations = db.prepare('SELECT COUNT(*) as c FROM am_consolidation_log').get().c;
      var lastConsolidation = this.getLastConsolidation();
      return {
        active_facts: total,
        superseded_facts: superseded,
        by_category: byCategory,
        by_agent: byAgent,
        total_consolidations: consolidations,
        last_consolidation: lastConsolidation ? lastConsolidation.run_at : null
      };
    },

    // -- Pruning --
    pruneOldSuperseded(maxAge) {
      maxAge = maxAge || '30 days';
      var result = db.prepare(
        "DELETE FROM am_facts WHERE superseded_by IS NOT NULL AND updated_at < datetime('now', '-' || ?)"
      ).run(maxAge);
      return result.changes;
    },

    logExtractionError(agentId, projectId, sourceEvent, errorMessage, inputPreview) {
      db.prepare(
        'INSERT INTO am_extraction_errors (agent_id, project_id, source_event, error_message, input_text_preview) VALUES (?, ?, ?, ?, ?)'
      ).run(agentId || '', projectId || '', sourceEvent || '', errorMessage, (inputPreview || '').substring(0, 500));
    },

    getExtractionErrors(limit) {
      return db.prepare('SELECT * FROM am_extraction_errors ORDER BY created_at DESC LIMIT ?').all(limit || 50);
    },

    getErrorStats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM am_extraction_errors').get().c;
      var last24h = db.prepare("SELECT COUNT(*) as c FROM am_extraction_errors WHERE created_at >= datetime('now', '-1 day')").get().c;
      return { total: total, last_24h: last24h };
    },

    pruneExcessFacts(agentId, maxFacts) {
      maxFacts = maxFacts || 500;
      // Delete oldest superseded facts for this agent beyond the limit
      var count = db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE agent_id = ?').get(agentId).c;
      if (count <= maxFacts) return 0;
      var toDelete = count - maxFacts;
      var result = db.prepare(
        'DELETE FROM am_facts WHERE id IN (SELECT id FROM am_facts WHERE agent_id = ? ORDER BY CASE WHEN superseded_by IS NOT NULL THEN 0 ELSE 1 END, updated_at ASC LIMIT ?)'
      ).run(agentId, toDelete);
      return result.changes;
    }
  };
}
