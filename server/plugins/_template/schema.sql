-- Plugin: _template
-- Rename table prefix from template_ to YOURPLUGIN_

CREATE TABLE IF NOT EXISTS template_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  data        TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_template_items_status ON template_items(status);
