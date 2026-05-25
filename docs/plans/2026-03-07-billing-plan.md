# Billing Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Accept Stripe payments via Payment Links, sync subscription status via webhooks, and enforce plan status on API requests.

**Architecture:** New server plugin (`billing`) following the existing plugin pattern (cost-tracker as reference). Stripe webhook endpoint receives events, updates `dv_subscriptions` table, and syncs org plan status. Middleware in the main routes file checks subscription status on org-scoped requests.

**Tech Stack:** Express plugin (routes.js + db.js + handlers.js), `stripe` npm package (webhook signature verification only), better-sqlite3.

---

### Task 1: Install stripe dependency

**Files:**
- Modify: `package.json`

**Step 1: Install stripe**

```bash
cd /path/to/mycelium && npm install stripe
```

**Step 2: Verify it installed**

```bash
cd /path/to/mycelium && node -e "require('stripe'); console.log('ok')"
```
Expected: `ok`

**Step 3: Commit**

```bash
cd /path/to/mycelium
git add package.json package-lock.json
git commit -m "feat(billing): add stripe dependency"
```

---

### Task 2: Create billing plugin scaffold

**Files:**
- Create: `server/plugins/billing/plugin.json`
- Create: `server/plugins/billing/schema.sql`
- Create: `server/plugins/billing/db.js`
- Create: `server/plugins/billing/routes.js`
- Create: `server/plugins/billing/handlers.js`

**Step 1: Create plugin.json**

Create `server/plugins/billing/plugin.json`:

```json
{
  "name": "billing",
  "version": "1.0.0",
  "displayName": "Billing",
  "description": "Stripe subscription tracking and plan enforcement via webhooks.",
  "author": "SoftBacon Software",
  "enabled": true,
  "routePrefix": "/billing",
  "schema": "schema.sql",
  "gatedActions": [],
  "configSchema": [
    {
      "key": "stripe_webhook_secret",
      "type": "string",
      "label": "Stripe Webhook Secret",
      "description": "whsec_... from Stripe dashboard. Required for webhook signature verification.",
      "default": ""
    },
    {
      "key": "grace_period_days",
      "type": "number",
      "label": "Grace Period (days)",
      "description": "Days to allow API access after payment fails before enforcing 403.",
      "default": "7"
    }
  ]
}
```

**Step 2: Create schema.sql**

Create `server/plugins/billing/schema.sql`:

```sql
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
```

**Step 3: Create db.js**

Create `server/plugins/billing/db.js`:

```javascript
export default function createBillingDB(db) {
  return {
    getSubscriptionByOrg(orgId) {
      return db.prepare(
        'SELECT * FROM dv_subscriptions WHERE org_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(orgId) || null;
    },

    getSubscriptionByStripeId(stripeSubscriptionId) {
      return db.prepare(
        'SELECT * FROM dv_subscriptions WHERE stripe_subscription_id = ?'
      ).get(stripeSubscriptionId) || null;
    },

    getSubscriptionByCustomer(stripeCustomerId) {
      return db.prepare(
        'SELECT * FROM dv_subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(stripeCustomerId) || null;
    },

    createSubscription(orgId, stripeCustomerId, stripeSubscriptionId, status, plan, periodEnd) {
      var result = db.prepare(
        `INSERT INTO dv_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status, plan, current_period_end)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(orgId, stripeCustomerId, stripeSubscriptionId, status, plan, periodEnd);
      return result.lastInsertRowid;
    },

    updateSubscriptionStatus(stripeSubscriptionId, status, periodEnd) {
      db.prepare(
        `UPDATE dv_subscriptions SET status = ?, current_period_end = ?, updated_at = datetime('now')
         WHERE stripe_subscription_id = ?`
      ).run(status, periodEnd || '', stripeSubscriptionId);
    },

    listSubscriptions() {
      return db.prepare('SELECT * FROM dv_subscriptions ORDER BY created_at DESC').all();
    },

    updateOrgPlan(orgId, plan) {
      db.prepare(
        'UPDATE dv_organizations SET plan = ? WHERE id = ?'
      ).run(plan, orgId);
    },

    getOrg(orgId) {
      return db.prepare('SELECT * FROM dv_organizations WHERE id = ?').get(orgId) || null;
    },

    getOrgByPlan(plan) {
      return db.prepare('SELECT * FROM dv_organizations WHERE plan = ?').all(plan);
    }
  };
}
```

**Step 4: Create routes.js (stub)**

Create `server/plugins/billing/routes.js`:

```javascript
import { Router } from 'express';
import createBillingDB from './db.js';

