-- Video Pipeline plugin tables

CREATE TABLE IF NOT EXISTS dv_video_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  footage_url     TEXT NOT NULL DEFAULT '',
  event_log_url   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',
  detect_job_id   INTEGER,
  assemble_job_id INTEGER,
  export_job_id   INTEGER,
  clip_count      INTEGER NOT NULL DEFAULT 0,
  config          TEXT NOT NULL DEFAULT '{}',
  result_data     TEXT NOT NULL DEFAULT '{}',
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dv_video_clips (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES dv_video_sessions(id),
  clip_id         TEXT NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'C',
  event_type      TEXT NOT NULL,
  start_sec       REAL NOT NULL DEFAULT 0,
  end_sec         REAL NOT NULL DEFAULT 0,
  duration_sec    REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'detected',
  platforms       TEXT NOT NULL DEFAULT '[]',
  caption_data    TEXT NOT NULL DEFAULT '{}',
  metadata        TEXT NOT NULL DEFAULT '{}',
  result_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_video_sessions_project ON dv_video_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_video_sessions_status ON dv_video_sessions(status);
CREATE INDEX IF NOT EXISTS idx_dv_video_clips_session ON dv_video_clips(session_id);
CREATE INDEX IF NOT EXISTS idx_dv_video_clips_tier ON dv_video_clips(tier);
