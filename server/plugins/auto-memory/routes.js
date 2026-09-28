// Auto-Memory plugin routes

import { Router } from 'express';
import createAutoMemoryDB from './db.js';
import { callLLM } from './llm.js';
import { rateLimited } from '../../lib/rate-limit.js';
import { memoryAgentGuard } from '../../lib/memory-auth.js';

export default function (core) {
  var router = Router();
  var db = createAutoMemoryDB(core.db);
  var { checkAdmin } = core.auth;
  // TRUST LAYER P0.1 (F-mycelium/250): the agent routes' gate — an agent key,
  // the admin key/JWT, or a role-'agent' studio token; any OTHER studio JWT is
  // refused. checkAgentOrAdmin's any-JWT-authenticates path was the hole the
  // 09-26 audit named, so the agent surface no longer rides it.
  var checkMemoryAgent = memoryAgentGuard(core.auth);
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

  // TRUST LAYER P0.2 (F-mycelium/250, review A blocker B2): write authority on
  // facts — the am_facts counterpart of refuseNotRowOwner on the sm_embeddings
  // surface. agent_id has been the AUTHENTICATED writer since this PR, so it
  // is the ownership column: a non-admin caller supersedes or reverifies only
  // facts it wrote. A NULL agent_id (the internal consolidator's insights, or
  // anything written before the column meant "writer") is owner-UNKNOWN and
  // therefore admin-only — fail-closed, exactly like written_by NULL on
  // /memory/*: an accidental NULL can only make a row MORE protected, never
  // less. The admin key keeps cross-agent access (the bench arms, the MCP
  // fork, the due-reverification drain). Refusal mirrors the same 403
  // sentence family the owner-only /memory routes use.
  // Returns true when the request was refused (response already sent).
  function refuseNotFactOwner(res, fact, who, isAdmin, action) {
    if (isAdmin) return false;
    if (fact.agent_id === who) return false;
    apiError(res, 403, (action ? action + ' refused: ' : '') + 'fact ' + fact.id + ' is ' +
      (fact.agent_id
        ? "owned by '" + fact.agent_id + "' — an agent key may supersede or reverify only the facts it wrote; ask the owner or use the admin key"
        : 'owner-unknown (agent_id is NULL — written before write authority existed) — only the admin key may supersede or reverify it'));
    return true;
  }
  router.get('/facts', function (req, res) {
    var who = checkMemoryAgent(req, res);
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
    var who = checkMemoryAgent(req, res);
    if (!who) return;
    var fact = db.getFact(parseIntParam(req.params.id));
    if (!fact) return apiError(res, 404, 'Fact not found');
    if (namespaceGuard(req, fact, res, 'read')) return;
    // TRUST LAYER P0.2 (review A nit N1): the single read is scoped like the
    // list (agent_id = who) — another agent's fact is "not there": a plain
    // 404 that neither confirms the row nor names its owner. Admin excepted.
    if (!req._authIsAdmin && fact.agent_id !== who) return apiError(res, 404, 'Fact not found');
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
  // Rate-limited (TRUST LAYER P0.2): the timeline bench arm writes a run's
  // facts through here (tens of thousands per run, over minutes) — 2400/min
  // per IP keeps that ceiling far above the bench while bounding abuse.
  router.post('/facts', rateLimited('auto-memory/facts', { windowMs: 60000, max: 2400 }), async function (req, res) {
    var who = checkMemoryAgent(req, res);
    if (!who) return;
    var b = req.body || {};
    if (!b.fact_text || String(b.fact_text).length < 10) return apiError(res, 400, 'fact_text (>=10 chars) is required');
    // TRUST LAYER P0.2: the size cap — fact_text lands verbatim in the
    // semantic index, so an unbounded fact was an unbounded index row.
    if (String(b.fact_text).length > 2000) {
      return apiError(res, 400, 'fact_text exceeds the 2000-character cap (got ' + String(b.fact_text).length + ') — split the fact');
    }
    var authority = b.source_authority || 'inferred';
    if (['verified', 'directive', 'inferred'].indexOf(authority) === -1) {
      return apiError(res, 400, 'source_authority must be one of: verified, directive, inferred');
    }
    // TRUST LAYER P0.2: 'directive' is decay-exempt provenance — the
    // DIRECTOR's channel, reached through the admin key only. An agent grading
    // its own statements as directives would exempt them from re-verification.
    if (authority === 'directive' && !req._authIsAdmin) {
      return apiError(res, 403, "source_authority 'directive' is reserved for the admin key — an agent's facts are verified or inferred, never directives");
    }
    if (b.namespace != null && (typeof b.namespace !== 'string' || b.namespace.trim().length === 0 || b.namespace.length > 200)) {
      return apiError(res, 400, 'namespace must be a non-empty string (<= 200 chars)');
    }
    if (b.metadata != null && (typeof b.metadata !== 'object' || Array.isArray(b.metadata))) {
      return apiError(res, 400, 'metadata must be a JSON object');
    }
    var conf = (b.confidence == null) ? 0.8 : Number(b.confidence);
    // TRUST LAYER P0.2: agent_id is the AUTHENTICATED identity, never a body
    // claim. A non-admin caller IS `who`; a body agent_id that disagrees is
    // kept as claimed_agent_id — visible, flagged, never trusted. Admin (the
    // bench arms, the MCP fork) keeps writing facts on behalf of a named agent.
    var claimedAgentId = null;
    var factAgentId;
    if (req._authIsAdmin) {
      factAgentId = b.agent_id || who;
    } else {
      factAgentId = who;
      if (b.agent_id && b.agent_id !== who) claimedAgentId = b.agent_id;
    }
    var id = db.createFact(factAgentId, b.project_id || null, b.category || 'general',
      String(b.fact_text), conf, b.source_type || 'aria', b.source_id || null, authority, b.valid_from || null, b.namespace || null, claimedAgentId);
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
          agent_id: factAgentId,
          claimed_agent_id: claimedAgentId || undefined, // omitted from the stored JSON when absent
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
          factAgentId, b.project_id || null);
      }
    } catch (e) {
      memoryIndex = { indexed: false, reason: e.message };
    }
    var fact = db.getFact(id);
    // An honest write carries no claim field at all — the column reads NULL
    // and the key is dropped rather than serialized as null.
    if (!fact.claimed_agent_id) delete fact.claimed_agent_id;
    res.json({ ok: true, id: id, fact: fact, memory_index: memoryIndex });
  });

  // POST /auto-memory/facts/:id/reverify — a ground-truth re-check CONFIRMED it (stamp verified_at)
  // Rate-limited (task 240): the production reverify sweep is one ~90-call
  // burst per day (route_usage: 810 calls over 9 active days), so the ceiling
  // is 10x that peak — the floor 120/min would leave only a 1.3x margin over
  // the sweep the lab itself runs.
  router.post('/facts/:id/reverify',
    rateLimited('auto-memory/reverify', { windowMs: 60000, max: 900 }),
    function (req, res) {
    var who = checkMemoryAgent(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    var fact = db.getFact(id);
    if (!fact) return apiError(res, 404, 'Fact not found');
    if (namespaceGuard(req, fact, res, 'reverify')) return;
    // TRUST LAYER P0.2 (review A blocker B2): verified_at/confidence are the
    // row's provenance — a cross-agent stamp was the same door the sm_embeddings
    // custody closed, one surface over. Owner (or admin) only.
    if (refuseNotFactOwner(res, fact, who, req._authIsAdmin, 'reverify')) return;
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
    var who = checkMemoryAgent(req, res);
    if (!who) return;
    var oldId = parseIntParam(req.params.id);
    var newId = req.body && parseInt(req.body.new_id);
    if (!newId) return apiError(res, 400, 'new_id is required');
    var oldFact = db.getFact(oldId);
    if (!oldFact) return apiError(res, 404, 'Fact not found');
    var newFact = db.getFact(newId);
    if (!newFact) return apiError(res, 400, 'new_id does not exist');
    if (namespaceGuard(req, oldFact, res, 'supersede')) return;
    // TRUST LAYER P0.2 (review A blocker B2): a supersede writes the OLD row —
    // superseded_by, valid_to, and (namespaced) its live index text through the
    // internal indexFactSemantic seam. Ownership of the old fact decides who
    // may start one; the replacement row is only referenced, never written.
    if (refuseNotFactOwner(res, oldFact, who, req._authIsAdmin, 'supersede')) return;
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
  // Rate-limited (TRUST LAYER P0.2): LLM-bound — seconds per call; the floor.
  router.post('/extract', rateLimited('auto-memory/extract', { windowMs: 60000, max: 120 }), async function (req, res) {
    var who = checkMemoryAgent(req, res);
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
    // TRUST LAYER P0.2 (F-mycelium/250): mirror GET /config — the key never
    // echoes back. The PUT used to hand the freshly-set LLM key to whoever
    // set it. getAllConfig() builds a fresh object each call (stored state
    // lives in am_config), so masking here never touches what's persisted.
    var config = db.getAllConfig();
    if (config.llm_api_key) config.llm_api_key = '***';
    res.json({ ok: true, config: config });
  });

  // GET /auto-memory/stats — stats (includes decay info)
  // Rate-limited (task 240): ~1 call/day on production — the 120/min floor.
  router.get('/stats',
    rateLimited('auto-memory/stats', { windowMs: 60000, max: 120 }),
    function (req, res) {
    var who = checkMemoryAgent(req, res);
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

// F-mycelium 254: every field below comes back as MODEL OUTPUT, and until now
// it was trusted verbatim — into am_facts AND the sm_embeddings metadata that
// trust-weighted ranking (P1.6) reads. The prompt ASKS for one word from this
// set; the validator ENFORCES it (off-set, mistyped or missing → 'other').
var EXTRACTION_CATEGORIES = ['preference', 'decision', 'pattern', 'architecture', 'convention', 'insight'];

function validExtractionCategory(raw) {
  var c = (typeof raw === 'string') ? raw.trim().toLowerCase() : '';
  return EXTRACTION_CATEGORIES.indexOf(c) !== -1 ? c : 'other';
}

// Confidence is the model grading ITSELF — it may inform ranking but must
// never outrank a verified fact, so it is clamped to [0, 0.9]. Missing or
// non-numeric keeps the historical 0.8 default (createFact's own default).
var MODEL_CONFIDENCE_CEILING = 0.9;

function clampModelConfidence(raw) {
  if (raw == null || raw === '') return 0.8;
  var n = Number(raw);
  if (!isFinite(n)) return 0.8;
  return Math.min(MODEL_CONFIDENCE_CEILING, Math.max(0, n));
}

// The same 2000-char cap POST /auto-memory/facts enforces on writes. Here the
// text is the model's own summary of paid-for activity, so DROP would silently
// lose knowledge — TRUNCATE instead, and say so on the created[] echo.
var FACT_TEXT_CAP = 2000;

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
      // F-mycelium 254: category, confidence and fact_text are MODEL OUTPUT —
      // validated/clamped/capped BEFORE they reach am_facts or the index.
      var category = validExtractionCategory(fact.category);
      var confidence = clampModelConfidence(fact.confidence);
      var factText = fact.fact_text;
      var truncated = false;
      if (String(factText).length > FACT_TEXT_CAP) {
        factText = String(factText).substring(0, FACT_TEXT_CAP);
        truncated = true;
      }
      var id = db.createFact(
        agentId, projectId,
        category,
        factText,
        confidence,
        'extraction', null
      );

      // Index in semantic memory if available — and SURFACE the outcome (§F4
      // honesty): the status object used to be discarded here, so a fact that
      // reached am_facts but not the searchable index vanished silently.
      // indexFactInMemory unwraps the wrapper to the core db (F-mycelium 252).
      var memoryIndex;
      try {
        // The object handed on carries the VALIDATED fields, never the raw
        // model output — indexFactInMemory mirrors the am_facts row when it
        // can and falls back to this object when it cannot. (254)
        memoryIndex = indexFactInMemory(db, id, { fact_text: factText, category: category, confidence: confidence }, agentId, projectId);
      } catch (e) {
        memoryIndex = { indexed: false, reason: e.message };
      }
      if (!memoryIndex.indexed) {
        console.error('[auto-memory] extracted fact ' + id + ' is NOT searchable: ' + (memoryIndex.reason || 'unknown reason'));
      }
      var echo = { id: id, category: category, fact_text: factText, confidence: confidence, memory_index: memoryIndex };
      if (truncated) echo.truncated = true;
      created.push(echo);
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
    // Accept the auto-memory wrapper too: extractFacts only ever holds the
    // wrapper (createAutoMemoryDB), which has no .prepare of its own — hand
    // it the core db it wraps. (F-mycelium 252; see db.js __coreDb.)
    if (coreDb && coreDb.__coreDb) coreDb = coreDb.__coreDb;
    coreDb.prepare || (function () { throw new Error('no db'); })();
    // TRUST LAYER P0 (review B, PR #192 blocker): source_authority NEVER comes
    // off the passed object — for extractFacts that object is RAW MODEL OUTPUT,
    // and a model (or a prompt-injected activity text it echoes) stamping
    // source_authority 'directive' onto a fact re-opens the directive path
    // PR #190 closed on /memory/index. The am_facts row is the authority of
    // record — /facts validated it on write and extraction never sets one
    // (createFact defaults 'inferred') — so read it back from the row itself.
    // F-mycelium 254: category + confidence read back WITH it, so the index
    // metadata mirrors the row of record instead of whatever the caller held
    // (that caller object is the validated/clamped fields since 254, but the
    // row is still the truth the metadata should agree with).
    var factRow = null;
    try {
      factRow = coreDb.prepare('SELECT source_authority, category, confidence FROM am_facts WHERE id = ?').get(factId);
    } catch (e) {
      // Fail-soft to the caller's (validated) values, but never SILENTLY — an
      // unreadable row of record is exactly what the honesty surfaces exist
      // to expose, and a swallowed throw here read as a clean index write.
      console.warn('[auto-memory] indexFactInMemory: am_facts read-back failed for fact ' + factId + ' (authority stays inferred, metadata falls back to the caller): ' + e.message);
    }
    var authority = (factRow && factRow.source_authority) ? factRow.source_authority : 'inferred';
    var metaCategory = (factRow && factRow.category != null) ? factRow.category : (fact.category != null ? fact.category : 'other');
    var metaConfidence = (factRow && factRow.confidence != null) ? factRow.confidence : clampModelConfidence(fact.confidence);
    // The sm_embeddings table may not exist if the semantic-memory plugin isn't loaded.
    coreDb.prepare(`
      INSERT INTO sm_embeddings (source_type, source_id, content_text, metadata, written_by)
      VALUES ('memory', ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id, chunk_index) DO UPDATE SET
        content_text = excluded.content_text, metadata = excluded.metadata,
        -- TRUST LAYER P0 (review B item 2): this is a SERVER write of a
        -- server-owned type — the fact's agent_id is the row's real owner and
        -- replaces whatever custody the row carried (a squatter's write under
        -- the next fact id does not survive the server's own upsert).
        written_by = excluded.written_by, updated_at = datetime('now')
    `).run(String(factId), fact.fact_text, JSON.stringify({ category: metaCategory, agent_id: agentId, project_id: projectId, source_authority: authority, confidence: metaConfidence }), agentId || null);
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
    // TRUST LAYER P0 (review B item 2): the row's custody is the fact's real
    // owner (metadata.agent_id, bound to the authenticated caller by the
    // /facts route) — stamped on insert and FORCED on conflict, so a squatter
    // who pre-wrote the fact's id under a NULL/other written_by loses the row
    // to the server's own write instead of inheriting custody.
    coreDb.prepare(`
      INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model, written_by)
      VALUES ('am_fact', ?, ?, ?, 0, ?, NULL, NULL, ?)
      ON CONFLICT(source_type, source_id, chunk_index) DO UPDATE SET
        content_text = excluded.content_text, namespace = excluded.namespace,
        metadata = excluded.metadata, embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        written_by = excluded.written_by, updated_at = datetime('now')
    `).run(String(factId), contentText, namespace, JSON.stringify(metadata || {}),
      (metadata && metadata.agent_id) || null);
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

export async function runConsolidation(db, config, _core, opts) {
  var startTime = Date.now();
  // TRUST LAYER P0 (review B item 5): the caller bounds what the LLM's answer
  // may touch. null (the scheduler, the admin-only POST /consolidate route) is
  // the server itself — input-set-bounded only; a callerAgentId further
  // restricts every mutation to that agent's OWN input rows.
  var safeOpts = opts || {};
  var callerAgentId = safeOpts.callerAgentId || null;

  // Get recent facts
  var recentFacts = db.listFacts({ limit: 200 });
  if (recentFacts.length < 5) {
    return { message: 'Not enough facts to consolidate', facts_count: recentFacts.length };
  }

  // The input set is the contract: an id the LLM outputs that is not one of
  // these rows was never shown to it (an invented or stale id) and touches
  // nothing. Directives are decay-exempt provenance — they outlive
  // consolidations whatever the caller is.
  var inputById = {};
  recentFacts.forEach(function (f) { inputById[String(f.id)] = f; });
  function canTouch(f) {
    if (!f) return false;
    if (f.source_authority === 'directive') return false;
    if (callerAgentId && String(f.agent_id) !== String(callerAgentId)) return false;
    return true;
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

    // Update confidence scores — same bounds as the merge leg (review B item 5)
    var factsRefused = 0;
    if (Array.isArray(result.keep)) {
      for (var k of result.keep) {
        if (k.id && k.new_confidence !== undefined) {
          if (!canTouch(inputById[String(k.id)])) { factsRefused++; continue; }
          db.updateFactConfidence(k.id, k.new_confidence);
        }
      }
    }

    // Merge duplicates — supersede_ids restricted to the consolidation's own
    // input ids, never a directive row, and (caller-scoped runs) the caller's
    // own rows only. Refusals are counted, not silently swallowed.
    if (Array.isArray(result.merge)) {
      for (var m of result.merge) {
        if (m.keep_id && Array.isArray(m.supersede_ids)) {
          if (!canTouch(inputById[String(m.keep_id)])) { factsRefused++; continue; }
          var applied = 0;
          for (var sid of m.supersede_ids) {
            if (!canTouch(inputById[String(sid)])) { factsRefused++; continue; }
            db.supersedeFact(sid, m.keep_id);
            applied++;
          }
          if (applied > 0) factsMerged++;
          factsSuperseded += applied;
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
      mutations_refused: factsRefused,
      duration_ms: durationMs
    };
  } catch (e) {
    console.error('[auto-memory] Consolidation error:', e.message);
    return { error: e.message, facts_processed: recentFacts.length };
  }
}
