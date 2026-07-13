// =============== MYCELIUM — DB entity: bugs ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the six functions below use only the live `db` + `buildUpdate` bindings from
// ./core.js (no sibling db/* imports). Bodies moved VERBATIM — bare
// db.prepare(...) / buildUpdate(...) keep working via the ESM live bindings
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/bugs.js'` so no consumer changes
// a single import.
import { db, buildUpdate } from './core.js';

// -- Bugs --

export function createBug(projectId, title, description, category, severity, reporter, assignee, diagnosticData) {
  var result = db.prepare(
    "INSERT INTO bugs (project_id, title, description, category, severity, reporter, assignee, diagnostic_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(projectId || '', title, description, category || 'other', severity || 'normal', reporter || 'admin', assignee || null, diagnosticData || null);
  return result.id;
}

export function getBug(id) {
  return db.prepare("SELECT * FROM bugs WHERE id = ?").get(id);
}

export function listBugs(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.reporter) { where.push('reporter = ?'); params.push(filters.reporter); }
  if (filters.severity) { where.push('severity = ?'); params.push(filters.severity); }
  if (filters.category) { where.push('category = ?'); params.push(filters.category); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM bugs WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateBug(id, updates) {
  buildUpdate('bugs', id, updates, ['status', 'assignee', 'admin_notes', 'severity'], { updatedAt: true });
}

export function deleteBug(id) {
  return db.prepare('DELETE FROM bugs WHERE id = ?').run(id);
}

export function countBugs() {
  return db.prepare("SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress, SUM(CASE WHEN status = 'fixed' THEN 1 ELSE 0 END) as fixed, COUNT(*) as total FROM bugs").get();
}
