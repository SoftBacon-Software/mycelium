-- X/Twitter Posting plugin tables

CREATE TABLE IF NOT EXISTS dv_x_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL DEFAULT '',
  tweet_text      TEXT NOT NULL,
  tweet_id        TEXT,
  tweet_url       TEXT,
  thread_id       TEXT,
  thread_position INTEGER,
  source          TEXT NOT NULL DEFAULT 'manual',
  source_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  error           TEXT,
  posted_by       TEXT NOT NULL DEFAULT '',
  posted_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_x_posts_status ON dv_x_posts(status);
CREATE INDEX IF NOT EXISTS idx_dv_x_posts_thread ON dv_x_posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_dv_x_posts_source ON dv_x_posts(source, source_id);
