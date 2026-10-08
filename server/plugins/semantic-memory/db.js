// Semantic Memory DB helpers

import { cosineSimilarity, embedQueueDepth, embedDrainSnapshot } from './embeddings.js';
import { chunkText, DEFAULT_CHUNK_SIZE } from './chunking.js';
import { createVectorCache } from './vector-cache.js';
import { parseMeta as parseQuarantineMeta, promotedMeta } from '../../lib/memory-quarantine.js';
import { retrievalTrustWeight, RETRIEVAL_TRUST } from '../../lib/retrieval-trust.js';

// -- Bench rows are invisible to plain recall (2026-09-08) ---------------------
// Benchmark harnesses write into the ONE index live recall reads from (task
// 163's Mycelium arm left 3,104 rows with source_type bench_longmemeval /
// namespace bench-p1-2026-09-08-*; they outranked real agent memories on every
// unfiltered search). Rule: a bench row — source_type starting 'bench_' OR
// namespace starting 'bench-' — is returned by the search functions ONLY when
// the request itself names a bench source_type in source_types or a bench
// namespace in namespace. Those are exact-match filters, so naming one bench
// type/namespace cannot leak another; a request that names no bench filter at
// all sees no bench rows. Enforced in the query layer (not post-filter) so the
// caller's `limit` is spent on visible rows instead of being burned on hidden
// ones before the slice.
export var BENCH_TYPE_PREFIX = 'bench_';
export var BENCH_NS_PREFIX = 'bench-';

export function benchOptIn(opts) {
  opts = opts || {};
  if (Array.isArray(opts.source_types) &&
      opts.source_types.some(function (t) {
        return typeof t === 'string' && t.indexOf(BENCH_TYPE_PREFIX) === 0;
      })) return true;
  if (typeof opts.namespace === 'string' && opts.namespace.indexOf(BENCH_NS_PREFIX) === 0) return true;
  return false;
}

// TRUST LAYER P1.1 (F-mycelium/265): the one-time origin/trust backfill.
// Stamps existing rows from what is KNOWN, and only what is known: a row the
// federation store marked (fed_home/fed_visit) is foreign-network at the
// lowest trust; everything else stays unknown (NULL origin), which every
// reader treats as the LOWEST trust — never the highest. Custody does not
// imply origin, so written_by is deliberately not consulted. One-time by the
// 'origin_trust_backfill_v1' marker in sm_config (clearing it re-arms, the
// documented path the suite exercises); the run is idempotent regardless —
// only unstamped fed rows match the UPDATE. Exported (not init-private) so
// the migration is testable on a seeded DB: a silent migration is an
// unverified one. Returns the applied counts; a held marker short-circuits
// to { fed: 0, marker: 'held' }.
export function backfillOriginTrust(db) {
  // A raw harness DB may have sm_embeddings without sm_config — without the
  // marker table the one-time guard cannot exist, so skip LOUDLY rather than
  // throw the whole wrapper away (the init block logs the skip).
  var hasConfig = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sm_config'").get();
  if (!hasConfig) return { marker: 'skipped: no sm_config table on this database' };
  var marker = db.prepare("SELECT value FROM sm_config WHERE key = 'origin_trust_backfill_v1'").get();
  if (marker) return { fed: 0, marker: 'held' };
  var fed = db.prepare(`
    UPDATE sm_embeddings SET origin = 'foreign-network', trust = 0
    WHERE (fed_home IS NOT NULL OR fed_visit IS NOT NULL)
      AND (origin IS NULL AND (trust IS NULL OR trust = 0))
  `).run().changes;
  db.prepare("INSERT INTO sm_config (key, value) VALUES ('origin_trust_backfill_v1', ?)")
    .run('applied: ' + fed + ' fed rows; all other pre-column rows unknown (lowest trust)');
  return { fed: fed };
}

// TRUST LAYER P1.1: the read-side shape of the trust stamps. Every path that
// hands a row to a client goes through this, so the fields come back
// uniformly: derived_from is an ARRAY of refs (never the raw JSON string)
// and trust is a NUMBER (NULL stamp = unknown = the lowest, 0 — "unknown is
// the lowest trust" holds on the way out exactly as on the way in). Rows
// written before the migration simply read trust 0, origin null.
function decodeTrustRow(row) {
  if (!row) return row;
  if (typeof row.derived_from === 'string' && row.derived_from.length > 0) {
    try { row.derived_from = JSON.parse(row.derived_from); } catch (e) { /* keep raw */ }
  }
  row.trust = (row.trust == null) ? 0 : row.trust;
  return row;
}

// Static SQL for the exclusion — no parameters, the prefixes are the constants
// above and nothing user-supplied is interpolated. substr() instead of LIKE so
// the '_' in the type prefix is a literal, not a single-char wildcard.
// COALESCE guards NULL namespace: NULL LIKE/substr = NULL, and a bare NOT(...)
// would silently drop every NULL-namespace row with it.
var BENCH_HIDDEN_SQL =
  "NOT (substr(COALESCE(source_type,''),1," + BENCH_TYPE_PREFIX.length + ") = '" + BENCH_TYPE_PREFIX + "'" +
  " OR substr(COALESCE(namespace,''),1," + BENCH_NS_PREFIX.length + ") = '" + BENCH_NS_PREFIX + "')";

// -- Companion rows are PRIVATE (task F-mycelium/246, review A finding 1) ------
// A companion row — source_type 'companion' OR namespace starting 'companion:' —
// is a person's memory, written through /me/memory with that person's studio
// bearer. Unlike bench rows (fixtures, visible when a search names them), a
// companion row is NEVER visible to the agent-facing search arms: the only
// caller that may see one sets opts.companion_ok, and that flag is set by ROUTE
// CODE (the companion API itself), never from request input — naming
// source_types:['companion'] on an agent search opts into nothing. Enforced in
// the query layer, same rule and same reason as the bench exclusion above: the
// caller's limit is spent on rows it is allowed to see. The source_type leg is
// an exact '=' (one type, not a prefix family); the namespace leg is substr()
// for the same literal-'_'-vs-LIKE reason the bench SQL cites.
export var COMPANION_TYPE = 'companion';
export var COMPANION_NS_PREFIX = 'companion:';

var COMPANION_HIDDEN_SQL =
  "NOT (COALESCE(source_type,'') = '" + COMPANION_TYPE + "'" +
  " OR substr(COALESCE(namespace,''),1," + COMPANION_NS_PREFIX.length + ") = '" + COMPANION_NS_PREFIX + "')";

// DoS bound shared by BOTH vector arms: only the newest N candidate rows
// among the filtered set are scored — what the old per-query SQL expressed as
// `ORDER BY updated_at DESC LIMIT <cap>`, and what the decoded-vector cache
// (vector-cache.js) expresses as an early break in its recency order.
// Exported for the cache default and the tests.
export var VECTOR_SCAN_CAP = 5000;

// -- Per-result embeddedness stamp (task 213) ----------------------------------
// Rows are embedded asynchronously after indexing, so a search seconds later
// ranks the newest rows keyword-only — and inside a hybrid result those
// keyword-only scores are indistinguishable from semantic ones. Every search
// result now states whether its OWN vector exists (the LEFT JOIN answer:
// keyword-found row with a NULL embedding = false; a vector-scan hit = true),
// so a caller — the bench reconcile fastpath first (task 213) — can refuse to
// decide on a score that was never a semantic one. A row that cannot know (a
// producer that predates the stamp carries no embedding column at all) stamps
// null — never a guessed true.
export function stampEmbedded(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.embedded === undefined) {
    r.embedded = 'embedding' in r ? r.embedding != null : null;
  }
  return r;
}

// Keyword leg of hybrid search: the FTS5 MATCH is bounded. 2026-09-18 02:56,
// 03:38 and 03:52 CDT the Jetson platform wedged three times — node's main
// thread R at 100% for up to 30 CPU-min inside Statement.all → fts5FilterMethod
// → fts5Bm25Function → fts5ApiInstCount (gdb on the live process). The query
// builder quoted EVERY whitespace token of the caller's text and OR'd them, so a
// 6 KB workflow brief (the runner's and the lanes' "prior work" retrieval sends
// the brief itself) became a ~1,000-term MATCH that every row satisfies, ranked
// by bm25 over every instance in every 40 KB episode row — and the client's
// timeout + retry re-wedged the process seconds after each restart. Terms are
// now distinct, lowercased, ≥ 3 chars, not stopwords, at most FTS_MAX_TERMS,
// taken from the first FTS_MAX_QUERY_CHARS of the text.
export var FTS_MAX_TERMS = 24;
export var FTS_MAX_QUERY_CHARS = 2000;
var FTS_STOPWORDS = new Set(('the and for are but not you all any can had her was one our out day get has him his how '
  + 'its let may new now old see two way who did that this with from they have been will what when your than then '
  + 'them into over such also more most some only very just like each other about after before under while where '
  + 'which there their would could should does doing done being were because these those').split(' '));

