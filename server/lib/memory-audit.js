// TRUST LAYER P1.5 (F-mycelium/264, PROGRAM-mycelium-trust-layer-2026-09-26 §P1.5)
// — the append-only, hash-chained memory audit log.
//
// The 09-26 audit's finding 6: memory writes left no attributable trail —
// `memory_indexed` fired on /index + lesson supersede only (nothing on bulk,
// deletes, /me/memory, auto-memory or federation), and the `events` table is
// prunable and was readable by any agent. This module is the fix's storage
// half: ONE SQLite table, appended by every memory write path across the
// semantic-memory, auto-memory and federation plugins, that nothing can
// revise —
//
//   * APPEND-ONLY at the storage layer: the only statements this module (or
//     any caller) can run against `memory_audit` are INSERT and SELECT;
//     BEFORE UPDATE/DELETE triggers RAISE at the database itself, so even
//     housekeeping/rotation code cannot touch it (the #193 lesson: audit
//     every DELETE path — the audit table is the one path that audits
//     itself out of the cleanup lists). The DDL here is mirrored in
//     server/schema.sql (the canonical fresh-boot shape) — keep the two in
//     sync; both are IF NOT EXISTS idempotent.
//   * HASH-CHAINED: each row carries prev_hash (the prior row's hash,
//     genesis = 64 × '0') and hash = sha256(prev_hash + canonical(row)),
//     where canonical(row) is a stable JSON serialization (recursively
//     key-sorted, no whitespace) of every field except `hash` itself. Any
//     edit, reorder or middle-row deletion breaks every hash after it —
//     verify() names the first broken seq.
//
// Actor law: `actor` is ALWAYS the authenticated identity the caller's
// route derived (agent key → agent id, admin key → '__system__'/X-Acting-As,
// studio bearer → '__user:<displayName>', federation visit → the
// grant-bound visitor agent). No body field ever reaches it. The one
// exception is server-internal writers, which sign 'system:<role>' — a
// server-internal write is attributable to the server itself, which is the
// honest actor. The one asterisk (review A threat model): the admin key's
// X-Acting-As attribution IS a header-set actor — reachable only behind
// checkAdmin, so no header a NON-admin can set ever reaches this field.
//
// `row_owner` is the target memory row's owner AT ACTION TIME (written_by /
// am_fact agent_id / companion owner id) — the read-side scope: the audit
// log for a row outlives the row (deletes included), so ownership is
// captured when the row is written on, not re-derived after it is gone.

import crypto from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

