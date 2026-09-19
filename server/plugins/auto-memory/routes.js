// Auto-Memory plugin routes

import { Router } from 'express';
import createAutoMemoryDB from './db.js';
import { callLLM } from './llm.js';
import { rateLimited } from '../../lib/rate-limit.js';

export default function (core) {
  var router = Router();
  var db = createAutoMemoryDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  // The source_type namespaced facts index under in sm_embeddings — distinct from
  // the legacy 'memory' rows so a scoped search targets facts precisely and the
  // two index shapes never mix. bench/memory/arms/arm_mycelium_timeline.mjs
  // carries the same constant (FACT_INDEX_SOURCE_TYPE) — keep them in sync.
  var FACT_INDEX_SOURCE_TYPE = 'am_fact';

  // A query/body namespace that is present-and-meaningful, else null — an empty
  // `namespace=` is "unscoped", not a namespace named "".
  function requestedNamespace(req) {
    var v = (req.query && req.query.namespace) || (req.body && req.body.namespace) || null;
    return (typeof v === 'string' && v.trim().length > 0) ? v : null;
  }

  // Namespace isolation guard (task 206). A non-admin caller may only touch facts
  // in the namespace they name — and unscoped callers only reach legacy
  // (NULL-namespace) rows, so a run's facts never leak into another surface's
  // reads. Refusal is a 404 (the fact is "not there" in your namespace), naming
  // the fact's namespace so the caller can re-scope; admins bypass it.
  // Returns true when the request was refused (response already sent).
  function namespaceGuard(req, fact, res, action) {
    if (req._authIsAdmin) return false;
    var owner = fact.namespace || null;
    if ((requestedNamespace(req) || null) === owner) return false;
    apiError(res, 404, (action ? action + ' refused: ' : '') + 'fact ' + fact.id + ' lives in namespace ' +
      (owner ? "'" + owner + "'" : '(legacy, unscoped)') +
      ' — pass namespace=' + (owner ? "'" + owner + "'" + ' to reach it' : '(none) to reach it'));
    return true;
  }

  // GET /auto-memory/facts — list facts
  router.get('/facts', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var facts = db.listFacts({
      agent_id: who,
      project_id: req.query.project_id,
      category: req.query.category,
      min_confidence: req.query.min_confidence ? parseFloat(req.query.min_confidence) : undefined,
      namespace: requestedNamespace(req),
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });
    res.json(facts);
  });

  // GET /auto-memory/facts/due-reverification — the re-verify queue: CURRENT inferred facts never
  // checked or last checked > older_than_days ago. Admin-only (a cross-agent maintenance view).
  // MUST be declared before /facts/:id or ':id' would swallow 'due-reverification'.
  router.get('/facts/due-reverification', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    res.json(db.factsDueForReverification({
      older_than_days: parseInt(req.query.older_than_days) || 30,
      namespace: requestedNamespace(req),
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /auto-memory/facts/:id — get single fact
  router.get('/facts/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var fact = db.getFact(parseIntParam(req.params.id));
    if (!fact) return apiError(res, 404, 'Fact not found');
    if (namespaceGuard(req, fact, res, 'read')) return;
    res.json(fact);
  });

  // DELETE /auto-memory/facts/:id — delete a fact (admin)
  //
  // Reports index removal the same way POST /facts reports index insertion: the
  // caller is told whether the fact is actually gone from /memory/search, not just
  // from am_facts. index_removed:0 on a fact that was indexed means the row is
  // still searchable — the reader would otherwise have no way to know.
  router.delete('/facts/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var fact = db.getFact(parseIntParam(req.params.id));
    if (!fact) return apiError(res, 404, 'Fact not found');
    var indexRemoved = db.deleteFact(fact.id);
    res.json({ ok: true, index_removed: indexRemoved });
  });

  // DELETE /auto-memory/facts?namespace=<ns> — purge a whole namespace (admin)
  //
  // The cleanup leg the bench contract needs (task 211): purge-everything-after.
  // A timeline n=50 run writes ~21.5k am_facts rows — per-id DELETE /facts/:id
  // is not a cleanup path, and skipping cleanup strands the run's rows in the
  // lab's LIVE fact table forever. Deletes CURRENT and SUPERSEDED rows alike
  // (a cleanup is not a supersede) and takes the index rows out through the
  // same seam supersede/delete use, so a purged namespace stops answering
  // /memory/search in the same request.
  //
  // UNSCOPED REFUSAL: this route NEVER touches a row with namespace IS NULL —
  // legacy rows and Aria's internal writer are unreachable from it, ever. An
  // unnamed (or empty/whitespace) namespace is a 400 naming that rule, NOT a
  // wipe of the live store; a named namespace with zero rows is a 200
  // {deleted: 0} — an honest count, not an error.
  router.delete('/facts', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var ns = requestedNamespace(req);
    if (!ns) {
      return apiError(res, 400, 'namespace is required: bulk delete purges ONLY the namespace you name — ' +
        'rows with no namespace (legacy rows, Aria\'s internal writer) are unreachable from this route by design, ' +
        'so an unscoped call refuses rather than guess');
    }
    var result = db.deleteFactsByNamespace(ns);
    res.json({ deleted: result.deleted, namespaces: [ns] });
  });

  // POST /auto-memory/facts — create a fact directly (Aria's writer ADD branch; provenance-aware)
  // A `namespace` (task 206) scopes the fact to a run/surface: it is stored on the
  // row, only reachable through namespace-named reads, and indexed into
  // semantic-memory under source_type 'am_fact' so searchHybrid can hit it — the
  // SAME index path memory rows use (row + embed scheduler; keyword-searchable
  // immediately, vector follows one-at-a-time per model, degrade-to-keyword on
  // backlog). Optional `metadata` (free-form object — the bench contract carries
  // episode/valid_from/supersedes/...) rides along on the index row.
  router.post('/facts', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var b = req.body || {};
    if (!b.fact_text || String(b.fact_text).length < 10) return apiError(res, 400, 'fact_text (>=10 chars) is required');
    var authority = b.source_authority || 'inferred';
    if (['verified', 'directive', 'inferred'].indexOf(authority) === -1) {
      return apiError(res, 400, 'source_authority must be one of: verified, directive, inferred');
    }
    if (b.namespace != null && (typeof b.namespace !== 'string' || b.namespace.trim().length === 0 || b.namespace.length > 200)) {
      return apiError(res, 400, 'namespace must be a non-empty string (<= 200 chars)');
    }
    if (b.metadata != null && (typeof b.metadata !== 'object' || Array.isArray(b.metadata))) {
      return apiError(res, 400, 'metadata must be a JSON object');
    }
    var conf = (b.confidence == null) ? 0.8 : Number(b.confidence);
    var id = db.createFact(b.agent_id || who, b.project_id || null, b.category || 'general',
      String(b.fact_text), conf, b.source_type || 'aria', b.source_id || null, authority, b.valid_from || null, b.namespace || null);
    // Surface whether the fact actually reached the searchable index. A 200 {ok:true}
    // used to hide BOTH "indexed, keyword-searchable, vector pending backfill" AND
    // "NOT indexed at all (semantic-memory absent / schema drift)". (§F4)
    var memoryIndex; // assigned on both paths below
    try {
      if (b.namespace) {
        var fact = db.getFact(id);
        // Column mirrors WIN over caller metadata: the index row always tells the
        // row's bi-temporal truth, even if the caller's metadata went stale.
        var meta = Object.assign({}, b.metadata || {}, {
          namespace: b.namespace,
          category: b.category || 'general',
          source_authority: authority,
          confidence: conf,
          agent_id: b.agent_id || who,
          project_id: b.project_id || null,
          fact_source_id: b.source_id || null,
          valid_from: fact.valid_from || null,
          valid_to: fact.valid_to || null,
          superseded_by: fact.superseded_by || null
        });
        memoryIndex = await indexFactSemantic(core.db, id, String(b.fact_text), meta, b.namespace);
      } else {
        memoryIndex = indexFactInMemory(core.db, id,
          { fact_text: b.fact_text, category: b.category || 'general', source_authority: authority, confidence: conf },
          b.agent_id || who, b.project_id || null);
      }
    } catch (e) {
      memoryIndex = { indexed: false, reason: e.message };
    }
    res.json({ ok: true, id: id, fact: db.getFact(id), memory_index: memoryIndex });
  });

  // POST /auto-memory/facts/:id/reverify — a ground-truth re-check CONFIRMED it (stamp verified_at)
  // Rate-limited (task 240): the production reverify sweep is one ~90-call
  // burst per day (route_usage: 810 calls over 9 active days), so the ceiling
  // is 10x that peak — the floor 120/min would leave only a 1.3x margin over
  // the sweep the lab itself runs.
  router.post('/facts/:id/reverify',
    rateLimited('auto-memory/reverify', { windowMs: 60000, max: 900 }),
    function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var fact = db.getFact(id);
    if (!fact) return apiError(res, 404, 'Fact not found');
    if (namespaceGuard(req, fact, res, 'reverify')) return;
    var conf = (req.body && req.body.confidence != null) ? Number(req.body.confidence) : null;
    db.reverifyFact(id, conf);
    res.json({ ok: true, fact: db.getFact(id) });
  });

  // POST /auto-memory/facts/:id/supersede — a newer fact replaces this one (Aria's UPDATE branch)
  // Namespaced facts (task 206): the guard refuses a cross-namespace pair, and the
  // old row STAYS indexed — re-indexed in place with its valid_to, the new fact's
  // text (superseded_by_text), and the row's caller metadata preserved, so the
  // timeline's "what did we believe on date X" keeps its history searchable. The
  // response carries both rows so the caller's ledger updates without a re-read;
  // the legacy (no-namespace) path returns {ok:true} exactly as before.
  router.post('/facts/:id/supersede',
    rateLimited('auto-memory/supersede', { windowMs: 60000, max: 120 }),
    async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var oldId = parseIntParam(req.params.id);
    var newId = req.body && parseInt(req.body.new_id);
    if (!newId) return apiError(res, 400, 'new_id is required');
    var oldFact = db.getFact(oldId);
    if (!oldFact) return apiError(res, 404, 'Fact not found');
    var newFact = db.getFact(newId);
    if (!newFact) return apiError(res, 400, 'new_id does not exist');
    if (namespaceGuard(req, oldFact, res, 'supersede')) return;
    if ((oldFact.namespace || null) !== (newFact.namespace || null)) {
      return apiError(res, 404, 'supersede refused: fact ' + oldId + ' lives in namespace ' +
        (oldFact.namespace ? "'" + oldFact.namespace + "'" : '(legacy, unscoped)') + ', fact ' + newId + ' lives in namespace ' +
        (newFact.namespace ? "'" + newFact.namespace + "'" : '(legacy, unscoped)'));
    }
    var namespaced = !!oldFact.namespace;
    var result = db.supersedeFact(oldId, newId, namespaced ? { keepIndexed: true } : undefined);
    if (namespaced) {
      var memoryIndex; // assigned on every path below before the response reads it
      // Re-index the old row in place: same (source_type, source_id) key, so the
      // upsert REPLACES the live text with the dated supersede line — a hit for
      // the old fact now renders "superseded on <date> by: <new text>".
      var priorMeta = {};
      try {
        var prior = core.db.prepare('SELECT metadata FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = 0')
          .get(FACT_INDEX_SOURCE_TYPE, String(oldId));
        if (prior && prior.metadata) priorMeta = JSON.parse(prior.metadata);
      } catch (e) { /* semantic-memory absent — build from the row alone */ }
      var meta = Object.assign({}, priorMeta, {
        valid_from: result.old.valid_from || priorMeta.valid_from || null,
        valid_to: result.old.valid_to || null,
        superseded_by: result.old.superseded_by || null,
        superseded_by_text: result.replacement.fact_text
      });
      try {
        memoryIndex = await indexFactSemantic(core.db, oldId,
          result.old.fact_text + '\n\n[superseded on ' + result.old.valid_to + ' by: ' + result.replacement.fact_text + ']',
          meta, oldFact.namespace);
      } catch (e) {
        memoryIndex = { indexed: false, reason: e.message };
      }
      res.json({ ok: true, fact: result.old, replacement: result.replacement, memory_index: memoryIndex });
      return;
    }
    res.json({ ok: true });
  });

  // POST /auto-memory/extract — manually trigger extraction on text
  router.post('/extract', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { text, project_id } = req.body;
    if (!text) return apiError(res, 400, 'text is required');

    var config = db.getAllConfig();
    if (config.extraction_enabled === 'false') {
      return apiError(res, 400, 'Extraction is disabled');
    }

    try {
      var facts = await extractFacts(db, config, text, who, project_id);
      // When 0 facts come back, "nothing durable to extract" and "the LLM was down"
      // used to be indistinguishable (both: {ok:true, facts_extracted:0}). Surface the
      // recent extraction-error health so a caller can tell them apart. extractFacts
      // now logs LLM failures to am_extraction_errors, so this is populated on real
      // breakage and empty on a legitimate "nothing here." (§F5)
      var body = { ok: true, facts_extracted: facts.length, facts: facts };
      if (facts.length === 0) {
        try {
          var es = db.getErrorStats();
          var recent = db.getExtractionErrors(1);
          body.extraction_health = {
            total_errors: es.total,
            errors_last_24h: es.last_24h,
            last_error: recent.length ? { at: recent[0].created_at, message: (recent[0].error_message || '').slice(0, 200) } : null
          };
        } catch (e2) { /* non-critical */ }
      }
      res.json(body);
    } catch (e) {
      return apiError(res, 500, 'Extraction failed: ' + e.message);
    }
  });

  // POST /auto-memory/consolidate — manually trigger consolidation
  router.post('/consolidate', async function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var config = db.getAllConfig();
    if (config.consolidation_enabled === 'false') {
      return apiError(res, 400, 'Consolidation is disabled');
    }

    try {
      var result = await runConsolidation(db, config, core);
      res.json({ ok: true, result: result });
    } catch (e) {
      return apiError(res, 500, 'Consolidation failed: ' + e.message);
    }
  });

  // GET /auto-memory/config — current config
  router.get('/config', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var config = db.getAllConfig();
    if (config.llm_api_key) config.llm_api_key = '***';
    res.json(config);
  });

  // PUT /auto-memory/config — update config
  router.put('/config', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var allowed = ['llm_provider', 'llm_model', 'llm_url', 'llm_api_key',
      'extraction_enabled', 'consolidation_enabled', 'consolidation_interval_hours',
      'max_facts_per_agent'];
    for (var key of allowed) {
      if (req.body[key] !== undefined) {
        db.setConfig(key, String(req.body[key]));
      }
    }
    res.json({ ok: true, config: db.getAllConfig() });
  });

  // GET /auto-memory/stats — stats (includes decay info)
  // Rate-limited (task 240): ~1 call/day on production — the 120/min floor.
  router.get('/stats',
    rateLimited('auto-memory/stats', { windowMs: 60000, max: 120 }),
    function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var stats = db.stats();
    // Add decay-related stats
    try {
      var belowThreshold = core.db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by IS NULL AND confidence < 0.15').get().c;
      var decayPruned = core.db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by = id').get().c;
      stats.decay = {
        facts_below_threshold: belowThreshold,
        facts_decay_pruned: decayPruned
      };
    } catch (e) { /* non-critical */ }
    // Surface extraction/consolidation LLM health so a SILENT failure — a configured
    // LLM that went unreachable — becomes VISIBLE. This is exactly how the memory
    // quietly broke 2026-07-06: errors were logged to am_extraction_errors the whole
    // time, but nothing surfaced them. (mycelium house rule: no silent failures.)
    try {
      var es = db.getErrorStats();
      var recent = db.getExtractionErrors(1);
      stats.extraction_errors = {
        total: es.total,
        last_24h: es.last24h,
        last_error: recent.length ? {
          at: recent[0].created_at,
          source: recent[0].source_event,
          message: (recent[0].error_message || '').slice(0, 200)
        } : null
      };
    } catch (e) { /* non-critical */ }
    res.json(stats);
  });

  return router;
}

