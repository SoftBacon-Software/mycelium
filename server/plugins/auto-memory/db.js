// Auto-Memory DB helpers

import createMemoryAudit, { contentHash } from '../../lib/memory-audit.js';
import { originTrust } from '../../lib/trust-origins.js';

// The canonical state of one am_facts row — what every row_hash hashes.
// Lives here (not in routes.js) so every writer of an audited fact field —
// the routes, the extraction/consolidation paths and the decay pass — hashes
// the same bytes (review A B1: decay audits its confidence rewrite too).
// TRUST LAYER P1.1 (264d merge): origin/trust/derived_from are audited
// CONTENT — P1.1 made the stamps part of the row's meaning (a re-stamp is a
// mutation the chain must pin; two rows differing only in their stamps are
// different rows). The stored shapes hash verbatim: origin as the string,
// trust as the stored integer (NULL = unknown = the LOWEST, never highest —
// 0 hashes as 0, not null), derived_from as the JSON string the column holds.
export function factState(fact) {
  return {
    kind: 'am_fact',
    fact_text: fact.fact_text,
    agent_id: fact.agent_id || null,
    category: fact.category || null,
    project_id: fact.project_id || null,
    confidence: fact.confidence,
    source_type: fact.source_type || null,
    source_authority: fact.source_authority || null,
    valid_from: fact.valid_from || null,
    valid_to: fact.valid_to || null,
    verified_at: fact.verified_at || null,
    superseded_by: fact.superseded_by || null,
    namespace: fact.namespace || null,
    origin: fact.origin || null,
    trust: (fact.trust == null) ? null : Number(fact.trust),
    derived_from: fact.derived_from || null
  };
}

// TRUST LAYER P1.1 (F-mycelium/265): the ONE-TIME backfill of what is KNOWN
// about pre-column rows. A directive fact came from the operator's own hand
// (source_authority 'directive' is admin-only by P0's gate) — it is stamped
// owner-agent at the ladder's owner-agent trust. Everything else stays
// unknown on purpose: an extracted or inferred row's pre-column origin is
// genuinely unknowable, and unknown reads as the LOWEST trust, never the
// highest. Guarded by a marker row in am_config; clearing the marker re-arms
// it (the test does exactly that). Exported named so the migration is
// callable — and therefore testable — on a seeded database; a silent
// migration is an unverified one.
export function backfillOriginTrust(db) {
  // A raw harness DB may have am_facts without am_config (the temporal tests
  // build the wrapper on a minimal schema) — without the marker table the
  // one-time guard cannot exist, so skip LOUDLY (the init block logs it)
  // rather than throw the whole wrapper away.
  var hasConfig = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'am_config'").get();
  if (!hasConfig) return { marker: 'skipped: no am_config table on this database' };
  var marker = db.prepare("SELECT value FROM am_config WHERE key = 'origin_trust_backfill_v1'").get();
  if (marker) return { directive: 0, marker: 'held' };
  var directive = db.prepare(
    "UPDATE am_facts SET origin = 'owner-agent', trust = ? WHERE source_authority = 'directive' AND origin IS NULL"
  ).run(originTrust('owner-agent')).changes;
  db.prepare("INSERT INTO am_config (key, value) VALUES ('origin_trust_backfill_v1', ?)")
    .run('applied: ' + directive + ' directive rows -> owner-agent; all other pre-column rows unknown (lowest trust)');
  return { directive: directive };
}

