-- Steam Assets plugin tables

CREATE TABLE IF NOT EXISTS dv_steam_assets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  asset_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  drone_job_id    INTEGER,
  config          TEXT NOT NULL DEFAULT '{}',
  result_data     TEXT NOT NULL DEFAULT '{}',
  result_url      TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_steam_assets_project ON dv_steam_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_dv_steam_assets_type ON dv_steam_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_dv_steam_assets_status ON dv_steam_assets(status);