// ---- Extraction ----

// Robustly pull a facts array from an LLM response (2026-07-06 parse-robustness).
// Handles response_format=json_object -> {"facts":[...]}, a bare JSON array, and
// JSON embedded in prose/code fences — so a small local model (nemotron-mini on the
// jetson) that wraps or wobbles its output no longer yields silent 0-fact extractions.
function parseFactArray(response) {
  if (!response) return [];
  var text = String(response);
  try {
    var whole = JSON.parse(text.trim());
    if (Array.isArray(whole)) return whole;
    if (whole && Array.isArray(whole.facts)) return whole.facts;
  } catch (_) { /* fall through */ }
  var objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) { try { var obj = JSON.parse(objMatch[0]); if (obj && Array.isArray(obj.facts)) return obj.facts; } catch (_) {} }
  var arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { var arr = JSON.parse(arrMatch[0]); if (Array.isArray(arr)) return arr; } catch (_) {} }
  return [];
}

var EXTRACTION_PROMPT = `Given this agent activity, extract durable knowledge facts.
Only extract facts useful across sessions — preferences, decisions, patterns, architecture choices, conventions.
Do NOT extract: temporary status, in-progress work, timestamps, routine heartbeats.

Each fact's "category" MUST be exactly ONE word from this set: preference, decision, pattern, architecture, convention, insight. Output a single word, never the whole list.

Activity:
{content}

Return a JSON object of the form {"facts":[{"category":"<one word>","fact_text":"...","confidence":0.5}]} (no markdown, no prose).`;

