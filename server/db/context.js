// =============== MYCELIUM — DB entity: legacy context + context keys + history ===============
// Extracted from server/db.js (Wave 2 of the decomposition). Zero coupling: the
// functions below use only the live `db` + `stmt` bindings from ./core.js (no
// sibling db/* imports). Prototype-pollution sanitization stays INLINED inside
// upsertContextKey (master form — verbatim); `enforceNamespaceCap` and the
// CONTEXT_MAX_KEYS_PER_NAMESPACE cap move with the module and stay unexported.
// Bodies moved VERBATIM — bare db.prepare(...) / stmt(...) keep working via the
// ESM live bindings (initDBConnection assigns db; nobody else may). The barrel
// server/db.js re-exports these via `export * from './db/context.js'` so no
// consumer changes a single import.
import { db, stmt } from './core.js';
import { isSecurityContextKey, SECURITY_CONTEXT_KEYS } from '../enforcement-rules.js';

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
  // Trust layer P0 (review A round 2 of PR #193): a census key is DURABLE BY
  // CONSTRUCTION — whatever the caller asked, the row is stored durable with
  // no expiry, so no expiry sweep can ever find an expired census key to take.
  // The routes additionally REFUSE ttl/expires_at on census writes (400 /
  // per-entry) so a caller asking for one is told, not silently ignored; this
  // layer holds for every writer that bypasses the routes (internal callers,
  // admin bulk loads, future census keys).
  if (isSecurityContextKey(namespace, key)) {
    category = 'durable';
    expiresAt = null;
  }

  var existing = db.prepare("SELECT data, project_id FROM context_keys WHERE namespace = ? AND key = ?").get(namespace, key);
  var merged = data;
  // A security-gating key (the census in ../enforcement-rules.js) is stored
  // WHOLE, never merged: Object.assign-spread of a bare array over an object
  // manufactures {"0":…,"1":…} — which getEnforcementRules reads as zero
  // rules. The HTTP route validates the shape first; the invariant lives HERE
  // because this is the layer that owns the merge (trust layer P0 / F-253).
  var replace = !!(opts && opts.replace) || isSecurityContextKey(namespace, key);
  if (existing) {
    // Save previous value to history before overwriting. Stamp the history row
    // with the key's CURRENT project (preserved for existing keys) so history
    // reads + rollbacks can be project-scoped (F1).
    try {
      db.prepare("INSERT INTO context_history (namespace, key, data, changed_by, project_id) VALUES (?, ?, ?, ?, ?)").run(namespace, key, existing.data, agentId || '', existing.project_id || null);
      // Keep only last 50 versions per key
      db.prepare("DELETE FROM context_history WHERE namespace = ? AND key = ? AND id NOT IN (SELECT id FROM context_history WHERE namespace = ? AND key = ? ORDER BY id DESC LIMIT 50)").run(namespace, key, namespace, key);
    } catch (e) { /* non-critical — history table may not exist yet */ }
    if (!replace) {
      try {
        var existingData = JSON.parse(existing.data);
        var newData = typeof data === 'string' ? JSON.parse(data) : data;
        // Sanitize against prototype pollution
        if (newData && typeof newData === 'object') {
          delete newData.__proto__;
          delete newData.constructor;
          delete newData.prototype;
        }
        merged = JSON.stringify(Object.assign({}, existingData, newData));
      } catch (e) {
        merged = typeof data === 'string' ? data : JSON.stringify(data);
      }
    } else {
      merged = typeof data === 'string' ? data : JSON.stringify(data);
    }
  } else {
    merged = typeof data === 'string' ? data : JSON.stringify(data);
  }
  db.prepare(
    "INSERT INTO context_keys (namespace, key, data, category, project_id, expires_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(namespace, key) DO UPDATE SET data = excluded.data, category = excluded.category, expires_at = excluded.expires_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
  ).run(namespace, key, merged, category, projectId, expiresAt, agentId);

  // Enforce size cap per namespace
  enforceNamespaceCap(namespace);
}