export default function (core) {
  var router = Router();
  var db = createBillingDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError } = core;

  // GET /billing/subscriptions — list all subscriptions (admin only)
  router.get('/subscriptions', function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json({ subscriptions: db.listSubscriptions() });
  });

  // GET /billing/subscriptions/:orgId — get org subscription
  router.get('/subscriptions/:orgId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var sub = db.getSubscriptionByOrg(req.params.orgId);
    if (!sub) return apiError(res, 404, 'No subscription found');
    res.json(sub);
  });

  return router;
}
```

**Step 5: Create handlers.js (stub)**

Create `server/plugins/billing/handlers.js`:

```javascript
export function registerHooks(core) {
  // No event hooks needed initially — billing is webhook-driven
}
```

**Step 6: Verify plugin loads**

```bash
cd /path/to/mycelium && node server/index.js
```

Check console for `[plugins] Loaded billing` or similar. Ctrl+C to stop.

**Step 7: Commit**

```bash
cd /path/to/mycelium
git add server/plugins/billing/
git commit -m "feat(billing): scaffold billing plugin with schema, db, routes"
```

---

### Task 3: Add Stripe webhook endpoint

**Files:**
- Modify: `server/plugins/billing/routes.js`

**Step 1: Add the webhook route**

Add this route to routes.js, before the `return router` line. This is the core of the billing plugin — Stripe sends POST requests here when subscription events occur.

Important: Stripe webhooks need the raw body for signature verification. The route must be mounted BEFORE Express json() parsing, or use `express.raw()`. Since the plugin system mounts routes after json middleware, we need to handle this by reading from `req.body` as a Buffer when content-type is not application/json.

Replace the full `routes.js` content with:

```javascript
import { Router } from 'express';
import Stripe from 'stripe';
import createBillingDB from './db.js';

