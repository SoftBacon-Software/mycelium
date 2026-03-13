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
      agent_id: req.query.agent_id,
      project_id: req.query.project_id,
      category: req.query.category,
      min_confidence: req.query.min_confidence ? parseFloat(req.query.min_confidence) : undefined,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });
    res.json(facts);
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
      var facts = await extractFacts(db, config, text, agent_id || who, project_id);
      res.json({ ok: true, facts_extracted: facts.length, facts: facts });
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
      var decayPruned = core.db.prepare('SELECT COUNT(*) as c FROM am_facts WHERE superseded_by = -1').get().c;
      stats.decay = {
        facts_below_threshold: belowThreshold,
        facts_decay_pruned: decayPruned
      };
    } catch (e) { /* non-critical */ }
    res.json(stats);
  });

  return router;
}

// ---- Extraction ----

var EXTRACTION_PROMPT = `Given this agent activity, extract durable knowledge facts.
Only extract facts that would be useful across sessions — preferences, decisions, patterns, architecture choices, conventions.
Do NOT extract: temporary status, in-progress work, timestamps, routine heartbeats.

Activity:
{content}

Return a JSON array only (no markdown, no explanation): [{ "category": "preference|decision|pattern|architecture|convention|insight", "fact_text": "...", "confidence": 0.0-1.0 }]`;

export async function extractFacts(db, config, text, agentId, projectId) {
  if (!text || text.length < 20) return [];

  var prompt = EXTRACTION_PROMPT.replace('{content}', text.substring(0, 4000));

  try {
    var response = await callLLM(config, prompt);
    if (!response) return [];

    // Parse JSON from response
    var jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    var facts = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(facts)) return [];

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
    console.error('[auto-memory] Extraction error:', e.message);
    return [];
  }
}

function indexFactInMemory(coreDb, factId, fact, agentId, projectId) {
  // Try to index in semantic-memory plugin's table if it exists
  try {
    coreDb.prepare || (function () { throw new Error('no db'); })();
    // The sm_embeddings table may not exist if semantic-memory plugin isn't loaded
    coreDb.prepare(`
      INSERT INTO sm_embeddings (source_type, source_id, content_text, metadata)
      VALUES ('memory', ?, ?, ?)
      ON CONFLICT(source_type, source_id, chunk_index) DO UPDATE SET
        content_text = excluded.content_text, metadata = excluded.metadata, updated_at = datetime('now')
    `).run(String(factId), fact.fact_text, JSON.stringify({ category: fact.category, agent_id: agentId, project_id: projectId }));
  } catch (e) { /* semantic-memory not available or table doesn't exist */ }
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
