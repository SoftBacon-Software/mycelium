-- Marketing & Growth plugin schema — concatenated from the four merged areas.
-- (bip / social / x / outreach). Table names unchanged for data compatibility.

-- ===== bip =====
-- Build-in-Public plugin schema
-- Drafts of social content generated from agent events, pending operator approval.

CREATE TABLE IF NOT EXISTS bip_drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_event   TEXT NOT NULL DEFAULT '',         -- 'task_completed', 'plan_step_completed', etc.
  trigger_data    TEXT NOT NULL DEFAULT '{}',       -- the event payload that triggered this
  title           TEXT NOT NULL DEFAULT '',         -- headline (e.g. "macbook-claude shipped operator inbox")
  content         TEXT NOT NULL DEFAULT '',         -- draft post content
  platforms       TEXT NOT NULL DEFAULT '["twitter"]',
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending','approved','rejected','published','skipped'
  approval_id     INTEGER,                          -- linked approvals entry
  inbox_item_id   TEXT NOT NULL DEFAULT '[]',       -- JSON array of linked operator_inbox ids
  rejection_note  TEXT NOT NULL DEFAULT '',
  posted_at       TEXT,
  post_ids        TEXT NOT NULL DEFAULT '{}',       -- platform -> post id
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bip_drafts_status ON bip_drafts(status);
CREATE INDEX IF NOT EXISTS idx_bip_drafts_event ON bip_drafts(trigger_event);
CREATE INDEX IF NOT EXISTS idx_bip_drafts_created ON bip_drafts(created_at DESC);

-- ===== social =====
-- Social Posting plugin tables

CREATE TABLE IF NOT EXISTS social_accounts (
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

CREATE TABLE IF NOT EXISTS social_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  account_id      INTEGER REFERENCES social_accounts(id),
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

CREATE INDEX IF NOT EXISTS idx_social_accounts_project ON social_accounts(project_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_project ON social_posts(project_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled ON social_posts(scheduled_at);

-- ===== x =====
-- X/Twitter Posting plugin tables

CREATE TABLE IF NOT EXISTS x_posts (
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

CREATE INDEX IF NOT EXISTS idx_x_posts_status ON x_posts(status);
CREATE INDEX IF NOT EXISTS idx_x_posts_thread ON x_posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_x_posts_source ON x_posts(source, source_id);

-- ===== outreach =====
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