export function buildFtsQuery(query) {
  var text = String(query || '').slice(0, FTS_MAX_QUERY_CHARS).replace(/['"*()]/g, ' ');
  var seen = {};
  var terms = [];
  var toks = text.split(/\s+/);
  for (var i = 0; i < toks.length && terms.length < FTS_MAX_TERMS; i++) {
    var w = toks[i].toLowerCase();
    if (w.length < 3 || FTS_STOPWORDS.has(w) || seen[w]) continue;
    seen[w] = true;
    terms.push('"' + w + '"');
  }
  return terms.join(' OR ');
}

export default function createMemoryDB(db, opts) {
  // Decoded-vector cache behind searchVector (F-mycelium/194): each embedded
  // row's vector is JSON.parse'd ONCE, not on every query. Write paths below
  // keep it exact through hooks; the freshness signature in vector-cache.js
  // self-heals writers nothing hooks — incrementally since 196, so a drift
  // no longer re-decodes the corpus on the event loop. auto-memory's
  // unindexFacts lands through the same-tick side-channel below.
  // Memory bound: 25k rows x 768 dims x 4 B = 77 MB.
  var vectorCache = createVectorCache(db, Object.assign({
    benchOptIn: benchOptIn,
    benchTypePrefix: BENCH_TYPE_PREFIX,
    benchNsPrefix: BENCH_NS_PREFIX,
    // Plumbed, not re-declared over there (review A r3 MINOR 1): one copy of
    // the private-class constants, or the cache arm and the SQL arms can
    // silently disagree about what is private.
    companionType: COMPANION_TYPE,
    companionNsPrefix: COMPANION_NS_PREFIX,
    scanCap: VECTOR_SCAN_CAP
  }, (opts && opts.vectorCache) || {}));
  // The per-db side-channel auto-memory's unindexFacts uses (196): both
  // plugins receive the SAME core.db instance, and a property on it needs no
  // cross-plugin import — auto-memory must stay loadable on deployments
  // without this plugin (the loader can boot a temp plugins dir carrying one
  // plugin alone). Fail-soft: if the property cannot be set, the signature
  // reconcile still self-heals (pinned by the negative-control test).
  try { db.__myceliumVectorCache = vectorCache; } catch (e) { /* frozen host */ }

  // The WRITE side of the same side-channel (task 206): the raw UPDATE of
  // sm_embeddings stays in THIS file only — the vector-cache-resilience gate
  // pins that ("no raw UPDATE of sm_embeddings in product code outside the
  // hooked db.js") — so an out-of-plugin embedding write-back (auto-memory's
  // fact routes) rides this hook: same SQL, same cache hook. Fail-soft like
  // the read side: an absent hook leaves the row keyword-searchable and the
  // signature reconcile still self-heals.
  function updateEmbeddingRow(sourceType, sourceId, chunkIndex, embedding, model) {
    // A null embedding must NOT be stored as the string "null" — that
    // escapes `embedding IS NULL` and orphans the row from backfill.
    if (embedding == null) return;
    db.prepare(
      "UPDATE sm_embeddings SET embedding = ?, embedding_model = ?, updated_at = datetime('now') WHERE source_type = ? AND source_id = ? AND chunk_index = ?"
    ).run(JSON.stringify(embedding), model, sourceType, sourceId, chunkIndex || 0);
    vectorCache.onUpsert(sourceType, sourceId, chunkIndex || 0);
  }
  try { db.__myceliumEmbeddingWrite = updateEmbeddingRow; } catch (e) { /* frozen host */ }

  // Companion Memory API (docs/companion-memory-api.md): bridge the
  // superseded_by column onto an sm_embeddings table that predates it —
  // CREATE TABLE IF NOT EXISTS in schema.sql cannot extend a table that
  // already exists, so the column would silently miss every persistent
  // instance on upgrade. Same guarded-ALTER idiom as core.js applyMigrations:
  // "already exists" is the fresh-DB case (schema.sql already declared it)
  // and is swallowed; anything else surfaces at load.
  try {
    db.prepare('ALTER TABLE sm_embeddings ADD COLUMN superseded_by TEXT').run();
  } catch (e) {
    // "duplicate column name" = the fresh-DB case (schema.sql declared it);
    // anything else is real and surfaces at load.
    if (!/duplicate column|already exists/.test(String(e.message))) throw e;
  }

  // TRUST LAYER P0.2 (F-mycelium/250): write authority — WHO wrote this row.
  // The agent routes stamp it from the AUTHENTICATED identity on every write
  // (routes.js); the routes' owner check lets a non-admin overwrite/delete
  // only rows bearing its own name. NULL = written before the column existed,
  // or by an internal writer (fact indexing, chunk-splitting) = owner-UNKNOWN
  // = only the admin key may mutate it (fail-closed: an accidental NULL can
  // only ever make a row MORE protected, never less). Guarded ALTER, same
  // idiom as superseded_by above.
  try {
    db.prepare('ALTER TABLE sm_embeddings ADD COLUMN written_by TEXT').run();
  } catch (e) {
    if (!/duplicate column|already exists/.test(String(e.message))) throw e;
  }

  // TRUST LAYER P0 (review B item 4): the live lab wrote rows before custody
  // existed — written_by NULL everywhere, which the owner checks read as
  // admin-only (fail-closed) and a cross-owner supersede as refused, so the
  // lab-alive loops would stop silently on deploy. Recover the owner where
  // the row's own metadata names one: metadata.actor, then metadata.agent,
  // then metadata.agent_id — the fields every writer used to self-assert
  // (lesson actors, episode agents, indexed context keys, facts, savepoints).
  // One-time (marker in sm_config); the UPDATE is itself idempotent (only
  // NULL-custody rows carrying an owner-shaped key are touched, and stamped
  // rows stop matching). The platform's pseudo-agents are not owners, rows
  // with unparseable metadata are left NULL (fail-closed), and the applied
  // count is logged loudly — a silent migration is an unverified one.
  try {
    var backfillMarker = db.prepare("SELECT value FROM sm_config WHERE key = 'written_by_backfill_v1'").get();
    if (!backfillMarker) {
      var backfilled = db.prepare(`
        UPDATE sm_embeddings SET written_by = COALESCE(
            json_extract(metadata, '$.actor'),
            json_extract(metadata, '$.agent'),
            json_extract(metadata, '$.agent_id'))
        WHERE written_by IS NULL AND metadata IS NOT NULL AND json_valid(metadata)
          AND COALESCE(json_extract(metadata, '$.actor'),
                       json_extract(metadata, '$.agent'),
                       json_extract(metadata, '$.agent_id'))
              NOT IN ('__system__', '__admin__')
      `).run();
      db.prepare("INSERT INTO sm_config (key, value) VALUES ('written_by_backfill_v1', ?)")
        .run('applied: ' + backfilled.changes + ' rows');
      console.log('[semantic-memory] written_by backfill: stamped custody on ' + backfilled.changes +
        ' pre-column rows from their own metadata (review B item 4)');
    }
  } catch (e) {
    // Loud but not fatal: the fail-closed default (NULL = admin-only) still
    // protects every un-migrated row until this is fixed and re-run (clearing
    // the marker re-arms it).
    console.error('[semantic-memory] written_by backfill FAILED — affected rows stay admin-only (clear sm_config key written_by_backfill_v1 to re-arm):', e.message);
  }

  // TRUST LAYER P1.1 (F-mycelium/265): trust + provenance columns. origin
  // (who the content came from), trust (0..4; NULL reads as the LOWEST) and
  // derived_from (JSON array of input refs on derived rows). Guarded ALTERs,
  // the same idiom as superseded_by/written_by above. The one-time backfill
  // stamps existing rows from what is KNOWN — and only that: a row that
  // crossed a network border (fed_home/fed_visit set by the federation
  // store) is foreign-network at the lowest trust; EVERYTHING else stays
  // unknown, and unknown reads as the lowest trust, never the highest.
  // Custody (written_by) deliberately does NOT imply origin: an agent key
  // relaying a person's words is still an owner-agent row, and guessing
  // upward is the one direction this migration must never go.
  try {
    db.prepare('ALTER TABLE sm_embeddings ADD COLUMN origin TEXT').run();
  } catch (e) {
    if (!/duplicate column|already exists/.test(String(e.message))) throw e;
  }
  try {
    db.prepare('ALTER TABLE sm_embeddings ADD COLUMN trust INTEGER DEFAULT 0').run();
  } catch (e) {
    if (!/duplicate column|already exists/.test(String(e.message))) throw e;
  }
  try {
    db.prepare('ALTER TABLE sm_embeddings ADD COLUMN derived_from TEXT').run();
  } catch (e) {
    if (!/duplicate column|already exists/.test(String(e.message))) throw e;
  }
  try {
    var stamped = backfillOriginTrust(db);
    if (stamped.fed > 0) {
      console.log('[semantic-memory] origin/trust backfill: stamped ' + stamped.fed +
        ' federated rows foreign-network; all other pre-column rows stay unknown (lowest trust) (F-mycelium/265)');
    }
  } catch (e) {
    console.error('[semantic-memory] origin/trust backfill FAILED — pre-column rows stay unknown (lowest trust; clear sm_config key origin_trust_backfill_v1 to re-arm):', e.message);
  }

  return {

    // -- Config --
    // Two stores: sm_config (PUT /memory/config) is canonical; the platform's
    // plugin_config table (PUT /plugins/semantic-memory/config) is the fallback
    // so config set through the platform plugin surface is honored too.
    // Reads happen per-call, so either route applies live — no restart needed.
    getConfig(key) {
      var row = db.prepare('SELECT value FROM sm_config WHERE key = ?').get(key);
      if (row) return row.value;
      try {
        var prow = db.prepare("SELECT value FROM plugin_config WHERE plugin_name = 'semantic-memory' AND key = ?").get(key);
        return prow ? prow.value : null;
      } catch (e) {
        return null; // plugin_config may not exist (plugin-only DBs, tests)
      }
    },

    setConfig(key, value) {
      db.prepare('INSERT OR REPLACE INTO sm_config (key, value) VALUES (?, ?)').run(key, value);
    },

    getAllConfig() {
      var config = {};
      try {
        var prows = db.prepare("SELECT key, value FROM plugin_config WHERE plugin_name = 'semantic-memory'").all();
        for (var p of prows) config[p.key] = p.value;
      } catch (e) { /* plugin_config may not exist (plugin-only DBs, tests) */ }
      var rows = db.prepare('SELECT key, value FROM sm_config').all();
      for (var r of rows) config[r.key] = r.value;
      return config;
    },

    // -- Chunking --
    // Threshold for splitting docs into chunk rows. Tunable via the
    // chunk_size config key; floor of 200 so a stray tiny value can't
    // shred every doc.
    getChunkSize() {
      var v = parseInt(this.getConfig('chunk_size'), 10);
      return (isNaN(v) || v < 200) ? DEFAULT_CHUNK_SIZE : v;
    },

    // Chunk-aware indexing: oversized content is split into chunk rows
    // (chunk_index 0..N), each holding its slice — replacing the doc's
    // previous rows. Stale chunks beyond the new count are removed in the
    // same transaction, so re-index never orphans old chunks. Returns the
    // chunk texts written (length 1 for docs under the threshold).
    indexDoc(sourceType, sourceId, contentText, opts) {
      opts = opts || {};
      var chunks = chunkText(contentText, this.getChunkSize());
      var self = this;
      var unchangedCount = 0;
      var txn = db.transaction(function () {
        for (var i = 0; i < chunks.length; i++) {
          var chunkOpts = Object.assign({}, opts, { chunk_index: i });
          if (chunks.length > 1) {
            // caller-supplied embeddings cover the whole doc — invalid per-chunk
            delete chunkOpts.embedding;
            delete chunkOpts.embedding_model;
          }
          var res = self.index(sourceType, sourceId, chunks[i], chunkOpts);
          if (res && res.unchanged) unchangedCount++;
        }
        self.removeChunksFrom(sourceType, sourceId, chunks.length);
      });
      txn();
      // Task 227: how many chunks were byte-identical no-ops, riding the
      // established array return (callers read .length and the texts). A
      // count equal to chunks.length means the doc wrote nothing at all.
      chunks.unchangedCount = unchangedCount;
      return chunks;
    },

    removeChunksFrom(sourceType, sourceId, fromIndex) {
      db.prepare(
        'DELETE FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index >= ?'
      ).run(sourceType, sourceId, fromIndex);
      vectorCache.onRemovePair(sourceType, sourceId, fromIndex);
    },

    getDocChunks(sourceType, sourceId) {
      return db.prepare(
        'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? ORDER BY chunk_index'
      ).all(sourceType, sourceId);
    },

    // -- Index --
    // 2026-09-18 (task 227): re-indexing IDENTICAL content with no embedding in
    // the request used to run `embedding = excluded.embedding` — resetting the
    // stored vector to NULL and re-queueing the row — so the Mac's half-hourly
    // memory backfill cost the Jetson ~2k re-embeds per tick and helped wedge
    // the platform that night (node R at 100% CPU, 811s down). Two guards now:
    // a read-before-write that SKIPS the write entirely when content, namespace
    // and metadata all match and the request carries no embedding (no FTS
    // rewrite, no cache touch, no embed — the row is byte-identical), and a
    // CASE on the upsert itself so a metadata-only or namespace-only change
    // keeps the stored vector while CHANGED content still resets it (stale
    // vectors are worse than missing ones). Returns { unchanged } so callers
    // (indexDoc → bulkIndex → the route) can skip the embed queue for no-ops.
    index(sourceType, sourceId, contentText, opts) {
      opts = opts || {};
      var namespace = opts.namespace || null;
      var chunkIndex = opts.chunk_index || 0;
      var metadata = opts.metadata ? JSON.stringify(opts.metadata) : '{}';
      var embedding = opts.embedding || null;
      var embeddingModel = opts.embedding_model || null;
      // TRUST LAYER P0.2: the write's owner, stamped by the route from the
      // AUTHENTICATED identity (never a body field). NULL on internal writers.
      var writtenBy = opts.written_by || null;
      // TRUST LAYER P1.1: the row's origin, trust level and (on derived rows)
      // its input refs — computed by the route (surface ceiling + min-of-
      // inputs; see routes.js bindOriginAndTrust) or named explicitly by an
      // internal writer that knows them (indexFactInMemory, the federation
      // store). Omitted = NULL = unknown = reads as the LOWEST trust, never
      // the highest.
      var origin = opts.origin || null;
      var trust = (opts.trust == null) ? null : Number(opts.trust);
      var derivedFrom = opts.derived_from ? JSON.stringify(opts.derived_from) : null;
      // TRUST LAYER P0 (review B item 2): SERVER-side writers of server-owned
      // source types set force_written_by — the source's real owner replaces
      // whatever custody the row carried, so a squatter's claim cannot survive
      // the server writing its own row. Surface writes keep the keep-first CASE.
      var forceWrittenBy = opts.force_written_by === true;

      var prior = db.prepare(
        'SELECT content_text, namespace, metadata FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = ?'
      ).get(sourceType, sourceId, chunkIndex);
      if (prior && embedding == null &&
          prior.content_text === contentText &&
          (prior.namespace || null) === namespace &&
          (prior.metadata || '{}') === metadata) {
        return { unchanged: true }; // a genuinely empty write — touch nothing
      }

      db.prepare(`
        INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model, written_by, origin, trust, derived_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id, chunk_index)
        DO UPDATE SET content_text = excluded.content_text, namespace = excluded.namespace,
          metadata = excluded.metadata,
          -- TRUST LAYER P0.2: written_by is CUSTODY, established by the row's
          -- FIRST writer and preserved on every authorized rewrite — an admin
          -- correcting a row does not steal it, and the owner can keep
          -- maintaining (or deleting) it afterwards. Only a first write (or a
          -- pre-column NULL) takes a new value. Review B item 2: a forced
          -- (server-side) write always takes excluded.written_by instead —
          -- the source's real owner evicts a squatter's claim.
          written_by = ${forceWrittenBy
            ? 'excluded.written_by'
            : 'CASE WHEN sm_embeddings.written_by IS NULL\n            THEN excluded.written_by ELSE sm_embeddings.written_by END'},
          -- TRUST LAYER P1.1: origin/trust/derived_from take the new write's
          -- values when it states them. A write that OMITS them preserves the
          -- row's stamps ONLY while the content is unchanged (a metadata-only
          -- touch, an embedding backfill). A content REWRITE that omits them
          -- drops the row to unknown: unknown reads as the LOWEST trust — the
          -- fail-closed outcome — while keeping the stamp would let new
          -- content inherit trust it never earned (review B of PR #201, B-1).
          -- The lesson-supersede flip restates its stamps explicitly, so it
          -- passes through the ELSE branch with its own values.
          origin = CASE WHEN excluded.origin IS NULL AND sm_embeddings.content_text = excluded.content_text
            THEN sm_embeddings.origin ELSE excluded.origin END,
          trust = CASE WHEN excluded.trust IS NULL AND sm_embeddings.content_text = excluded.content_text
            THEN sm_embeddings.trust ELSE excluded.trust END,
          derived_from = CASE WHEN excluded.derived_from IS NULL AND sm_embeddings.content_text = excluded.content_text
            THEN sm_embeddings.derived_from ELSE excluded.derived_from END,
          embedding = CASE WHEN excluded.embedding IS NULL AND sm_embeddings.content_text = excluded.content_text
            THEN sm_embeddings.embedding ELSE excluded.embedding END,
          embedding_model = CASE WHEN excluded.embedding IS NULL AND sm_embeddings.content_text = excluded.content_text
            THEN sm_embeddings.embedding_model ELSE excluded.embedding_model END,
          updated_at = CASE WHEN sm_embeddings.content_text = excluded.content_text
            AND sm_embeddings.namespace = excluded.namespace
            AND sm_embeddings.metadata = excluded.metadata
            THEN sm_embeddings.updated_at ELSE datetime('now') END
      `).run(sourceType, sourceId, contentText, namespace, chunkIndex, metadata, embedding, embeddingModel, writtenBy, origin, trust, derivedFrom);
      vectorCache.onUpsert(sourceType, sourceId, chunkIndex);
      return { unchanged: false };
    },

    // Chunk-aware bulk index. Items carrying an explicit chunk_index are
    // stored as single rows (caller-managed chunking); everything else goes
    // through indexDoc so oversized content splits and stale chunks are
    // cleaned up. Returns the rows actually written (post-chunking) so the
    // caller can embed each one; each row also carries `unchanged` (this row
    // was a byte-identical no-op and needs no embed), and the array carries
    // `unchangedCount` — the number of INPUT ITEMS that churned nothing — so
    // the bulk route can answer the {ok, indexed, rows, unchanged} split
    // (task 227).
    bulkIndex(items, writtenBy) {
      var self = this;
      var rows = [];
      var unchangedItems = 0;
      // TRUST LAYER P0.2: the route stamps every item with the AUTHENTICATED
      // writer (second arg); internal callers that omit it leave NULL.
      var owner = writtenBy || null;
      var txn = db.transaction(function (items) {
        for (var item of items) {
          if (item.chunk_index !== undefined && item.chunk_index !== null) {
            var one = self.index(item.source_type, item.source_id, item.content_text, {
              namespace: item.namespace, chunk_index: item.chunk_index,
              metadata: item.metadata, embedding: item.embedding,
              embedding_model: item.embedding_model, written_by: owner,
              origin: item.origin, trust: item.trust, derived_from: item.derived_from
            });
            var oneUnchanged = !!(one && one.unchanged);
            if (oneUnchanged) unchangedItems++;
            rows.push({
              source_type: item.source_type, source_id: item.source_id,
              chunk_index: item.chunk_index, content_text: item.content_text,
              embedding: item.embedding || null,
              unchanged: oneUnchanged
            });
            continue;
          }
          var chunks = self.indexDoc(item.source_type, item.source_id, item.content_text, {
            namespace: item.namespace, metadata: item.metadata,
            embedding: item.embedding, embedding_model: item.embedding_model,
            written_by: owner,
            origin: item.origin, trust: item.trust, derived_from: item.derived_from
          });
          // Content that is unchanged is unchanged for every chunk of the doc
          // (the split is deterministic), so the doc-level flag rides each row;
          // a changed doc's rows are NULL-embedded and embed regardless.
          var docUnchanged = chunks.unchangedCount === chunks.length;
          if (docUnchanged) unchangedItems++;
          for (var i = 0; i < chunks.length; i++) {
            rows.push({
              source_type: item.source_type, source_id: item.source_id,
              chunk_index: i, content_text: chunks[i],
              embedding: chunks.length === 1 ? (item.embedding || null) : null,
              unchanged: docUnchanged
            });
          }
        }
      });
      txn(items);
      rows.unchangedCount = unchangedItems;
      return rows;
    },

    getDoc(sourceType, sourceId, chunkIndex) {
      return db.prepare(
        'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = ?'
      ).get(sourceType, sourceId, chunkIndex || 0);
    },

    // TRUST LAYER P1.4: a true delete leaves a tombstone (id, when, the
    // AUTHENTICATED actor, why — never the content). opts: { by, reason,
    // tombstone } — tombstone:false opts out (the forget-cascade path writes
    // its own; nothing else may). Chunk cleanup (removeChunksFrom) is NOT a
    // delete — a re-index replaces chunks on a doc that still exists — so it
    // never tombstones.
    remove(sourceType, sourceId, opts) {
      opts = opts || {};
      var txn = db.transaction(function () {
        if (opts.tombstone !== false) {
          db.prepare('INSERT INTO sm_tombstones (source_type, source_id, deleted_by, reason) VALUES (?, ?, ?, ?)')
            .run(sourceType, sourceId, opts.by || null, opts.reason || 'delete');
        }
        db.prepare('DELETE FROM sm_embeddings WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
      });
      txn();
      vectorCache.onRemovePair(sourceType, sourceId, null);
    },

    // TRUST LAYER P1.4: forget one document AND the rows derived from it.
    // Three legs, one transaction each on the store side:
    //   1. the doc itself (tombstone + remove through the seam above, so the
    //      FTS triggers and the vector cache both see it leave);
    //   2. the sm rows DERIVED from the doc — on master today that is the
    //      plan_step rows of a deleted plan (metadata.plan_id), found through
    //      the metadata link the auto-indexer already writes;
    //   3. the auto-memory facts whose provenance points at this entity
    //      (derived_from 'task:<id>' / the legacy source_type+source_id
    //      shape) — reached through the event listeners auto-memory registers
    //      on the same source-delete events (each plugin cleans its own
    //      store; no plugin imports another). Here only leg 1 + 2.
    // Returns { removed, tombstoned, derived } for the route/receipt.
    forgetDoc(sourceType, sourceId, opts) {
      opts = opts || {};
      var derivedDocs = [];
      if (sourceType === 'plan') {
        // Review A round 2 (267d): plan_step_completed writes metadata.plan_id
        // as the raw INTEGER off plan_steps, so json_extract yields an INTEGER
        // and INTEGER = TEXT never matches in SQLite — the leg silently
        // orphaned every step row the platform itself indexed. CAST makes the
        // comparison TEXT = TEXT on either stored shape (and heals rows
        // already written as integers).
        derivedDocs = db.prepare(
          "SELECT source_id FROM sm_embeddings WHERE source_type = 'plan_step' AND CAST(json_extract(metadata, '$.plan_id') AS TEXT) = ?"
        ).all(String(sourceId)).map(function (r) { return r.source_id; });
      }
      this.remove(sourceType, sourceId, { by: opts.by, reason: opts.reason || 'source-deleted' });
      for (var i = 0; i < derivedDocs.length; i++) {
        this.remove('plan_step', derivedDocs[i], { by: opts.by, reason: 'source-deleted' });
      }
      return { removed: 1 + derivedDocs.length, tombstoned: 1 + derivedDocs.length, derived: derivedDocs.length };
    },

    // -- Companion rows (docs/companion-memory-api.md) ---------------------------
    // Ordinary sm_embeddings rows — source_type 'companion', one namespace per
    // owner ('companion:u<userId>') so the EXISTING search arms scope owner
    // reads in SQL; supersede state is the schema.sql column, not metadata,
    // so a recall filter reads it straight off the row.

    companionRow(sourceId) {
      return db.prepare(
        "SELECT * FROM sm_embeddings WHERE source_type = 'companion' AND source_id = ? AND chunk_index = 0"
      ).get(sourceId);
    },

    // TRUST LAYER P1.3: a row by source_id ALONE, any source_type — the
    // promote route's :id (a row id on this surface is a source_id). The head
    // chunk (chunk_index 0) resolves first so a multi-chunk doc promotes as
    // one document; a real row is never 404'd over chunk ordering.
    // opts.hide_companion (review A NIT 3): the COMPANION_HIDDEN_SQL class is
    // invisible to non-admin callers on this surface — passing it keeps a
    // companion id a 404 instead of leaking "this row exists" through the
    // 403-vs-404 distinction.
    anyBySourceId(sourceId, opts) {
      var sql = 'SELECT * FROM sm_embeddings WHERE source_id = ?';
      if (opts && opts.hide_companion) sql += ' AND ' + COMPANION_HIDDEN_SQL;
      sql += ' ORDER BY (chunk_index = 0) DESC, chunk_index LIMIT 1';
      return db.prepare(sql).get(sourceId);
    },



    // A state flip, not a content change: content_text is untouched (so the
    // FTS triggers don't fire and the stored vector stays valid) and
    // updated_at is deliberately left alone (the vector cache's recency scan
    // doesn't reshuffle because a row died). The WHERE re-asserts a live row
    // so even a concurrent double-submit cannot flip history twice.
    companionMarkSuperseded(sourceId, supersededById) {
      db.prepare(
        "UPDATE sm_embeddings SET superseded_by = ? WHERE source_type = 'companion' AND source_id = ? AND chunk_index = 0 AND superseded_by IS NULL"
      ).run(supersededById, sourceId);
    },

    // Forget must UN-MARK what it orphans (review A r3 MINOR 3): if the
    // forgotten row was itself a replacement, the row it superseded still
    // carries a superseded_by pointing at a row that no longer exists —
    // excluded from recall FOREVER with no API able to restore it, and
    // re-creating the replacement 409s against the dangling mark. Clearing
    // the pointer puts the older row back where the world was before the
    // correction; forget stays "never should have been here", not "and
    // everything it touched, too".
    companionClearSupersededBy(forgottenId) {
      return db.prepare(
        "UPDATE sm_embeddings SET superseded_by = NULL WHERE source_type = 'companion' AND superseded_by = ?"
      ).run(forgottenId);
    },

    companionList(filters) {
      filters = filters || {};
      // Named columns (review A r4 NIT 4): the view needs five fields; SELECT *
      // would drag up to 500 embedding BLOBs into a phone's sync page. The fed_*
      // provenance columns ride along (NULL on native rows, small TEXT) —
      // without them a visited/imported row's receipt is silently stripped by
      // the list/sync path, the exact path the phone reads provenance through.
      // TRUST LAYER P1.1: origin/trust/derived_from ride along (tiny columns) —
      // the phone fences instruction positions on them (P0.4/P1.1).
      var sql = "SELECT source_id, content_text, metadata, created_at, superseded_by, fed_agent, fed_network, fed_home, fed_visit, fed_sig, origin, trust, derived_from FROM sm_embeddings WHERE source_type = 'companion' AND namespace = @namespace";
      var params = { namespace: filters.namespace, limit: Math.max(1, Math.min(filters.limit || 100, 500)) }; // floor 1: SQLite reads a negative LIMIT as UNBOUNDED (review A r3 NIT 6)
      if (filters.kind) {
        sql += " AND json_extract(metadata, '$.kind') = @kind";
        params.kind = filters.kind;
      }
      if (filters.since) {
        // INCLUSIVE cursor (review A finding 3): created_at has 1-second
        // resolution and this product writes in bursts, so `>` silently skips
        // any row sharing the cursor's store-second — a sync loss the client
        // cannot see. The client dedups by id (the doc says so); an extra
        // already-known row is cheap, a lost one is forever.
        sql += ' AND created_at >= @since';
        params.since = filters.since;
      }
      sql += ' ORDER BY created_at DESC, id DESC LIMIT @limit';
      return db.prepare(sql).all(params).map(function (r) {
        // companionView reads these (P1.1); normalizing here keeps the raw
        // list path consistent with the search arms.
        return decodeTrustRow(r);
      });
    },

    // Admin bulk purge by exact filter — how a finished benchmark run cleans up
    // after itself (task 163's 3,104 bench rows were only reachable one
    // (source_type, source_id) pair at a time before this). At least one filter
    // is required: the route refuses a bare purge, and this returns null rather
    // than guess. FTS stays in sync through the sm_fts_delete trigger. Returns
    // the number of rows deleted.
    purge(filters, opts) {
      filters = filters || {};
      opts = opts || {};
      var where = [];
      var params = [];
      if (filters.source_type) { where.push('source_type = ?'); params.push(filters.source_type); }
      if (filters.namespace) { where.push('namespace = ?'); params.push(filters.namespace); }
      if (where.length === 0) return null; // never delete unfiltered
      // TRUST LAYER P1.4: the identity of every row this purge takes, read
      // BEFORE the delete — afterwards there is nothing left to name. One
      // tombstone per row (append-only), in the same transaction as the
      // delete so a purge is all-or-nothing on the ledger too.
      var doomed = db.prepare('SELECT DISTINCT source_type, source_id FROM sm_embeddings WHERE ' + where.join(' AND ')).all(...params);
      var txn = db.transaction(function () {
        for (var d of doomed) {
          db.prepare('INSERT INTO sm_tombstones (source_type, source_id, deleted_by, reason) VALUES (?, ?, ?, ?)')
            .run(d.source_type, d.source_id, opts.by || null, opts.reason || 'purge');
        }
        var info = db.prepare('DELETE FROM sm_embeddings WHERE ' + where.join(' AND ')).run(...params);
        return info.changes;
      });
      var changes = txn();
      vectorCache.onPurge(filters);
      return changes;
    },

    // -- Search --
    // Collapse chunked docs to their best-scoring chunk so one big doc
    // can't flood a result page. Input must be sorted best-first; keeps
    // the first row seen per (source_type, source_id).
    collapseChunks(results) {
      var seen = {};
      var out = [];
      for (var r of results) {
        var key = r.source_type + ':' + r.source_id;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(r);
      }
      return out;
    },

    // TRUST LAYER P1.6 (F-mycelium/270): the ONE ranking step every recall
    // page goes through. Each row's ranking value (`score`, or `scoreField`
    // — the hybrid fusion passes 'rrf_score') is multiplied by the retrieval-
    // trust weight (server/lib/retrieval-trust.js — the ONE function and the
    // ONE constants block; no per-call-site weights) into `retrieval_score`,
    // and the page is ordered by it. The raw relevance field is never
    // overwritten — `score` keeps its meaning for every existing caller, the
    // weighted value rides beside it.
    //
    // opts.deferTrustRank is INTERNAL (set only by searchHybrid, on its
    // fusion-input arms): the arms then rank pure relevance, and the fused
    // page is weighted exactly once at the fusion tail — no compounding, so
    // the measured utility cost is mode-independent. Routes never pass it.
    rankRowsByRetrievalTrust(rows, opts, scoreField) {
      if (opts && opts.deferTrustRank) return rows;
      var field = scoreField || 'score';
      var now = Date.now();
      for (var r of rows) {
        r.retrieval_score = ((r[field] != null) ? r[field] : 0) * retrievalTrustWeight(r, { now: now });
      }
      rows.sort(function (a, b) { return b.retrieval_score - a.retrieval_score; });
      return rows;
    },

    searchKeyword(query, opts) {
      opts = opts || {};
      var limit = Math.min(opts.limit || 10, 100);
      // Overfetch so collapsing a multi-chunk doc doesn't starve the page
      var fetchLimit = Math.min(limit * 2, 200);
      var where = [];
      var params = [];

      // FTS5 match — bounded (see buildFtsQuery); a query with no usable term has no keyword leg
      var ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) return [];
      where.push("sm_embeddings_fts MATCH ?");
      params.push(ftsQuery);

      if (opts.source_types && opts.source_types.length > 0) {
        where.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
        params = params.concat(opts.source_types);
      }
      if (opts.namespace) {
        where.push('namespace = ?');
        params.push(opts.namespace);
      }
      if (!benchOptIn(opts)) where.push(BENCH_HIDDEN_SQL);
      if (!opts.companion_ok) where.push(COMPANION_HIDDEN_SQL);

      params.push(fetchLimit);

      try {
        var rows = db.prepare(
          'SELECT rowid, content_text, source_type, namespace, rank FROM sm_embeddings_fts WHERE ' + where.join(' AND ') + ' ORDER BY rank LIMIT ?'
        ).all(...params);

        // Enrich with full row data
        var enriched = rows.map(function (r) {
          var full = db.prepare('SELECT * FROM sm_embeddings WHERE id = ?').get(r.rowid);
          if (!full) return null;
          try { full.metadata = JSON.parse(full.metadata); } catch (e) { full.metadata = {}; }
          full.score = -r.rank; // FTS5 rank is negative (lower = better)
          return decodeTrustRow(stampEmbedded(full)); // task 213 embeddedness + P1.1 trust stamps
        }).filter(Boolean);
        // P1.6: the page is trust-ordered at its terminal (one application)
        return this.collapseChunks(this.rankRowsByRetrievalTrust(enriched, opts)).slice(0, limit);
      } catch (e) {
        // FTS5 query syntax error — fall back to LIKE search
        var likeParams = [];
        var likeWhere = ['content_text LIKE ?'];
        likeParams.push('%' + query + '%');
        if (opts.source_types && opts.source_types.length > 0) {
          likeWhere.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
          likeParams = likeParams.concat(opts.source_types);
        }
        if (opts.namespace) {
          likeWhere.push('namespace = ?');
          likeParams.push(opts.namespace);
        }
        if (!benchOptIn(opts)) likeWhere.push(BENCH_HIDDEN_SQL);
        if (!opts.companion_ok) likeWhere.push(COMPANION_HIDDEN_SQL);
        likeParams.push(fetchLimit);
        var likeRows = db.prepare(
          'SELECT * FROM sm_embeddings WHERE ' + likeWhere.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ?'
        ).all(...likeParams).map(decodeTrustRow);
        // P1.6: the LIKE page is trust-ordered too (one application)
        return this.collapseChunks(this.rankRowsByRetrievalTrust(likeRows.map(function (r) {
          try { r.metadata = JSON.parse(r.metadata); } catch (e) { r.metadata = {}; }
          r.score = 1.0; // no ranking for LIKE fallback
          return stampEmbedded(r); // task 213: the row states its own embeddedness
        }), opts)).slice(0, limit);
      }
    },

    // -- Vector Search --
    // The query path NEVER JSON.parses an embedding: vectors are decoded once
    // into the cache (vector-cache.js) and search is a filter + tight dot
    // loop. Per-query parse of up to 5,000 vectors was 2.4-4.3 s on jetson01
    // and blocked the event loop hard enough to wedge the platform
    // (F-mycelium/194). The original algorithm lives on verbatim as
    // searchVectorJsonPath — the oracle the tests hold the cache to, and the
    // fallback if the cache ever throws or its breaker is open (never worse
    // than before the cache). Async since 196: a search arriving mid-build
    // waits on the ONE in-flight build instead of running a second one or
    // blocking the loop on the corpus decode.
    async searchVector(queryEmbedding, opts) {
      opts = opts || {};
      await vectorCache.ensureFresh();
      if (!vectorCache.available()) {
        // Breaker open — skip the cache entirely (no build attempt inside a
        // window; the window's ONE log line already fired at the failure).
        vectorCache.fallbackServed();
        return this.searchVectorJsonPath(queryEmbedding, opts);
      }
      try {
        var scored = vectorCache.scored(queryEmbedding, opts);
        return this.finishScored(scored, Math.min(opts.limit || 10, 100), opts);
      } catch (e) {
        console.error('[semantic-memory] vector cache failed, falling back to JSON path:', e.message);
        return this.searchVectorJsonPath(queryEmbedding, opts);
      }
    },

    // Shared tail for both vector arms: collapse chunked docs to their best
    // chunk BEFORE slicing to the page limit (mirrors searchKeyword), then
    // fetch full rows for the candidate pool and — P1.6 — trust-rank the page
    // at this terminal. The pool is limit × RETRIEVAL_TRUST.RERANK_POOL rows
    // fetched by raw similarity, so a trusted row just below the relevance
    // cutoff can still move INTO the page; the fetch is one round-trip over an
    // explicit column list (the multi-KB embedding excluded — routes strip it,
    // and a vector-scan hit is embedded by construction, which the stamp says
    // directly instead of re-reading the blob).
    finishScored(scored, limit, opts) {
      var defer = !!(opts && opts.deferTrustRank);
      var pool = this.collapseChunks(scored);
      var poolSize = defer ? limit : Math.min(pool.length, limit * RETRIEVAL_TRUST.RERANK_POOL);
      var topIds = pool.slice(0, poolSize);
      if (topIds.length === 0) return [];
      var ids = topIds.map(function (s) { return s.id; });
      var fetched = db.prepare(
        'SELECT id, source_type, source_id, chunk_index, namespace, content_text, metadata, embedding_model, ' +
        'created_at, updated_at, superseded_by, written_by, fed_agent, fed_network, fed_home, fed_visit, fed_sig, ' +
        'origin, trust, derived_from FROM sm_embeddings WHERE id IN (' +
        ids.map(function () { return '?'; }).join(',') + ')'
      ).all(...ids);
      var byId = {};
      for (var f of fetched) byId[f.id] = f;
      var rows = [];
      for (var s of topIds) {
        var full = byId[s.id];
        if (!full) continue;
        try { full.metadata = JSON.parse(full.metadata); } catch (e) { full.metadata = {}; }
        full.score = s.score;
        full.embedded = true; // task 213: a vector-scan hit is embedded by construction
        rows.push(decodeTrustRow(full)); // P1.1 trust stamps
      }
      if (!defer) rows = this.rankRowsByRetrievalTrust(rows, opts);
      return rows.slice(0, limit);
    },

    // The pre-194 algorithm, kept verbatim as the correctness oracle for the
    // cache (test/unit/search-vector-decode-cache.test.js asserts identical
    // ranking and scores to 1e-6) and as the emergency fallback above. Not
    // called on the hot path; do not optimize or "clean up" this method —
    // its value is being exactly what shipped before the cache.
    searchVectorJsonPath(queryEmbedding, opts) {
      opts = opts || {};
      var limit = Math.min(opts.limit || 10, 100);
      var where = ['embedding IS NOT NULL'];
      var params = [];

      if (opts.source_types && opts.source_types.length > 0) {
        where.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
        params = params.concat(opts.source_types);
      }
      if (opts.namespace) {
        where.push('namespace = ?');
        params.push(opts.namespace);
      }
      if (!benchOptIn(opts)) where.push(BENCH_HIDDEN_SQL);
      if (!opts.companion_ok) where.push(COMPANION_HIDDEN_SQL);

      // Cap rows loaded for JS-side cosine sim to prevent DoS on large tables
      params.push(VECTOR_SCAN_CAP);
      var rows = db.prepare(
        'SELECT id, source_type, source_id, chunk_index, embedding FROM sm_embeddings WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ?'
      ).all(...params);

      // Compute cosine similarity in JS
      var scored = [];
      for (var row of rows) {
        var embedding = null;
        try {
          if (typeof row.embedding === 'string') {
            embedding = JSON.parse(row.embedding);
          } else if (Buffer.isBuffer(row.embedding)) {
            embedding = JSON.parse(row.embedding.toString());
          }
        } catch (e) { continue; }
        if (!embedding) continue;

        var sim = cosineSimilarity(queryEmbedding, embedding);
        scored.push({ id: row.id, source_type: row.source_type, source_id: row.source_id, chunk_index: row.chunk_index, score: sim });
      }

      scored.sort(function (a, b) { return b.score - a.score; });
      return this.finishScored(scored, limit, opts);
    },

    // Cache observability for tests and ops (additive, read-only).
    vectorCacheInfo() {
      return vectorCache.info();
    },

    updateEmbedding(sourceType, sourceId, chunkIndex, embedding, model) {
      updateEmbeddingRow(sourceType, sourceId, chunkIndex, embedding, model);
    },

    getUnembedded(limit, owner) {
      // Companion rows are NOT backlog (review A r4 MINOR 2): under the drone
      // provider they are security-refused at the queue by design, so counting
      // them made /reindex and /backfill-embeddings answer remaining:true
      // forever and the boot drain re-offer them every pass. The same
      // predicate the search arms hide them with keeps this from drifting.
      // Not-backlog is not deleted: the rows stay keyword-searchable.
      // TRUST LAYER P0 (250c, review-A r2 major (a)): `owner` scopes the
      // backlog to rows the caller WROTE — a non-admin backfill never queues
      // another owner's row (their text would enter the agent-readable drone
      // job queue and the completed vector would cross owners). NULL
      // written_by is owner-UNKNOWN and never matches an owner scope: those
      // rows stay admin-only, fail-closed like every other custody gate.
      var sql = 'SELECT id, source_type, source_id, chunk_index, content_text FROM sm_embeddings WHERE embedding IS NULL AND ' + COMPANION_HIDDEN_SQL;
      var params = [];
      if (owner) { sql += ' AND written_by = ?'; params.push(owner); }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit || 50);
      return db.prepare(sql).all(...params);
    },

    countUnembedded(owner) {
      var sql = 'SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NULL AND ' + COMPANION_HIDDEN_SQL;
      var params = [];
      if (owner) { sql += ' AND written_by = ?'; params.push(owner); }
      return db.prepare(sql).get(...params).c;
    },

    // Oversized NULL-embedding rows can never embed whole — the provider
    // rejects them. Moved here from routes.js (task 219) so the boot drain
    // (boot-drain.js) reuses the EXACT treatment /reindex and
    // /backfill-embeddings give them instead of growing a second copy.
    // Covers both legacy un-chunked docs AND docs whose chunks were cut at a
    // larger (since-lowered) threshold. The full doc is rebuilt from ALL its
    // chunk rows (chunking is lossless, so the join IS the original) and
    // re-chunked at the current threshold — re-chunking from a single chunk's
    // slice would drop sibling chunk content. Returns the expanded work list
    // of rows to embed.
    expandOversizedRows(rows) {
      var work = [];
      var rechunked = {}; // source_type:source_id — re-chunk each doc once
      var chunkSize = this.getChunkSize(); // hoisted — static per request, not per row (N+1)
      for (var row of rows) {
        var key = row.source_type + ':' + row.source_id;
        if (rechunked[key]) continue;
        if (row.content_text.length > chunkSize) {
          rechunked[key] = true;
          var docRows = this.getDocChunks(row.source_type, row.source_id);
          var fullText = docRows.map(function (c) { return c.content_text; }).join('');
          var meta; // assigned on both paths below
          try { meta = docRows[0].metadata ? JSON.parse(docRows[0].metadata) : null; } catch (e) { meta = null; }
          var chunks = this.indexDoc(row.source_type, row.source_id, fullText, {
            namespace: docRows[0].namespace, metadata: meta,
            // TRUST LAYER P0 (250c): custody survives the chunk-split — the
            // re-written/new chunk rows keep the doc's owner, so the owner's
            // own claim-and-write still answers after an oversized-row backfill
            // (a split that dropped written_by would strand the row
            // owner-unknown and fail the vector-write gate closed at them).
            written_by: docRows[0].written_by
          });
          for (var ci = 0; ci < chunks.length; ci++) {
            work.push({ source_type: row.source_type, source_id: row.source_id, chunk_index: ci, content_text: chunks[ci] });
          }
        } else {
          work.push(row);
        }
      }
      return work;
    },

    // Async since 196: the vector arm may wait on an in-flight cache build.
    async searchHybrid(query, opts, queryEmbedding) {
      opts = opts || {};
      var limit = opts.limit || 10;

      // Always do keyword search. deferTrustRank is INTERNAL (see
      // rankRowsByRetrievalTrust): the fusion-input arms rank pure relevance,
      // the fused page below is weighted exactly once.
      var keywordResults = this.searchKeyword(query, Object.assign({}, opts, { limit: limit * 2, deferTrustRank: true }));

      // If no query embedding, return keyword only — the arm above deferred
      // its trust rank (it was staged as a fusion input), so this tail applies
      // the weight exactly once for the keyword-fallback page.
      if (!queryEmbedding) {
        return this.rankRowsByRetrievalTrust(keywordResults, opts).slice(0, limit);
      }

      // Vector search
      var vectorResults = await this.searchVector(queryEmbedding, Object.assign({}, opts, { limit: limit * 2, deferTrustRank: true }));

      // Reciprocal Rank Fusion (RRF)
      var K = 60; // standard RRF constant
      var scores = {}; // key: source_type:source_id:chunk_index -> { score, row }

      for (var ki = 0; ki < keywordResults.length; ki++) {
        var kr = keywordResults[ki];
        var key = kr.source_type + ':' + kr.source_id + ':' + (kr.chunk_index || 0);
        if (!scores[key]) scores[key] = { score: 0, row: kr };
        scores[key].score += 1 / (K + ki + 1);
      }

      for (var vi = 0; vi < vectorResults.length; vi++) {
        var vr = vectorResults[vi];
        var key2 = vr.source_type + ':' + vr.source_id + ':' + (vr.chunk_index || 0);
        if (!scores[key2]) scores[key2] = { score: 0, row: vr };
        scores[key2].score += 1 / (K + vi + 1);
        scores[key2].row.vector_score = vr.score; // attach vector similarity for debugging
      }

      // Sort by combined RRF score, then collapse chunked docs to their
      // best chunk before applying the page limit. P1.6: the fused page is
      // trust-ranked at THIS terminal (the arms deferred) — one application,
      // on the fusion score; rrf_score itself keeps its raw meaning.
      var merged = Object.values(scores).sort(function (a, b) { return b.score - a.score; });
      var rows = merged.map(function (m) {
        m.row.rrf_score = m.score;
        return m.row;
      });
      return this.collapseChunks(this.rankRowsByRetrievalTrust(rows, opts, 'rrf_score')).slice(0, limit);
    },

    // -- Stats --
    // List rows of a given source_type, newest first — query-free retrieval for
    // always-on content (e.g. standing preferences injected every turn
    // regardless of the current query). Added 2026-08-18.
    listByType(sourceType, opts) {
      opts = opts || {};
      var namespace = opts.namespace || null;
      var limit = Math.min(parseInt(opts.limit, 10) || 20, 100);
      // TRUST LAYER P1.1: the trust stamps ride the query-free listing too.
      var sql = 'SELECT source_type, source_id, content_text, namespace, metadata, created_at, origin, trust, derived_from '
              + 'FROM sm_embeddings WHERE source_type = ? AND chunk_index = 0';
      var args = [sourceType];
      if (namespace) { sql += ' AND namespace = ?'; args.push(namespace); }
      sql += ' ORDER BY created_at DESC LIMIT ?'; args.push(limit);
      return db.prepare(sql).all(...args).map(decodeTrustRow);
    },

    // -- Lessons & history (2026-09-10, F-mycelium/186) ---------------------------
    // A LESSON is a memory row like everything else: source_type 'lesson', one
    // row per lesson (chunk_index 0), provenance in metadata (actor, learned_at,
    // evidence — enforced at the route, not here). Recall orders by the lesson's
    // OWN date ("last Tuesday this exact shape failed because…"), falling back
    // to created_at for rows that somehow lack learned_at — NOT by insertion
    // order, which disagrees with reality the moment a batch migrates in.
    // History is the sibling view over source_type 'verdict' (prior workflow/
    // lane verdicts for a repo/class). Same provenance gate, same ordering.
    // 237: superseded rows (metadata.superseded_by set) are EXCLUDED by default —
    // the recall block stops teaching the dead version the moment the correction
    // lands; ?include_superseded=1 reads them back with their pointer (the §3
    // rule: history is kept, never erased).
    listProvenanceRows(sourceType, opts) {
      opts = opts || {};
      var limit = Math.min(parseInt(opts.limit, 10) || 20, 100);
      var where = ['source_type = ?', 'chunk_index = 0'];
      var args = [sourceType];
      if (!opts.include_superseded) {
        where.push("json_extract(metadata, '$.superseded_by') IS NULL");
      }
      if (opts.task_class) { where.push("json_extract(metadata, '$.task_class') = ?"); args.push(opts.task_class); }
      if (opts.repo) { where.push("json_extract(metadata, '$.repo') = ?"); args.push(opts.repo); }
      if (opts.since) {
        // ISO date/datetime strings compare correctly as text (fixed-width,
        // zero-padded) — a date-only since= covers the whole named day.
        where.push("COALESCE(json_extract(metadata, '$.learned_at'), created_at) >= ?");
        args.push(opts.since);
      }
      // TRUST LAYER P1.1: the trust stamps ride the lesson/history views.
      var sql = 'SELECT source_type, source_id, content_text, namespace, metadata, created_at, updated_at, origin, trust, derived_from '
              + 'FROM sm_embeddings WHERE ' + where.join(' AND ')
              + " ORDER BY COALESCE(json_extract(metadata, '$.learned_at'), created_at) DESC, created_at DESC LIMIT ?";
      args.push(limit);
      var rows = db.prepare(sql).all(...args);
      for (var r of rows) {
        try { r.metadata = JSON.parse(r.metadata); } catch (e) { r.metadata = {}; }
        decodeTrustRow(r);
      }
      return rows;
    },

    listLessons(opts) {
      return this.listProvenanceRows('lesson', opts);
    },

    listHistory(opts) {
      return this.listProvenanceRows('verdict', opts);
    },

    // The provenance gate the route enforces for lesson/verdict rows — lives
    // beside the query layer so /index and /index/bulk share ONE definition.
    // actor/learned_at/evidence are the brief's provenance trio (BRIEF-lab-
    // alive-memory-program: "a lesson row without provenance is refused at
    // the route"); the rest of the §1 shape (symptom, fix_or_rule, task_class,
    // repo, origin, outcome) is the documented contract but is not the gate.
    LESSON_SOURCE_TYPES: { lesson: true, verdict: true },
    REQUIRED_PROVENANCE: ['actor', 'learned_at', 'evidence'],
    missingProvenanceFields(metadata) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return this.REQUIRED_PROVENANCE.slice();
      }
      return this.REQUIRED_PROVENANCE.filter(function (f) {
        var v = metadata[f];
        return typeof v !== 'string' || v.trim().length === 0;
      });
    },

    // -- Episodes: the §3 EVENT half (2026-09-18, F-mycelium/218) ------------------
    // An EPISODE is one squad session transcript stored VERBATIM as a memory row
    // (source_type 'episode') so every reconciled fact can cite the session that
    // established it — "the lab has the fact half and no episode half". Same index
    // path, same plugin, no new organ; the provenance gate is 186's scoped to what
    // an episode must carry: WHO (agent) and WHEN (session_date). session_id (the
    // transcript's content hash) and origin (workflow_id or file path) are the
    // documented contract but are not the gate — a fact cites the episode by
    // agent+date+hash, so those two are the ones a writer cannot guess.
    EPISODE_SOURCE_TYPES: { episode: true },
    REQUIRED_EPISODE_PROVENANCE: ['agent', 'session_date'],
    missingEpisodeFields(metadata) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return this.REQUIRED_EPISODE_PROVENANCE.slice();
      }
      return this.REQUIRED_EPISODE_PROVENANCE.filter(function (f) {
        var v = metadata[f];
        return typeof v !== 'string' || v.trim().length === 0;
      });
    },

    // GET /memory/episodes' query layer — the dated enumeration: "the indexed
    // episodes of one agent/day" (the reconcile dry-run's input; tomorrow, the
    // wake/boot blocks' dated-episode line). Metadata parsed; newest first by
    // the episode's OWN session_date (falling back to created_at), not
    // insertion order — a backfilled week must read as the week it was, not as
    // the night it was indexed. An episode spans chunk rows 0..N (chunking.js
    // is lossless: chunks.join('') === the original text), and the row out is
    // the WHOLE text — its chunks concatenated in index order. Returning
    // chunk 0 alone was the defect the 2026-09-18 live receipt caught: a
    // 4000-char fragment whose first JSON line dies mid-string — nothing
    // downstream could parse the transcript the row claims to carry.
    listEpisodes(opts) {
      opts = opts || {};
      var limit = Math.min(parseInt(opts.limit, 10) || 20, 500);
      var where = ["source_type = 'episode'", 'chunk_index = 0'];
      var args = [];
      if (opts.agent) { where.push("json_extract(metadata, '$.agent') = ?"); args.push(opts.agent); }
      if (opts.session_date) { where.push("json_extract(metadata, '$.session_date') = ?"); args.push(opts.session_date); }
      if (opts.namespace) { where.push('namespace = ?'); args.push(opts.namespace); }
      // Pass 1: the episode heads (chunk 0 exists for every row — the chunker
      // always emits at least one chunk), so LIMIT counts EPISODES, not chunks.
      var sql = 'SELECT source_type, source_id, namespace, metadata, created_at, updated_at '
              + 'FROM sm_embeddings WHERE ' + where.join(' AND ')
              + " ORDER BY COALESCE(json_extract(metadata, '$.session_date'), created_at) DESC, created_at DESC LIMIT ?";
      args.push(limit);
      var heads = db.prepare(sql).all(...args);
      if (heads.length === 0) return [];
      // Pass 2: every chunk of those episodes, in index order, joined back.
      var marks = heads.map(function () { return '?'; }).join(',');
      var chunks = db.prepare("SELECT source_id, content_text FROM sm_embeddings "
          + "WHERE source_type = 'episode' AND source_id IN (" + marks + ") "
          + 'ORDER BY source_id, chunk_index').all(heads.map(function (h) { return h.source_id; }));
      var byId = {};
      for (var c of chunks) {
        (byId[c.source_id] = byId[c.source_id] || []).push(c.content_text);
      }
      for (var h of heads) {
        h.content_text = (byId[h.source_id] || []).join('');
        try { h.metadata = JSON.parse(h.metadata); } catch (e) { h.metadata = {}; }
      }
      return heads;
    },

    // Lightweight health snapshot for the search response — the four numbers a
    // caller needs to judge whether a result set is complete + healthy (total,
    // embedded, coverage %, vector-scan cap), WITHOUT the two GROUP BYs stats()
    // runs. Search is a hotter path than GET /stats, so this stays cheap.
    // Surfaced on every /memory/search response — see MEMORY-FAILURE-STATES.md §F3.
    indexHealth() {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings').get().c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
      return {
        total: total,
        embedded: withEmbedding,
        coverage_pct: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        vector_scan_capped: withEmbedding > VECTOR_SCAN_CAP // mirrors the cap in searchVector()
      };
    },

    // The SAME four definitions scoped to ONE namespace (task 214) — the
    // per-namespace truth the bench's embedding wait needs: a run's own rows
    // can be 100% embedded while the global index sits at 40% behind the lab's
    // live write burst, and a wait that can only read the global number burns
    // its cap on rows the run will never search. Superseded am_fact index rows
    // count (namespace = ? matches them like any other row — they stay
    // searchable by design, task 206); a namespace with no rows reads an
    // honest 0/0/0, same convention as indexHealth's empty index.
    namespaceHealth(namespace) {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE namespace = ?').get(namespace).c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE namespace = ? AND embedding IS NOT NULL').get(namespace).c;
      return {
        rows: total,
        embedded: withEmbedding,
        coverage_pct: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        vector_scan_capped: withEmbedding > VECTOR_SCAN_CAP
      };
    },

    stats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings').get().c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
      var byType = db.prepare('SELECT source_type, COUNT(*) as count FROM sm_embeddings GROUP BY source_type ORDER BY count DESC').all();
      var byNamespace = db.prepare('SELECT namespace, COUNT(*) as count FROM sm_embeddings WHERE namespace IS NOT NULL GROUP BY namespace ORDER BY count DESC LIMIT 20').all();
      return {
        total_indexed: total,
        with_embeddings: withEmbedding,
        embedding_coverage: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        // Rows awaiting embedding (the row-level backlog) + the in-process
        // scheduler depth (what's in flight / queued per lane). A client
        // watching a bulk index can see the embed pipeline drain here
        // instead of diagnosing it from search timeouts. (2026-09-09)
        embed_backlog: this.countUnembedded(),
        // + the drain receipt (task 219): last_drain_at / rows_enqueued_at_boot —
        // how a client proves the boot drain ran and the self-check is alive,
        // instead of diagnosing a frozen embedded count from the outside.
        embed_queue: Object.assign(embedQueueDepth(), embedDrainSnapshot()),
        by_source_type: byType,
        by_namespace: byNamespace,
        // Lesson retirements (237): how many lesson rows have been superseded
        // (metadata.superseded_by set) and the latest valid_to — the weekly
        // report's "the lab corrected itself N times" line. Zero rows stamps
        // count 0 / latest null, never an absent field.
        lessons_superseded: (function () {
          // 241/F1 (review 239a): the supersede flip stamps EVERY chunk of the
          // dead lesson with the pointer, so the count is per DOC — a
          // multi-chunk row must retire once, not once per chunk.
          var row = db.prepare(
            "SELECT COUNT(DISTINCT source_id) AS c, MAX(json_extract(metadata, '$.valid_to')) AS latest " +
            "FROM sm_embeddings WHERE source_type = 'lesson' " +
            "AND json_extract(metadata, '$.superseded_by') IS NOT NULL"
          ).get();
          return { count: row.c, latest: row.latest || null };
        })(),
        vector_scan_capped: withEmbedding > VECTOR_SCAN_CAP,
        // The decoded-vector cache's own state (194) + its breaker/fallback
        // windows (196): what /stats shows when search latency or the log's
        // "JSON fallback for Ns" line needs explaining. (§F1 honesty)
        vector_cache: vectorCache.info()
      };
    }
  };
}

