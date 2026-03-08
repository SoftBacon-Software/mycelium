-- GitHub Sync plugin schema
-- Webhook event log and entity link mapping between GitHub and Mycelium.

CREATE TABLE IF NOT EXISTS github_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL DEFAULT '',           -- 'push', 'pull_request', 'issues', etc.
  action      TEXT NOT NULL DEFAULT '',           -- 'opened', 'closed', 'merged', etc.
  repo        TEXT NOT NULL DEFAULT '',           -- 'owner/repo'
  payload     TEXT NOT NULL DEFAULT '{}',         -- full webhook payload JSON
  processed   INTEGER NOT NULL DEFAULT 0,         -- 0=pending, 1=processed
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_github_events_repo ON github_events(repo);
CREATE INDEX IF NOT EXISTS idx_github_events_type ON github_events(event_type);
CREATE INDEX IF NOT EXISTS idx_github_events_created ON github_events(created_at DESC);

CREATE TABLE IF NOT EXISTS github_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  github_type     TEXT NOT NULL DEFAULT '',        -- 'pr', 'issue', 'check'
  github_repo     TEXT NOT NULL DEFAULT '',        -- 'owner/repo'
  github_number   INTEGER NOT NULL DEFAULT 0,      -- PR/issue number
  mycelium_type   TEXT NOT NULL DEFAULT '',        -- 'task', 'bug'
  mycelium_id     INTEGER NOT NULL DEFAULT 0,      -- Mycelium task/bug ID
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_github_links_repo ON github_links(github_repo);
CREATE INDEX IF NOT EXISTS idx_github_links_github ON github_links(github_type, github_number);
CREATE INDEX IF NOT EXISTS idx_github_links_mycelium ON github_links(mycelium_type, mycelium_id);