export async function extractFacts(db, config, text, agentId, projectId) {
  if (!text || text.length < 20) return [];

  var prompt = EXTRACTION_PROMPT.replace('{content}', text.substring(0, 4000));

  try {
    var response = await callLLM(config, prompt);
    if (!response) {
      // callLLM returns null only for provider='none' (expected — llm.js logs it) OR
      // for an UNKNOWN provider. Only the latter is a breakage worth surfacing: a
      // configured-but-unrecognized provider silently extracted 0 facts forever, and
      // the /stats extraction_errors surface never saw it (this branch used to swallow
      // it). Log it so the already-existing health surface works as intended. (§F5)
      if (config.llm_provider && config.llm_provider !== 'none') {
        try { db.logExtractionError(agentId, projectId, 'extract', 'LLM provider "' + config.llm_provider + '" returned no response (unknown or misconfigured)', text.substring(0, 500)); } catch (_) {}
      }
      return [];
    }

    // Parse facts robustly (2026-07-06): response_format=json_object yields
    // {"facts":[...]}; parseFactArray also handles bare arrays + prose-wrapped JSON.
    var facts = parseFactArray(response);
    if (!facts.length) return [];

    var created = [];
    for (var fact of facts) {
      if (!fact.fact_text || fact.fact_text.length < 10) continue;
      var id = db.createFact(
        agentId, projectId,
        fact.category || 'general',
        fact.fact_text,
        fact.confidence || 0.8,
        'extraction', null
      );
      created.push({ id: id, category: fact.category, fact_text: fact.fact_text, confidence: fact.confidence });

      // Index in semantic memory if available
      try {
        indexFactInMemory(db, id, fact, agentId, projectId);
      } catch (e) { /* non-critical */ }
    }

    // Prune excess facts per agent
    var maxFacts = parseInt(config.max_facts_per_agent) || 500;
    if (agentId) {
      try { db.pruneExcessFacts(agentId, maxFacts); } catch (e) { /* non-critical */ }
    }

    return created;
  } catch (e) {
    // An LLM outage (ollama down → HTTP error) throws here. Log it to
    // am_extraction_errors so the /stats extraction_errors surface reflects it —
    // previously this swallow left the outage totally invisible (0 facts extracted +
    // 0 reported errors). The event-driven handlers wrap extractFacts in .catch +
    // logExtractionError, but that .catch never fired because extractFacts caught
    // internally and resolved with []. (§F5)
    console.error('[auto-memory] Extraction error:', e.message);
    try { db.logExtractionError(agentId, projectId, 'extract', e.message, text.substring(0, 500)); } catch (_) {}
    return [];
  }
}

