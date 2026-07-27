// =============== MYCELIUM — DB entity: skills registry ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the seven functions below use only the live `db` + `buildUpdate` bindings
// from ./core.js (no `stmt`, no sibling db/* imports). Bodies moved VERBATIM —
// bare db.prepare(...) / buildUpdate(...) keep working via the ESM live
// bindings (initDBConnection assigns db; nobody else may). The barrel
// server/db.js re-exports these via `export * from './db/skills.js'` so no
// consumer changes a single import.
import { db, buildUpdate } from './core.js';

// -- Skills Registry --

export function createSkill(id, name, description, category, version, author, installType, installData, requiredCapabilities, tags) {
  db.prepare(
    "INSERT INTO skills (id, name, description, category, version, author, install_type, install_data, required_capabilities, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, description || '', category || 'general', version || '1.0.0', author || '',
    installType || 'concept', typeof installData === 'string' ? installData : JSON.stringify(installData || {}),
    typeof requiredCapabilities === 'string' ? requiredCapabilities : JSON.stringify(requiredCapabilities || []),
    typeof tags === 'string' ? tags : JSON.stringify(tags || []));
  return { id: id };
}

export function getSkill(id) {
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
}

export function listSkills(filters) {
  var where = ["status = 'published'"];
  var params = [];
  if (filters && filters.category) { where.push('category = ?'); params.push(filters.category); }
  if (filters && filters.search) { where.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)'); var s = '%' + filters.search + '%'; params.push(s, s, s); }
  return db.prepare('SELECT * FROM skills WHERE ' + where.join(' AND ') + ' ORDER BY install_count DESC, name ASC').all(...params);
}

export function updateSkill(id, updates) {
  var f = Object.assign({}, updates);
  if (f.install_data !== undefined && typeof f.install_data !== 'string') f.install_data = JSON.stringify(f.install_data);
  if (f.required_capabilities !== undefined && typeof f.required_capabilities !== 'string') f.required_capabilities = JSON.stringify(f.required_capabilities);
  if (f.tags !== undefined && typeof f.tags !== 'string') f.tags = JSON.stringify(f.tags);
  var changed = buildUpdate('skills', id, f, ['name', 'description', 'category', 'version', 'install_data', 'required_capabilities', 'tags', 'status'], { updatedAt: true });
  if (!changed) return null;
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
}

export function installSkill(agentId, skillId, config) {
  db.prepare(
    "INSERT OR REPLACE INTO agent_skills (agent_id, skill_id, config) VALUES (?, ?, ?)"
  ).run(agentId, skillId, typeof config === 'string' ? config : JSON.stringify(config || {}));
  db.prepare('UPDATE skills SET install_count = install_count + 1 WHERE id = ?').run(skillId);
}

export function uninstallSkill(agentId, skillId) {
  db.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?').run(agentId, skillId);
}

export function getAgentSkills(agentId) {
  return db.prepare(
    'SELECT s.*, as2.installed_at, as2.config FROM skills s JOIN agent_skills as2 ON s.id = as2.skill_id WHERE as2.agent_id = ? ORDER BY s.name'
  ).all(agentId);
}
