-- residency plugin — P1 foundation schema
-- Tracks the live model-residency map: nodes + their RAM budgets, the resident
-- model set per node, and seat→backend route preferences. P1 is state + read API
-- + policy only — no actuator columns are wired to actuation yet.

CREATE TABLE IF NOT EXISTS residency_nodes (
  node_id        TEXT PRIMARY KEY,
  ram_total_gb   REAL NOT NULL,
  ram_budget_gb  REAL NOT NULL,
  actuator_kind  TEXT,
  actuator_url   TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS residency_models (
  node_id      TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  backend      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('api', 'local')),
  state        TEXT NOT NULL CHECK (state IN ('cold', 'loading', 'warm', 'resident')),
  rss_gb       REAL NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (node_id, model_id)
);

CREATE TABLE IF NOT EXISTS residency_seat_routes (
  seat      TEXT PRIMARY KEY,
  backend   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  mode_pref TEXT
);

CREATE INDEX IF NOT EXISTS idx_residency_models_node ON residency_models (node_id);
