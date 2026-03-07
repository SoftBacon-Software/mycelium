CREATE TABLE IF NOT EXISTS dv_subscriptions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                  TEXT NOT NULL DEFAULT '',
  stripe_customer_id      TEXT NOT NULL DEFAULT '',
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'active',
  plan                    TEXT NOT NULL DEFAULT 'managed',
  current_period_end      TEXT NOT NULL DEFAULT '',
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON dv_subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust ON dv_subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON dv_subscriptions(status);
