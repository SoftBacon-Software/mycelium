-- Slack Bridge plugin schema
-- Channel mappings between Mycelium channels and Slack channels,
-- plus a message log for audit and debugging.

CREATE TABLE IF NOT EXISTS dv_slack_channel_map (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  mycelium_channel_id   INTEGER,
  slack_channel_id      TEXT NOT NULL,
  direction             TEXT NOT NULL DEFAULT 'both',   -- 'both', 'to_slack', 'to_mycelium'
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slack_channel_map_slack ON dv_slack_channel_map(slack_channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_channel_map_mycelium ON dv_slack_channel_map(mycelium_channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_channel_map_direction ON dv_slack_channel_map(direction);

CREATE TABLE IF NOT EXISTS dv_slack_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  direction         TEXT NOT NULL,              -- 'inbound' (Slack->Mycelium) or 'outbound' (Mycelium->Slack)
  mycelium_msg_id   INTEGER,
  slack_ts          TEXT NOT NULL DEFAULT '',
  slack_channel     TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  agent_id          TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slack_messages_direction ON dv_slack_messages(direction);
CREATE INDEX IF NOT EXISTS idx_slack_messages_slack_channel ON dv_slack_messages(slack_channel);
CREATE INDEX IF NOT EXISTS idx_slack_messages_created ON dv_slack_messages(created_at DESC);