// Index a fact into semantic-memory's sm_embeddings so it is keyword/FTS searchable.
// Returns a status object so the caller can surface a write that landed in am_facts
// but DID NOT reach the searchable index — otherwise the fact exists but is invisible
// to /memory/search until a manual reindex, and nobody knows. (no silent failures)
//
// NOTE on embedded:false — this path stores the row with a NULL embedding and does NOT
// trigger auto-embed (there is no auto-memory backfill worker). The fact is keyword/
// FTS searchable immediately but NOT vector-searchable until an admin runs POST
// /memory/reindex or /memory/backfill-embeddings. We say so honestly rather than let
// the caller believe a freshly-saved fact is already semantically retrievable.
// See MEMORY-FAILURE-STATES.md §F4.
function indexFactInMemory(coreDb, factId, fact, agentId, projectId) {
  try {
    coreDb.prepare || (function () { throw new Error('no db'); })();
    // The sm_embeddings table may not exist if the semantic-memory plugin isn't loaded.
    coreDb.prepare(`
      INSERT INTO sm_embeddings (source_type, source_id, content_text, metadata)
      VALUES ('memory', ?, ?, ?)
      ON CONFLICT(source_type, source_id, chunk_index) DO UPDATE SET
        content_text = excluded.content_text, metadata = excluded.metadata, updated_at = datetime('now')
    `).run(String(factId), fact.fact_text, JSON.stringify({ category: fact.category, agent_id: agentId, project_id: projectId, source_authority: fact.source_authority || 'inferred', confidence: fact.confidence }));
    return { indexed: true, embedded: false, vector_search: 'pending backfill (POST /memory/reindex or /memory/backfill-embeddings)' };
  } catch (e) {
    return { indexed: false, embedded: false, reason: 'semantic-memory not available: ' + e.message };
  }
}

