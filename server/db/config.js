// =============== MYCELIUM — DB entity: instance config + sleep mode ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the six functions below use only the live `stmt` binding from ./core.js (no
// `db`, no `buildUpdate`, no sibling db/* imports). getSleepMode /
// appendSleepLog call getInstanceConfig / setInstanceConfig in-module, which
// resolve to this module's own exports. Bodies moved VERBATIM — bare
// stmt('dv…', …) keeps working via the ESM live binding (initDBConnection
// assigns db; nobody else may). The barrel server/db.js re-exports these via
// `export * from './db/config.js'` so no consumer changes a single import.
import { stmt } from './core.js';

// -- Instance Config --

export function getInstanceConfig(key) {
  var row = stmt('dvGetConfig', 'SELECT value FROM instance_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setInstanceConfig(key, value, updatedBy) {
  stmt('dvSetConfig', `INSERT INTO instance_config (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(key, value, updatedBy || '');
}

export function listInstanceConfig() {
  return stmt('dvListConfig', 'SELECT * FROM instance_config ORDER BY key').all();
}

export function deleteInstanceConfig(key) {
  stmt('dvDeleteConfig', 'DELETE FROM instance_config WHERE key = ?').run(key);
}

// -- Sleep Mode --

export function getSleepMode() {
  var val = getInstanceConfig('sleep_mode');
  if (!val) return { active: false };
  try { return JSON.parse(val); } catch (e) { return { active: false }; }
}

export function appendSleepLog(field, item) {
  var val = getInstanceConfig('sleep_mode_log');
  var log;
  try { log = val ? JSON.parse(val) : {}; } catch (e) { log = {}; }
  if (!log[field]) log[field] = [];
  if (Array.isArray(log[field])) {
    log[field].push(item);
  }
  setInstanceConfig('sleep_mode_log', JSON.stringify(log), '__system__');
}
