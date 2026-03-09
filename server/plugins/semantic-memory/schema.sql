-- Plugin: semantic-memory
-- Hybrid keyword (FTS5) + vector (sqlite-vec) search across platform data

CREATE TABLE IF NOT EXISTS sm_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  namespace TEXT,
  chunk_index INTEGER DEFAULT 0,
  content_text TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_sm_source ON sm_embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_sm_namespace ON sm_embeddings(namespace);

-- FTS5 index for keyword search (always available, zero-config)
CREATE VIRTUAL TABLE IF NOT EXISTS sm_embeddings_fts USING fts5(
  content_text, source_type, namespace,
  content='sm_embeddings', content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS sm_fts_insert AFTER INSERT ON sm_embeddings BEGIN
  INSERT INTO sm_embeddings_fts(rowid, content_text, source_type, namespace)
  VALUES (new.id, new.content_text, new.source_type, new.namespace);
END;

CREATE TRIGGER IF NOT EXISTS sm_fts_delete AFTER DELETE ON sm_embeddings BEGIN
  INSERT INTO sm_embeddings_fts(sm_embeddings_fts, rowid, content_text, source_type, namespace)
  VALUES ('delete', old.id, old.content_text, old.source_type, old.namespace);
END;

CREATE TRIGGER IF NOT EXISTS sm_fts_update AFTER UPDATE OF content_text ON sm_embeddings BEGIN
  INSERT INTO sm_embeddings_fts(sm_embeddings_fts, rowid, content_text, source_type, namespace)
  VALUES ('delete', old.id, old.content_text, old.source_type, old.namespace);
  INSERT INTO sm_embeddings_fts(rowid, content_text, source_type, namespace)
  VALUES (new.id, new.content_text, new.source_type, new.namespace);
END;

-- Embedding provider config
CREATE TABLE IF NOT EXISTS sm_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