export default function createAutoMemoryDB(db) {
  // Migration: add access tracking columns
  try { db.exec('ALTER TABLE am_facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN last_accessed_at TEXT'); } catch (e) { /* already exists */ }

  // Migration: bi-temporal validity + provenance-scoped trust (2026-07-22, memory-rework slice 1).
  // valid_from/valid_to = world-time interval; verified_at = last ground-truth re-check;
  // source_authority = how-validated (verified|directive|inferred), NOT who-spoke.
  // Invariant (held by supersedeFact/pruneLowConfidence): valid_to IS NULL <=> superseded_by IS NULL <=> current.
  try { db.exec('ALTER TABLE am_facts ADD COLUMN valid_from TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN valid_to TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN verified_at TEXT'); } catch (e) { /* already exists */ }
  try { db.exec("ALTER TABLE am_facts ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'inferred'"); } catch (e) { /* already exists */ }
  // Backfill existing rows so as-of queries are correct from day one.
  // (Review A nit: these backfills rewrite audited-content fields on legacy
  // DBs BEFORE the audit table exists — a one-time, unaudited migration per
  // install, not a runtime write path; there is no log to append to yet.)
  try { db.exec('UPDATE am_facts SET valid_from = created_at WHERE valid_from IS NULL'); } catch (e) { /* */ }
  try { db.exec('UPDATE am_facts SET valid_to = updated_at WHERE superseded_by IS NOT NULL AND valid_to IS NULL'); } catch (e) { /* */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_am_facts_valid ON am_facts(valid_to)'); } catch (e) { /* */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_am_facts_authority ON am_facts(source_authority)'); } catch (e) { /* */ }

  // Migration: namespace scoping (2026-09-17, task 206 — the am_facts routes' first
  // real caller, BRIEF-lab-alive-memory §3). A NULL namespace is a LEGACY row: it
  // behaves exactly as before this column existed. A named namespace (a bench run,
  // a per-run scratch) is invisible to every unscoped read — the guarantee that let
  // the timeline arm move off memory-row modeling was "bench facts never land in
  // the lab's live fact store". Like every column-dependent index above, this one
  // lives HERE, not in schema.sql (on an existing DB the CREATE TABLE is a no-op
  // and a CREATE INDEX on a not-yet-added column throws at plugin load).
  try { db.exec('ALTER TABLE am_facts ADD COLUMN namespace TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_am_facts_namespace ON am_facts(namespace)'); } catch (e) { /* */ }

  // Migration: claimed identity (TRUST LAYER P0.2, F-mycelium/250). agent_id on
  // a row is the AUTHENTICATED writer (routes.js binds it); claimed_agent_id
  // keeps what a non-admin caller ASKED to be named when that differed —
  // visible, flagged, never trusted. NULL on honest writes. Like namespace,
  // this lives HERE (the guarded-ALTER block), not in schema.sql — same
  // column-dependent-migration rule the namespace note above states.
  try { db.exec('ALTER TABLE am_facts ADD COLUMN claimed_agent_id TEXT'); } catch (e) { /* already exists */ }

  // Migration: trust + provenance that survive derivation (TRUST LAYER P1.1,
  // F-mycelium/265). origin/trust/derived_from, same law as sm_embeddings —
  // see the schema.sql comment and server/lib/trust-origins.js (the one
  // definition). Like every column-dependent migration above, this lives
  // HERE; on an existing DB the CREATE TABLE in schema.sql is a no-op.
  // (P1.4 merge note: derived_from is P1.1's column — its ref vocabulary
  // ("am:<id>" / "sm:<type>:<id>", trust-origins.js) is the one the P1.4
  // cascade walks; P1.4 adds no column of its own here.)
  try { db.exec('ALTER TABLE am_facts ADD COLUMN origin TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN trust INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE am_facts ADD COLUMN derived_from TEXT'); } catch (e) { /* already exists */ }
  var backfill = backfillOriginTrust(db);
  if (backfill.marker) {
    // 'held' is the NORMAL steady state (every boot after the first); a skip
    // names its cause. Either way the one-time migration is not re-armed
    // silently — the log line says which.
    console.log('[auto-memory] origin/trust backfill not applied (' + backfill.marker + ')');
  } else {
    console.log('[auto-memory] TRUST LAYER P1.1 backfill applied: ' + backfill.directive +
      ' directive facts -> origin owner-agent; all other pre-column rows left unknown (lowest trust)');
  }

  // The tombstone store (TRUST LAYER P1.4, F-mycelium/267): every true delete
  // of a fact leaves one — id, when, authenticated actor, why — never the
  // content. The hash-chained trail for the same delete is P1.5's memory_audit
  // (appended in the SAME transaction — see forgetFacts / auditHousekeeping);
  // the tombstone is the per-row "this row was deliberately forgotten" marker
  // that survives recall probes. Declared in schema.sql for fresh DBs;
  // CREATE TABLE IF NOT EXISTS is idempotent on existing ones (a new TABLE has
  // no column-order hazard, unlike the ALTERs).
  db.exec("CREATE TABLE IF NOT EXISTS am_tombstones (\n" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    "  fact_id INTEGER NOT NULL,\n" +
    "  deleted_at TEXT DEFAULT (datetime('now')),\n" +
    "  deleted_by TEXT,\n" +
    "  reason TEXT NOT NULL DEFAULT 'delete'\n" +
    ")");
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_am_tombstones_fact ON am_tombstones(fact_id)'); } catch (e) { /* */ }

  // The inverse of indexFactInMemory() in routes.js. Every path that stops a fact
  // being CURRENT must also stop it being SEARCHABLE — otherwise a retracted or
  // superseded fact keeps ranking in /memory/search as though it were live, with
  // nothing to tell the reader its source is gone. That is strictly worse than
  // §F4's "written but not retrievable": this is "deleted but still retrieved".
  //
  // Lives here rather than in the route so all five removal paths are covered —
  // deleteFact, supersedeFact, pruneLowConfidence, pruneOldSuperseded and
  // pruneExcessFacts — not just the one an HTTP handler happens to call.
  //
  // Deletes by (source_type, source_id) with no chunk_index predicate, so a fact
  // that was chunk-split loses all of its chunks. Mirrors semantic-memory's own
  // deleteBySource (db.js:151). Returns rows removed; 0 when sm_embeddings does
  // not exist, i.e. the semantic-memory plugin is not loaded — that is a normal
  // deployment, not an error, which is why it is caught rather than surfaced.
  function unindexFacts(ids, opts) {
    opts = opts || {};
    if (!ids || !ids.length) return 0;
    try {
      // Both fact index shapes: legacy rows index under 'memory' (indexFactInMemory),
      // namespaced rows under 'am_fact' (indexFactSemantic in routes.js). The second
      // type cannot affect legacy rows — none existed before task 206.
      var stmt = db.prepare("DELETE FROM sm_embeddings WHERE source_type IN ('memory', 'am_fact') AND source_id = ?");
      var removed = 0;
      var removedIds = [];
      for (var id of ids) {
        // Review A nit (267c): tombstone the shape(s) ACTUALLY removed — a
        // legacy row indexes under 'memory', namespaced rows under 'am_fact',
        // and the tombstone must agree with the index row it records. Read the
        // shapes BEFORE the delete takes them away.
        var shapes = db.prepare("SELECT DISTINCT source_type AS t FROM sm_embeddings WHERE source_type IN ('memory', 'am_fact') AND source_id = ?")
          .all(String(id)).map(function (r) { return r.t; });
        var changes = stmt.run(String(id)).changes;
        if (changes > 0) {
          removed += changes;
          removedIds.push(String(id));
          // TRUST LAYER P1.4: a true delete of index rows leaves the
          // index-store half of the tombstone law — id, when, actor, why,
          // never the content. Only for ids that HAD rows (a tombstone
          // records something that was actually removed); fault-tolerant on
          // its own so an absent sm_tombstones table can't turn a done
          // delete into a reported failure.
          if (opts.tombstone) {
            for (var s of (shapes.length ? shapes : ['am_fact'])) {
              try {
                db.prepare('INSERT INTO sm_tombstones (source_type, source_id, deleted_by, reason) VALUES (?, ?, ?, ?)')
                  .run(s, String(id), opts.by || null, opts.reason || 'delete');
              } catch (e2) { /* tombstone store absent — the delete itself already landed */ }
            }
          }
        }
      }
      // F-mycelium/196: keep semantic-memory's decoded-vector cache exact in
      // the same tick. Before this, every delete here moved the freshness
      // signature and the NEXT search paid a corpus-wide rebuild on the
      // event loop. Looked up off the shared db instance (both plugins
      // receive core.db), so this file stays loadable when semantic-memory
      // is not deployed — the property is simply absent and the signature
      // reconcile remains the net, exactly as before. Like every cache
      // hook it is optimistic: a rolled-back delete is caught by the
      // post-write signature check on the next search.
      var vc = db.__myceliumVectorCache;
      if (vc && removedIds.length) vc.onRemoveMany('memory', removedIds);
      return removed;
    } catch (e) {
      return 0;
    }
  }

  // Plain row fetch WITHOUT the access-count side effect getFact() carries —
  // internal reads (supersede's receipt, the re-index) must not masquerade as
  // reader interest.
  function factRow(id) {
    return db.prepare('SELECT * FROM am_facts WHERE id = ?').get(id);
  }

  // TRUST LAYER P1.5: the audit log (self-ensuring DDL — any harness works).
  var audit = createMemoryAudit(db);

  // Housekeeping prunes are audited as 'purge' rows signed
  // 'system:housekeeping' — ONE summary row per prune call, appended ONLY
  // when rows actually changed. (#193 lesson: a prune the log cannot name is
  // silent data loss.)
  function auditHousekeeping(what, doomed, extra) {
    if (!doomed.length) return;
    audit.append({
      actor: 'system:housekeeping',
      action: 'purge',
      source_type: 'am_fact',
      source_id: 'housekeeping:' + what,
      row_owner: null,
      row_hash: contentHash(Object.assign({
        kind: 'am_fact_purge',
        what: what,
        deleted: doomed.length,
        ids: doomed.slice(0, 200)
      }, extra || {})),
      reason: what + ': pruned ' + doomed.length + ' facts'
    });
  }

  return {
    // The RAW shared db (the one with .prepare). extractFacts receives THIS
    // wrapper and indexFactInMemory needs the core handle — before 2026-09-28
    // (F-mycelium 252) it was handed the wrapper itself, whose missing
    // .prepare threw, was swallowed as "non-critical", and every extracted
    // fact silently failed to reach sm_embeddings (written but never
    // searchable — the §F4 state).
    __coreDb: db,

    // -- Config --
    getConfig(key) {
      var row = db.prepare('SELECT value FROM am_config WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setConfig(key, value) {
      db.prepare('INSERT OR REPLACE INTO am_config (key, value) VALUES (?, ?)').run(key, value);
    },

    getAllConfig() {
      var rows = db.prepare('SELECT key, value FROM am_config').all();
      var config = {};
      for (var r of rows) config[r.key] = r.value;
      return config;
    },

    // -- Facts --
    // sourceAuthority (verified|directive|inferred), validFrom, namespace,
    // claimedAgentId and — TRUST LAYER P1.1 — origin/trustLevel/derivedFrom
    // are optional & appended, so existing callers keep working (defaults:
    // inferred, valid_from=now, namespace=NULL = a legacy row,
    // claimed_agent_id=NULL = an honest write, origin/trust=NULL = unstamped,
    // read as the lowest). claimedAgentId is the body's agent_id when it
    // disagreed with the authenticated identity — recorded, flagged, never
    // trusted (TRUST LAYER P0.2). trustLevel is the ALREADY-RESOLVED integer
    // (the routes apply the min law before calling); derivedFrom is an array
    // of row refs, stored JSON-encoded.
    createFact(agentId, projectId, category, factText, confidence, sourceType, sourceId, sourceAuthority, validFrom, namespace, claimedAgentId, origin, trustLevel, derivedFrom) {
      // F-mycelium 254: an explicit 0 is "no confidence", not "missing" — the
      // old `confidence || 0.8` inflated a caller's 0 to 0.8, both here and on
      // every /facts POST with confidence: 0. Only a null/undefined confidence
      // takes the 0.8 default.
      var conf = (confidence == null) ? 0.8 : confidence;
      var result = db.prepare(
        "INSERT INTO am_facts (agent_id, project_id, category, fact_text, confidence, source_type, source_id, source_authority, valid_from, namespace, claimed_agent_id, origin, trust, derived_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?) RETURNING id"
      ).get(agentId || null, projectId || null, category || 'general', factText, conf, sourceType || null, sourceId || null, sourceAuthority || 'inferred', validFrom || null, namespace || null, claimedAgentId || null, origin || null, (trustLevel == null) ? null : Number(trustLevel), derivedFrom ? JSON.stringify(derivedFrom) : null);
      return result.id;
    },

    getFact(id) {
      var fact = db.prepare('SELECT * FROM am_facts WHERE id = ?').get(id);
      if (fact) {
        try { db.prepare("UPDATE am_facts SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?").run(id); } catch (e) { /* */ }
      }
      return fact;
    },

    listFacts(opts) {
      opts = opts || {};
      var where = ['superseded_by IS NULL']; // only show current facts
      var params = [];
      if (opts.agent_id) { where.push('agent_id = ?'); params.push(opts.agent_id); }
      if (opts.project_id) { where.push('project_id = ?'); params.push(opts.project_id); }
      if (opts.category) { where.push('category = ?'); params.push(opts.category); }
      if (opts.min_confidence) { where.push('confidence >= ?'); params.push(opts.min_confidence); }
      // Namespace scoping (task 206): a named namespace returns exactly that
      // namespace; NO namespace returns only legacy (NULL-namespace) rows. That is
      // byte-for-byte today's behavior for every row that exists today, and it is
      // the isolation guarantee: a bench run's facts never surface in the lab's
      // live fact-store view.
      if (opts.namespace) { where.push('namespace = ?'); params.push(opts.namespace); }
      else { where.push('namespace IS NULL'); }
      var limit = Math.min(opts.limit || 50, 500);
      var offset = opts.offset || 0;
      params.push(limit, offset);
      return db.prepare(
        'SELECT * FROM am_facts WHERE ' + where.join(' AND ') + ' ORDER BY confidence DESC, updated_at DESC LIMIT ? OFFSET ?'
      ).all(...params);
    },

    // TRUST LAYER P1.4 — the forget cascade. `refs` name the ROOTS to forget:
    // an explicit fact in P1.1's ref vocabulary ('am:<id>'), or the entity a
    // fact was extracted from ('task:<id>', 'context_key:<ns>:<key>'), matched
    // on the fact's (source_type, source_id) columns. From the roots the
    // closure walks derived_from TRANSITIVELY (P1.1's refs — "am:<id>" for
    // consolidation inputs, trust-origins.js is the one definition) — every
    // summary/consolidation built on a falling row falls with it — so a
    // forgotten fact is not recalled through its summary. One transaction:
    // tombstone (fact-store AND index halves), the P1.5 audit row, delete,
    // unindex. Returns { deleted, cascaded, index_removed } — deleted counts
    // every row that fell, cascaded the ones that fell only because a row they
    // were derived from did.
    forgetFacts(refs, opts) {
      opts = opts || {};
      var by = opts.by || null;
      var rootReason = opts.reason || 'delete';
      var out = { deleted: 0, cascaded: 0, index_removed: 0 };
      var txn = db.transaction(function () {
        var seen = {};   // id -> 'root' | 'derived'
        var queue = [];
        var rootCount = 0;
        for (var i = 0; i < (refs || []).length; i++) {
          var ref = String(refs[i]);
          var fid = /^am:\d+$/.test(ref) ? Number(ref.split(':')[1]) : null;
          if (fid != null) {
            // An explicit fact id roots AT that row (its own source_type is
            // 'extraction'/'consolidation' or the source entity, never 'am' —
            // the generic probe below would only find its DERIVED rows, not it).
            if (!seen[fid] && db.prepare('SELECT id FROM am_facts WHERE id = ?').get(fid)) {
              seen[fid] = 'root'; queue.push(fid); rootCount++;
            }
            continue;
          }
          var colon = ref.indexOf(':');
          var rtype = colon === -1 ? ref : ref.substring(0, colon);
          var rid = colon === -1 ? null : ref.substring(colon + 1);
          var rows = db.prepare(
            'SELECT id FROM am_facts WHERE source_type = ? AND source_id IS NOT NULL AND source_id = ?'
          ).all(rtype, rid);
          for (var r of rows) {
            if (!seen[r.id]) { seen[r.id] = 'root'; queue.push(r.id); rootCount++; }
          }
        }
        // The transitive walk: anything naming a falling row as input (P1.1's
        // "am:<id>" refs) falls.
        while (queue.length) {
          var cur = queue.shift();
          var kids = db.prepare(
            "SELECT id FROM am_facts WHERE derived_from IS NOT NULL AND derived_from LIKE ?"
          ).all('%"am:' + cur + '"%');
          for (var k of kids) {
            if (!seen[k.id]) { seen[k.id] = 'derived'; queue.push(k.id); }
          }
        }
        var ids = Object.keys(seen).map(Number);
        if (!ids.length) return out;
        var tstmt = db.prepare('INSERT INTO am_tombstones (fact_id, deleted_by, reason) VALUES (?, ?, ?)');
        var dstmt = db.prepare('DELETE FROM am_facts WHERE id = ?');
        for (var id of ids) {
          // The record before the delete, both halves. A derived row's why is
          // the root's why plus '-cascade' — it died because its input died.
          try { tstmt.run(id, by, seen[id] === 'derived' ? rootReason + '-cascade' : rootReason); } catch (e) { /* the record never blocks the delete */ }
          dstmt.run(id);
        }
        // TRUST LAYER P1.5: the cascade and its audit row are ONE transaction
        // (#193: a delete the log cannot name never happened). ONE summary row
        // naming the roots and every id that fell — the auditHousekeeping
        // shape; the route adds the named fact's own per-row row with its true
        // deleted-state hash.
        audit.append({
          actor: by || 'system:forget',
          action: 'delete',
          source_type: 'am_fact',
          source_id: 'forget:' + (refs || []).join(','),
          row_owner: null,
          row_hash: contentHash({
            kind: 'am_fact_forget',
            roots: refs || [],
            deleted: ids.length,
            cascaded: ids.length - rootCount,
            ids: ids.slice(0, 200)
          }),
          reason: 'forget cascade: ' + ids.length + ' facts (' + (ids.length - rootCount) + ' cascaded)'
        });
        out.cascaded = ids.length - rootCount;
        out.deleted = ids.length;
        out.index_removed = unindexFacts(ids, { tombstone: true, by: by, reason: rootReason });
        return out;
      });
      return txn();
    },

    // A single-fact forget: the cascade root is the fact itself (P1.1's
    // ref vocabulary). opts {by, reason} land on the tombstones and the
    // audit row; supersedeFact is the NON-delete sibling and must never
    // come through here (a superseded row stays alive — no tombstone, no
    // cascade).
    deleteFact(id, opts) {
      return this.forgetFacts(['am:' + id], opts);
    },

    // Bulk purge by namespace (task 211, BRIEF-lab-alive-memory §3): the bench
    // contract is purge-everything-after, and a timeline n=50 run writes ~21.5k
    // am_facts rows — per-id deletes are not a cleanup path, and skipping cleanup
    // strands the run's rows in the lab's LIVE fact table forever. Deletes ALL
    // rows in the namespace, CURRENT and SUPERSEDED alike (a cleanup is not a
    // supersede: leaving tombstones behind would keep the run's rows in the
    // table), then takes every index row out through the SAME seam every other
    // removal path uses (unindexFacts above — both index shapes + the vector-
    // cache hook), so the namespace stops answering /memory/search in the same
    // request. TRUST LAYER P1.4: a purge is deletes — every doomed row is
    // tombstoned (both halves) before it goes (#193: housekeeping is deletes).
    //
    // NO namespace = no purge, by construction: the WHERE clause is
    // `namespace = ?` and SQL NULL never equals anything, so legacy rows
    // (namespace IS NULL — Aria's internal writer's rows) are unreachable from
    // here whatever the caller passes. The route refuses an unnamed namespace
    // before this runs; this predicate is the second layer of that refusal.
    deleteFactsByNamespace(namespace, opts) {
      opts = opts || {};
      // Ids BEFORE the delete (the pruneOldSuperseded rule): afterwards there is
      // nothing left to join against and the index rows would orphan.
      var doomed = db.prepare('SELECT id FROM am_facts WHERE namespace = ?').all(namespace)
        .map(function (r) { return r.id; });
      if (!doomed.length) return { deleted: 0, index_removed: 0 };
      var txn = db.transaction(function () {
        var tstmt = db.prepare('INSERT INTO am_tombstones (fact_id, deleted_by, reason) VALUES (?, ?, ?)');
        for (var id of doomed) {
          try { tstmt.run(id, opts.by || null, opts.reason || 'purge'); } catch (e) { /* the record never blocks the delete */ }
        }
        var result = db.prepare('DELETE FROM am_facts WHERE namespace = ?').run(namespace);
        var indexRemoved = unindexFacts(doomed, { tombstone: true, by: opts.by || null, reason: opts.reason || 'purge' });
        return { deleted: result.changes, index_removed: indexRemoved };
      });
      return txn();
    },

    // opts.keepIndexed (namespaced facts only): the old row STAYS indexed. A
    // timeline fact's history is the point — "what did we believe on date X"
    // needs the superseded row retrievable with its valid_to and the
    // supersede line renderable from a hit (task 206). Legacy supersede keeps
    // the old behavior: unindex, so a retracted fact cannot rank against its
    // replacement in the shared live recall.
    supersedeFact(oldId, newId, opts) {
      // Close the validity interval (bi-temporal supersession) — don't just tombstone.
      db.prepare("UPDATE am_facts SET superseded_by = ?, valid_to = datetime('now') WHERE id = ?").run(newId, oldId);
      if (opts && opts.keepIndexed) {
        return { old: factRow(oldId), replacement: factRow(newId) };
      }
      // A superseded fact is no longer current, and listFacts() already hides it
      // (`superseded_by IS NULL`). Drop it from the index too, or it keeps ranking
      // in /memory/search against the very fact that replaced it.
      return unindexFacts([oldId]);
    },

    updateFactConfidence(id, confidence) {
      db.prepare("UPDATE am_facts SET confidence = ?, updated_at = datetime('now') WHERE id = ?").run(confidence, id);
    },

    // TRUST LAYER P1.5 (review A B1): the decay pass's confidence rewrite is
    // the identical operation runConsolidation audits as a system:consolidation
    // edit row — so it is audited too: ONE 'system:decay' edit row per changed
    // fact, in the SAME transaction as the update (a crash leaves neither the
    // rewrite nor its row). Signed by the server like the housekeeping prunes:
    // the actor is the scheduled pass, not any caller.
    decayFactConfidence(id, confidence) {
      db.transaction(function () {
        db.prepare("UPDATE am_facts SET confidence = ?, updated_at = datetime('now') WHERE id = ?").run(confidence, id);
        var fact = db.prepare('SELECT * FROM am_facts WHERE id = ?').get(id);
        audit.append({
          actor: 'system:decay',
          action: 'edit',
          source_type: 'am_fact',
          source_id: String(id),
          row_owner: fact ? (fact.agent_id || null) : null,
          row_hash: contentHash(factState(fact)),
          reason: 'confidence decay'
        });
      })();
    },

    // -- Provenance / bi-temporal (memory-rework slice 1) --

    // A ground-truth re-check CONFIRMED the fact: stamp verified_at, optionally refresh
    // confidence, and reset the access reference (a re-verified fact is "fresh").
    reverifyFact(id, confidence) {
      db.prepare(
        "UPDATE am_facts SET verified_at = datetime('now'), confidence = COALESCE(?, confidence), last_accessed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(confidence == null ? null : confidence, id);
    },

    // The re-verification queue: CURRENT, inferred (not directive/verified) facts never
    // checked, or last checked longer than older_than_days ago. Aria's loop drains this.
    // Namespace rule mirrors listFacts: scoped = that namespace only; unscoped =
    // legacy rows only, so a bench run's facts never enter Aria's prod queue.
    factsDueForReverification(opts) {
      opts = opts || {};
      var olderThanDays = parseInt(opts.older_than_days) || 30;
      var limit = Math.min(opts.limit || 50, 500);
      var namespaceSql = opts.namespace ? 'namespace = ?' : 'namespace IS NULL';
      var params = opts.namespace ? [opts.namespace, olderThanDays, limit] : [olderThanDays, limit];
      return db.prepare(
        "SELECT * FROM am_facts WHERE superseded_by IS NULL AND source_authority = 'inferred' AND " + namespaceSql + ' ' +
        "AND (verified_at IS NULL OR verified_at < datetime('now', '-' || ? || ' days')) " +
        "ORDER BY (verified_at IS NULL) DESC, COALESCE(verified_at, created_at) ASC LIMIT ?"
      ).all(...params);
    },

    // Bi-temporal "as of": facts whose validity interval [valid_from, valid_to) contains asOf.
    // Answers "what did we believe on date X" — resolves the three-file contradiction problem.
    factsAsOf(asOf, opts) {
      opts = opts || {};
      var where = ['valid_from IS NOT NULL', 'valid_from <= ?', '(valid_to IS NULL OR valid_to > ?)'];
      var params = [asOf, asOf];
      if (opts.agent_id) { where.push('agent_id = ?'); params.push(opts.agent_id); }
      var limit = Math.min(opts.limit || 50, 500);
      params.push(limit);
      return db.prepare(
        'SELECT * FROM am_facts WHERE ' + where.join(' AND ') + ' ORDER BY confidence DESC LIMIT ?'
      ).all(...params);
    },

    // -- Consolidation --
    logConsolidation(factsProcessed, factsMerged, factsSuperseded, durationMs) {
      db.prepare(
        'INSERT INTO am_consolidation_log (facts_processed, facts_merged, facts_superseded, duration_ms) VALUES (?, ?, ?, ?)'
      ).run(factsProcessed, factsMerged, factsSuperseded, durationMs);
    },

    getConsolidationHistory(limit) {
      return db.prepare('SELECT * FROM am_consolidation_log ORDER BY run_at DESC LIMIT ?').all(limit || 20);
    },

    getLastConsolidation() {
      return db.prepare('SELECT * FROM am_consolidation_log ORDER BY run_at DESC LIMIT 1').get();
    },

    // -- Stats --
    stats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by IS NULL').get().c;
      var superseded = db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by IS NOT NULL').get().c;
      var byCategory = db.prepare('SELECT category, COUNT(*) as count FROM am_facts WHERE superseded_by IS NULL GROUP BY category ORDER BY count DESC').all();
      var byAgent = db.prepare('SELECT agent_id, COUNT(*) as count FROM am_facts WHERE superseded_by IS NULL AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY count DESC LIMIT 20').all();
      var consolidations = db.prepare('SELECT COUNT(*) as c FROM am_consolidation_log').get().c;
      var lastConsolidation = this.getLastConsolidation();
      return {
        active_facts: total,
        superseded_facts: superseded,
        by_category: byCategory,
        by_agent: byAgent,
        total_consolidations: consolidations,
        last_consolidation: lastConsolidation ? lastConsolidation.run_at : null
      };
    },

    // -- Pruning --
    // TRUST LAYER P1.5 (#193 lesson: audit every DELETE path): housekeeping
    // prunes are audited as 'purge' rows signed 'system:housekeeping' — the
    // server is the honest actor, and a prune the log cannot name is silent
    // data loss. ONE summary row per prune call (the count + the id list, the
    // id list capped at 200 in the hashed reason), appended ONLY when rows
    // actually changed. Review A round 2 N4: the prune, its audit row and its
    // index cleanup are ONE transaction (the decayFactConfidence shape, B1) —
    // a failed append rolls the prune back instead of leaving rows deleted
    // with their audit row owed.

    pruneOldSuperseded(maxAge) {
      maxAge = maxAge || '30 days';
      // Collect ids BEFORE the delete — afterwards there is nothing left to join
      // against, and the index rows would be orphaned with no way to find them.
      // Predicate is duplicated verbatim so the two statements cannot disagree.
      var doomed = db.prepare(
        "SELECT id FROM am_facts WHERE superseded_by IS NOT NULL AND updated_at < datetime('now', '-' || ?)"
      ).all(maxAge).map(function (r) { return r.id; });
      var changes = 0;
      db.transaction(function () {
        var result = db.prepare(
          "DELETE FROM am_facts WHERE superseded_by IS NOT NULL AND updated_at < datetime('now', '-' || ?)"
        ).run(maxAge);
        changes = result.changes;
        // TRUST LAYER P1.4: housekeeping is deletes (#193) — the row is gone,
        // so the record is left. (Their index rows went at supersede time; a
        // doomed row here normally has nothing left to unindex.) The P1.5
        // audit row lands in the SAME transaction as the delete it describes.
        var tstmt = db.prepare('INSERT INTO am_tombstones (fact_id, deleted_by, reason) VALUES (?, ?, ?)');
        for (var id of doomed) {
          try { tstmt.run(id, null, 'prune-old-superseded'); } catch (e) { /* the record never blocks the prune */ }
        }
        auditHousekeeping('old-superseded', doomed, { max_age: maxAge });
        unindexFacts(doomed);
      })();
      return changes;
    },

    logExtractionError(agentId, projectId, sourceEvent, errorMessage, inputPreview) {
      db.prepare(
        'INSERT INTO am_extraction_errors (agent_id, project_id, source_event, error_message, input_text_preview) VALUES (?, ?, ?, ?, ?)'
      ).run(agentId || '', projectId || '', sourceEvent || '', errorMessage, (inputPreview || '').substring(0, 500));
    },

    getExtractionErrors(limit) {
      return db.prepare('SELECT * FROM am_extraction_errors ORDER BY created_at DESC LIMIT ?').all(limit || 50);
    },

    getErrorStats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM am_extraction_errors').get().c;
      var last24h = db.prepare("SELECT COUNT(*) as c FROM am_extraction_errors WHERE created_at >= datetime('now', '-1 day')").get().c;
      return { total: total, last_24h: last24h };
    },

    // Batch-update facts for decay: returns all facts not accessed in 24h with their timestamps
    getDecayableFacts() {
      // Operator DIRECTIVES (stated intent/preference) do NOT decay — they hold until a new
      // directive supersedes them. verified + inferred still decay (verified is re-checked via
      // verified_at, not eroded to zero by time alone). Namespaced rows (bench runs) are
      // excluded: a prod decay loop must never rewrite a run's data mid-run. (task 206)
      return db.prepare(
        "SELECT id, category, confidence, last_accessed_at, updated_at FROM am_facts WHERE superseded_by IS NULL AND namespace IS NULL AND source_authority != 'directive' AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-1 day'))"
      ).all();
    },

    pruneLowConfidence(threshold) {
      // Decay-prune: SELF-supersede (superseded_by = own id) so the fact is "not current" +
      // distinguishable from a merge, and FK-SAFE. (The old -1 sentinel violated the
      // superseded_by -> am_facts(id) FK under foreign_keys=ON — verified 2026-07-22: it threw
      // silently and NOTHING was ever pruned in prod. Self-id keeps the invariant
      // valid_to IS NULL <=> superseded_by IS NULL <=> current.)
      // Age guard: don't prune facts less than 7 days old (may have low initial confidence).
      // Ids first: after the UPDATE these rows no longer match `superseded_by IS NULL`.
      var doomed = db.prepare(
        "SELECT id FROM am_facts WHERE superseded_by IS NULL AND confidence < ? AND updated_at < datetime('now', '-7 days')"
      ).all(threshold).map(function (r) { return r.id; });
      var changes = 0;
      db.transaction(function () {
        var result = db.prepare(
          "UPDATE am_facts SET superseded_by = id, valid_to = datetime('now') WHERE superseded_by IS NULL AND confidence < ? AND updated_at < datetime('now', '-7 days')"
        ).run(threshold);
        changes = result.changes;
        // Decay-pruned facts are the ones the system judged least trustworthy —
        // leaving them searchable would rank exactly the facts it decided to retire.
        auditHousekeeping('low-confidence', doomed, { threshold: threshold });
        unindexFacts(doomed);
      })();
      return changes;
    },

    pruneExcessFacts(agentId, maxFacts) {
      maxFacts = maxFacts || 500;
      // Delete oldest superseded facts for this agent beyond the limit
      var count = db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE agent_id = ?').get(agentId).c;
      if (count <= maxFacts) return 0;
      var toDelete = count - maxFacts;
      // Same subquery the DELETE uses, run first so the ids survive the delete.
      var doomed = db.prepare(
        'SELECT id FROM am_facts WHERE agent_id = ? ORDER BY CASE WHEN superseded_by IS NOT NULL THEN 0 ELSE 1 END, updated_at ASC LIMIT ?'
      ).all(agentId, toDelete).map(function (r) { return r.id; });
      var changes = 0;
      db.transaction(function () {
        var result = db.prepare(
          'DELETE FROM am_facts WHERE id IN (SELECT id FROM am_facts WHERE agent_id = ? ORDER BY CASE WHEN superseded_by IS NOT NULL THEN 0 ELSE 1 END, updated_at ASC LIMIT ?)'
        ).run(agentId, toDelete);
        changes = result.changes;
        // TRUST LAYER P1.4: housekeeping is deletes (#193) — both tombstone
        // halves for rows that truly went, and the P1.5 audit row in the
        // SAME transaction as the delete it describes.
        var tstmt = db.prepare('INSERT INTO am_tombstones (fact_id, deleted_by, reason) VALUES (?, ?, ?)');
        for (var id of doomed) {
          try { tstmt.run(id, null, 'prune-excess'); } catch (e) { /* the record never blocks the prune */ }
        }
        auditHousekeeping('excess:' + agentId, doomed, { max_facts: maxFacts });
        unindexFacts(doomed, { tombstone: true, reason: 'prune-excess' });
      })();
      return changes;
    }
  };
}