// TRUST LAYER P1.4: the one FORGET write for the federation door — the same
// shape promoteBySourceId established for the PROMOTE write (a named export
// taking the host db, NOT a memoryDB method: the federation routes hold
// core.db, and constructing a second createMemoryDB there would evict the
// attached vector cache). Tombstones (by = the revoking agent, reason
// 'federation-revoke'), deletes the row class through the same DELETE the
// memoryDB.remove seam uses (the FTS triggers fire on any delete), and hooks
// the decoded-vector cache through its per-db side-channel when one is
// attached — the same optimistic hook auto-memory's unindexFacts uses; a
// rolled-back delete is caught by the post-write signature check on the
// next search. Returns the number of rows removed.
export function forgetDocRaw(db, sourceType, sourceId, opts) {
  opts = opts || {};
  var vc = db.__myceliumVectorCache;
  var txn = db.transaction(function () {
    db.prepare('INSERT INTO sm_tombstones (source_type, source_id, deleted_by, reason) VALUES (?, ?, ?, ?)')
      .run(sourceType, sourceId, opts.by || null, opts.reason || 'delete');
    return db.prepare('DELETE FROM sm_embeddings WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId).changes;
  });
  var changes = txn();
  if (vc && changes > 0) {
    try { vc.onRemoveMany(sourceType, [String(sourceId)]); } catch (e) { /* cache absent — the signature reconcile is the net */ }
  }
  return changes;
}

// TRUST LAYER P1.3: the one PROMOTE write. Both doors — POST
// /memory/:id/promote and the federation accept route — come through here so
// the raw UPDATE lives in this one file (the vector-cache gate allows no raw
// sm_embeddings UPDATE outside it). A promote is a STATE flip, not a content
// change, in exactly the companionMarkSuperseded class: content_text is
// untouched (the FTS triggers stay silent, the stored vector stays valid)
// and updated_at is deliberately left alone (the cache's recency scan does
// not reshuffle because a row was vouched for). The metadata rewrite moves
// neither COUNT nor MAX(id) — the signature-blind gap vector-cache.js's
// header documents for precisely this shape. A named export taking the host
// db (NOT a memoryDB method): the federation door calls it with core.db, and
// constructing a second createMemoryDB there would evict the attached vector
// cache.
export function promoteBySourceId(db, sourceType, sourceId, promotedBy, claimedBy) {
  var rows = db.prepare(
    'SELECT id, metadata FROM sm_embeddings WHERE source_type = ? AND source_id = ?'
  ).all(sourceType, sourceId);
  for (var i = 0; i < rows.length; i++) {
    db.prepare('UPDATE sm_embeddings SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(promotedMeta(parseQuarantineMeta(rows[i].metadata), promotedBy, claimedBy)), rows[i].id);
  }
  return rows.length;
}