function enforceNamespaceCap(namespace) {
  // Trust layer P0 (review B of PR #193): census keys (isSecurityContextKey —
  // e.g. mycelium/enforcement_rules, the value checkEnforcementRules turns
  // into 403s) never count toward the cap and are never eviction candidates.
  // The cap is driven by ORDINARY writes to the namespace, so without this a
  // non-admin flood deletes the security key without any write to it — and a
  // delete that bypasses the routes cannot invalidate the enforcement cache,
  // so the gate reads intact until the TTL lapses and then reads zero rules.
  // Excluding census keys from BOTH the count and the candidates means the
  // cap neither evicts them nor evicts others early on their behalf; the
  // context routes (routes/context.js) additionally refuse non-admin NEW keys
  // in a census namespace, and this layer holds for every writer that
  // bypasses the routes (internal callers, admin bulk loads, pre-existing
  // rows, future census keys).
  var count = db.prepare("SELECT COUNT(*) as c FROM context_keys WHERE namespace = ?").get(namespace);
  if (count.c <= CONTEXT_MAX_KEYS_PER_NAMESPACE) return;
  var rows = db.prepare("SELECT id, key, category, updated_at FROM context_keys WHERE namespace = ?").all(namespace);
  var evictable = rows.filter(function (r) { return !isSecurityContextKey(namespace, r.key); });
  var excess = evictable.length - CONTEXT_MAX_KEYS_PER_NAMESPACE;
  if (excess <= 0) return;
  // Delete oldest ephemeral keys first, then oldest durable — the original
  // eviction order (CASE WHEN category = 'ephemeral' THEN 0 ELSE 1 END, updated_at ASC).
  evictable.sort(function (a, b) {
    var ae = a.category === 'ephemeral' ? 0 : 1;
    var be = b.category === 'ephemeral' ? 0 : 1;
    if (ae !== be) return ae - be;
    return String(a.updated_at || '').localeCompare(String(b.updated_at || ''));
  });
  var ids = evictable.slice(0, excess).map(function (r) { return r.id; });
  db.prepare(
    "DELETE FROM context_keys WHERE id IN (" + ids.map(function () { return '?'; }).join(',') + ")"
  ).run(...ids);
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
  // Trust layer P0 (review A round 2 of PR #193): the lazy-expiry sweep never
  // takes a census key. A key whose value is an authorization gate must not
  // vanish by clock on a cold read — the enforcement-rules loader's own cold
  // read runs through HERE, so without this the reader would be the remover,
  // deleting the gate with no cache invalidation and no event. (Legacy rows
  // are sanitized durable at boot by sanitizeSecurityContextKeys; post-fix no
  // writer can put an expiry on a census key.)
  if (row && !isSecurityContextKey(namespace, key) && row.expires_at && new Date(row.expires_at) < new Date()) {
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

// What a bulk-delete is ABOUT to delete (id, namespace, key) — the context
// routes call this before bulkDeleteContextKeys so they can invalidate the
// enforcement cache when the rules key is among the rows (trust layer P0).
export function getContextKeysByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  var placeholders = ids.map(function () { return '?'; }).join(',');
  return db.prepare("SELECT id, namespace, key FROM context_keys WHERE id IN (" + placeholders + ")").all(...ids);
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
  // Restore the historical value. Trust layer P0 (review A round 2 of PR
  // #193): a rollback is a census write — the restored row comes back DURABLE
  // with no expiry, so a rollback can neither resurrect nor keep an expiry
  // that an expiry sweep could act on. (History rows carry no expiry of their
  // own; the taint, if any, sits on the live row.)
  var census = isSecurityContextKey(row.namespace, row.key);
  db.prepare(
    "UPDATE context_keys SET data = ?, updated_by = ?, updated_at = datetime('now')" +
    (census ? ", category = 'durable', expires_at = NULL" : "") +
    " WHERE namespace = ? AND key = ?"
  ).run(row.data, agentId || '', row.namespace, row.key);
  return row;
}

// Purge all expired context keys (called on server boot and periodically).
// Trust layer P0 (review A round 2 of PR #193): the sweep never takes a census
// key — an expires_at on the rules row (a legacy or admin write) must not be
// able to remove the gate by clock, with no cache invalidation and no event.
// The census lives in ../enforcement-rules.js and is a JS predicate, so the
// candidates are filtered here rather than in SQL; the delete is by id.
export function purgeExpiredContextKeys() {
  var expired = db.prepare(
    "SELECT id, namespace, key FROM context_keys WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')"
  ).all();
  var doomed = expired.filter(function (r) { return !isSecurityContextKey(r.namespace, r.key); });
  if (doomed.length === 0) return 0;
  var result = db.prepare(
    "DELETE FROM context_keys WHERE id IN (" + doomed.map(function () { return '?'; }).join(',') + ")"
  ).run(...doomed.map(function (r) { return r.id; }));
  return result.changes;
}

// Trust layer P0 (review A round 2 of PR #193): census keys are durable by
// construction — clear any legacy expiry/ephemeral off an EXISTING census row.
// Called once at boot, BEFORE the first purge, so a pre-fix row carrying an
// expires_at is healed before any sweep can even consider it. Migration-safe
// (an UPDATE, no schema change) and idempotent (the WHERE guard makes a
// second call a no-op).
export function sanitizeSecurityContextKeys() {
  var changed = 0;
  for (var i = 0; i < SECURITY_CONTEXT_KEYS.length; i++) {
    var entry = SECURITY_CONTEXT_KEYS[i];
    var result = db.prepare(
      "UPDATE context_keys SET category = 'durable', expires_at = NULL " +
      "WHERE namespace = ? AND key = ? AND (category != 'durable' OR expires_at IS NOT NULL)"
    ).run(entry.namespace, entry.key);
    changed += result.changes;
  }
  return changed;
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
