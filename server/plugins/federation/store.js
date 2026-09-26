// Federation v0 — the store layer (fed_* tables + provenance on companion rows).
//
// Companion rows (sm_embeddings, source_type 'companion' — see
// docs/companion-memory-api.md) gain five provenance columns:
//   fed_agent   — agent_id of the writer
//   fed_network — network_id where the row was MADE
//   fed_home    — the writer's home network
//   fed_visit   — visit id (null on home-written rows)
//   fed_sig     — the row's Ed25519 signature by the agent (null on home rows)
//
// The columns reach EXISTING databases through the guarded-ALTER idiom
// semantic-memory's db.js uses for superseded_by (the sibling precedent):
// "duplicate column" is the fresh-DB case and is swallowed; anything else
// surfaces at load. Fresh databases get them declared in
// semantic-memory/schema.sql. NULL on every pre-federation row — existing
// rows and their (owner, key, text) ids are untouched.
//
// ROW IDS. The protocol's row id is the content-addressed sha256 (spec §2.3)
// — owner-free by design, so the same memory dedupes across networks. But a
// SERVER is multi-owner and sm_embeddings keys rows by
// UNIQUE(source_type, source_id): two owners importing the same souvenir
// would collide into ONE row, breaking the companion API's absolute owner
// isolation ("a token can never read or forget another owner's rows"). So a
// federated row's STORAGE id is a length-prefixed digest of
// (owner, protocol id) — the companionRowId idiom — and the protocol id
// rides in metadata.fed_id (and in provenance.id in views). On a phone
// (network of one) the two coincide in spirit: one owner, one row.

import crypto from 'crypto';
import companionView from '../semantic-memory/companion-view.js';

