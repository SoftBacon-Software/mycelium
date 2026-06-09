// Semantic Memory plugin routes

import { Router } from 'express';
import createMemoryDB from './db.js';
import { generateEmbedding, generateEmbeddingBatch, createDroneEmbedJob } from './embeddings.js';

export default function (core) {
  var router = Router();
  var db = createMemoryDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

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

  // POST /memory/search — hybrid search
  router.post('/search', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { query, source_types, namespace, project_id, limit, mode } = req.body;
    if (!query || typeof query !== 'string') return apiError(res, 400, 'query is required');
    limit = Math.min(parseInt(limit) || 10, 100);
    mode = mode || 'hybrid';

    var opts = { limit: limit };
    if (source_types && Array.isArray(source_types)) opts.source_types = source_types;
    if (namespace) opts.namespace = namespace;
    if (project_id) {
      opts.project_id = project_id;
    }

    var results;
    if (mode === 'keyword') {
      results = db.searchKeyword(query, opts);
    } else {
      // Generate query embedding for hybrid search
      var queryEmbedding = null;
      try {
        var config = db.getAllConfig();
        if (config.embedding_provider && config.embedding_provider !== 'none') {
          queryEmbedding = await generateEmbedding(config, query);
        }
      } catch (e) {
        console.error('[semantic-memory] Query embedding failed, falling back to keyword:', e.message);
      }
      results = db.searchHybrid(query, opts, queryEmbedding);
    }

    // Post-filter by project_id if specified (metadata-level filtering)
    if (project_id) {
      results = results.filter(function (r) {
        return r.metadata && r.metadata.project_id === project_id;
      });
    }

    res.json({ results: results, mode: mode, query: query, count: results.length });
  });

  // POST /memory/index — index content
  router.post('/index', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { source_type, source_id, content_text, namespace, metadata, chunk_index } = req.body;
    if (!source_type || !source_id || !content_text) {
      return apiError(res, 400, 'source_type, source_id, and content_text are required');
    }
    db.index(source_type, source_id, content_text, {
      namespace: namespace,
      chunk_index: chunk_index || 0,
      metadata: metadata
    });
    autoEmbed(source_type, source_id, content_text, chunk_index || 0);
    core.emitEvent('memory_indexed', who, null,
      who + ' indexed ' + source_type + ':' + source_id, { source_type: source_type, source_id: source_id });
    res.json({ ok: true, source_type: source_type, source_id: source_id });
  });

  // POST /memory/index/bulk — bulk index
  router.post('/index/bulk', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) return apiError(res, 400, 'items array is required');
    if (items.length > 100) return apiError(res, 400, 'Max 100 items per bulk request');

    // Validate
    for (var item of items) {
      if (!item.source_type || !item.source_id || !item.content_text) {
        return apiError(res, 400, 'Each item needs source_type, source_id, and content_text');
      }
    }

    var count = db.bulkIndex(items);

    // Fire-and-forget embed for items that didn't bring their own embedding.
    // generateEmbeddingBatch is sequential for ollama, so this won't stampede.
    var toEmbed = items.filter(function (it) { return !it.embedding; });
    if (toEmbed.length > 0) {
      var config = db.getAllConfig();
      if (config.embedding_provider && config.embedding_provider !== 'none') {
        generateEmbeddingBatch(config, toEmbed.map(function (it) { return it.content_text; }), {
          db: core.db,
          items: toEmbed.map(function (it) {
            return { source_type: it.source_type, source_id: it.source_id, chunk_index: it.chunk_index || 0 };
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

    res.json({ ok: true, indexed: count });
  });

  // DELETE /memory/index/:sourceType/:sourceId — remove from index
  router.delete('/index/:sourceType/:sourceId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    db.remove(req.params.sourceType, req.params.sourceId);
    res.json({ ok: true });
  });

  // GET /memory/stats — index stats
  router.get('/stats', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.stats());
  });

  // PUT /memory/embeddings/:sourceType/:sourceId — drone callback to store embedding
  router.put('/embeddings/:sourceType/:sourceId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { embedding, model, chunk_index } = req.body;
    if (!embedding || !Array.isArray(embedding)) return apiError(res, 400, 'embedding array is required');
    db.updateEmbedding(req.params.sourceType, decodeURIComponent(req.params.sourceId), chunk_index || 0, embedding, model || 'unknown');
    res.json({ ok: true, source_type: req.params.sourceType, source_id: decodeURIComponent(req.params.sourceId) });
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
    var allowed = ['embedding_provider', 'embedding_model', 'embedding_url', 'embedding_api_key', 'embedding_dimensions', 'chunk_size', 'auto_index'];
    for (var key of allowed) {
      if (req.body[key] !== undefined) {
        db.setConfig(key, String(req.body[key]));
      }
    }
    res.json({ ok: true, config: db.getAllConfig() });
  });

  // POST /memory/reindex — batch-embed all unembedded content (admin, async)
  router.post('/reindex', async function (req, res) {
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

    // Drone provider: queue async jobs instead of embedding synchronously
    if (config.embedding_provider === 'drone') {
      var queued = 0;
      for (var row of unembedded) {
        try {
          createDroneEmbedJob(core.db, row.source_type, row.source_id, row.chunk_index, row.content_text, config.embedding_model || 'nomic-embed-text');
          queued++;
        } catch (e) {
          console.error('[semantic-memory] reindex drone queue failed:', e.message);
        }
      }
      var droneRemaining = db.getUnembedded(1).length;
      return res.json({
        ok: true,
        message: 'Queued ' + queued + ' drone embed jobs' + (droneRemaining > 0 ? ' — more remaining, call again' : ''),
        queued: queued,
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
  });

  // POST /memory/backfill-embeddings — embed rows stored with NULL embeddings.
  // Safely re-runnable (only touches embedding IS NULL rows) and bounded per
  // call: ?limit= rows max (default 200, cap 1000), embedded in batches of 20.
  // Returns { processed, embedded, failed, queued, remaining } where remaining
  // is the total count of docs still lacking embeddings after this call.
  router.post('/backfill-embeddings', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var config = db.getAllConfig();
    if (!config.embedding_provider || config.embedding_provider === 'none') {
      return apiError(res, 400, 'No embedding provider configured. Set via PUT /memory/config');
    }

    var limit = parseIntParam(req.query.limit) || (req.body && parseIntParam(req.body.limit)) || 200;
    limit = Math.min(Math.max(limit, 1), 1000);

    // Fetch the working set once — failed rows stay NULL, and re-querying
    // inside the loop would spin on them forever.
    var rows = db.getUnembedded(limit);
    var processed = 0;
    var embedded = 0;
    var failed = 0;
    var queued = 0;

    if (config.embedding_provider === 'drone') {
      // Drone provider: queue async jobs; vectors arrive later via callback
      for (var row of rows) {
        try {
          createDroneEmbedJob(core.db, row.source_type, row.source_id, row.chunk_index, row.content_text, config.embedding_model || 'nomic-embed-text');
          queued++;
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
      queued: queued,
      remaining: db.countUnembedded()
    });
  });

  return router;
}