export default function (core) {
  var router = Router();
  var db = createBillingDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError } = core;

  function getConfig(key, fallback) {
    var row = core.db.prepare(
      "SELECT value FROM dv_plugin_config WHERE plugin_name = 'billing' AND key = ?"
    ).get(key);
    return row ? row.value : fallback;
  }

  // POST /billing/webhook — Stripe webhook receiver
  // This endpoint does NOT require auth — Stripe signs the payload
  router.post('/webhook', function (req, res) {
    var webhookSecret = getConfig('stripe_webhook_secret', '');
    if (!webhookSecret) {
      console.error('[billing] No stripe_webhook_secret configured');
      return apiError(res, 500, 'Webhook secret not configured');
    }

    var sig = req.headers['stripe-signature'];
    if (!sig) {
      return apiError(res, 400, 'Missing stripe-signature header');
    }

    var event;
    try {
      var stripe = new Stripe('not-needed'); // only using constructEvent
      // req.body may be a string or buffer depending on middleware
      var payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
    } catch (err) {
      console.error('[billing] Webhook signature verification failed:', err.message);
      return apiError(res, 400, 'Webhook signature verification failed');
    }

    console.log('[billing] Received event:', event.type);

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          var session = event.data.object;
          var customerId = session.customer;
          var subscriptionId = session.subscription;
          var customerEmail = session.customer_details?.email || '';

          if (!subscriptionId) {
            console.log('[billing] checkout.session.completed without subscription (one-time payment?), skipping');
            break;
          }

          // Check if subscription already exists
          var existing = db.getSubscriptionByStripeId(subscriptionId);
          if (existing) {
            console.log('[billing] Subscription already exists for', subscriptionId);
            break;
          }

          // Create org from customer email or ID if it doesn't exist
          var orgId = customerEmail || customerId;
          var org = db.getOrg(orgId);
          if (!org) {
            core.db.prepare(
              "INSERT INTO dv_organizations (id, name, plan) VALUES (?, ?, 'managed')"
            ).run(orgId, customerEmail || 'Customer ' + customerId);
          } else {
            db.updateOrgPlan(orgId, 'managed');
          }

          db.createSubscription(orgId, customerId, subscriptionId, 'active', 'managed', '');
          console.log('[billing] New subscription created for org:', orgId);

          core.emitEvent('subscription_created', '__system__', null,
            'New subscription for ' + orgId, { org_id: orgId, stripe_customer_id: customerId });

          core.inbox.createInboxItemForAllOperators(
            'subscription', 'subscription', subscriptionId,
            'New subscriber: ' + orgId,
            customerEmail ? 'Email: ' + customerEmail : 'Customer: ' + customerId,
            { org_id: orgId, customer_id: customerId, email: customerEmail },
            'normal'
          );
          break;
        }

        case 'customer.subscription.updated': {
          var sub = event.data.object;
          var subRecord = db.getSubscriptionByStripeId(sub.id);
          if (!subRecord) {
            console.log('[billing] Unknown subscription:', sub.id);
            break;
          }

          var newStatus = sub.status; // active, past_due, canceled, unpaid, etc.
          var periodEnd = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : '';

          db.updateSubscriptionStatus(sub.id, newStatus, periodEnd);

          // Update org plan based on status
          if (newStatus === 'canceled' || newStatus === 'unpaid') {
            db.updateOrgPlan(subRecord.org_id, 'free');
          } else {
            db.updateOrgPlan(subRecord.org_id, 'managed');
          }

          console.log('[billing] Subscription', sub.id, 'updated to', newStatus);

          if (newStatus === 'past_due') {
            core.inbox.createInboxItemForAllOperators(
              'subscription_warning', 'subscription', sub.id,
              'Payment past due: ' + subRecord.org_id,
              'Subscription ' + sub.id + ' is past due',
              { org_id: subRecord.org_id, status: newStatus },
              'urgent'
            );
          }
          break;
        }

        case 'customer.subscription.deleted': {
          var sub = event.data.object;
          var subRecord = db.getSubscriptionByStripeId(sub.id);
          if (!subRecord) break;

          db.updateSubscriptionStatus(sub.id, 'canceled', '');
          db.updateOrgPlan(subRecord.org_id, 'free');
          console.log('[billing] Subscription canceled for org:', subRecord.org_id);

          core.inbox.createInboxItemForAllOperators(
            'subscription_canceled', 'subscription', sub.id,
            'Subscription canceled: ' + subRecord.org_id,
            'Customer canceled their subscription',
            { org_id: subRecord.org_id },
            'normal'
          );
          break;
        }

        case 'invoice.payment_failed': {
          var invoice = event.data.object;
          var subRecord = db.getSubscriptionByCustomer(invoice.customer);
          if (!subRecord) break;

          db.updateSubscriptionStatus(subRecord.stripe_subscription_id, 'past_due', '');
          console.log('[billing] Payment failed for org:', subRecord.org_id);

          core.inbox.createInboxItemForAllOperators(
            'payment_failed', 'subscription', subRecord.stripe_subscription_id,
            'Payment failed: ' + subRecord.org_id,
            'Invoice payment failed for ' + invoice.customer,
            { org_id: subRecord.org_id, invoice_id: invoice.id },
            'urgent'
          );
          break;
        }

        default:
          console.log('[billing] Unhandled event type:', event.type);
      }
    } catch (err) {
      console.error('[billing] Error processing webhook event:', err.message);
      return apiError(res, 500, 'Webhook processing error');
    }

    res.json({ received: true });
  });

  // GET /billing/subscriptions — list all subscriptions (admin only)
  router.get('/subscriptions', function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json({ subscriptions: db.listSubscriptions() });
  });

  // GET /billing/subscriptions/:orgId — get org subscription
  router.get('/subscriptions/:orgId', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var sub = db.getSubscriptionByOrg(req.params.orgId);
    if (!sub) return apiError(res, 404, 'No subscription found');
    res.json(sub);
  });

  return router;
}
```

**Step 2: Test the server starts**

```bash
cd /path/to/mycelium && node server/index.js
```

Check for no errors. Ctrl+C.

**Step 3: Commit**

```bash
cd /path/to/mycelium
git add server/plugins/billing/routes.js
git commit -m "feat(billing): add Stripe webhook endpoint with event handling"
```

---

### Task 4: Add raw body support for webhook signature verification

**Files:**
- Modify: `server/index.js`

Stripe's `constructEvent` needs the raw request body (not parsed JSON) to verify signatures. Express `json()` middleware parses it before the route runs. We need to capture the raw body.

**Step 1: Find the json middleware in index.js**

Read `server/index.js` and find where `express.json()` is called. It will look something like:

```javascript
app.use(express.json({ limit: '50mb' }));
```

**Step 2: Add raw body capture**

Change the json middleware call to also save the raw body:

```javascript
app.use(express.json({
  limit: '50mb',
  verify: function (req, res, buf) {
    // Save raw body for Stripe webhook signature verification
    if (req.url.includes('/billing/webhook')) {
      req.rawBody = buf;
    }
  }
}));
```

**Step 3: Update routes.js to use rawBody**

In `server/plugins/billing/routes.js`, change the constructEvent call from:

```javascript
var payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
```

To:

```javascript
var payload = req.rawBody || Buffer.from(JSON.stringify(req.body));
event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
```

**Step 4: Test the server starts**

```bash
cd /path/to/mycelium && node server/index.js
```

**Step 5: Commit**

```bash
cd /path/to/mycelium
git add server/index.js server/plugins/billing/routes.js
git commit -m "feat(billing): capture raw body for Stripe webhook signature verification"
```

---

### Task 5: Add plan enforcement middleware

**Files:**
- Modify: `server/routes/mycelium.js`

The enforcement middleware checks whether an org has an active subscription when its plan is 'managed'. This goes in the main routes file because it needs to run on all org-scoped API requests, not just billing routes.

**Step 1: Find where routes are initialized in mycelium.js**

Read `server/routes/mycelium.js` near the top to find the router setup. Look for `var router = Router()` or similar.

**Step 2: Add the enforcement middleware**

After the router is created but before any routes are defined, add:

```javascript
// Billing plan enforcement — check subscription status on org-scoped requests
function checkBillingEnforcement(req, res, next) {
  // Only enforce on routes that have an org context
  var orgId = req.headers['x-org-id'] || req.query.org_id;
  if (!orgId) return next();

  try {
    var org = db.prepare('SELECT * FROM dv_organizations WHERE id = ?').get(orgId);
    if (!org) return next();
    if (org.plan === 'free') return next();

    // Plan requires subscription — check it
    var sub = db.prepare(
      'SELECT * FROM dv_subscriptions WHERE org_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(orgId);

    if (!sub) {
      return res.status(403).json({ error: 'Subscription required', plan: org.plan });
    }

    if (sub.status === 'active') return next();

    if (sub.status === 'past_due') {
      // Check grace period
      var graceDays = 7;
      try {
        var row = db.prepare(
          "SELECT value FROM dv_plugin_config WHERE plugin_name = 'billing' AND key = 'grace_period_days'"
        ).get();
        if (row) graceDays = parseInt(row.value) || 7;
      } catch (e) { /* use default */ }

      var updatedAt = new Date(sub.updated_at);
      var graceEnd = new Date(updatedAt.getTime() + graceDays * 86400000);
      if (new Date() < graceEnd) return next();

      return res.status(403).json({
        error: 'Subscription past due — grace period expired',
        plan: org.plan,
        status: sub.status
      });
    }

    // canceled, unpaid, etc.
    return res.status(403).json({
      error: 'Subscription ' + sub.status,
      plan: org.plan,
      status: sub.status
    });
  } catch (e) {
    console.error('[billing] Enforcement check error:', e.message);
    return next(); // fail open — don't block on errors
  }
}
```

Note: This middleware is optional for now since we're running a single shared instance. It becomes important when multi-tenant isolation (Plan #19 step 5) ships. For now, add it but don't mount it on any routes — just export it so it can be wired up later.

**Step 3: Commit**

```bash
cd /path/to/mycelium
git add server/routes/mycelium.js
git commit -m "feat(billing): add plan enforcement middleware (not yet mounted)"
```

---

### Task 6: Add dashboard subscription indicator

**Files:**
- Modify: `public/studio/index.html` (or wherever the org management UI lives in the dashboard)

**Step 1: Find the orgs section in the dashboard**

Search the dashboard code for where organizations are displayed. Look for references to `dv_organizations` or `/api/mycelium/orgs`.

**Step 2: Add subscription status badge**

When rendering an org card/row, fetch subscription status and show a colored badge:

```javascript
// After fetching org data, also fetch subscription
var subRes = await fetch('/api/mycelium/billing/subscriptions/' + org.id, {
  headers: { 'Authorization': 'Bearer ' + token }
});
var subStatus = 'none';
if (subRes.ok) {
  var sub = await subRes.json();
  subStatus = sub.status; // active, past_due, canceled
}

// Render badge
var badgeColors = { active: '#4ade80', past_due: '#fbbf24', canceled: '#f87171', none: '#6b7280' };
var badge = document.createElement('span');
badge.textContent = subStatus;
badge.style.cssText = 'padding:2px 8px;border-radius:4px;font-size:12px;color:#fff;background:' + (badgeColors[subStatus] || badgeColors.none);
```

**Step 3: Commit**

```bash
cd /path/to/mycelium
git add public/
git commit -m "feat(billing): add subscription status badge to org dashboard"
```

---

### Task 7: Configure Stripe and test end-to-end

**Step 1: Set up Stripe webhook in test mode**

In Stripe dashboard:
1. Go to Developers > Webhooks
2. Add endpoint: `https://mycelium.fyi/api/mycelium/billing/webhook`
3. Select events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
4. Copy the webhook signing secret (`whsec_...`)

**Step 2: Store webhook secret in plugin config**

```bash
# Via direct DB or API call:
curl -X PUT https://mycelium.fyi/api/mycelium/context/keys/billing/stripe_webhook_secret \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": "whsec_YOUR_SECRET_HERE"}'
```

Or insert directly into `dv_plugin_config`:

```sql
INSERT OR REPLACE INTO dv_plugin_config (plugin_name, key, value, is_secret)
VALUES ('billing', 'stripe_webhook_secret', 'whsec_YOUR_SECRET_HERE', 1);
```

**Step 3: Create a Stripe Payment Link**

In Stripe dashboard:
1. Go to Payment Links
2. Create a new link for a recurring product ($20-50/mo)
3. Save the link URL — this is what customers use to pay

**Step 4: Test with Stripe CLI**

```bash
stripe listen --forward-to localhost:3002/api/mycelium/billing/webhook
stripe trigger checkout.session.completed
```

Verify:
- Console shows `[billing] Received event: checkout.session.completed`
- `dv_subscriptions` table has a new row
- `dv_organizations` has a new org with `plan = 'managed'`
- Operator inbox has a notification

**Step 5: Commit any fixes, deploy**

```bash
cd /path/to/mycelium
git add -A
git commit -m "feat(billing): final adjustments from e2e testing"
```

Deploy:
```bash
railway up
```
