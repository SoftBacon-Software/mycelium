CREATE TABLE IF NOT EXISTS appointments (
  role TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  host TEXT NOT NULL,
  flag_overrides TEXT DEFAULT '{}',
  capability TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);