// The DDL — mirrored verbatim in server/schema.sql (keep in sync).
export const MEMORY_AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS memory_audit (
  seq         INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  row_owner   TEXT,
  row_hash    TEXT NOT NULL,
  reason      TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_audit_row ON memory_audit(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_audit_actor ON memory_audit(actor);
CREATE INDEX IF NOT EXISTS idx_memory_audit_action ON memory_audit(action, seq);
CREATE TRIGGER IF NOT EXISTS memory_audit_no_update
  BEFORE UPDATE ON memory_audit
BEGIN
  SELECT RAISE(ABORT, 'memory_audit is append-only (TRUST LAYER P1.5): UPDATE refused');
END;
CREATE TRIGGER IF NOT EXISTS memory_audit_no_delete
  BEFORE DELETE ON memory_audit
BEGIN
  SELECT RAISE(ABORT, 'memory_audit is append-only (TRUST LAYER P1.5): DELETE refused');
END;
`;

// Canonical form: every object's keys recursively sorted, JSON, no
// whitespace. Deterministic across processes and runs — this exact byte
// string is what the chain hashes, so it must never change shape once rows
// exist (a change would strand every stored hash).
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + canonicalJson(value[k]);
  }).join(',') + '}';
}

// The chain's input for one row: every field except `hash` itself.
export function canonicalAuditRow(row) {
  return canonicalJson({
    seq: row.seq,
    at: row.at,
    actor: row.actor,
    action: row.action,
    source_type: row.source_type,
    source_id: row.source_id,
    row_owner: row.row_owner === undefined ? null : row.row_owner,
    row_hash: row.row_hash,
    reason: row.reason === undefined ? null : row.reason,
    prev_hash: row.prev_hash
  });
}

// The audited CONTENT's hash — sha256 over the row's canonical form AFTER
// the action. Callers pass the post-action state they wrote (or, for a
// delete, the row's state AS DELETED — captured in the same transaction, so
// the chain pins what the delete removed). Keys are canonicalized here, so
// the caller's object key order cannot change the hash.
export function contentHash(fields) {
  return crypto.createHash('sha256').update(canonicalJson(fields)).digest('hex');
}

export default function createMemoryAudit(db) {
  db.exec(MEMORY_AUDIT_DDL);

  var insertStmt = db.prepare(
    'INSERT INTO memory_audit (seq, at, actor, action, source_type, source_id, row_owner, row_hash, reason, prev_hash, hash) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  var nextSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM memory_audit');
  var headStmt = db.prepare('SELECT hash FROM memory_audit ORDER BY seq DESC LIMIT 1');
  var nowStmt = db.prepare("SELECT datetime('now') AS n");

  // Append ONE row. Runs inside the caller's transaction when there is one
  // (better-sqlite3 exposes it via inTransaction — the audit row then commits
  // or rolls back WITH the memory write it describes), else in its own.
  // Fail-loud: a throw propagates — the request 500s and the omission is in
  // the server log. An audit that can skip rows silently is not an audit.
  function append(entry) {
    var reason = entry.reason === undefined || entry.reason === null
      ? null
      : String(entry.reason).slice(0, 512);

    function write() {
      var seq = nextSeqStmt.get().seq;
      var prev = seq === 1 ? GENESIS_HASH : headStmt.get().hash;
      var at = nowStmt.get().n;
      var row = {
        seq: seq,
        at: at,
        actor: entry.actor,
        action: entry.action,
        source_type: entry.source_type,
        source_id: String(entry.source_id),
        row_owner: entry.row_owner === undefined ? null : entry.row_owner,
        row_hash: entry.row_hash,
        reason: reason,
        prev_hash: prev
      };
      var hash = crypto.createHash('sha256').update(prev + canonicalAuditRow(row)).digest('hex');
      insertStmt.run(seq, at, row.actor, row.action, row.source_type, row.source_id,
        row.row_owner, row.row_hash, row.reason, prev, hash);
      return seq;
    }

    if (db.inTransaction) return write();
    return db.transaction(write).immediate();
  }

  // Recompute the whole chain. O(n) — an admin integrity read, not a hot path.
  // first_bad_seq names the first row whose stored hash no longer matches its
  // canonical form OR whose linkage to its predecessor broke (an edit, a
  // reorder, or a middle-row deletion; a deletion shows up at the NEXT seq).
  function verify() {
    var rows = db.prepare('SELECT * FROM memory_audit ORDER BY seq').all();
    var prev = GENESIS_HASH;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.prev_hash !== prev ||
          r.hash !== crypto.createHash('sha256').update(r.prev_hash + canonicalAuditRow(r)).digest('hex')) {
        return { ok: false, length: rows.length, first_bad_seq: r.seq };
      }
      prev = r.hash;
    }
    return { ok: true, length: rows.length, first_bad_seq: null };
  }

  // The audit rows for ONE memory row (its full history: writes, edits,
  // deletes — whatever touched it).
  function rowsForRow(sourceType, sourceId, limit) {
    return db.prepare(
      'SELECT seq, at, actor, action, source_type, source_id, row_owner, row_hash, reason, prev_hash, hash ' +
      'FROM memory_audit WHERE source_type = ? AND source_id = ? ORDER BY seq LIMIT ?'
    ).all(sourceType, String(sourceId), limit || 200);
  }

  // Everything after a seq — the sync cursor. `owners`, when given (a string
  // or an array of the caller's owner scopes — an agent id and/or a user id),
  // narrows to rows on memory the caller owns (the non-admin read path).
  function rowsSince(sinceSeq, owners, limit) {
    var COLS = 'SELECT seq, at, actor, action, source_type, source_id, row_owner, row_hash, reason, prev_hash, hash ' +
      'FROM memory_audit WHERE seq > ?';
    if (owners === undefined || owners === null) {
      return db.prepare(COLS + ' ORDER BY seq LIMIT ?').all(sinceSeq, limit || 200);
    }
    var scopes = Array.isArray(owners) ? owners : [owners];
    if (scopes.length === 0) return [];
    var marks = scopes.map(function () { return '?'; }).join(',');
    var stmt = db.prepare(COLS + ' AND row_owner IN (' + marks + ') ORDER BY seq LIMIT ?');
    return stmt.all.apply(stmt, [sinceSeq].concat(scopes, [limit || 200]));
  }

  // The /safety/events surface — the shape the dead
  // mycelium_list_safety_events / mycelium_safety_stats MCP tools have been
  // 404ing on since the day they shipped. The memory audit log IS the safety
  // event stream of the memory layer; the projection below is what the tools
  // render (action, agent_id, severity, command, reason, created_at).
  function safetyEvents(filters) {
    filters = filters || {};
    var where = [];
    var params = [];
    if (filters.actor) { where.push('actor = ?'); params.push(filters.actor); }
    if (filters.action) { where.push('action = ?'); params.push(filters.action); }
    if (filters.since) { where.push('at >= ?'); params.push(filters.since); }
    var sql = 'SELECT seq, at, actor, action, source_type, source_id, row_owner, reason ' +
      'FROM memory_audit' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY seq DESC LIMIT ?';
    params.push(Math.min(filters.limit || 50, 500));
    return db.prepare(sql).all(...params).map(function (r) {
      return {
        action: r.action,
        agent_id: r.actor,
        severity: 'none',
        command: r.source_type + ':' + r.source_id,
        reason: r.reason || ('memory ' + r.action + ' on ' + r.source_type + ':' + r.source_id),
        created_at: r.at
      };
    });
  }

  function safetyStats(filters) {
    filters = filters || {};
    var where = [];
    var params = [];
    if (filters.actor) { where.push('actor = ?'); params.push(filters.actor); }
    if (filters.since) { where.push('at >= ?'); params.push(filters.since); }
    var sql = 'SELECT action, COUNT(*) AS count FROM memory_audit' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' GROUP BY action ORDER BY count DESC';
    var breakdown = db.prepare(sql).all(...params);
    var total = 0;
    for (var i = 0; i < breakdown.length; i++) total += breakdown[i].count;
    return { total: total, breakdown: breakdown };
  }

  return {
    append: append,
    verify: verify,
    rowsForRow: rowsForRow,
    rowsSince: rowsSince,
    safetyEvents: safetyEvents,
    safetyStats: safetyStats
  };
}
