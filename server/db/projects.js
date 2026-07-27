// =============== MYCELIUM — DB entity: orgs + projects ===============
// Extracted from server/db.js (Wave 2 of the decomposition). Zero coupling: the
// ten functions below use only the live `db` + `stmt` + `buildUpdate` + `getDB`
// bindings from ./core.js (no sibling db/* imports). deleteProject uses getDB()
// verbatim. Bodies moved VERBATIM — bare db.prepare(...) / stmt(...) /
// buildUpdate(...) / getDB() keep working via the ESM live bindings
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/projects.js'` so no consumer
// changes a single import.
import { db, stmt, buildUpdate, getDB } from './core.js';

// -- Organizations --

export function createOrg(id, name, description, ownerId) {
  stmt('dvCreateOrg', `INSERT OR IGNORE INTO organizations (id, name, description, owner_id)
    VALUES (?, ?, ?, ?)`).run(id, name, description || '', ownerId || '');
}

export function listOrgs() {
  return stmt('dvListOrgs', 'SELECT * FROM organizations ORDER BY created_at').all();
}

export function getOrg(id) {
  return stmt('dvGetOrg', 'SELECT * FROM organizations WHERE id = ?').get(id);
}

export function updateOrg(id, fields) {
  buildUpdate('organizations', id, fields, ['name', 'description', 'plan', 'status']);
}

export function deleteOrg(id) {
  db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
}

// -- Projects --

export function createProject(id, name, description, repoUrl, orgId, type) {
  stmt('dvCreateProject', `INSERT OR IGNORE INTO projects (id, name, description, repo_url, org_id, type)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, description || '', repoUrl || '', orgId || '', type || 'software');
}

export function listProjects(orgId) {
  if (orgId) return db.prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at').all(orgId);
  return stmt('dvListProjects', 'SELECT * FROM projects ORDER BY created_at').all();
}

export function getProject(id) {
  return stmt('dvGetProject', 'SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProject(id, fields) {
  if (fields.bug_categories !== undefined && typeof fields.bug_categories !== 'string') {
    fields = Object.assign({}, fields, { bug_categories: JSON.stringify(fields.bug_categories) });
  }
  buildUpdate('projects', id, fields, ['name', 'description', 'repo_url', 'repo_path', 'org_id', 'type', 'status', 'bug_categories', 'team_id']);
}

export function deleteProject(id) {
  getDB().prepare('DELETE FROM projects WHERE id = ?').run(id);
}
