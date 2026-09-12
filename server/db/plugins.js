// =============== MYCELIUM — DB entity: plugin records + config ===============
// Extracted from server/db.js (Wave 3 of the decomposition). Zero coupling
// outgoing; consumed by the plugin loader (server/plugins.js) at boot via the
// barrel. The ten functions below use only the live `db` + `stmt` bindings from
// ./core.js (no sibling db/* imports). Bodies moved VERBATIM — bare
// db.prepare(...) / stmt(...) keep working via the ESM live bindings
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/plugins.js'` so no consumer changes
// a single import.
import { db, stmt } from './core.js';

// =============== PLUGINS ===============

export function ensurePluginRecord(manifest) {
  var existing = stmt('dvGetPlugin', 'SELECT * FROM plugins WHERE name = ?').get(manifest.name);
  if (existing) {
    stmt('dvUpdatePlugin', `UPDATE plugins SET display_name = ?, description = ?, version = ?, author = ?, route_prefix = ?, mcp_tool_count = ?, updated_at = datetime('now')
      WHERE name = ?`).run(manifest.displayName || '', manifest.description || '', manifest.version || '1.0.0', manifest.author || '', manifest.routePrefix || '', manifest.mcpToolCount || 0, manifest.name);
    return { ...existing, updated: true };
  }
  // First insert honors the manifest's declared initial state (a plugin that
  // ships enabled:true loads on first boot); thereafter the existing-record
  // path above preserves the operator's enable/disable override. Manifests
  // without an explicit enabled flag still default to disabled (safe).
  stmt('dvInsertPlugin', `INSERT INTO plugins (name, display_name, description, version, author, enabled, route_prefix, mcp_tool_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(manifest.name, manifest.displayName || '', manifest.description || '', manifest.version || '1.0.0', manifest.author || '', manifest.enabled === true ? 1 : 0, manifest.routePrefix || '', manifest.mcpToolCount || 0);
  return { name: manifest.name, created: true };
}

export function getPluginRecord(name) {
  return stmt('dvGetPlugin', 'SELECT * FROM plugins WHERE name = ?').get(name);
}

export function listPluginRecords() {
  return db.prepare('SELECT * FROM plugins ORDER BY name').all();
}

export function updatePluginEnabled(name, enabled) {
  return db.prepare("UPDATE plugins SET enabled = ?, updated_at = datetime('now') WHERE name = ?").run(enabled ? 1 : 0, name);
}

// ======== REGISTRY RECONCILE (task 186 §5, AUDIT-lab-clockwork-2026-09-12) ========
// The registry carried rows whose plugin DIRECTORY no longer exists (12 on the
// live box — removed plugins leave permanent ghosts, one reading `enabled`
// with no code behind it). ensurePluginRecord only syncs rows for dirs that
// exist, so nothing ever cleaned these up. The loader now reconciles at boot:
// a row with no directory is MARKED orphaned — rows are never deleted, the
// operator's enabled flag is never touched — and a directory that comes back
// clears the flag on the next boot.

export function ensurePluginOrphanColumns() {
  try { db.prepare('ALTER TABLE plugins ADD COLUMN orphaned INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* column exists */ }
  try { db.prepare('ALTER TABLE plugins ADD COLUMN orphaned_at TEXT').run(); } catch (e) { /* column exists */ }
}

export function reconcilePluginOrphans(existingDirs) {
  ensurePluginOrphanColumns();
  var dirs = existingDirs || [];
  var marked = 0;
  var restored = 0;
  var rows = db.prepare('SELECT name, orphaned FROM plugins').all();
  for (var row of rows) {
    var hasDir = dirs.indexOf(row.name) !== -1;
    if (hasDir && row.orphaned) {
      db.prepare("UPDATE plugins SET orphaned = 0, orphaned_at = NULL, updated_at = datetime('now') WHERE name = ?").run(row.name);
      restored++;
    } else if (!hasDir && !row.orphaned) {
      db.prepare("UPDATE plugins SET orphaned = 1, orphaned_at = datetime('now') WHERE name = ?").run(row.name);
      marked++;
    }
  }
  return { marked: marked, restored: restored };
}

export function getPluginMigrationVersion(pluginName) {
  var row = db.prepare('SELECT MAX(version) as v FROM plugin_migrations WHERE plugin_name = ?').get(pluginName);
  return row ? (row.v || 0) : 0;
}

export function recordPluginMigration(pluginName, version, description) {
  db.prepare('INSERT INTO plugin_migrations (plugin_name, version, description) VALUES (?, ?, ?)').run(pluginName, version, description || '');
}

// ======== PLUGIN CONFIG ========

export function getPluginConfig(pluginName) {
  var rows = db.prepare('SELECT key, value, is_secret FROM plugin_config WHERE plugin_name = ?').all(pluginName);
  return rows;
}

export function getPluginConfigValue(pluginName, key) {
  var row = db.prepare('SELECT value FROM plugin_config WHERE plugin_name = ? AND key = ?').get(pluginName, key);
  return row ? row.value : null;
}

export function setPluginConfig(pluginName, key, value, isSecret) {
  db.prepare(
    `INSERT INTO plugin_config (plugin_name, key, value, is_secret, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(plugin_name, key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at`
  ).run(pluginName, key, String(value), isSecret ? 1 : 0);
}

export function deletePluginConfig(pluginName, key) {
  db.prepare('DELETE FROM plugin_config WHERE plugin_name = ? AND key = ?').run(pluginName, key);
}
