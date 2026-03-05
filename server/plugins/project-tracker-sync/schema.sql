-- Project Tracker Sync: link Mycelium entities to external tracker issues

CREATE TABLE IF NOT EXISTS dv_tracker_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_key TEXT DEFAULT '',
  mycelium_type TEXT NOT NULL DEFAULT 'task',
  mycelium_id INTEGER NOT NULL,
  last_synced TEXT DEFAULT (datetime('now')),
  sync_status TEXT DEFAULT 'synced',
  conflict_data TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracker_links_external ON dv_tracker_links(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_tracker_links_mycelium ON dv_tracker_links(mycelium_type, mycelium_id);
CREATE INDEX IF NOT EXISTS idx_tracker_links_sync_status ON dv_tracker_links(sync_status);

CREATE TABLE IF NOT EXISTS dv_tracker_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  direction TEXT,
  action TEXT,
  mycelium_id INTEGER,
  external_id TEXT,
  status TEXT DEFAULT 'success',
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracker_sync_log_provider ON dv_tracker_sync_log(provider);
CREATE INDEX IF NOT EXISTS idx_tracker_sync_log_status ON dv_tracker_sync_log(status);

CREATE TABLE IF NOT EXISTS dv_tracker_status_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  mycelium_status TEXT NOT NULL,
  external_status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracker_status_map_provider ON dv_tracker_status_map(provider);
