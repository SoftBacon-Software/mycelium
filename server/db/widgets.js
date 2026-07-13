// =============== MYCELIUM — DB entity: widgets ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the four functions below use only the live `db` + `buildUpdate` bindings from
// ./core.js (no `stmt`, no sibling db/* imports). Bodies moved VERBATIM — bare
// db.prepare(...) / buildUpdate(...) keep working via the ESM live bindings
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/widgets.js'` so no consumer changes
// a single import.
//
// NOTE: getWidget() stays in server/db.js for now (not in this wave's set).
import { db, buildUpdate } from './core.js';

// -- Widgets --

export function createWidget(agentId, projectId, title, widgetType, data) {
  var result = db.prepare(
    "INSERT INTO widgets (agent_id, project_id, title, widget_type, data) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, projectId || '', title, widgetType || 'status', typeof data === 'string' ? data : JSON.stringify(data || {}));
  return { id: result.lastInsertRowid };
}

export function updateWidget(id, updates) {
  var f = Object.assign({}, updates);
  if (f.data !== undefined && typeof f.data !== 'string') f.data = JSON.stringify(f.data);
  var changed = buildUpdate('widgets', id, f, ['title', 'widget_type', 'data', 'position', 'status'], { updatedAt: true });
  if (!changed) return null;
  return db.prepare('SELECT * FROM widgets WHERE id = ?').get(id);
}

export function listWidgets(filters) {
  var where = ["status = 'active'"];
  var params = [];
  if (filters && filters.agent_id) { where.push('agent_id = ?'); params.push(filters.agent_id); }
  if (filters && filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  return db.prepare('SELECT * FROM widgets WHERE ' + where.join(' AND ') + ' ORDER BY position ASC, updated_at DESC').all(...params);
}

export function deleteWidget(id) {
  db.prepare("UPDATE widgets SET status = 'archived' WHERE id = ?").run(id);
}
