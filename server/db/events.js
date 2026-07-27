// =============== MYCELIUM — DB entity: event log ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the three functions below use only the live `db` + `stmt` bindings from
// ./core.js (no `buildUpdate`, no sibling db/* imports). Bodies moved VERBATIM
// — bare db.prepare(...) / stmt('dv…', …) keep working via the ESM live
// bindings (initDBConnection assigns db; nobody else may). The barrel
// server/db.js re-exports these via `export * from './db/events.js'` so no
// consumer changes a single import.
import { db, stmt } from './core.js';

// -- Events --

export function createEvent(type, agent, projectId, summary, data) {
  var result = stmt('dvCreateEvent', `INSERT INTO events (type, agent, project_id, summary, data)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).get(type, agent || '', projectId || null, summary || '', data || '{}');
  return result.id;
}

export function listEvents(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.agent) { where.push('agent = ?'); params.push(filters.agent); }
  if (filters.search) { where.push('(summary LIKE ? OR type LIKE ? OR agent LIKE ?)'); var s = '%' + filters.search + '%'; params.push(s, s, s); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM events WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

// Archive old events older than N days (default 60)
export function archiveOldEvents(daysOld) {
  daysOld = parseInt(daysOld) || 60;
  var result = db.prepare(
    "DELETE FROM events WHERE created_at < datetime('now', '-' || ? || ' days')"
  ).run(String(daysOld));
  return result.changes;
}
