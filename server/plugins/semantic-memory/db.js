// Semantic Memory DB helpers

var _vecAvailable = null;

export default function createMemoryDB(db) {
  // Try to load sqlite-vec extension on first use
  if (_vecAvailable === null) {
    try {
      db.loadExtension('vec0');
      _vecAvailable = true;
      console.log('[semantic-memory] sqlite-vec loaded — vector search enabled');
    } catch (e) {
      _vecAvailable = false;
      console.log('[semantic-memory] sqlite-vec not available — FTS5-only mode');
    }
  }

  return {
    vecAvailable() { return _vecAvailable; },

    // -- Config --
    getConfig(key) {
      var row = db.prepare('SELECT value FROM sm_config WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setConfig(key, value) {
      db.prepare('INSERT OR REPLACE INTO sm_config (key, value) VALUES (?, ?)').run(key, value);
    },

    getAllConfig() {
      var rows = db.prepare('SELECT key, value FROM sm_config').all();
      var config = {};
      for (var r of rows) config[r.key] = r.value;
      return config;
    },

    // -- Index --
    index(sourceType, sourceId, contentText, opts) {
      opts = opts || {};
      var namespace = opts.namespace || null;
      var chunkIndex = opts.chunk_index || 0;
      var metadata = opts.metadata ? JSON.stringify(opts.metadata) : '{}';
      var embedding = opts.embedding || null;
      var embeddingModel = opts.embedding_model || null;

      db.prepare(`
        INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id, chunk_index)
        DO UPDATE SET content_text = excluded.content_text, namespace = excluded.namespace,
          metadata = excluded.metadata, embedding = excluded.embedding,
          embedding_model = excluded.embedding_model, updated_at = datetime('now')
      `).run(sourceType, sourceId, contentText, namespace, chunkIndex, metadata, embedding, embeddingModel);
    },

    bulkIndex(items) {
      var insertStmt = db.prepare(`
        INSERT INTO sm_embeddings (source_type, source_id, content_text, namespace, chunk_index, metadata, embedding, embedding_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id, chunk_index)
        DO UPDATE SET content_text = excluded.content_text, namespace = excluded.namespace,
          metadata = excluded.metadata, embedding = excluded.embedding,
          embedding_model = excluded.embedding_model, updated_at = datetime('now')
      `);
      var txn = db.transaction(function (items) {
        for (var item of items) {
          insertStmt.run(
            item.source_type, item.source_id, item.content_text,
            item.namespace || null, item.chunk_index || 0,
            item.metadata ? JSON.stringify(item.metadata) : '{}',
            item.embedding || null, item.embedding_model || null
          );
        }
      });
      txn(items);
      return items.length;
    },

    remove(sourceType, sourceId) {
      db.prepare('DELETE FROM sm_embeddings WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
    },

    // -- Search --
    searchKeyword(query, opts) {
      opts = opts || {};
      var limit = Math.min(opts.limit || 10, 100);
      var where = [];
      var params = [];

      // FTS5 match
      where.push("sm_embeddings_fts MATCH ?");
      // Escape special FTS5 chars and convert to prefix search
      var ftsQuery = query.replace(/['"*()]/g, '').split(/\s+/).filter(Boolean).map(function (w) { return '"' + w + '"'; }).join(' OR ');
      params.push(ftsQuery);

      if (opts.source_types && opts.source_types.length > 0) {
        where.push('source_type IN (' + opts.source_types.map(function () { return '?'; }).join(',') + ')');
        params = params.concat(opts.source_types);
      }
      if (opts.namespace) {
        where.push('namespace = ?');
        params.push(opts.namespace);
      }

      params.push(limit);

      try {
        var rows = db.prepare(
          'SELECT rowid, content_text, source_type, namespace, rank FROM sm_embeddings_fts WHERE ' + where.join(' AND ') + ' ORDER BY rank LIMIT ?'
        ).all(...params);

        // Enrich with full row data
        return rows.map(function (r) {
          var full = db.prepare('SELECT * FROM sm_embeddings WHERE id = ?').get(r.rowid);
          if (!full) return null;
          try { full.metadata = JSON.parse(full.metadata); } catch (e) { full.metadata = {}; }
          full.score = -r.rank; // FTS5 rank is negative (lower = better)
          return full;
        }).filter(Boolean);
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
        likeParams.push(limit);
        var rows = db.prepare(
          'SELECT * FROM sm_embeddings WHERE ' + likeWhere.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ?'
        ).all(...likeParams);
        return rows.map(function (r) {
          try { r.metadata = JSON.parse(r.metadata); } catch (e) { r.metadata = {}; }
          r.score = 1.0; // no ranking for LIKE fallback
          return r;
        });
      }
    },

    searchHybrid(query, opts, embeddingFn) {
      // Always do keyword search
      var keywordResults = this.searchKeyword(query, Object.assign({}, opts, { limit: (opts.limit || 10) * 2 }));

      // If no embedding function or vec not available, return keyword only
      if (!embeddingFn || !_vecAvailable) {
        return keywordResults.slice(0, opts.limit || 10);
      }

      // TODO: vector search + hybrid scoring when sqlite-vec is available
      // For now, keyword search is the primary mode
      return keywordResults.slice(0, opts.limit || 10);
    },

    // -- Stats --
    stats() {
      var total = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings').get().c;
      var withEmbedding = db.prepare('SELECT COUNT(*) as c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c;
      var byType = db.prepare('SELECT source_type, COUNT(*) as count FROM sm_embeddings GROUP BY source_type ORDER BY count DESC').all();
      var byNamespace = db.prepare('SELECT namespace, COUNT(*) as count FROM sm_embeddings WHERE namespace IS NOT NULL GROUP BY namespace ORDER BY count DESC LIMIT 20').all();
      return {
        total_indexed: total,
        with_embeddings: withEmbedding,
        embedding_coverage: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
        by_source_type: byType,
        by_namespace: byNamespace,
        vec_available: _vecAvailable
      };
    }
  };
}
