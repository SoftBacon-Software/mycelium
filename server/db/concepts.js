// =============== MYCELIUM — DB entity: shared concepts ===============
// Extracted from server/db.js (Wave 2 of the decomposition). Zero coupling: the
// nine functions below use only the live `db` + `stmt` + `buildUpdate` bindings
// from ./core.js (no sibling db/* imports). Bodies moved VERBATIM — bare
// db.prepare(...) / stmt(...) / buildUpdate(...) keep working via the ESM live
// bindings (initDBConnection assigns db; nobody else may). The barrel
// server/db.js re-exports these via `export * from './db/concepts.js'` so no
// consumer changes a single import.
import { db, stmt, buildUpdate } from './core.js';

// -- Shared Concepts --

export function createConcept(name, type, description, data, createdBy) {
  var r = stmt('dvCreateConcept', `INSERT INTO concepts (name, type, description, data, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(name, type || 'custom', description || '', JSON.stringify(data || {}), createdBy || '');
  return r.lastInsertRowid;
}

export function getConcept(id) {
  return stmt('dvGetConcept', 'SELECT * FROM concepts WHERE id = ?').get(id);
}

export function listConcepts(filters) {
  var where = []; var params = [];
  if (filters && filters.type) { where.push('type = ?'); params.push(filters.type); }
  var sql = 'SELECT * FROM concepts' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC';
  if (filters && filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
  return stmt('dvListConcepts_' + where.join('_') + (filters && filters.limit || ''), sql).all(...params);
}

export function updateConcept(id, fields) {
  var f = Object.assign({}, fields);
  if (f.data !== undefined && typeof f.data !== 'string') f.data = JSON.stringify(f.data);
  buildUpdate('concepts', id, f, ['name', 'type', 'description', 'data'], { updatedAt: true, extraSets: ['version = version + 1'] });
}

export function deleteConcept(id) {
  db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
}

export function linkConceptToProject(projectId, conceptId, linkedBy) {
  stmt('dvLinkConcept', `INSERT OR IGNORE INTO project_concepts (project_id, concept_id, linked_by)
    VALUES (?, ?, ?)`).run(projectId, conceptId, linkedBy || '');
}

export function unlinkConceptFromProject(projectId, conceptId) {
  stmt('dvUnlinkConcept', 'DELETE FROM project_concepts WHERE project_id = ? AND concept_id = ?').run(projectId, conceptId);
}

export function getProjectConcepts(projectId) {
  return stmt('dvGetProjectConcepts', `SELECT c.*, pc.linked_at, pc.linked_by
    FROM concepts c JOIN project_concepts pc ON c.id = pc.concept_id
    WHERE pc.project_id = ? ORDER BY c.name`).all(projectId);
}

export function getConceptProjects(conceptId) {
  return stmt('dvGetConceptProjects', `SELECT p.*, pc.linked_at, pc.linked_by
    FROM projects p JOIN project_concepts pc ON p.id = pc.project_id
    WHERE pc.concept_id = ? ORDER BY p.name`).all(conceptId);
}