// -- Namespaced fact index (task 206) -----------------------------------------
// The namespaced counterpart of indexFactInMemory: instead of a bare NULL-
// embedding row, the fact goes through the SAME path a memory row takes via
// POST /memory/index — an sm_embeddings row carrying its namespace + metadata,
// then the embed scheduler (semantic-memory/embeddings.js: one-at-a-time per
// model, query embeds jump the bulk lane, degrade-to-keyword on backlog). The
// row is keyword/FTS-searchable the moment it lands; the vector follows.
//
// SEAM: direct shared-db access, the same seam unindexFacts() in db.js already
// uses for the delete direction (both plugins receive core.db; a cross-plugin
// IMPORT would make auto-memory unloadable on deployments without semantic-
// memory, which is why the import below is dynamic and every failure is
// fail-soft to keyword-only). The event-hook alternative loses the §F4
// honesty surface — hook errors are swallowed, so POST /facts could no longer
// report whether its write reached the index.
//
// One row per fact (chunk_index 0): facts are fact-sized. An oversized outlier
// takes the same path legacy rows always did — POST /memory/reindex's
// expandOversizedRows chunk-splits it on the next backfill.

// semantic-memory's config lives in sm_config on the SHARED db (its getAllConfig
// also merges plugin_config; sm_config is canonical and readable without the
// wrapper — creating a second createMemoryDB instance here would REPLACE the
// shared decoded-vector cache on db.__myceliumVectorCache).
function readSmConfig(coreDb) {
  var config = {};
  try {
    var rows = coreDb.prepare('SELECT key, value FROM sm_config').all();
    for (var r of rows) config[r.key] = r.value;
  } catch (e) { /* no sm_config → provider 'none' → keyword-only */ }
  return config;
}

