-- Social Posting plugin tables

CREATE TABLE IF NOT EXISTS dv_social_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  platform        TEXT NOT NULL,
  account_name    TEXT NOT NULL DEFAULT '',
  credentials     TEXT NOT NULL DEFAULT '{}',
  config          TEXT NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dv_social_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  account_id      INTEGER REFERENCES dv_social_accounts(id),
  platform        TEXT NOT NULL,
  clip_id         TEXT,
  video_session_id INTEGER,
  event_type      TEXT NOT NULL DEFAULT '',
  tier            TEXT NOT NULL DEFAULT 'C',
  caption         TEXT NOT NULL DEFAULT '',
  media_url       TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
  scheduled_at    TEXT,
  posted_at       TEXT,
  drone_job_id    INTEGER,
  result_data     TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_social_accounts_project ON dv_social_accounts(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_social_posts_project ON dv_social_posts(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_social_posts_status ON dv_social_posts(status);
CREATE INDEX IF NOT EXISTS idx_dv_social_posts_platform ON dv_social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_dv_social_posts_scheduled ON dv_social_posts(scheduled_at);
