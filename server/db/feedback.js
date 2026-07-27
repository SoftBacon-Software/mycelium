// =============== MYCELIUM — DB entity: feedback ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the five functions below use only the live `db` binding from ./core.js (no
// `stmt`, no `buildUpdate`, no sibling db/* imports). Bodies moved VERBATIM —
// bare db.prepare(...) keeps working via the ESM live binding
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/feedback.js'` so no consumer
// changes a single import.
import { db } from './core.js';

// -- Feedback --

export function createFeedback(entityType, entityId, subject, rating, comment, submittedBy, agentId) {
  var r = Math.max(1, Math.min(5, parseInt(rating) || 3));
  var result = db.prepare(
    'INSERT INTO feedback (entity_type, entity_id, subject, rating, comment, submitted_by, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(entityType || 'general', entityId || '', subject || '', r, comment || '', submittedBy || 'operator', agentId || '');
  return result.id;
}

export function getFeedback(id) {
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
}

export function listFeedback(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.entity_type) { where.push('entity_type = ?'); params.push(filters.entity_type); }
  if (filters.agent_id) { where.push('agent_id = ?'); params.push(filters.agent_id); }
  if (filters.submitted_by) { where.push('submitted_by = ?'); params.push(filters.submitted_by); }
  if (filters.rating) { where.push('rating = ?'); params.push(parseInt(filters.rating)); }
  if (filters.min_rating) { where.push('rating >= ?'); params.push(parseInt(filters.min_rating)); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  var sql = 'SELECT * FROM feedback WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function deleteFeedback(id) {
  db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
}

export function getFeedbackSummary() {
  var total = db.prepare('SELECT COUNT(*) as count FROM feedback').get().count;
  var avgRating = db.prepare('SELECT ROUND(AVG(rating), 2) as avg FROM feedback').get().avg || 0;
  var byAgent = db.prepare(
    "SELECT agent_id, COUNT(*) as count, ROUND(AVG(rating), 2) as avg_rating FROM feedback WHERE agent_id != '' GROUP BY agent_id ORDER BY count DESC LIMIT 20"
  ).all();
  var byType = db.prepare(
    'SELECT entity_type, COUNT(*) as count, ROUND(AVG(rating), 2) as avg_rating FROM feedback GROUP BY entity_type ORDER BY count DESC'
  ).all();
  var ratingDist = db.prepare(
    'SELECT rating, COUNT(*) as count FROM feedback GROUP BY rating ORDER BY rating'
  ).all();
  var recent = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 5').all();
  return { total, avg_rating: avgRating, by_agent: byAgent, by_type: byType, rating_dist: ratingDist, recent };
}