// Fire-and-forget embed through semantic-memory's scheduler. Returns what the
// CALLER can honestly claim now: 'off' (no provider) or 'scheduled'. The
// dynamic import keeps auto-memory loadable when semantic-memory is not
// deployed; a failed embed leaves the row keyword-searchable (degrade-to-
// keyword) and logs — never silent, never fatal to the fact write.
function scheduleFactEmbed(coreDb, sourceType, sourceId, contentText) {
  try {
    import('../semantic-memory/embeddings.js').then(function (mod) {
      var config = readSmConfig(coreDb);
      if (!config.embedding_provider || config.embedding_provider === 'none') return;
      mod.generateEmbedding(config, contentText, { sourceType: sourceType, sourceId: sourceId, chunkIndex: 0 })
        .then(function (embedding) {
          if (!embedding) return;
          try {
            // The WRITE side of the 196 side-channel (attached by
            // semantic-memory/db.js next to __myceliumVectorCache): updateEmbedding's
            // exact SQL + vector-cache hook, WITHOUT constructing a second
            // createMemoryDB instance (that would REPLACE the shared decoded-vector
            // cache). The raw UPDATE lives only in semantic-memory's db.js — the
            // vector-cache-resilience gate pins that invariant.
            var write = coreDb.__myceliumEmbeddingWrite;
            if (!write) return; // older semantic-memory without the hook — keyword-only, honest
            write(sourceType, sourceId, 0, embedding, config.embedding_model || config.embedding_provider);
          } catch (e) {
            console.error('[auto-memory] fact embed write-back failed (row stays keyword-searchable): ' + e.message);
          }
        })
        .catch(function (e) {
          console.error('[auto-memory] fact embed failed (row stays keyword-searchable): ' + e.message);
        });
    }).catch(function () { /* semantic-memory not deployed — keyword-only is the honest state */ });
    return 'scheduled';
  } catch (e) {
    return 'off';
  }
}

