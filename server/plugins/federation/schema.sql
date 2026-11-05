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
  agent_passport_cjson TEXT,         -- the verified agent passport BOUND to this
                                     -- grant at /grant (review B blocker 1): the
                                     -- souvenir is built from THIS exact canonical
                                     -- form, never from the overwritable
                                     -- fed_passports row
  kinds_writable TEXT NOT NULL,      -- JSON array
  kinds_readable TEXT NOT NULL DEFAULT '[]',
  kinds_exportable TEXT NOT NULL DEFAULT '[]',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sig_by_host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | ended | revoked
                                   -- 'revoked' = the admin kill switch
                                   -- (POST /visit/:id/end): writes AND
                                   -- souvenirs refuse; 'ended' still allows
                                   -- the idempotent souvenir rebuild.
  CHECK (status IN ('active', 'ended', 'revoked'))
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
-- replay bookkeeping on top of the row-level content-id dedupe. Keyed PER
-- OWNER: two owners importing the same bundle are two rows, so the replay
-- fast path fires for each of them (the multi-owner model the store commits
-- to elsewhere).
CREATE TABLE IF NOT EXISTS fed_imports (
  bundle_id TEXT NOT NULL,
  owner INTEGER NOT NULL,
  outcomes TEXT NOT NULL,            -- JSON array, as answered
  imported_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (bundle_id, owner)
);

-- TRUST LAYER P1.4 follow-up (#206): the AUTHOR's outstanding revokes — the
-- signed forget-statements its agents have issued, kept so the next HELLO to
-- each network carries them. A revoke for an id a holder has never seen
-- writes no standing ban (`unknown`, the M1 trade-off); without a re-send,
-- a copy that arrives LATER would land with the author's instruction lost.
-- One row per revoked row id; (agent_id, row_id) is the key — re-revoking an
-- id re-arms the entry. `revoked_at` is the message's issued_at (inside the
-- signature — age is author-asserted), `signature` verifies over the
-- single-id message the entry re-sends (verifyRevoke, byte-exact).
CREATE TABLE IF NOT EXISTS fed_revoke_outbox (
  agent_id     TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  home_network TEXT NOT NULL,
  reason       TEXT,
  revoked_at   TEXT NOT NULL,
  signature    TEXT NOT NULL,
  recorded_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, row_id)
);
CREATE INDEX IF NOT EXISTS idx_fed_revoke_outbox_age ON fed_revoke_outbox(revoked_at);

-- NOTE — provenance on the memory rows themselves (fed_agent, fed_network,
-- fed_home, fed_visit, fed_sig on sm_embeddings) is added by the guarded
-- ALTERs in store.js:CREATE at load, the same idiom semantic-memory uses for
-- its superseded_by column, and is declared for fresh databases in
-- semantic-memory/schema.sql. NULL on every pre-federation row — the
-- migration leaves existing rows valid.
