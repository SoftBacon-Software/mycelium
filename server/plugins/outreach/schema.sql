-- Outreach campaigns (per-project config for press/creator outreach)
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  persona_prompt  TEXT NOT NULL DEFAULT '',
  project_facts   TEXT NOT NULL DEFAULT '',
  templates       TEXT NOT NULL DEFAULT '{}',
  config          TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outreach contacts (press, creators, influencers)
CREATE TABLE IF NOT EXISTS outreach_contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  campaign_id     INTEGER REFERENCES outreach_campaigns(id),
  type            TEXT NOT NULL DEFAULT 'creator',
  name            TEXT NOT NULL,
  email           TEXT NOT NULL DEFAULT '',
  outlet          TEXT NOT NULL DEFAULT '',
  tier            TEXT NOT NULL DEFAULT '',
  archetype       TEXT NOT NULL DEFAULT '',
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'discovered',
  pitch_subject   TEXT NOT NULL DEFAULT '',
  pitch_body      TEXT NOT NULL DEFAULT '',
  last_content    TEXT NOT NULL DEFAULT '',
  key_assigned    TEXT NOT NULL DEFAULT '',
  pitch_sent_at   TEXT,
  followup_due_at TEXT,
  followup_sent_at TEXT,
  response_at     TEXT,
  outcome         TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_project ON outreach_campaigns(project_id);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_status ON outreach_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_project ON outreach_contacts(project_id);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_status ON outreach_contacts(status);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_campaign ON outreach_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_email ON outreach_contacts(email);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_outlet ON outreach_contacts(outlet);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_tier ON outreach_contacts(tier);
