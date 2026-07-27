// =============== MYCELIUM — DB entity: operators + studio users ===============
// Extracted from server/db.js (Wave 2 of the decomposition). Co-located
// deliberately — `isNetworkAutonomous` JOINs `operators × studio_users`. The
// sixteen functions below use only the live `db` + `stmt` + `buildUpdate`
// bindings from ./core.js (no sibling db/* imports). Bodies moved VERBATIM —
// bare db.prepare(...) / stmt(...) / buildUpdate(...) keep working via the ESM
// live bindings (initDBConnection assigns db; nobody else may). The barrel
// server/db.js re-exports these via `export * from './db/operators.js'` so no
// consumer changes a single import.
import { db, stmt, buildUpdate } from './core.js';

// -- Operators --

export function createOperator(id, displayName, role, responsibilities, email, studioUserId) {
  stmt('dvCreateOperator', `INSERT INTO operators (id, display_name, role, responsibilities, email, studio_user_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, displayName, role || 'member', responsibilities || '', email || '', studioUserId || null);
}

export function getOperator(id) {
  return stmt('dvGetOperator', 'SELECT * FROM operators WHERE id = ?').get(id);
}

export function listOperators() {
  return stmt('dvListOperators', 'SELECT * FROM operators ORDER BY created_at').all();
}

export function updateOperator(id, fields) {
  buildUpdate('operators', id, fields, ['display_name', 'role', 'responsibilities', 'email', 'studio_user_id', 'status', 'availability', 'away_message'], { updatedAt: true });
}

export function setOperatorAvailability(id, availability, awayMessage) {
  db.prepare(`UPDATE operators SET availability = ?, away_message = ?, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(availability, awayMessage || '', id);
}

export function getAvailableOperators() {
  return db.prepare("SELECT * FROM operators WHERE status = 'active' AND availability = 'available'").all();
}

export function isNetworkAutonomous() {
  // An operator counts as "present" only if they are available AND their linked
  // dashboard user has been active recently. Agent heartbeats are automated and
  // do NOT indicate human presence.
  var count = db.prepare(
    "SELECT COUNT(DISTINCT o.id) as c FROM operators o " +
    "LEFT JOIN studio_users u ON u.id = o.studio_user_id " +
    "WHERE o.status = 'active' AND o.availability = 'available' AND " +
    "  u.last_seen > datetime('now', '-30 minutes')"
  ).get();
  return count.c === 0;
}

export function deleteOperator(id) {
  stmt('dvDeleteOperator', 'DELETE FROM operators WHERE id = ?').run(id);
}

// -- Studio Users --

export function createStudioUser(username, displayName, passwordHash, role) {
  var result = db.prepare(
    "INSERT INTO studio_users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(username, displayName, passwordHash, role || 'admin');
  return result.id;
}

export function getStudioUserByUsername(username) {
  return db.prepare("SELECT * FROM studio_users WHERE username = ?").get(username);
}

export function getStudioUserById(id) {
  return db.prepare("SELECT id, username, display_name, role, created_at FROM studio_users WHERE id = ?").get(id);
}

export function listStudioUsers() {
  return db.prepare("SELECT id, username, display_name, role, created_at, last_seen FROM studio_users ORDER BY created_at").all();
}

export function touchStudioUserSeen(id) {
  db.prepare("UPDATE studio_users SET last_seen = datetime('now') WHERE id = ?").run(id);
}

export function getActiveStudioUsers(withinMinutes) {
  var mins = withinMinutes || 5;
  return db.prepare(
    "SELECT id, username, display_name, role, last_seen FROM studio_users WHERE last_seen >= datetime('now', '-' || ? || ' minutes') ORDER BY last_seen DESC"
  ).all(mins);
}

export function deleteStudioUser(id) {
  db.prepare("DELETE FROM studio_users WHERE id = ?").run(id);
}

export function updateStudioUser(id, fields) {
  buildUpdate('studio_users', id, fields, ['display_name', 'password_hash', 'role']);
}