async function indexFactSemantic(coreDb, factId, contentText, metadata, namespace) {
  try {
    coreDb.prepare || (function () { throw new Error('no db'); })();
    // Same upsert shape as semantic-memory's db.index (a re-index REPLACES the
    // row: text, metadata — and the vector, which the scheduler refills).
    coreDb.prepare(`
      INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model)
      VALUES ('am_fact', ?, ?, ?, 0, ?, NULL, NULL)
      ON CONFLICT(source_type, source_id, chunk_index) DO UPDATE SET
        content_text = excluded.content_text, namespace = excluded.namespace,
        metadata = excluded.metadata, embedding = excluded.embedding,
        embedding_model = excluded.embedding_model, updated_at = datetime('now')
    `).run(String(factId), contentText, namespace, JSON.stringify(metadata || {}));
  } catch (e) {
    return { indexed: false, embedded: false, reason: 'semantic-memory not available: ' + e.message };
  }
  try {
    var vc = coreDb.__myceliumVectorCache;
    if (vc) vc.onUpsert('am_fact', String(factId), 0);
  } catch (e) { /* cache hook is optimistic; the signature reconcile self-heals */ }
  var embedState = scheduleFactEmbed(coreDb, 'am_fact', String(factId), contentText);
  return {
    indexed: true,
    embedded: false,
    vector_search: embedState === 'scheduled'
      ? 'scheduled via the embed scheduler (keyword-searchable now; one-at-a-time per model)'
      : 'no embedding provider configured (keyword-searchable only)'
  };
}

// ---- Consolidation ----

var CONSOLIDATION_PROMPT = `Review these extracted knowledge facts and consolidate them:
1. Merge duplicates (same information stated differently)
2. Resolve contradictions (newer facts supersede older ones)
3. Adjust confidence scores (well-confirmed facts get higher confidence)

Facts:
{facts}

Return a JSON object (no markdown, no explanation):
{
  "keep": [{ "id": <existing_fact_id>, "new_confidence": 0.0-1.0 }],
  "merge": [{ "keep_id": <id_to_keep>, "supersede_ids": [<ids_to_supersede>] }],
  "insights": [{ "category": "...", "fact_text": "...", "confidence": 0.0-1.0 }]
}`;

export async function runConsolidation(db, config, _core) {
  var startTime = Date.now();

  // Get recent facts
  var recentFacts = db.listFacts({ limit: 200 });
  if (recentFacts.length < 5) {
    return { message: 'Not enough facts to consolidate', facts_count: recentFacts.length };
  }

  var factsText = recentFacts.map(function (f) {
    return 'ID:' + f.id + ' [' + f.category + '] (confidence:' + f.confidence + ') ' + f.fact_text;
  }).join('\n');

  var prompt = CONSOLIDATION_PROMPT.replace('{facts}', factsText.substring(0, 6000));

  try {
    var response = await callLLM(config, prompt);
    if (!response) {
      return { message: 'LLM returned empty response', facts_processed: recentFacts.length };
    }

    var jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { message: 'Could not parse consolidation response', facts_processed: recentFacts.length };
    }
    var result = JSON.parse(jsonMatch[0]);

    var factsMerged = 0;
    var factsSuperseded = 0;

    // Update confidence scores
    if (Array.isArray(result.keep)) {
      for (var k of result.keep) {
        if (k.id && k.new_confidence !== undefined) {
          db.updateFactConfidence(k.id, k.new_confidence);
        }
      }
    }

    // Merge duplicates
    if (Array.isArray(result.merge)) {
      for (var m of result.merge) {
        if (m.keep_id && Array.isArray(m.supersede_ids)) {
          for (var sid of m.supersede_ids) {
            db.supersedeFact(sid, m.keep_id);
            factsSuperseded++;
          }
          factsMerged++;
        }
      }
    }

    // Add new insights
    if (Array.isArray(result.insights)) {
      for (var insight of result.insights) {
        if (insight.fact_text && insight.fact_text.length >= 10) {
          db.createFact(null, null, insight.category || 'insight', insight.fact_text, insight.confidence || 0.7, 'consolidation', null);
        }
      }
    }

    var durationMs = Date.now() - startTime;
    db.logConsolidation(recentFacts.length, factsMerged, factsSuperseded, durationMs);

    // Prune old superseded facts
    db.pruneOldSuperseded('30 days');

    return {
      facts_processed: recentFacts.length,
      facts_merged: factsMerged,
      facts_superseded: factsSuperseded,
      duration_ms: durationMs
    };
  } catch (e) {
    console.error('[auto-memory] Consolidation error:', e.message);
    return { error: e.message, facts_processed: recentFacts.length };
  }
}
