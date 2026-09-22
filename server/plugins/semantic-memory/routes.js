// Semantic Memory plugin routes

import crypto from 'crypto';
import { Router } from 'express';
import createMemoryDB from './db.js';
import { chunkText } from './chunking.js';
import { rateLimited } from '../../lib/rate-limit.js';
import { generateEmbedding, generateEmbeddingBatch, createDroneEmbedJob } from './embeddings.js';

export default function (core) {
  var router = Router();
  var db = createMemoryDB(core.db);
  var { checkAgentOrAdmin, checkAdmin, getAdminDisplayName } = core.auth;
  // asyncHandler comes from core now (routes/mycelium.js exports it on
  // pluginCore), retiring the private copy this file used to ship. The loader's
  // guardPluginRouter also wraps every plugin handler at mount time, so an
  // explicit asyncHandler() wrap on a route is defense-in-depth, not load-
  // bearing — but it documents which routes can reject.
  var { apiError, parseIntParam, asyncHandler } = core;

  // Fire-and-forget embedding after route-level indexing — same flow as the
  // event handlers. (POST /index used to store NULL embeddings forever; that
  // was the bulk of the unembedded backlog.)
  function autoEmbed(sourceType, sourceId, contentText, chunkIndex) {
    var config = db.getAllConfig();
    if (!config.embedding_provider || config.embedding_provider === 'none') return;
    generateEmbedding(config, contentText, {
      db: core.db, sourceType: sourceType, sourceId: sourceId, chunkIndex: chunkIndex || 0
    }).then(function (embedding) {
      if (embedding) {
        db.updateEmbedding(sourceType, sourceId, chunkIndex || 0, embedding, config.embedding_model || config.embedding_provider);
      }
    }).catch(function (e) {
      console.error('[semantic-memory] auto-embed failed for ' + sourceType + ':' + sourceId + ':', e.message);
    });
  }

  // POST /memory/search — hybrid search. Wrapped in asyncHandler (rejected
  // promise from generateEmbedding/searchHybrid -> next(err) -> 500) — the
  // same class /reindex + /backfill already guard; /search had been missed.
  //
  // Bench-namespace rule (2026-09-08): rows whose source_type starts 'bench_'
  // or whose namespace starts 'bench-' are EXCLUDED here unless the request
  // names that source_type in `source_types` or that namespace in `namespace`.
  // Enforced in the query layer (db.js searchKeyword/searchVector) so `limit`
  // is spent on visible rows; to recall a benchmark's own writes, name them.
  router.post('/search', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { query, source_types, namespace, project_id, limit, mode } = req.body;
    if (!query || typeof query !== 'string') return apiError(res, 400, 'query is required');
    limit = Math.min(parseInt(limit) || 10, 100);
    var requestedMode = mode || 'hybrid';

    var opts = { limit: limit };
    if (source_types && Array.isArray(source_types)) opts.source_types = source_types;
    if (namespace) opts.namespace = namespace;
    if (project_id) opts.project_id = project_id; // NOTE: searchKeyword/searchVector currently
      // ignore this; the project scope is enforced post-query below. Kept on opts so the
      // future in-DB filter (see MEMORY-FAILURE-STATES §F2) can pick it up without an API change.

    // -- Optional overfetch when scoping by project (flagged, default OFF) ----------
    // The project_id filter runs AFTER searchHybrid returns its top-N, so a relevant
    // memory ranked just below N is silently dropped → a false-zero result set. Widening
    // the candidate pool before the filter materially reduces that. Flagged because it
    // widens the scan; OFF = bit-exact with the prior behavior. (§F2)
    var overfetch = false;
    try {
      overfetch = db.getConfig('search_project_overfetch') === 'true' && !!project_id;
    } catch (e) { /* config read is best-effort */ }
    if (overfetch) opts.limit = Math.min(limit * 5, 100);

    // -- Retrieval ------------------------------------------------------------------
    var results;
    var effectiveMode = requestedMode;
    var embedFailReason = null; // null = no degradation; a string = why hybrid dropped to keyword

    if (requestedMode === 'keyword') {
      results = db.searchKeyword(query, opts);
    } else {
      var queryEmbedding = null;
      try {
        var config = db.getAllConfig();
        var providerConfigured = !!(config.embedding_provider && config.embedding_provider !== 'none');
        if (providerConfigured) {
          // priority 'high': the query embed jumps the bulk embed backlog
          // (embedLanes in embeddings.js) instead of waiting behind it —
          // recall-while-ingesting is an L0 property (2026-09-09 jetson01
          // incident: searches waited >30 s behind a bulk backfill).
          queryEmbedding = await generateEmbedding(config, query, { priority: 'high' });
          if (!queryEmbedding) {
            // drone provider returns null (the vector arrives async), or an unknown
            // provider fell through — either way the query has no vector to rank with.
            embedFailReason = 'embedding provider returned no vector (async-drone, unknown provider, or empty response)';
          }
        } else {
          embedFailReason = 'no embedding provider configured (embedding_provider = ' + (config.embedding_provider || 'none') + ')';
        }
      } catch (e) {
        embedFailReason = e.message;
        console.error('[semantic-memory] Query embedding failed, falling back to keyword:', e.message);
      }

      if (queryEmbedding) {
        results = await db.searchHybrid(query, opts, queryEmbedding); // 196: may wait on an in-flight cache build
        effectiveMode = 'hybrid';
      } else {
        // Silent-degradation guard (house rule: no silent failures). Previously this
        // returned mode:'hybrid' over keyword-only results — the caller had no signal
        // that vector search never ran, and would answer confidently from a thinner
        // recall. Now effectiveMode reports the truth and `degraded` explains it. The
        // RESULT SET is unchanged; only the honesty changes. (§F1, §F3)
        results = await db.searchHybrid(query, opts, null);
        effectiveMode = 'keyword-fallback';
      }
    }

    // -- Post-filter by project_id (metadata-level) --------------------------------
    // NOTE: applied AFTER the limit, so it can produce false-zeros when relevant
    // memories rank below the cutoff. We surface that (project_filter) instead of
    // guessing; the overfetch flag above is the optional correctness fix. (§F2)
    var unfilteredCount = results.length;
    var projectCulled = false;
    if (project_id) {
      results = results.filter(function (r) {
        return r.metadata && r.metadata.project_id === project_id;
      });
      projectCulled = results.length < unfilteredCount;
    }

    // Strip raw vectors from the response — 768 floats per result is pure
    // payload waste for every consumer (scores already carry the signal).
    // task 213: the per-row `embedded` stamp survives the strip — every result
    // states whether its own vector exists (db.js stampEmbedded). A producer
    // that could not know (legacy shape, no stamp at all) leaves as null —
    // never a guessed true.
    results = results.map(function (r) {
      var { embedding: _embedding, ...rest } = r; // vector deliberately dropped
      if (rest.embedded === undefined) rest.embedded = null;
      return rest;
    });
    if (overfetch) results = results.slice(0, limit); // collapse the overfetch back to the requested page

    // -- Response: honest mode + degradation + project-filter + index health --------
    // Three mediocre hits from a 40%-covered index with the embedding backend down
    // are NOT the same signal as three hits from a healthy 100%-covered index. Surface
    // the difference instead of letting the caller answer from a gap. Mirrors the
    // auto-memory/stats extraction_errors convention. (§F1–F3)
    var response = { results: results, mode: effectiveMode, query: query, count: results.length };
    if (effectiveMode !== requestedMode) response.requested_mode = requestedMode;
    if (effectiveMode === 'keyword-fallback') {
      response.degraded = {
        reason: embedFailReason,
        fell_back_to: 'keyword',
        note: 'vector search unavailable; results are lexical (FTS5/LIKE) only'
      };
    }
    if (project_id && projectCulled) {
      response.project_filter = {
        project_id: project_id,
        results_before_filter: unfilteredCount,
        results_after_filter: results.length,
        hint: results.length === 0
          ? 'all top candidates matched a different/no project scope — relevant memories likely exist but were filtered out; retry without project_id to confirm'
          : 'some top candidates matched a different/no project scope and were dropped'
      };
    }
    try {
      var health = db.indexHealth();
      response.index = {
        total: health.total,
        embedded: health.embedded,
        coverage_pct: health.coverage_pct,
        vector_scan_capped: health.vector_scan_capped
      };
    } catch (e) { /* index health is best-effort; never block a search on it */ }
    res.json(response);
  }));

  // -- Lessons & verdicts: the provenance gate (2026-09-10, F-mycelium/186) ------
  // BRIEF-lab-alive-memory-program §1, first gate: "A lesson row without
  // provenance (actor, date, evidence) is refused at the route." A LESSON is a
  // memory row written by the HARNESS (workflow verdicts, lane DONEs, lab_check
  // state changes, director decisions) — source_type 'lesson' through the SAME
  // /memory/index path as every other row, so it embeds and searches like
  // everything else. Verdict rows (source_type 'verdict', the /memory/history
  // view; the writer lands in K-kira's task) carry the identical gate: a
  // verdict without provenance is the same failure. The 400 NAMES the missing
  // field(s) so the harness writer's first red run says what to fix.
  function refuseIfUnprovenanced(sourceType, metadata, res, label) {
    if (db.EPISODE_SOURCE_TYPES[sourceType]) {
      var missingEpisode = db.missingEpisodeFields(metadata);
      if (missingEpisode.length === 0) return false;
      apiError(res, 400, (label ? label + ': ' : '') + "source_type '" + sourceType +
        "' requires episode provenance metadata — missing: " + missingEpisode.join(', '));
      return true;
    }
    if (!db.LESSON_SOURCE_TYPES[sourceType]) return false;
    var missing = db.missingProvenanceFields(metadata);
    if (missing.length === 0) return false;
    apiError(res, 400, (label ? label + ': ' : '') + "source_type '" + sourceType +
      "' requires provenance metadata — missing: " + missing.join(', '));
    return true;
  }

  // A query param that is present-and-meaningful, else null — an empty `repo=`
  // is "no filter", not a repo named "".
  function nonEmptyQuery(v) {
    return (typeof v === 'string' && v.trim().length > 0) ? v.trim() : null;
  }

  // Embed only what lacks a vector (task 227): the row-state check, not the
  // caller's churn, decides. An unchanged doc keeps its stored embedding, so
  // a half-hourly re-post costs the embedder nothing — the same churn the
  // bulk route's `!r.unchanged` filter stops, at the single-doc seam.
  // `row` is an optional pre-read (the chunked path already has it); a row
  // that cannot be read back fails soft — the drains key on embedding IS NULL
  // and will find it.
  function autoEmbedUnembedded(sourceType, sourceId, chunkIndex, row) {
    row = row || db.getDoc(sourceType, sourceId, chunkIndex);
    if (!row || row.embedding != null) return;
    autoEmbed(sourceType, sourceId, row.content_text, chunkIndex);
  }

  // POST /memory/index — index content
  //
  // Chunk-count bound (task 240, alert #279 — js/loop-bound-injection): the
  // chunked path below loops once per chunk of caller-supplied content, so the
  // bound is made explicit and enforced BEFORE any write. The arithmetic:
  // express.json caps /memory bodies at 16 MB = 16,777,216 bytes (worst case
  // 1-byte chars); chunkText never emits a chunk smaller than half the chunk
  // size (its minCut floor), so at the DEFAULT_CHUNK_SIZE of 4000 the smallest
  // possible chunk is ~2000 chars and a 16 MB body cannot exceed
  // ceil(16777216 / 2000) = 8389 chunks. The constant also bounds the
  // operator-tunable chunk_size config (floor 200), where the body cap alone
  // would allow ~168k rows; a doc with more than 8389 embedding rows is
  // operationally absurd, so it is refused at a named constant rather than
  // discovered at loop time.
  var MAX_CHUNKS_PER_DOC = 8389;

  router.post('/index', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { source_type, source_id, content_text, namespace, metadata, chunk_index } = req.body;
    if (!source_type || !source_id || !content_text) {
      return apiError(res, 400, 'source_type, source_id, and content_text are required');
    }
    if (refuseCompanionScoped(source_type, namespace, res)) return;
    if (refuseIfUnprovenanced(source_type, metadata, res)) return;
    var chunkCount = 1;
    if (chunk_index) {
      // Explicit chunk_index = caller-managed chunking — store the row as-is
      db.index(source_type, source_id, content_text, {
        namespace: namespace,
        chunk_index: chunk_index,
        metadata: metadata
      });
      autoEmbedUnembedded(source_type, source_id, chunk_index);
    } else {
      // Enforce the chunk bound BEFORE writing: chunkText is pure slicing, so
      // a cheap preview count refuses an over-bound doc without touching the
      // index (413 names the field that caused it).
      var chunkPreview = chunkText(String(content_text), db.getChunkSize());
      if (chunkPreview.length > MAX_CHUNKS_PER_DOC) {
        return apiError(res, 413, 'content_text exceeds MAX_CHUNKS_PER_DOC (' + MAX_CHUNKS_PER_DOC +
          ' chunks at chunk_size ' + db.getChunkSize() + '); raise chunk_size or split the doc');
      }
      // Chunk-aware: oversized content splits into chunk rows, and stale
      // chunks from a previous (larger) version of the doc are removed
      var chunks = db.indexDoc(source_type, source_id, content_text, {
        namespace: namespace,
        metadata: metadata
      });
      chunkCount = chunks.length;
      // getDocChunks is chunk_index-ordered and indexDoc leaves exactly
      // 0..N-1 in place, so the rows align with the chunk texts.
      var stored = db.getDocChunks(source_type, source_id);
      for (var ci = 0; ci < chunks.length; ci++) {
        autoEmbedUnembedded(source_type, source_id, ci, stored[ci]);
      }
    }
    core.emitEvent('memory_indexed', who, null,
      who + ' indexed ' + source_type + ':' + source_id, { source_type: source_type, source_id: source_id });
    res.json({ ok: true, source_type: source_type, source_id: source_id, chunks: chunkCount });
  });

  // POST /memory/index/bulk — bulk index
  router.post('/index/bulk', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) return apiError(res, 400, 'items array is required');
    if (items.length > 100) return apiError(res, 400, 'Max 100 items per bulk request');

    // Validate
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.source_type || !item.source_id || !item.content_text) {
        return apiError(res, 400, 'Each item needs source_type, source_id, and content_text');
      }
      if (refuseCompanionScoped(item.source_type, item.namespace, res)) return;
      if (refuseIfUnprovenanced(item.source_type, item.metadata, res, 'items[' + i + ']')) return;
    }

    // bulkIndex is chunk-aware — oversized items split into chunk rows;
    // it returns the rows actually written so each one embeds separately.
    var rows = db.bulkIndex(items);

    // Fire-and-forget embed for rows that didn't bring their own embedding —
    // EXCEPT unchanged rows (task 227): a byte-identical re-index kept its
    // stored vector (or, never-embedded, belongs to the boot drain / fastpath,
    // which key on embedding IS NULL), so re-embedding it is the churn that
    // wedged the Jetson on 2026-09-18. generateEmbeddingBatch is sequential
    // for ollama, so this won't stampede.
    var toEmbed = rows.filter(function (r) { return !r.embedding && !r.unchanged; });
    if (toEmbed.length > 0) {
      var config = db.getAllConfig();
      if (config.embedding_provider && config.embedding_provider !== 'none') {
        generateEmbeddingBatch(config, toEmbed.map(function (r) { return r.content_text; }), {
          db: core.db,
          items: toEmbed.map(function (r) {
            return { source_type: r.source_type, source_id: r.source_id, chunk_index: r.chunk_index || 0 };
          })
        }).then(function (embeddings) {
          for (var i = 0; i < toEmbed.length; i++) {
            if (embeddings[i]) {
              db.updateEmbedding(toEmbed[i].source_type, toEmbed[i].source_id, toEmbed[i].chunk_index || 0, embeddings[i], config.embedding_model || config.embedding_provider);
            }
          }
        }).catch(function (e) {
          console.error('[semantic-memory] bulk auto-embed failed:', e.message);
        });
      }
    }

    res.json({
      ok: true,
      indexed: items.length,
      rows: rows.length,
      unchanged: rows.unchangedCount || 0
    });
  });

  // DELETE /memory/index/:sourceType/:sourceId — remove from index
  router.delete('/index/:sourceType/:sourceId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (refuseCompanionScoped(req.params.sourceType, null, res)) return;
    db.remove(req.params.sourceType, req.params.sourceId);
    res.json({ ok: true });
  });

  // DELETE /memory/index?source_type=<t>[&namespace=<n>] — admin bulk purge by
  // exact filter. A finished benchmark run cleans up after itself here: task
  // 163's Mycelium arm left 3,104 bench_longmemeval rows in the one index live
  // recall reads from, and the per-row DELETE above is not a cleanup story at
  // that scale. Admin key / admin studio JWT only (checkAdmin — an agent key
  // must never be able to bulk-wipe memory), refuses without at least one
  // exact filter (a bare DELETE would take the whole index), and writes one
  // attributable log line. Bench rows are invisible to unfiltered search (see
  // db.js) but invisibility is not deletion — this is how they actually leave.
  // Filter values must be non-empty strings: a malformed value 400s rather
  // than being silently dropped from the WHERE (that would purge by the
  // remaining filter and delete rows the caller never named).
  router.delete('/index', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    function filterArg(v) {
      if (v === undefined) return null;          // not supplied
      if (typeof v !== 'string' || v.length === 0) return undefined; // malformed
      return v;
    }
    var sourceType = filterArg(req.query.source_type);
    var namespace = filterArg(req.query.namespace);
    if (sourceType === undefined || namespace === undefined) {
      return apiError(res, 400, 'source_type and namespace must be non-empty strings');
    }
    if (!sourceType && !namespace) {
      return apiError(res, 400, 'refusing unfiltered purge — pass source_type and/or namespace');
    }
    var deleted = db.purge({ source_type: sourceType, namespace: namespace });
    console.log('[semantic-memory] purge: deleted ' + deleted + ' rows (source_type=' +
      (sourceType || '-') + ', namespace=' + (namespace || '-') + ') by ' + getAdminDisplayName(req));
    res.json({ ok: true, deleted: deleted, source_type: sourceType, namespace: namespace });
  });

  // ======== THE COMPANION MEMORY API (docs/companion-memory-api.md) ===========
  // Mycelium's first CONSUMER memory surface — built for the companion app
  // (the character Qurio): a phone that reads/writes ONE person's memory over
  // the network with a per-user token, offline-first, where PERSONA IS MEMORY
  // (rows of kind aboutYou / aboutMe / howWeTalk, keyed, newer supersedes
  // older). The agent-shaped /memory/* routes above are UNTOUCHED — this is an
  // additive owner-scoped surface over the SAME store + embedder: rows are
  // source_type 'companion' in one namespace per owner, so the existing
  // hybrid search reaches them unmodified.
  //
  // AUTH (the contract's hard line): a studio JWT minted by POST /studio/login
  // ONLY. Admin keys are REFUSED here — no admin key on a phone, ever — and
  // the owner scope is derived from the verified token payload on every call;
  // no header, query param, or body field can widen it. getStudioUser arrives
  // via pluginCore (the same decoder /studio/me uses); a core without it
  // fails CLOSED (every call 401s rather than guessing an owner).
  var getStudioUser = (core.auth && core.auth.getStudioUser) || function () { return null; };

  var COMPANION_SOURCE_TYPE = 'companion';
  var COMPANION_KINDS = ['aboutYou', 'aboutMe', 'howWeTalk'];
  var COMPANION_TEXT_MAX = 2000;
  // Keep in sync with db.js's COMPANION_NS_PREFIX — both must name the same
  // private row class or the db-layer search exclusion and these route guards
  // disagree about what is private.
  var COMPANION_NS_PREFIX = 'companion:';
  // One shared limiter — 60/min is the SURFACE budget for a phone, not a
  // per-route allowance (four separate buckets would quietly make it 240).
  var companionLimiter = rateLimited('memory/companion', { windowMs: 60000, max: 60 });

  function companionNamespace(userId) {
    return 'companion:u' + userId;
  }

  // Deterministic row id — the idempotency key is (owner, key, text), so an
  // offline client can replay its outbox forever: same three → same id → the
  // write path finds the row and answers without writing.
  function companionRowId(userId, key, text) {
    // Components are LENGTH-PREFIXED, not just \0-joined (review A r2 NIT 4):
    // a JSON body can carry U+0000, and a bare \0 join is ambiguous — key
    // 'a\0b' with text 'c' would hash the same as key 'a' with text 'b\0c'.
    var k = key || '';
    function comp(s) { return s.length + ':' + s; }
    return crypto.createHash('sha256')
      .update('companion\u0000' + userId + '\u0000' + comp(k) + '\u0000' + comp(text))
      .digest('hex');
  }

  // The row in the shape the doc's "Rows" table promises. Internal columns
  // (the embedding vector, chunk bookkeeping, raw metadata JSON) never leave.
  // metadata arrives as a string from a direct read and ALREADY PARSED from
  // the search arms — handle both.
  function companionView(row, opts) {
    var meta = row.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta || '{}'); } catch (e) { meta = {}; }
    }
    if (!meta || typeof meta !== 'object') meta = {};
    var view = {
      id: row.source_id,
      kind: meta.kind || null,
      key: meta.key || null,
      text: row.content_text,
      source: meta.source || null,
      at: meta.at || null,
      created_at: row.created_at,
      superseded_by: row.superseded_by || null,
      supersedes: meta.supersedes || null
    };
    if (opts && opts.score !== undefined) view.score = opts.score;
    // task 213's honest-embeddedness stamp, carried through from the search
    // arms: a keyword-ranked row with embedded:false must not masquerade as a
    // semantic hit. List reads have no stamp and omit the field.
    if (opts && opts.embedded !== undefined) view.embedded = opts.embedded;
    return view;
  }

  // The whole surface authenticates the same way: verify the bearer, derive
  // the owner, or refuse. Admin keys and agent keys never authenticate here.
  function companionOwner(req, res) {
    var user = getStudioUser(req);
    if (!user || !user.userId) {
      apiError(res, 401, 'a studio bearer token is required — log in via POST /api/mycelium/studio/login; this surface never accepts admin keys');
      return null;
    }
    return user;
  }

  function companionKindOr400(res, kind) {
    if (COMPANION_KINDS.indexOf(kind) !== -1) return true;
    apiError(res, 400, 'kind must be one of: ' + COMPANION_KINDS.join(', '));
    return false;
  }

  // Companion rows are PER-USER PRIVATE (docs/companion-memory-api.md): the
  // agent-facing surface never reads, lists, writes, or deletes them. The db
  // layer's COMPANION_HIDDEN_SQL hides them from every search arm; this guard
  // covers the rest of this router (list / index write / index delete). 403,
  // always naming why — a silent empty result would be a silent failure.
  // (Review A finding 1: before this guard an agent key could read, rewrite
  // the record of, and delete a person's companion memory.)
  function refuseCompanionScoped(sourceType, namespace, res) {
    if (sourceType === COMPANION_SOURCE_TYPE ||
        (typeof namespace === 'string' && namespace.indexOf(COMPANION_NS_PREFIX) === 0)) {
      apiError(res, 403, "'" + (sourceType || namespace) + "' is companion-private memory — agent keys cannot read, write, or delete it; the companion surface (/me/memory) manages its own rows");
      return true;
    }
    return false;
  }

  // POST /me/memory — write one memory. Idempotent by (owner, key, text): the
  // row id is a digest of exactly those three, so replaying an offline outbox
  // returns the SAME row ("replayed": true) and writes nothing — a replay
  // never resurrects a superseded row and never double-fires a supersede.
  // supersedes marks the old row in the SAME transaction that writes the new
  // one (a supersede is both rows or neither — the lessons-supersede rule).
  router.post('/me/memory', companionLimiter, function (req, res) {
    var user = companionOwner(req, res);
    if (!user) return;
    var body = req.body || {};
    function str(v) { return typeof v === 'string' ? v.trim() : ''; }
    var text = str(body.text);
    var source = str(body.source);
    var at = str(body.at);
    var kind = str(body.kind);
    var key = str(body.key);
    var supersedes = str(body.supersedes);

    if (!text) return apiError(res, 400, "text is required — the fact, in the companion's own words");
    if (text.length > COMPANION_TEXT_MAX) {
      return apiError(res, 400, 'text exceeds ' + COMPANION_TEXT_MAX + ' chars — a memory is a fact, not a document');
    }
    if (!source) return apiError(res, 400, 'source is required — where the fact came from (chat, trick, game, ...)');
    if (source.length > 64) return apiError(res, 400, 'source exceeds 64 chars');
    if (!at) return apiError(res, 400, 'at is required — when the fact was learned (ISO-8601)');
    // r3 NIT 5: any timestamp Date.parse takes, a 64-char cap bounds. It
    // refuses pathological junk before the parse, not after it.
    if (at.length > 64) return apiError(res, 400, 'at exceeds 64 chars');
    if (isNaN(Date.parse(at))) return apiError(res, 400, "at must be an ISO-8601 timestamp; got: '" + at + "'");
    if (!kind) return apiError(res, 400, 'kind is required — one of: ' + COMPANION_KINDS.join(', '));
    if (!companionKindOr400(res, kind)) return;
    if (key.length > 128) return apiError(res, 400, 'key exceeds 128 chars');
    if (supersedes.length > 128) return apiError(res, 400, 'supersedes exceeds 128 chars');

    var namespace = companionNamespace(user.userId);
    var id = companionRowId(user.userId, key, text);

    // A pure body-vs-identity check, so it fires even when the row already
    // exists: a retry that adds supersedes pointing at its own target is a
    // client bug, not a replay.
    if (supersedes && supersedes === id) {
      return apiError(res, 400, "supersedes names the row this write would create ('" + id + "') — a memory cannot replace itself");
    }

    var existing = db.companionRow(id);
    if (existing) {
      // As it is NOW — live, superseded, or the product of an earlier replay.
      return res.status(200).json({ ok: true, replayed: true, row: companionView(existing) });
    }

    var meta = { owner: user.userId, username: user.username || null, kind: kind, source: source, at: at };
    if (key) meta.key = key;
    if (supersedes) meta.supersedes = supersedes;

    if (supersedes) {
      var oldRow = db.companionRow(supersedes);
      if (!oldRow || (oldRow.namespace || '') !== namespace) {
        // Unknown AND another owner's row are the same 404 — ids are not an
        // existence oracle across owners.
        return apiError(res, 404, "supersedes names no memory of yours: '" + supersedes + "'");
      }
      var oldMeta;
      try { oldMeta = JSON.parse(oldRow.metadata || '{}'); } catch (e) { oldMeta = {}; }
      var alreadyDead = oldRow.superseded_by || oldMeta.superseded_by;
      if (alreadyDead) {
        return apiError(res, 409, "supersede refused: '" + supersedes + "' was already superseded — correct the replacement, not the history", { superseded_by: alreadyDead });
      }
      var writeBoth = core.db.transaction(function () {
        db.index(COMPANION_SOURCE_TYPE, id, text, { namespace: namespace, metadata: meta });
        db.companionMarkSuperseded(supersedes, id);
      });
      writeBoth();
    } else {
      db.index(COMPANION_SOURCE_TYPE, id, text, { namespace: namespace, metadata: meta });
    }

    // Embed like every other row (fire-and-forget; no-op without a provider).
    autoEmbedUnembedded(COMPANION_SOURCE_TYPE, id, 0);

    res.status(201).json({ ok: true, replayed: false, row: companionView(db.companionRow(id)) });
  });

  // GET /me/memory?kind=&since=&limit= — list / sync. Superseded rows are
  // INCLUDED and carry superseded_by: history is marked, never hidden — the
  // client renders the live row and "you used to say X, now Y" from the same
  // page. `since` is the sync cursor (rows stored after it, store clock).
  router.get('/me/memory', companionLimiter, function (req, res) {
    var user = companionOwner(req, res);
    if (!user) return;
    var kind = nonEmptyQuery(req.query.kind);
    if (kind && !companionKindOr400(res, kind)) return;
    var since = nonEmptyQuery(req.query.since);
    if (since) {
      // The store clock's format (`YYYY-MM-DD HH:MM:SS`, UTC) passes through
      // VERBATIM (review A finding 2): Date.parse reads that shape as
      // HOST-LOCAL time, so normalizing it shifted the cursor by the host's
      // UTC offset — and east of UTC that SKIPS a window of memories forever
      // while the client believes sync is complete. Offset-LESS ISO
      // (`2026-09-21T20:00:00`) hits the same Date.parse trap, so it is read
      // deliberately as UTC (review A r2 finding 3) — the store clock's own
      // frame. Anything else goes through Date.parse and lands on the store
      // format; the store-format shape itself is date-checked so a garbage
      // cursor 400s instead of reading as "sync complete" (r2 finding 6).
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since)) {
        if (isNaN(Date.parse(since.replace(' ', 'T') + 'Z'))) {
          return apiError(res, 400, "since is not a real timestamp: '" + since + "'");
        }
      } else {
        // ANY offset-less date-time (not just exact seconds — r3 MINOR 4:
        // `2026-09-21T20:00:00.500` hit the same host-local trap one grammar
        // production over) is read as UTC, the store clock's frame.
        if (/[T ]\d{2}:\d{2}/.test(since) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(since)) since += 'Z';
        var t = Date.parse(since);
        if (isNaN(t)) {
          return apiError(res, 400, "since must be a created_at exactly as this API returned it (YYYY-MM-DD HH:MM:SS) or an ISO-8601 timestamp; got: '" + since + "'");
        }
        since = new Date(t).toISOString().replace('T', ' ').slice(0, 19);
      }
    }
    // Non-positive / garbage limits fall back to the default (review A
    // finding 5: `LIMIT -1` in SQLite means UNBOUNDED — a negative limit must
    // never remove the cap).
    var qLimit = parseIntParam(req.query.limit);
    var limit = qLimit && qLimit > 0 ? Math.min(qLimit, 500) : 100;
    var rows = db.companionList({
      namespace: companionNamespace(user.userId),
      kind: kind,
      since: since,
      limit: limit
    });
    res.json({
      results: rows.map(function (r) { return companionView(r); }),
      count: rows.length
    });
  });

  // POST /me/memory/search — recall by meaning through the SAME hybrid layer
  // /search uses, scoped to the owner in the query itself (source_types +
  // namespace both narrow in SQL; the metadata owner check below is belt and
  // braces). Superseded rows are excluded unless ?include_superseded=1 — the
  // companion should not recall what was corrected. The overfetch-then-filter
  // order is the §F2 rule /lessons documents: the caller's limit is spent on
  // rows that survive, and a filter that culled says what it did.
  router.post('/me/memory/search', companionLimiter, asyncHandler(async function (req, res) {
    var user = companionOwner(req, res);
    if (!user) return;
    var body = req.body || {};
    var query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return apiError(res, 400, 'query is required');
    var kinds = null;
    if (body.kinds !== undefined) {
      if (!Array.isArray(body.kinds) || body.kinds.length === 0) {
        return apiError(res, 400, 'kinds, when present, must be a non-empty array drawn from: ' + COMPANION_KINDS.join(', '));
      }
      for (var ki = 0; ki < body.kinds.length; ki++) {
        if (COMPANION_KINDS.indexOf(body.kinds[ki]) === -1) {
          return apiError(res, 400, 'kinds must be a subset of: ' + COMPANION_KINDS.join(', '));
        }
      }
      kinds = body.kinds;
    }
    var bLimit = parseIntParam(body.limit); // same floor rule as GET /me/memory
    var limit = bLimit && bLimit > 0 ? Math.min(bLimit, 50) : 5;
    var includeSuperseded = req.query.include_superseded === '1' || req.query.include_superseded === 'true';

    var opts = {
      limit: Math.min(limit * 5, 100),
      source_types: [COMPANION_SOURCE_TYPE],
      namespace: companionNamespace(user.userId),
      // The one legitimate carrier of this flag: route code, not request
      // input. Without it the db layer's COMPANION_HIDDEN_SQL would exclude
      // the very rows this route exists to search.
      companion_ok: true
    };

    var embedFailReason = null;
    var queryEmbedding = null;
    try {
      var config = db.getAllConfig();
      if (config.embedding_provider && config.embedding_provider !== 'none') {
        queryEmbedding = await generateEmbedding(config, query, { priority: 'high' });
        if (!queryEmbedding) {
          embedFailReason = 'embedding provider returned no vector (async-drone, unknown provider, or empty response)';
        }
      } else {
        embedFailReason = 'no embedding provider configured (embedding_provider = ' + (config.embedding_provider || 'none') + ')';
      }
    } catch (e) {
      embedFailReason = e.message;
      console.error('[semantic-memory] companion query embedding failed, falling back to keyword:', e.message);
    }

    var results = await db.searchHybrid(query, opts, queryEmbedding); // 196: may wait on an in-flight cache build
    var beforeFilter = results.length;
    results = results.filter(function (r) {
      var meta = r.metadata || {};
      if (meta.owner !== user.userId) return false;
      if (kinds && kinds.indexOf(meta.kind) === -1) return false;
      if (!includeSuperseded && r.superseded_by) return false;
      return true;
    });
    var afterFilter = results.length; // measured BEFORE the page slice (review A r2 NIT 7): slicing is the caller's own limit at work, not a filter cull — attributing it to the filter lies about the corpus
    var response = {
      results: results.map(function (r) { return companionView(r, { score: r.score, embedded: r.embedded }); }).slice(0, limit),
      query: query,
      mode: queryEmbedding ? 'hybrid' : 'keyword-fallback',
      count: 0
    };
    response.count = response.results.length;
    if (embedFailReason) {
      response.degraded = {
        reason: embedFailReason,
        fell_back_to: 'keyword',
        note: 'vector search unavailable; results are lexical (FTS5/LIKE) only'
      };
    }
    if (beforeFilter > afterFilter) {
      response.filter = { results_before_filter: beforeFilter, results_after_filter: afterFilter };
    }
    res.json(response);
  }));

  // POST /me/memory/:id/forget — a hard delete: the row leaves the store, the
  // search index, and the vector set (db.remove drives both). Another owner's
  // id 404s exactly like an unknown id — ids are not an existence oracle
  // across owners. Supersede, not forget, is how a correction works.
  router.post('/me/memory/:id/forget', companionLimiter, function (req, res) {
    var user = companionOwner(req, res);
    if (!user) return;
    var id = String(req.params.id || '');
    var row = db.companionRow(id);
    if (!row || (row.namespace || '') !== companionNamespace(user.userId)) {
      return apiError(res, 404, "no such memory: '" + id + "'");
    }
    // Un-mark first (review A r3 MINOR 3): if the forgotten row was itself a
    // replacement, the row it superseded returns to recall instead of being
    // entombed behind a pointer to a row that no longer exists.
    // One transaction (review A r4 MINOR 1): a supersede is both rows or
    // neither, and a forget that un-marks is no different — half-done, it
    // leaves the corrected fact AND its correction both recallable.
    var forgetAll = core.db.transaction(function () {
      db.companionClearSupersededBy(id);
      db.remove(COMPANION_SOURCE_TYPE, id);
    });
    forgetAll();
    res.json({ ok: true, forgotten: id });
  });

  // GET /memory/stats — index stats
  // GET /memory/list?source_type=preference&namespace=&limit= — query-free
  // retrieval by type, newest first. For always-on content the model must see
  // every turn (standing preferences), where query-ranked /search is wrong.
  router.get('/list', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var sourceType = req.query.source_type;
    if (!sourceType || typeof sourceType !== 'string') {
      return apiError(res, 400, 'source_type is required');
    }
    if (refuseCompanionScoped(sourceType, req.query.namespace, res)) return;
    var rows = db.listByType(sourceType, {
      namespace: req.query.namespace || null,
      limit: req.query.limit
    });
    res.json({ results: rows, source_type: sourceType, count: rows.length });
  });

  // GET /memory/episodes?agent=&session_date=&namespace=&limit= — the §3 read
  // side (2026-09-18, F-mycelium/218): the dated enumeration of EPISODE rows —
  // "the indexed episodes of one agent/day". The reconcile dry-run reads this
  // to extract candidate facts; every reconciled fact cites an episode by
  // agent + session_date + session_id, so this is the pointer's other end.
  // Newest first by the episode's own session_date. (Meaning recall over
  // episodes needs no new route — POST /search with source_types:['episode']
  // already reaches them; this route exists because "all of Tuesday" is a
  // filter, not a query.)
  router.get('/episodes', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var rows = db.listEpisodes({
      agent: nonEmptyQuery(req.query.agent),
      session_date: nonEmptyQuery(req.query.session_date),
      namespace: nonEmptyQuery(req.query.namespace),
      limit: Math.min(parseInt(req.query.limit) || 20, 500)
    });
    res.json({
      source_type: 'episode', count: rows.length, results: rows,
      filters: { agent: nonEmptyQuery(req.query.agent), session_date: nonEmptyQuery(req.query.session_date) }
    });
  });

  // GET /memory/lessons?task_class=&repo=&since=&limit=[&q=] — the §2 read side
  // (2026-09-10, F-mycelium/186): lessons by class + repo, NEWEST first, with
  // their dates and provenance, so a brief can carry "last Tuesday this exact
  // shape failed because…". q= switches to semantic recall restricted to
  // lessons — the same searchHybrid /search uses, with source_types=['lesson']
  // (keyword arm when no embedder is configured; the response reports its mode
  // honestly, same contract as /search — a recall block must never answer from
  // a silently degraded query). q= relevance-ranks; the plain listing date-ranks.
  // 237: SUPERSEDED rows are excluded from the default block (both arms) — a
  // corrected lesson stops teaching the moment its correction lands;
  // ?include_superseded=1 reads them back with their supersede line and
  // provenance (history kept, never erased — the §3 rule).
  router.get('/lessons', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      task_class: nonEmptyQuery(req.query.task_class),
      repo: nonEmptyQuery(req.query.repo),
      since: nonEmptyQuery(req.query.since)
    };
    var includeSuperseded = req.query.include_superseded === '1' || req.query.include_superseded === 'true';
    var limit = Math.min(parseInt(req.query.limit) || 20, 100);
    if (filters.since && !/^\d{4}-\d{2}-\d{2}/.test(filters.since)) {
      return apiError(res, 400, "since must be an ISO date (YYYY-MM-DD); got: '" + filters.since + "'");
    }

    if (!req.query.q) {
      var rows = db.listLessons(Object.assign({}, filters, { limit: limit, include_superseded: includeSuperseded }));
      return res.json({
        source_type: 'lesson', count: rows.length, results: rows,
        filters: { task_class: filters.task_class, repo: filters.repo, since: filters.since },
        include_superseded: includeSuperseded
      });
    }

    // Semantic arm: overfetch ×5 (cap 100) before the metadata post-filter so a
    // lesson ranked just below the page can't be silently dropped by its own
    // filter (the §F2 false-zero hazard /search documents) — then report what
    // the filter did.
    var searchLimit = Math.min(limit * 5, 100);
    var opts = { limit: searchLimit, source_types: ['lesson'] };
    var embedFailReason = null;
    var effectiveMode = 'hybrid';
    var embedPromise = (function () {
      var config = db.getAllConfig();
      if (!config.embedding_provider || config.embedding_provider === 'none') {
        embedFailReason = 'no embedding provider configured (embedding_provider = ' + (config.embedding_provider || 'none') + ')';
        return Promise.resolve(null);
      }
      return generateEmbedding(config, String(req.query.q), { priority: 'high' })
        .then(function (vec) {
          if (!vec) embedFailReason = 'embedding provider returned no vector (async-drone, unknown provider, or empty response)';
          return vec;
        })
        .catch(function (e) {
          embedFailReason = e.message;
          return null;
        });
    })();
    embedPromise.then(async function (queryEmbedding) {
      if (queryEmbedding) effectiveMode = 'hybrid';
      else effectiveMode = 'keyword-fallback';
      var results = await db.searchHybrid(String(req.query.q), opts, queryEmbedding); // 196: may wait on an in-flight cache build
      var beforeFilter = results.length;
      results = results.filter(function (r) {
        var m = r.metadata || {};
        if (!includeSuperseded && m.superseded_by) return false; // 237: the dead version teaches no more
        if (filters.task_class && m.task_class !== filters.task_class) return false;
        if (filters.repo && m.repo !== filters.repo) return false;
        if (filters.since) {
          var ts = m.learned_at || r.created_at;
          if (!ts || String(ts) < filters.since) return false;
        }
        return true;
      });
      results = results.map(function (r) {
        var { embedding: _embedding, ...rest } = r; // vector deliberately dropped
        return rest;
      }).slice(0, limit);
      var response = {
        source_type: 'lesson', query: String(req.query.q), mode: effectiveMode,
        count: results.length, results: results,
        filters: { task_class: filters.task_class, repo: filters.repo, since: filters.since }
      };
      if (effectiveMode !== 'hybrid') {
        response.degraded = {
          reason: embedFailReason,
          fell_back_to: 'keyword',
          note: 'vector search unavailable; results are lexical (FTS5/LIKE) only'
        };
      }
      if (filters.task_class || filters.repo || filters.since) {
        response.filter = {
          results_before_filter: beforeFilter,
          results_after_filter: results.length
        };
      }
      res.json(response);
    }).catch(function (e) {
      apiError(res, 500, 'lesson recall failed: ' + e.message);
    });
  });

  // POST /memory/lessons/:id/supersede — a corrected lesson replaces this one
  // (2026-09-18, F-mycelium/237 — BRIEF-lab-alive-memory-program §1 refined
  // with §3's own semantics: a change SUPERSEDES rather than overwrites;
  // history is kept, never erased). Body: { by_text | by_id, reason, actor,
  // evidence, [learned_at], [new_source_id], [metadata] }.
  //
  // The hole this closes: lesson rows had NO supersede path (only am_facts
  // did), so a wrong or outdated lesson recalled FOREVER at full rank — the
  // exact failure THE DIRECTIVE names. The store's own incident (a chronicler
  // row banked a PLAN as a FACT; cured by hand with delete + supersede) is the
  // proof the lab needs the lever its facts already have.
  //
  // Effect — mirroring the am_facts route and the timeline arm's rendering:
  //   * the OLD row's metadata gains valid_to (now), superseded_by,
  //     superseded_by_text; its indexed CONTENT gains
  //     "[superseded on <date> by: <new lesson text>]" — a recall hit for the
  //     old lesson renders its own death, the same line the timeline arm renders;
  //   * by_text writes the NEW lesson row through the SAME index path, under
  //     the FULL 186 provenance contract — an under-provenanced correction is
  //     refused exactly like a first lesson;
  //   * NEVER a delete: the old row stays (excluded from the default /lessons
  //     block; ?include_superseded=1 reads it back).
  //
  // Refusals at the route, each naming the field: missing actor/evidence/reason
  // → 400; self-supersede (by_id === :id) → 400; neither/both of by_text|by_id
  // → 400; by_id naming no lesson → 400; unknown lesson → 404; already
  // superseded → 409 naming the existing pointer; a new_source_id that already
  // belongs to another lesson → 409 (never an overwrite). Both writes run in
  // one transaction — a supersede is both rows or neither.
  // Rate-limited (CodeQL js/missing-rate-limiting on PR #182): a correction is a
  // hand or lane action, never a machine loop — the 120/min floor.
  router.post('/lessons/:id/supersede',
    rateLimited('memory/lessons-supersede', { windowMs: 60000, max: 120 }),
    async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var oldId = String(req.params.id || '');
    var body = req.body || {};
    function str(v) { return typeof v === 'string' ? v.trim() : ''; }
    var reason = str(body.reason);
    var actor = str(body.actor);
    var evidence = str(body.evidence);
    var byText = str(body.by_text);
    var byId = str(body.by_id);

    if (!reason) return apiError(res, 400, "supersede refused: 'reason' is required — a correction states why the old lesson dies");
    if (!actor) return apiError(res, 400, "supersede refused: 'actor' is required — a correction is provenance like any lesson");
    if (!evidence) return apiError(res, 400, "supersede refused: 'evidence' is required — a correction cites what changed its mind");
    if (!byText && !byId) {
      return apiError(res, 400, "supersede refused: 'by_text' or 'by_id' is required — the correcting lesson either arrives as text or already exists as a row");
    }
    if (byText && byId) {
      return apiError(res, 400, "supersede refused: 'by_text' and 'by_id' are mutually exclusive — a correction is new text OR a pointer to an existing row, not both");
    }

    var oldRow = db.getDoc('lesson', oldId, 0);
    if (!oldRow) return apiError(res, 404, "supersede refused: no lesson row '" + oldId + "' (lessons are memory rows — source_type 'lesson', source_id '" + oldId + "' not found)");
    var oldMeta = {};
    try { oldMeta = JSON.parse(oldRow.metadata || '{}'); } catch (e) { oldMeta = {}; }
    if (oldMeta.superseded_by) {
      return apiError(res, 409, "supersede refused: lesson '" + oldId + "' was already superseded on " +
        (oldMeta.valid_to || '?') + " by '" + oldMeta.superseded_by +
        "' — supersede the replacement, not the history", {
        superseded_by: oldMeta.superseded_by,
        valid_to: oldMeta.valid_to || null
      });
    }
    if (byId && byId === oldId) {
      return apiError(res, 400, "supersede refused: 'by_id' equals the lesson being superseded ('" + oldId + "') — a lesson cannot replace itself");
    }

    var now = core.db.prepare("SELECT datetime('now') AS n").get().n; // the store's clock, same format am_facts' valid_to uses
    var newId, newText, newMeta;
    if (byId) {
      var succRow = db.getDoc('lesson', byId, 0);
      if (!succRow) return apiError(res, 400, "supersede refused: 'by_id' '" + byId + "' names no lesson row — write the correcting lesson first (or pass by_text)");
      newId = byId;
      newText = succRow.content_text;
      try { newMeta = JSON.parse(succRow.metadata || '{}'); } catch (e) { newMeta = {}; }
      // 241/F2 (review 239a): the successor must be LIVE. Pointing at an
      // already-superseded row landed the new pointer on hidden history, one
      // hop from the cure it names — the same rule the already-superseded-row
      // refusal above states, applied to the OTHER side of the edge.
      if (newMeta.superseded_by) {
        return apiError(res, 409, "supersede refused: 'by_id' '" + byId + "' was itself superseded on " +
          (newMeta.valid_to || '?') + " by '" + newMeta.superseded_by +
          "' — supersede by the replacement, not the history", {
          superseded_by: newMeta.superseded_by,
          valid_to: newMeta.valid_to || null
        });
      }
    } else {
      // The 186 gate runs on the ASSEMBLED new-row metadata — an
      // under-provenanced correction is refused exactly like a first lesson.
      newId = str(body.new_source_id) || (oldId + '-superseded-' + now.replace(/[^0-9]/g, ''));
      var metaPassthrough = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) ? body.metadata : {};
      newMeta = Object.assign({}, oldMeta, metaPassthrough, {
        actor: actor,
        // learned_at defaults to now only when the caller left it ABSENT — a
        // caller who PASSED an empty/whitespace one reaches the 186 gate and is
        // refused exactly like a first lesson (an empty value is never
        // silently rescued — the nonEmptyQuery convention).
        learned_at: (body.learned_at === undefined || body.learned_at === null) ? now : str(body.learned_at),
        evidence: evidence,
        reason: reason,
        supersedes: oldId
      });
      var missing = db.missingProvenanceFields(newMeta);
      if (missing.length > 0) {
        return apiError(res, 400, "supersede refused: source_type 'lesson' requires provenance metadata — missing: " + missing.join(', '));
      }
      if (db.getDoc('lesson', newId, 0)) {
        return apiError(res, 409, "supersede refused: 'new_source_id' '" + newId + "' already names a lesson — passing one would overwrite it; choose a fresh id");
      }
      newText = byText;
    }

    try {
      var writeBoth = core.db.transaction(function () {
        // The new row first (the old row is about to point at it) — through the
        // SAME index path POST /index uses, so it embeds and searches like
        // every other lesson. Then the old row re-indexed IN PLACE (same
        // source_type/source_id, so the upsert replaces its live text): its
        // content gains the dated supersede line, its metadata the pointer.
        if (byText) {
          var chunks = db.indexDoc('lesson', newId, newText, {
            namespace: oldRow.namespace || null,
            metadata: newMeta
          });
          var stored = db.getDocChunks('lesson', newId);
          for (var ci = 0; ci < chunks.length; ci++) {
            autoEmbedUnembedded('lesson', newId, ci, stored[ci]);
          }
        }
        // 241/F1 (review 239a): the flip goes through indexDoc, never a raw
        // chunk_index-0 db.index — indexDoc replaces the doc's chunk rows and
        // removes stale chunks 1..N in the SAME transaction. A multi-chunk
        // lesson left behind used to keep its later chunks at the ORIGINAL
        // content/metadata: searchHybrid fuses per-chunk, so the dead lesson
        // stayed recallable at full rank, unmarked.
        // The doc's content is the WHOLE doc: chunkText is lossless (chunks
        // join back to the text), and oldRow.content_text is only chunk 0's
        // slice — marking that slice alone would shrink the doc.
        var oldChunks = db.getDocChunks('lesson', oldId);
        var oldFullContent = oldChunks.map(function (c) { return c.content_text; }).join('');
        var deathLine = '\n\n[superseded on ' + now + ' by: ' + newText + ']';
        var supersededContent = oldFullContent + deathLine;
        var reindexedMeta = Object.assign({}, oldMeta, {
          valid_to: now,
          superseded_by: newId,
          superseded_by_text: newText
        });
        db.indexDoc('lesson', oldId, supersededContent, {
          namespace: oldRow.namespace || null,
          metadata: reindexedMeta
        });
        // The death line is a DOC-level stamp, but chunking may strand it in
        // the last slice — every surviving chunk that lacks it gains it (still
        // inside writeBoth), so a recall hit on ANY chunk renders the row's
        // own death. Then embed what is stored, never a stale copy.
        var storedChunks = db.getDocChunks('lesson', oldId);
        for (var si = 0; si < storedChunks.length; si++) {
          if (storedChunks[si].content_text.indexOf('[superseded on ') === -1) {
            db.index('lesson', oldId, storedChunks[si].content_text + deathLine, {
              namespace: storedChunks[si].namespace,
              chunk_index: storedChunks[si].chunk_index,
              metadata: reindexedMeta
            });
          }
          autoEmbedUnembedded('lesson', oldId, si, db.getDoc('lesson', oldId, si));
        }
      });
      writeBoth();
    } catch (e) {
      return apiError(res, 500, 'lesson supersede failed: ' + e.message);
    }

    core.emitEvent('memory_indexed', who, null,
      who + ' superseded lesson ' + oldId + ' -> ' + newId,
      { source_type: 'lesson', source_id: oldId, superseded_by: newId });

    res.json({
      ok: true,
      superseded: {
        source_id: oldId,
        valid_to: now,
        superseded_by: newId,
        superseded_by_text: newText,
        reason: reason
      },
      replacement: {
        source_id: newId,
        content_text: newText,
        metadata: newMeta
      }
    });
  });

  // GET /memory/history?repo=&task_class=&limit= — what happened LAST time on
  // this repo/class: prior verdict rows (source_type 'verdict'), newest first,
  // with provenance. The verdict WRITER lands in K-kira's task; the shape is
  // defined + accepted here: a verdict is a memory row with the same §1
  // metadata contract as a lesson (actor, learned_at, evidence required at the
  // route; task_class, repo, origin, outcome carrying the meaning).
  router.get('/history', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      task_class: nonEmptyQuery(req.query.task_class),
      repo: nonEmptyQuery(req.query.repo)
    };
    var limit = Math.min(parseInt(req.query.limit) || 20, 100);
    var rows = db.listHistory(Object.assign({}, filters, { limit: limit }));
    res.json({
      source_type: 'verdict', count: rows.length, results: rows,
      filters: { task_class: filters.task_class, repo: filters.repo }
    });
  });

  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.stats());
  });

  // GET /memory/coverage?namespace=<ns> — per-namespace embedding coverage
  // (task 214). The scoped shape the bench's embedding wait (and any recall
  // path that knows its own namespace) reads instead of the global number:
  // {namespace, rows, embedded, coverage_pct} — indexHealth()'s definitions,
  // scoped; superseded am_fact index rows count (searchable by design).
  // GET /memory/coverage with no namespace → the global indexHealth() shape,
  // the same block /memory/search stamps as `index`. Empty/whitespace
  // namespace is a 400 (nonEmptyQuery — "no namespace" is the absence of the
  // param, not a namespace named ""). Agent- OR admin-key readable: the lab's
  // recall paths read their own coverage with agent keys.
  router.get('/coverage', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    // "no namespace" is the ABSENCE of the param → the global shape. A param
    // that is present but empty/whitespace is a caller bug (the nonEmptyQuery
    // convention: an empty value is never silently "no filter") → 400.
    var raw = req.query.namespace;
    if (raw === undefined) return res.json(db.indexHealth());
    var ns = nonEmptyQuery(raw);
    if (!ns) return apiError(res, 400, 'namespace, when present, must be non-empty — an empty or whitespace namespace is not "the global index"');
    var h = db.namespaceHealth(ns);
    res.json({ namespace: ns, rows: h.rows, embedded: h.embedded, coverage_pct: h.coverage_pct });
  });

  // A drone returning a vector for an embed job authenticates with the same
  // agent key it claims work with (checkAgentOrAdmin falls through to that
  // check). Scope a non-admin (drone) write to an embed job THAT drone claimed,
  // so one agent can't poison another's embeddings. Returns true (allow) when
  // no drone has claimed the source (linkage N/A — a direct embed) or when
  // drone_jobs is absent (graceful: older installs / minimal fixtures).
  function droneOwnsEmbedJob(platformDb, droneId, sourceType, sourceId, chunkIndex) {
    try {
      var row = platformDb.prepare(
        "SELECT drone_id FROM drone_jobs WHERE job_type = 'embed' AND status = 'claimed' " +
        "AND json_extract(input_data, '$.source_type') = ? " +
        "AND json_extract(input_data, '$.source_id') = ? " +
        "AND CAST(json_extract(input_data, '$.chunk_index') AS INTEGER) = ? LIMIT 1"
      ).get(sourceType, String(sourceId), chunkIndex);
      if (!row) return true;            // no claim for this source → linkage N/A → allow
      return row.drone_id === droneId;  // scoped: only the owning drone
    } catch (e) {
      return true;                       // drone_jobs unavailable → graceful allow
    }
  }

  // PUT /memory/embeddings/:sourceType/:sourceId — drone callback to store embedding.
  // Auth is checkAgentOrAdmin (admin/agent direct, plus the drone key auth a
  // drone reuses to claim work). Non-admin writes are scoped to the drone's own
  // claimed embed job when the drone_jobs linkage is available.
  router.put('/embeddings/:sourceType/:sourceId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var sourceType = req.params.sourceType;
    if (refuseCompanionScoped(sourceType, null, res)) return; // review A r2: the last unguarded agent write into the class
    var sourceId = decodeURIComponent(req.params.sourceId);
    var { embedding, model, chunk_index } = req.body;
    if (!embedding || !Array.isArray(embedding)) return apiError(res, 400, 'embedding array is required');
    var chunkIndex = chunk_index || 0;
    if (!req._authIsAdmin && !droneOwnsEmbedJob(core.db, who, sourceType, sourceId, chunkIndex)) {
      return apiError(res, 403, 'not authorized to write this embedding');
    }
    db.updateEmbedding(sourceType, sourceId, chunkIndex, embedding, model || 'unknown');
    res.json({ ok: true, source_type: sourceType, source_id: sourceId });
  });

  // GET /memory/config — current provider config (admin only, key stripped)
  router.get('/config', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var config = db.getAllConfig();
    delete config.embedding_api_key;
    res.json(config);
  });

  // PUT /memory/config — update provider config
  router.put('/config', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var allowed = ['embedding_provider', 'embedding_model', 'embedding_url', 'embedding_api_key', 'embedding_dimensions', 'embedding_max_concurrency', 'chunk_size', 'auto_index'];
    for (var key of allowed) {
      if (req.body[key] !== undefined) {
        db.setConfig(key, String(req.body[key]));
      }
    }
    // Mirror GET /config: strip the API key from the response. getAllConfig()
    // builds a fresh object each call (stored state lives in sm_config), so
    // delete here never touches what's persisted.
    var config = db.getAllConfig();
    delete config.embedding_api_key;
    res.json({ ok: true, config: config });
  });

  // expandOversizedRows lives on the db wrapper now (db.js, task 219) — the
  // boot drain reuses it, and a second copy here was the wrong seam.

  // POST /memory/reindex — batch-embed all unembedded content (admin, async)
  router.post('/reindex', asyncHandler(async function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var config = db.getAllConfig();
    if (!config.embedding_provider || config.embedding_provider === 'none') {
      return apiError(res, 400, 'No embedding provider configured. Set via PUT /memory/config');
    }

    var batchSize = parseInt(req.body.batch_size) || 50;
    var unembedded = db.getUnembedded(batchSize);

    if (unembedded.length === 0) {
      return res.json({ ok: true, message: 'All content already embedded', embedded: 0, stats: db.stats() });
    }

    // Chunk-split oversized rows so each piece fits the embedding window
    unembedded = db.expandOversizedRows(unembedded);

    // Drone provider: queue async jobs instead of embedding synchronously
    if (config.embedding_provider === 'drone') {
      var queued = 0;
      var refused = 0; // a SECURITY refusal (companion rows never ride the agent-readable drone queue), not a failure — counted, not swallowed (review A r3 MINOR 2)
      for (var row of unembedded) {
        try {
          if (createDroneEmbedJob(core.db, row.source_type, row.source_id, row.chunk_index, row.content_text, config.embedding_model || 'nomic-embed-text')) {
            queued++;
          } else {
            refused++;
          }
        } catch (e) {
          console.error('[semantic-memory] reindex drone queue failed:', e.message);
        }
      }
      var droneRemaining = db.getUnembedded(1).length;
      return res.json({
        ok: true,
        message: 'Queued ' + queued + ' drone embed jobs' + (refused > 0 ? ' — ' + refused + ' companion rows refused (private rows never enter the drone queue)' : '') + (droneRemaining > 0 ? ' — more remaining, call again' : ''),
        queued: queued,
        refused: refused,
        remaining: droneRemaining > 0,
        stats: db.stats()
      });
    }

    // Process batch (ollama/openai — synchronous embedding)
    var embedded = 0;
    var errors = 0;
    var texts = unembedded.map(function (row) { return row.content_text; });
    var embeddings = await generateEmbeddingBatch(config, texts);

    for (var i = 0; i < unembedded.length; i++) {
      if (embeddings[i]) {
        try {
          db.updateEmbedding(unembedded[i].source_type, unembedded[i].source_id, unembedded[i].chunk_index, embeddings[i], config.embedding_model || config.embedding_provider);
          embedded++;
        } catch (e) {
          errors++;
          console.error('[semantic-memory] reindex embed update failed:', e.message);
        }
      } else {
        errors++;
      }
    }

    var remaining = db.getUnembedded(1).length;
    res.json({
      ok: true,
      message: remaining > 0 ? 'Batch complete, more remaining — call again' : 'Reindex complete',
      embedded: embedded,
      errors: errors,
      remaining: remaining > 0,
      stats: db.stats()
    });
  }));

  // POST /memory/backfill-embeddings — embed rows stored with NULL embeddings.
  // Safely re-runnable (only touches embedding IS NULL rows) and bounded per
  // call: ?limit= rows max (default 200, cap 1000), embedded in batches of 20.
  // Returns { processed, embedded, failed, queued, remaining } where remaining
  // is the total count of docs still lacking embeddings after this call.
  router.post('/backfill-embeddings', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var config = db.getAllConfig();
    if (!config.embedding_provider || config.embedding_provider === 'none') {
      return apiError(res, 400, 'No embedding provider configured. Set via PUT /memory/config');
    }

    var limit = parseIntParam(req.query.limit) || (req.body && parseIntParam(req.body.limit)) || 200;
    limit = Math.min(Math.max(limit, 1), 1000);

    // Fetch the working set once — failed rows stay NULL, and re-querying
    // inside the loop would spin on them forever. Oversized rows (the
    // persistently-failing legacy docs) are chunk-split before embedding,
    // so processed/embedded count post-chunking rows.
    var rows = db.expandOversizedRows(db.getUnembedded(limit));
    var processed = 0;
    var embedded = 0;
    var failed = 0;
    var queued = 0;

    if (config.embedding_provider === 'drone') {
      // Drone provider: queue async jobs; vectors arrive later via callback
      var refused = 0; // companion rows: security-refused from the drone queue (review A r3 MINOR 2)
      for (var row of rows) {
        try {
          if (createDroneEmbedJob(core.db, row.source_type, row.source_id, row.chunk_index, row.content_text, config.embedding_model || 'nomic-embed-text')) {
            queued++;
          } else {
            refused++;
          }
        } catch (e) {
          failed++;
          console.error('[semantic-memory] backfill drone queue failed:', e.message);
        }
        processed++;
      }
    } else {
      var BATCH = 20;
      for (var start = 0; start < rows.length; start += BATCH) {
        var batch = rows.slice(start, start + BATCH);
        var embeddings = await generateEmbeddingBatch(config, batch.map(function (r) { return r.content_text; }));
        for (var i = 0; i < batch.length; i++) {
          if (embeddings[i]) {
            try {
              db.updateEmbedding(batch[i].source_type, batch[i].source_id, batch[i].chunk_index, embeddings[i], config.embedding_model || config.embedding_provider);
              embedded++;
            } catch (e) {
              failed++;
              console.error('[semantic-memory] backfill embed update failed:', e.message);
            }
          } else {
            failed++;
          }
          processed++;
        }
      }
    }

    res.json({
      ok: true,
      processed: processed,
      embedded: embedded,
      failed: failed,
      refused: refused,
      queued: queued,
      remaining: db.countUnembedded()
    });
  }));

  return router;
}
