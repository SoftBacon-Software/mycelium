// Auto-Memory plugin routes

import { Router } from 'express';
import createAutoMemoryDB from './db.js';
import { callLLM } from './llm.js';

export default function (core) {
  var router = Router();
  var db = createAutoMemoryDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  // GET /auto-memory/facts — list facts
  router.get('/facts', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var facts = db.listFacts({
      agent_id: who,
      project_id: req.query.project_id,
      category: req.query.category,
      min_confidence: req.query.min_confidence ? parseFloat(req.query.min_confidence) : undefined,
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
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /auto-memory/facts/:id — get single fact
  router.get('/facts/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var fact = db.getFact(parseIntParam(req.params.id));
    if (!fact) return apiError(res, 404, 'Fact not found');
    res.json(fact);
  });

  // DELETE /auto-memory/facts/:id — delete a fact (admin)
  router.delete('/facts/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var fact = db.getFact(parseIntParam(req.params.id));
    if (!fact) return apiError(res, 404, 'Fact not found');
    db.deleteFact(fact.id);
    res.json({ ok: true });
  });

  // POST /auto-memory/facts — create a fact directly (Aria's writer ADD branch; provenance-aware)
  router.post('/facts', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var b = req.body || {};
    if (!b.fact_text || String(b.fact_text).length < 10) return apiError(res, 400, 'fact_text (>=10 chars) is required');
    var authority = b.source_authority || 'inferred';
    if (['verified', 'directive', 'inferred'].indexOf(authority) === -1) {
      return apiError(res, 400, 'source_authority must be one of: verified, directive, inferred');
    }
    var conf = (b.confidence == null) ? 0.8 : Number(b.confidence);
    var id = db.createFact(b.agent_id || who, b.project_id || null, b.category || 'general',
      String(b.fact_text), conf, b.source_type || 'aria', b.source_id || null, authority, b.valid_from || null);
    // Surface whether the fact actually reached the searchable index. A 200 {ok:true}
    // used to hide BOTH "indexed, keyword-searchable, vector pending backfill" AND
    // "NOT indexed at all (semantic-memory absent / schema drift)". (§F4)
    var memoryIndex = { indexed: false, reason: 'not attempted' };
    try {
      memoryIndex = indexFactInMemory(core.db, id,
        { fact_text: b.fact_text, category: b.category || 'general', source_authority: authority, confidence: conf },
        b.agent_id || who, b.project_id || null);
    } catch (e) {
      memoryIndex = { indexed: false, reason: e.message };
    }
    res.json({ ok: true, id: id, fact: db.getFact(id), memory_index: memoryIndex });
  });

  // POST /auto-memory/facts/:id/reverify — a ground-truth re-check CONFIRMED it (stamp verified_at)
  router.post('/facts/:id/reverify', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.getFact(id)) return apiError(res, 404, 'Fact not found');
    var conf = (req.body && req.body.confidence != null) ? Number(req.body.confidence) : null;
    db.reverifyFact(id, conf);
    res.json({ ok: true, fact: db.getFact(id) });
  });

  // POST /auto-memory/facts/:id/supersede — a newer fact replaces this one (Aria's UPDATE branch)
  router.post('/facts/:id/supersede', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var oldId = parseIntParam(req.params.id);
    var newId = req.body && parseInt(req.body.new_id);
    if (!newId) return apiError(res, 400, 'new_id is required');
    if (!db.getFact(oldId)) return apiError(res, 404, 'Fact not found');
    if (!db.getFact(newId)) return apiError(res, 400, 'new_id does not exist');
    db.supersedeFact(oldId, newId);
    res.json({ ok: true });
  });

  // POST /auto-memory/extract — manually trigger extraction on text
  router.post('/extract', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { text, agent_id, project_id } = req.body;
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
  router.get('/stats', function (req, res) {
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

export async function runConsolidation(db, config, core) {
  var startTime = Date.now();
  var lastConsolidation = db.getLastConsolidation();
  var since = lastConsolidation ? lastConsolidation.run_at : '2000-01-01';

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
