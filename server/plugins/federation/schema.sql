-- Plugin: federation
-- Federation v0 (spec/federation-v0/): every Mycelium install is a network;
-- agents with passports visit, make memories, and bring them home.

-- Instance identity + policy. `network_seed` is the Ed25519 seed (hex) of this
-- network's keypair — generated on first use unless FEDERATION_NETWORK_SEED
-- pins one. Default policy: NO visitors.
CREATE TABLE IF NOT EXISTS fed_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Passports this network has seen (HELLO): agent passports and the network
-- passports they arrived with. `subject_id` is the agent_id / network_id;
-- `passport_cjson` is the exact canonical form verified on arrival.
CREATE TABLE IF NOT EXISTS fed_passports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- 'agent' | 'network'
  subject_id TEXT NOT NULL,
  home_network TEXT,                 -- agents only
  passport_cjson TEXT NOT NULL,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')),
  UNIQUE(kind, subject_id)
);

-- Grants the host side issued. Content-addressed grant_id is the primary key;
-- one live visit per visit_id.
CREATE TABLE IF NOT EXISTS fed_grants (
  grant_id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL UNIQUE,
  host_owner INTEGER NOT NULL,       -- studio userId whose scope hosts the visit
  host_network TEXT NOT NULL,        -- network_id at issue time (a re-key invalidates)
  agent_id TEXT NOT NULL,
  home_network TEXT NOT NULL,
  kinds_writable TEXT NOT NULL,      -- JSON array
  kinds_readable TEXT NOT NULL DEFAULT '[]',
  kinds_exportable TEXT NOT NULL DEFAULT '[]',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sig_by_host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'  -- active | ended
);

CREATE INDEX IF NOT EXISTS idx_fed_grants_agent ON fed_grants(agent_id, status);

-- Visits this network hosted.
CREATE TABLE IF NOT EXISTS fed_visits (
  visit_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  home_network TEXT NOT NULL,
  host_owner INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  souvenir_at TEXT
);

-- Replay protection for visitor envelopes (spec §3): every accepted nonce is
-- remembered for the stale window, then pruned.
CREATE TABLE IF NOT EXISTS fed_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT DEFAULT (datetime('now'))
);

-- Souvenir bundles this network has imported (the home side) — bundle-level
-- replay bookkeeping on top of the row-level content-id dedupe.
CREATE TABLE IF NOT EXISTS fed_imports (
  bundle_id TEXT PRIMARY KEY,
  owner INTEGER NOT NULL,
  outcomes TEXT NOT NULL,            -- JSON array, as answered
  imported_at TEXT DEFAULT (datetime('now'))
);

-- NOTE — provenance on the memory rows themselves (fed_agent, fed_network,
-- fed_home, fed_visit, fed_sig on sm_embeddings) is added by the guarded
-- ALTERs in store.js:CREATE at load, the same idiom semantic-memory uses for
-- its superseded_by column, and is declared for fresh databases in
-- semantic-memory/schema.sql. NULL on every pre-federation row — the
-- migration leaves existing rows valid.
