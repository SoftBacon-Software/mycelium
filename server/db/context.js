// =============== MYCELIUM — DB entity: legacy context + context keys + history ===============
// Extracted from server/db.js (Wave 3 of the decomposition — see
// docs/DB-DECOMPOSITION-PLAN.md, §1 db/context.js). Zero coupling: the
// fifteen functions below use only the live `db` + `stmt` bindings from
// ./core.js (no sibling db/* imports). The findings-§8 sanitizer set
// (sanitizePrototypeKeys / sanitizeContextData / enforceNamespaceCap /
// CONTEXT_MAX_KEYS_PER_NAMESPACE) moves as a unit and stays unexported.
// Bodies moved VERBATIM — bare db.prepare(...) / stmt(...) keep working via
// the ESM live bindings (initDBConnection assigns db; nobody else may). The
// barrel server/db.js re-exports these via `export * from './db/context.js'`
// so no consumer changes a single import.
import { db, stmt } from './core.js';

// -- Context --

export function getContext(projectId) {
  return stmt('dvGetContext', 'SELECT * FROM context WHERE project_id = ?').get(projectId);
}

export function getAllContext() {
  return stmt('dvGetAllContext', 'SELECT * FROM context ORDER BY updated_at DESC').all();
}

export function upsertContext(projectId, data, agentId) {
  stmt('dvUpsertContext', `INSERT INTO context (project_id, data, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(projectId, data, agentId);
}

// -- Namespaced context --

// Context key categories:
//   'durable'   - persistent config, guidelines, gen profiles (no auto-expiry)
//   'ephemeral' - session state, recovery instructions (auto-expire via TTL)
var CONTEXT_MAX_KEYS_PER_NAMESPACE = 200;

// Strip prototype-pollution keys (__proto__/constructor/prototype) from a parsed
// object, in place. No-op for non-objects. (findings §8) This is the SAME
// sanitizer that used to live inline on the merge path only — extracted so every
// context write path can share it.
function sanitizePrototypeKeys(obj) {
  if (obj && typeof obj === 'object') {
    delete obj.__proto__;
    delete obj.constructor;
    delete obj.prototype;
  }
  return obj;
}

// Coerce a context `data` value (string or object) to its sanitized
// JSON-storage form: JSON-object inputs have __proto__/constructor/prototype
// stripped before re-stringify; non-JSON strings round-trip verbatim (nothing
// to sanitize). (findings §8) Applied to first-write, merge-fallback, and
// rollback writes so the sanitizer can no longer be bypassed by writing to a
// not-yet-existing key.
function sanitizeContextData(data) {
  if (typeof data === 'string') {
    var parsed;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      return data; // non-JSON string → store verbatim
    }
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(sanitizePrototypeKeys(parsed));
    }
    return data; // JSON scalar (number/true/false/null) → verbatim
  }
  sanitizePrototypeKeys(data);
  return JSON.stringify(data);
}

export function upsertContextKey(namespace, key, data, agentId, opts) {
  var category = (opts && opts.category) || 'durable';
  // project_id scopes a key to its owning project (F1). NULL = shared/global.
  // Only stamped on NEW rows; an existing key keeps its project (ON CONFLICT
  // below deliberately omits project_id from the UPDATE) so a shared key stays
  // shared and an owned key can't be re-homed by an overwrite.
  var projectId = (opts && opts.projectId) || null;
  var ttl = (opts && opts.ttl) || null; // seconds
  var expiresAt = null;
  if (ttl) {
    expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  } else if (opts && opts.expires_at) {
    expiresAt = opts.expires_at;
  }

  var existing = db.prepare("SELECT data, project_id FROM context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
  var merged = data;
  if (existing) {
    // Save previous value to history before overwriting. Stamp the history row
    // with the key's CURRENT project (preserved for existing keys) so history
    // reads + rollbacks can be project-scoped (F1).
    try {
      db.prepare("INSERT INTO context_history (namespace, key, data, changed_by, project_id) VALUES (?, ?, ?, ?, ?)").run(namespace, key, existing.data, agentId || '', existing.project_id || null);
      // Keep only last 50 versions per key
      db.prepare("DELETE FROM context_history WHERE namespace = ? AND key = ? AND id NOT IN (SELECT id FROM context_history WHERE namespace = ? AND key = ? ORDER BY id DESC LIMIT 50)").run(namespace, key, namespace, key);
    } catch (e) { /* non-critical — history table may not exist yet */ }
    try {
      var existingData = JSON.parse(existing.data);
      var newData = typeof data === 'string' ? JSON.parse(data) : data;
      sanitizePrototypeKeys(newData); // strip __proto__/constructor/prototype (findings §8)
      merged = JSON.stringify(Object.assign({}, existingData, newData));
    } catch (e) {
      merged = sanitizeContextData(data); // sanitize even when merge falls back to replace (findings §8)
    }
  } else {
    merged = sanitizeContextData(data); // first write — sanitize (findings §8: was stored verbatim)
  }
  db.prepare(
    "INSERT INTO context_keys (namespace, key, data, category, project_id, expires_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(namespace, key) DO UPDATE SET data = excluded.data, category = excluded.category, expires_at = excluded.expires_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).run(namespace, key, merged, category, projectId, expiresAt, agentId);

  // Enforce size cap per namespace
  enforceNamespaceCap(namespace);
}

function enforceNamespaceCap(namespace) {
  var count = db.prepare("SELECT COUNT(*) as c FROM context_keys WHERE namespace = ?").get(namespace);
  if (count.c > CONTEXT_MAX_KEYS_PER_NAMESPACE) {
    // Delete oldest ephemeral keys first, then oldest durable
    var excess = count.c - CONTEXT_MAX_KEYS_PER_NAMESPACE;
    db.prepare(
      "DELETE FROM context_keys WHERE id IN (SELECT id FROM context_keys WHERE namespace = ? ORDER BY CASE WHEN category = 'ephemeral' THEN 0 ELSE 1 END, updated_at ASC LIMIT ?)"
    ).run(namespace, excess);
  }
}

export function cleanupContextHistory(retentionDays) {
  var days = retentionDays || 90;
  var result = db.prepare(
    "DELETE FROM context_history WHERE changed_at < datetime('now', '-' || ? || ' days')"
  ).run(String(days));
  if (result.changes > 0) {
    console.log('[mycelium] Cleaned up %d old context history entries (retention: %d days)', result.changes, days);
  }
  return result.changes;
}

export function getContextKey(namespace, key) {
  var row = db.prepare("SELECT * FROM context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
  if (row && row.expires_at && new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM context_keys WHERE namespace = ? AND key = ?").run(namespace, key);
    return null;
  }
  if (row) {
    // Track access for smart boot scoring
    try {
      db.prepare("UPDATE context_keys SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?").run(row.id);
    } catch (e) { /* non-critical */ }
  }
  return row;
}

export function listContextKeys(namespace, projectId) {
  // Filter out expired keys on read
  var now = new Date().toISOString();
  var conditions = ["(expires_at IS NULL OR expires_at > ?)"];
  var params = [now];
  if (namespace) {
    conditions.push("namespace = ?");
    params.push(namespace);
  }
  // F1: scope listings to shared (NULL) + the caller's project. projectId is
  // left undefined for admins/studio (no filter, see all) and set (possibly
  // null → shared-only) for agents.
  if (projectId !== undefined) {
    conditions.push("(project_id IS NULL OR project_id = ?)");
    params.push(projectId);
  }
  var order = namespace ? "key" : "namespace, key";
  return db.prepare("SELECT * FROM context_keys WHERE " + conditions.join(" AND ") + " ORDER BY " + order).all(...params);
}

export function deleteContextKey(namespace, key) {
  db.prepare("DELETE FROM context_keys WHERE namespace = ? AND key = ?").run(namespace, key);
}

// Bulk delete context keys by array of IDs (admin use)
export function bulkDeleteContextKeys(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  var placeholders = ids.map(function () { return '?'; }).join(',');
  var result = db.prepare("DELETE FROM context_keys WHERE id IN (" + placeholders + ")").run(...ids);
  return result.changes;
}

// Search context keys with filters
export function searchContextKeys(opts) {
  var now = new Date().toISOString();
  var conditions = ["(expires_at IS NULL OR expires_at > ?)"];
  var params = [now];

  if (opts.namespace) {
    conditions.push("namespace = ?");
    params.push(opts.namespace);
  }
  if (opts.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }
  if (opts.updated_by) {
    conditions.push("updated_by = ?");
    params.push(opts.updated_by);
  }
  if (opts.search) {
    conditions.push("(key LIKE ? OR data LIKE ?)");
    var pattern = "%" + opts.search + "%";
    params.push(pattern, pattern);
  }
  // F1: scope search results to shared (NULL) + the caller's project.
  if (opts.projectId !== undefined) {
    conditions.push("(project_id IS NULL OR project_id = ?)");
    params.push(opts.projectId);
  }

  var sql = "SELECT * FROM context_keys WHERE " + conditions.join(" AND ") + " ORDER BY namespace, key";
  return db.prepare(sql).all(...params);
}

// Context history — view previous versions of a key
export function getContextHistory(namespace, key, limit) {
  return db.prepare(
    "SELECT * FROM context_history WHERE namespace = ? AND key = ? ORDER BY id DESC LIMIT ?"
  ).all(namespace, key, limit || 20);
}

// Single history entry by id — used by the rollback route to scope-check the
// caller against the entry's project BEFORE restoring (F1). Returns the row
// (now carrying project_id) without mutating anything.
export function getContextHistoryEntry(historyId) {
  return db.prepare("SELECT * FROM context_history WHERE id = ?").get(historyId);
}

// Rollback — restore a previous version by history ID
export function rollbackContextKey(historyId, agentId) {
  var row = db.prepare("SELECT * FROM context_history WHERE id = ?").get(historyId);
  if (!row) return null;
  // Save current value to history before rollback
  var current = db.prepare("SELECT data FROM context_keys WHERE namespace = ? AND key = ?").get(row.namespace, row.key);
  if (current) {
    db.prepare("INSERT INTO context_history (namespace, key, data, changed_by) VALUES (?, ?, ?, ?)").run(row.namespace, row.key, current.data, agentId || '');
  }
  // Restore the historical value — sanitized against prototype pollution in
  // case the history row predates the write-path fix (findings §8).
  var restored = sanitizeContextData(row.data);
  db.prepare(
    "UPDATE context_keys SET data = ?, updated_by = ?, updated_at = datetime('now') WHERE namespace = ? AND key = ?"
  ).run(restored, agentId || '', row.namespace, row.key);
  return row;
}

export function purgeExpiredContextKeys() {
  var result = db.prepare("DELETE FROM context_keys WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").run();
  return result.changes;
}

// Clean up stale session keys for an agent (called on agent boot)
export function cleanupAgentSessionKeys(agentId) {
  var result = db.prepare("DELETE FROM context_keys WHERE namespace = ? AND category = 'ephemeral' AND expires_at IS NOT NULL AND expires_at <= datetime('now')").run(agentId);
  return result.changes;
}

// Get context stats per namespace
export function contextKeyStats() {
  return db.prepare("SELECT namespace, category, COUNT(*) as count, SUM(LENGTH(data)) as total_bytes FROM context_keys WHERE expires_at IS NULL OR expires_at > datetime('now') GROUP BY namespace, category ORDER BY namespace").all();
}
