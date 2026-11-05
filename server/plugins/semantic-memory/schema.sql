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
  -- Companion Memory API (docs/companion-memory-api.md): a superseded row is
  -- MARKED, not deleted — this column names the row that replaced it. History
  -- is kept; recall filters it out unless the caller opts back in.
  superseded_by TEXT,
  -- Federation v0 (server/plugins/federation/, spec/federation-v0/): rows that
  -- crossed a network border carry provenance. NULL on every home-written and
  -- pre-federation row — the federation plugin's guarded ALTERs add these to
  -- databases that predate the columns (fresh DBs get them here).
  fed_agent TEXT,     -- agent_id of the writer
  fed_network TEXT,   -- network_id where the row was MADE
  fed_home TEXT,      -- the writer's home network
  fed_visit TEXT,     -- visit id (null on home-written rows)
  fed_sig TEXT,       -- the row's Ed25519 signature (null on home rows)
  -- TRUST LAYER P0.2 (F-mycelium/250): the AUTHENTICATED identity that wrote
  -- this row, stamped by the agent routes at write time. NULL = written
  -- before write authority existed (or by an internal writer) = only the
  -- admin key may overwrite or delete it. The guarded ALTER in db.js adds
  -- this to databases that predate the column (fresh DBs get it here).
  written_by TEXT,
  -- TRUST LAYER P1.1 (F-mycelium/265): trust + provenance that survive
  -- derivation. origin = WHO the content came from (person | owner-agent |
  -- tool | model-derived | foreign-network; NULL = unknown — server/lib/
  -- trust-origins.js is the one definition). trust = the row's trust level
  -- (0..4 on the origin ladder; NULL = no stamp, read as the LOWEST).
  -- derived_from = JSON array of input row refs ("sm:<source_type>:<source_id>"
  -- or "am:<fact_id>") on DERIVED rows — summaries, consolidations, lessons,
  -- extracted facts — whose trust is the MIN of those inputs, resolved
  -- server-side at write time. A body claim above the writer's surface
  -- ceiling is ignored and flagged (metadata.claimed_origin) — the P0
  -- claimed_actor pattern. The guarded ALTERs in db.js carry all three to
  -- existing databases.
  origin TEXT,
  trust INTEGER DEFAULT 0,
  derived_from TEXT,
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

-- TRUST LAYER P1.4 (F-mycelium/267): deletion that propagates. Every true
-- delete of an index row leaves a tombstone — the row's identity, when it
-- died, the AUTHENTICATED actor that deleted it, and why. Deliberately NO
-- content column: a tombstone remembers THAT a row died, never WHAT it said
-- (the whole row is checked for content in trust-layer-p1-4-deletion.test.js).
-- Two jobs: the deletion record the audit reads, and the resurrection guard
-- the federation import door consults (a row forgotten here is refused at
-- the border, so a replayed souvenir cannot raise it). Append-only: a row
-- deleted, legitimately re-indexed and deleted again gets a second row.
CREATE TABLE IF NOT EXISTS sm_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  deleted_at TEXT DEFAULT (datetime('now')),
  deleted_by TEXT,                    -- authenticated actor (agent id / admin display); NULL = internal writer
  reason TEXT NOT NULL DEFAULT 'delete'
);
CREATE INDEX IF NOT EXISTS idx_sm_tombstones_row ON sm_tombstones(source_type, source_id);

-- Embedding provider config
CREATE TABLE IF NOT EXISTS sm_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Freshness signature for the decoded-vector cache (vector-cache.js,
-- F-mycelium/194): the embedded-row count is recomputed per search so an
-- out-of-band writer (auto-memory deletes rows directly) self-heals on the
-- next search. The partial index makes that count an index-only scan — it
-- never touches the table's multi-KB embedding pages.
CREATE INDEX IF NOT EXISTS idx_sm_embedded ON sm_embeddings(id) WHERE embedding IS NOT NULL;

-- The cache's own read path (vector-cache.js ID_SCAN, F-mycelium/196): every
-- rebuild and every post-drift reconcile selects the embedded ids ordered by
-- updated_at DESC. Without this index that scan is a table scan plus a TEMP
-- B-TREE sort over the multi-KB embedding rows — ~62 ms per read at 25k rows,
-- the bulk of a reconcile tick. Covering (updated_at, id) with the same
-- partial predicate makes it an index-only backward scan (~2 ms at 25k,
-- measured), which is what keeps the post-prune heal under the 50 ms
-- loop-blocking budget.
CREATE INDEX IF NOT EXISTS idx_sm_embedded_recent ON sm_embeddings(updated_at, id) WHERE embedding IS NOT NULL;
