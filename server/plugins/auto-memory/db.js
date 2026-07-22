// Auto-Memory DB helpers

export default function createAutoMemoryDB(db) {
  // Migration: add access tracking columns
  try { db.exec('ALTER TABLE am_facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN last_accessed_at TEXT'); } catch (e) { /* already exists */ }

  // Migration: bi-temporal validity + provenance-scoped trust (2026-07-22, memory-rework slice 1).
  // valid_from/valid_to = world-time interval; verified_at = last ground-truth re-check;
  // source_authority = how-validated (verified|directive|inferred), NOT who-spoke.
  // Invariant (held by supersedeFact/pruneLowConfidence): valid_to IS NULL <=> superseded_by IS NULL <=> current.
  try { db.exec('ALTER TABLE am_facts ADD COLUMN valid_from TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN valid_to TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN verified_at TEXT'); } catch (e) { /* already exists */ }
  try { db.exec("ALTER TABLE am_facts ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'inferred'"); } catch (e) { /* already exists */ }
  // Backfill existing rows so as-of queries are correct from day one.
  try { db.exec('UPDATE am_facts SET valid_from = created_at WHERE valid_from IS NULL'); } catch (e) { /* */ }
  try { db.exec('UPDATE am_facts SET valid_to = updated_at WHERE superseded_by IS NOT NULL AND valid_to IS NULL'); } catch (e) { /* */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_am_facts_valid ON am_facts(valid_to)'); } catch (e) { /* */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_am_facts_authority ON am_facts(source_authority)'); } catch (e) { /* */ }

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
    // sourceAuthority (verified|directive|inferred) + validFrom are optional & appended,
    // so existing 7-arg callers keep working (defaults: inferred, valid_from=now).
    createFact(agentId, projectId, category, factText, confidence, sourceType, sourceId, sourceAuthority, validFrom) {
      var result = db.prepare(
        "INSERT INTO am_facts (agent_id, project_id, category, fact_text, confidence, source_type, source_id, source_authority, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now'))) RETURNING id"
      ).get(agentId || null, projectId || null, category || 'general', factText, confidence || 0.8, sourceType || null, sourceId || null, sourceAuthority || 'inferred', validFrom || null);
      return result.id;
    },

    getFact(id) {
      var fact = db.prepare('SELECT * FROM am_facts WHERE id = ?').get(id);
      if (fact) {
        try { db.prepare("UPDATE am_facts SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?").run(id); } catch (e) { /* */ }
      }
      return fact;
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
      // Close the validity interval (bi-temporal supersession) — don't just tombstone.
      db.prepare("UPDATE am_facts SET superseded_by = ?, valid_to = datetime('now') WHERE id = ?").run(newId, oldId);
    },

    updateFactConfidence(id, confidence) {
      db.prepare("UPDATE am_facts SET confidence = ?, updated_at = datetime('now') WHERE id = ?").run(confidence, id);
    },

    // -- Provenance / bi-temporal (memory-rework slice 1) --

    // A ground-truth re-check CONFIRMED the fact: stamp verified_at, optionally refresh
    // confidence, and reset the access reference (a re-verified fact is "fresh").
    reverifyFact(id, confidence) {
      db.prepare(
        "UPDATE am_facts SET verified_at = datetime('now'), confidence = COALESCE(?, confidence), last_accessed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(confidence == null ? null : confidence, id);
    },

    // The re-verification queue: CURRENT, inferred (not directive/verified) facts never
    // checked, or last checked longer than older_than_days ago. Aria's loop drains this.
    factsDueForReverification(opts) {
      opts = opts || {};
      var olderThanDays = parseInt(opts.older_than_days) || 30;
      var limit = Math.min(opts.limit || 50, 500);
      return db.prepare(
        "SELECT * FROM am_facts WHERE superseded_by IS NULL AND source_authority = 'inferred' " +
        "AND (verified_at IS NULL OR verified_at < datetime('now', '-' || ? || ' days')) " +
        "ORDER BY (verified_at IS NULL) DESC, COALESCE(verified_at, created_at) ASC LIMIT ?"
      ).all(olderThanDays, limit);
    },

    // Bi-temporal "as of": facts whose validity interval [valid_from, valid_to) contains asOf.
    // Answers "what did we believe on date X" — resolves the three-file contradiction problem.
    factsAsOf(asOf, opts) {
      opts = opts || {};
      var where = ['valid_from IS NOT NULL', 'valid_from <= ?', '(valid_to IS NULL OR valid_to > ?)'];
      var params = [asOf, asOf];
      if (opts.agent_id) { where.push('agent_id = ?'); params.push(opts.agent_id); }
      var limit = Math.min(opts.limit || 50, 500);
      params.push(limit);
      return db.prepare(
        'SELECT * FROM am_facts WHERE ' + where.join(' AND ') + ' ORDER BY confidence DESC LIMIT ?'
      ).all(...params);
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

    // Batch-update facts for decay: returns all facts not accessed in 24h with their timestamps
    getDecayableFacts() {
      // Operator DIRECTIVES (stated intent/preference) do NOT decay — they hold until a new
      // directive supersedes them. verified + inferred still decay (verified is re-checked via
      // verified_at, not eroded to zero by time alone).
      return db.prepare(
        "SELECT id, category, confidence, last_accessed_at, updated_at FROM am_facts WHERE superseded_by IS NULL AND source_authority != 'directive' AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-1 day'))"
      ).all();
    },

    pruneLowConfidence(threshold) {
      // Decay-prune: SELF-supersede (superseded_by = own id) so the fact is "not current" +
      // distinguishable from a merge, and FK-SAFE. (The old -1 sentinel violated the
      // superseded_by -> am_facts(id) FK under foreign_keys=ON — verified 2026-07-22: it threw
      // silently and NOTHING was ever pruned in prod. Self-id keeps the invariant
      // valid_to IS NULL <=> superseded_by IS NULL <=> current.)
      // Age guard: don't prune facts less than 7 days old (may have low initial confidence).
      var result = db.prepare(
        "UPDATE am_facts SET superseded_by = id, valid_to = datetime('now') WHERE superseded_by IS NULL AND confidence < ? AND updated_at < datetime('now', '-7 days')"
      ).run(threshold);
      return result.changes;
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