export default function createFederationStore(db) {
  // The migration this plugin owns (task 247 §2): provenance columns on the
  // companion row class. Idempotent — safe on every boot and every ordering
  // of plugin loads.
  for (var [table, col, def] of [
    ['sm_embeddings', 'fed_agent', 'TEXT'],
    ['sm_embeddings', 'fed_network', 'TEXT'],
    ['sm_embeddings', 'fed_home', 'TEXT'],
    ['sm_embeddings', 'fed_visit', 'TEXT'],
    ['sm_embeddings', 'fed_sig', 'TEXT']
  ]) {
    try {
      db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def).run();
    } catch (e) {
      if (/duplicate column|already exists/.test(String(e.message))) continue; // fresh-DB case: declared in schema.sql
      if (/no such table/i.test(String(e.message))) {
        // Review A nit 8: name the dependency instead of dying on a raw
        // SQLite error — without semantic-memory the per-plugin load catch
        // reduces this to "federation silently absent", and the operator
        // gets to do the archaeology. Say the requirement out loud — and
        // name BOTH causes: the table is created by semantic-memory's
        // schema, so either semantic-memory is missing/disabled, or (the
        // round-3 blocker) it loaded after federation on this boot. The old
        // "enable semantic-memory" advice was wrong on a fresh install,
        // where it IS enabled and the load ORDER was the defect.
        throw new Error('federation requires the semantic-memory plugin: sm_embeddings is missing — the table is created by semantic-memory\'s schema, so semantic-memory must be enabled and its plugin loaded before federation; if semantic-memory IS enabled, this is a plugin load-order defect', { cause: e });
      }
      throw e;
    }
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sm_fed_visit ON sm_embeddings(fed_visit)');
  } catch (e) {
    // Only the missing-table case is expected here (federation-only test
    // DBs — which the ALTER above already refused); anything else surfaces.
    if (!/no such table/i.test(String(e.message))) throw e;
  }
  // Review B blocker 1: the souvenir is built from the agent passport BOUND
  // to the grant at /grant. Fresh databases get the column declared in this
  // plugin's schema.sql; existing ones reach it through the same guarded
  // ALTER idiom as the sm_embeddings columns above.
  try {
    db.prepare('ALTER TABLE fed_grants ADD COLUMN agent_passport_cjson TEXT').run();
  } catch (e) {
    if (!/duplicate column|already exists/.test(String(e.message))) throw e;
  }

  var now = "datetime('now')";

  function companionNamespace(userId) {
    return 'companion:u' + userId;
  }

  return {

    companionNamespace,

    // ---- identity + policy --------------------------------------------------

    getConfig(key) {
      var row = db.prepare('SELECT value FROM fed_config WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setConfig(key, value) {
      db.prepare('INSERT OR REPLACE INTO fed_config (key, value) VALUES (?, ?)').run(key, String(value));
    },

    // ---- passports ----------------------------------------------------------

    upsertPassport(kind, subjectId, homeNetwork, passportCjson) {
      db.prepare(
        'INSERT INTO fed_passports (kind, subject_id, home_network, passport_cjson, first_seen, last_seen) VALUES (?, ?, ?, ?, ' + now + ', ' + now + ') ' +
        'ON CONFLICT(kind, subject_id) DO UPDATE SET passport_cjson = excluded.passport_cjson, last_seen = excluded.last_seen'
      ).run(kind, subjectId, homeNetwork || null, passportCjson);
    },

    getPassport(kind, subjectId) {
      return db.prepare('SELECT * FROM fed_passports WHERE kind = ? AND subject_id = ?').get(kind, subjectId);
    },

    // ---- grants + visits ------------------------------------------------------

    insertGrant(g) {
      db.prepare(
        'INSERT INTO fed_grants (grant_id, visit_id, host_owner, host_network, agent_id, home_network, agent_passport_cjson, kinds_writable, kinds_readable, kinds_exportable, issued_at, expires_at, sig_by_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(g.grant_id, g.visit_id, g.host_owner, g.host_network, g.agent_id, g.home_network, g.agent_passport_cjson || null,
        JSON.stringify(g.kinds_writable), JSON.stringify(g.kinds_readable || []),
        JSON.stringify(g.kinds_exportable), g.issued_at, g.expires_at, g.sig_by_host);
      db.prepare(
        'INSERT INTO fed_visits (visit_id, grant_id, agent_id, home_network, host_owner, started_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(g.visit_id, g.grant_id, g.agent_id, g.home_network, g.host_owner, g.issued_at);
    },

    grantByVisit(visitId) {
      var row = db.prepare('SELECT * FROM fed_grants WHERE visit_id = ?').get(visitId);
      if (!row) return null;
      row.kinds_writable = JSON.parse(row.kinds_writable);
      row.kinds_readable = JSON.parse(row.kinds_readable);
      row.kinds_exportable = JSON.parse(row.kinds_exportable);
      return row;
    },

    endVisit(visitId) {
      db.prepare('UPDATE fed_visits SET ended_at = ' + now + ', souvenir_at = ' + now + ' WHERE visit_id = ? AND ended_at IS NULL').run(visitId);
      db.prepare("UPDATE fed_grants SET status = 'ended' WHERE visit_id = ? AND status = 'active'").run(visitId);
    },

    // The admin kill switch (review A minor 3): unlike endVisit (the visit's
    // own souvenir closing it), a revoked visit refuses writes AND souvenirs.
    // ended_at is stamped only when the visit was still open, so a revoke
    // after a natural end does not rewrite history.
    revokeVisit(visitId) {
      db.prepare('UPDATE fed_visits SET ended_at = COALESCE(ended_at, ' + now + ') WHERE visit_id = ?').run(visitId);
      db.prepare("UPDATE fed_grants SET status = 'revoked' WHERE visit_id = ?").run(visitId);
      return db.prepare(
        'SELECT v.*, g.status AS grant_status FROM fed_visits v LEFT JOIN fed_grants g ON g.visit_id = v.visit_id WHERE v.visit_id = ?'
      ).get(visitId);
    },

    visit(visitId) {
      return db.prepare('SELECT * FROM fed_visits WHERE visit_id = ?').get(visitId);
    },

    // ---- envelopes (replay window) -------------------------------------------

    consumeNonce(nonce) {
      var res = db.prepare('INSERT OR IGNORE INTO fed_nonces (nonce, seen_at) VALUES (?, ' + now + ')').run(nonce);
      db.prepare("DELETE FROM fed_nonces WHERE seen_at < datetime('now', '-15 minutes')").run();
      return res.changes === 1; // false = already seen = replay
    },

    // ---- rows on the companion store -----------------------------------------
    // Direct INSERTs with the exact shape /me/memory writes (source_type
    // 'companion', one namespace per owner, metadata carrying kind/source/at);
    // the FTS triggers in semantic-memory's schema fire on any insert, so
    // these rows are keyword-searchable from birth. Embedding is left to the
    // existing backfill (/memory/reindex) — federation never spawns jobs.

    // Storage id: length-prefixed digest of (owner, protocol id) — the
    // companionRowId idiom (a bare \0 join is ambiguous; see review A r2 NIT 4
    // on the companion surface). Owner-scoped so the multi-owner isolation
    // guarantee holds; the protocol id rides in metadata.fed_id.
    fedRowId(ownerId, protocolId) {
      function comp(s) { return s.length + ':' + s; }
      return crypto.createHash('sha256')
        .update('fed\u0000' + comp(String(ownerId)) + '\u0000' + comp(String(protocolId)))
        .digest('hex');
    },

    rowById(ownerId, protocolId) {
      return db.prepare(
        "SELECT * FROM sm_embeddings WHERE source_type = 'companion' AND source_id = ? AND namespace = ? AND chunk_index = 0"
      ).get(this.fedRowId(ownerId, protocolId), companionNamespace(ownerId));
    },

    // Host-owner scoped (review B minor 2): when one server is both host and
    // home, an import writes the episode row with fed_visit set and sig null
    // into the HOME owner's namespace — `WHERE fed_visit = ?` alone would
    // ship it in a souvenir rebuild and fail row-sig at the home door.
    rowsByVisit(visitId, hostOwnerId) {
      return db.prepare(
        "SELECT * FROM sm_embeddings WHERE source_type = 'companion' AND fed_visit = ? AND namespace = ? AND chunk_index = 0 ORDER BY created_at, source_id"
      ).all(visitId, companionNamespace(hostOwnerId));
    },

    liveHomeRows(ownerId) {
      return db.prepare(
        "SELECT source_id, metadata FROM sm_embeddings WHERE source_type = 'companion' AND namespace = ? AND superseded_by IS NULL"
      ).all(companionNamespace(ownerId));
    },

    // Insert one federated row (visited or imported). Idempotent per owner by
    // protocol id: returns { inserted: false, row } when the row already exists.
    insertFedRow(ownerId, row, opts) {
      var meta = {
        owner: ownerId,
        kind: row.kind,
        source: row.source,
        at: row.at,
        fed_id: row.id
      };
      if (row.key) meta.key = row.key;
      if (row.supersedes) meta.supersedes = row.supersedes;
      if (opts && opts.candidate) meta.candidate = true;
      var storageId = this.fedRowId(ownerId, row.id);
      var existing = db.prepare(
        "SELECT * FROM sm_embeddings WHERE source_type = 'companion' AND source_id = ? AND chunk_index = 0"
      ).get(storageId);
      if (existing) return { inserted: false, row: existing };
      var res = db.prepare(
        'INSERT OR IGNORE INTO sm_embeddings (source_type, source_id, chunk_index, content_text, namespace, metadata, fed_agent, fed_network, fed_home, fed_visit, fed_sig) ' +
        "VALUES ('companion', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(storageId, row.text, companionNamespace(ownerId), JSON.stringify(meta),
        row.agent || null, row.network || null, row.home || null, row.visit || null, row.sig || null);
      if (res.changes === 0) return { inserted: false, row: this.rowById(ownerId, row.id) };
      return { inserted: true, row: this.rowById(ownerId, row.id) };
    },

    // The row shape the protocol + API surfaces agree on. This IS the
    // companion view — one shared implementation in semantic-memory (the
    // plugin that owns the table), not a twin that can drift (review A nit 7).
    view(row) {
      return companionView(row);
    },

    // A store row back into protocol shape (for building souvenir bundles).
    protocolRow(row) {
      var meta = row.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta || '{}'); } catch (e) { meta = {}; }
      }
      return {
        kind: meta.kind || null,
        key: meta.key || null,
        text: row.content_text,
        source: meta.source || null,
        at: meta.at || null,
        supersedes: meta.supersedes || null,
        id: meta.fed_id || row.source_id,
        agent: row.fed_agent || null,
        network: row.fed_network || null,
        home: row.fed_home || null,
        visit: row.fed_visit || null,
        sig: row.fed_sig || null
      };
    },

    // ---- imports --------------------------------------------------------------

    // Per-owner bookkeeping (review A minor 6): the PK is (bundle_id, owner),
    // so OR IGNORE only ever collapses the SAME owner re-importing — the
    // route's replay fast path then fires for every owner, not just the first.
    recordImport(bundleId, ownerId, outcomes) {
      db.prepare('INSERT OR IGNORE INTO fed_imports (bundle_id, owner, outcomes) VALUES (?, ?, ?)').run(bundleId, ownerId, JSON.stringify(outcomes));
    },

    getImport(bundleId, ownerId) {
      var row = db.prepare('SELECT * FROM fed_imports WHERE bundle_id = ? AND owner = ?').get(bundleId, ownerId);
      if (!row) return null;
      row.outcomes = JSON.parse(row.outcomes);
      return row;
    }
  };
}
