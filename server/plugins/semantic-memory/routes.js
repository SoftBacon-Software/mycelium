// Semantic Memory plugin routes

import { Router } from 'express';
import createMemoryDB from './db.js';
import { generateEmbedding, generateEmbeddingBatch } from './embeddings.js';

export default function (core) {
  var router = Router();
  var db = createMemoryDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

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

  // GET /memory/config — current provider config
  router.get('/config', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var config = db.getAllConfig();
    // Mask API key
    if (config.embedding_api_key) config.embedding_api_key = '***';
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

    // Process batch
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

  return router;
}
