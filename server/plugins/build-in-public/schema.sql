-- Build-in-Public plugin schema
-- Drafts of social content generated from agent events, pending operator approval.

CREATE TABLE IF NOT EXISTS dv_bip_drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_event   TEXT NOT NULL DEFAULT '',         -- 'task_completed', 'plan_step_completed', etc.
  trigger_data    TEXT NOT NULL DEFAULT '{}',       -- the event payload that triggered this
  title           TEXT NOT NULL DEFAULT '',         -- headline (e.g. "macbook-claude shipped operator inbox")
  content         TEXT NOT NULL DEFAULT '',         -- draft post content
  platforms       TEXT NOT NULL DEFAULT '["twitter"]',
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending','approved','rejected','published','skipped'
  approval_id     INTEGER,                          -- linked dv_approvals entry
  inbox_item_id   TEXT NOT NULL DEFAULT '[]',       -- JSON array of linked dv_operator_inbox ids
  rejection_note  TEXT NOT NULL DEFAULT '',
  posted_at       TEXT,
  post_ids        TEXT NOT NULL DEFAULT '{}',       -- platform -> post id
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_bip_drafts_status ON dv_bip_drafts(status);
CREATE INDEX IF NOT EXISTS idx_dv_bip_drafts_event ON dv_bip_drafts(trigger_event);
CREATE INDEX IF NOT EXISTS idx_dv_bip_drafts_created ON dv_bip_drafts(created_at DESC);
