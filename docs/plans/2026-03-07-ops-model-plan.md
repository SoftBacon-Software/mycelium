# Mycelium Operations Model — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire billing, provisioning, support, deployment, and churn into one automated pipeline so a customer goes from payment to running instance with one click, gets tiered support, receives canary-tested deploys, and follows a graceful churn lifecycle.

**Architecture:** Billing webhook triggers provisioning pipeline. Support tickets classify into L1 (agent-handled) / L2 (operator-approved). Deploys canary on master, soak, approval, merge to stable. Churn follows past_due, suspended, archived, deleted with scheduled checks. New dv_customer_instances table is the glue connecting all subsystems.

**Tech Stack:** Express, better-sqlite3, Stripe webhooks, Railway API, Cloudflare API, Resend email.

**Testing:** No test framework exists. Verify each task with curl commands and manual checks.

---

## Task 1: Add dv_customer_instances Table

The glue table that connects billing, provisioning, deploys, and churn.

**Files:**
- Modify: `server/schema.sql` (append after existing tables, near line 600)
- Modify: `server/db.js` (add CRUD functions at end of file)

**Step 1: Add schema**

In `server/schema.sql`, append after the last CREATE INDEX statement:

```sql
-- Customer instances (links billing to provisioning to deploys to churn)
CREATE TABLE IF NOT EXISTS dv_customer_instances (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                TEXT NOT NULL,
  railway_project_id    TEXT,
  railway_service_id    TEXT,
  railway_environment_id TEXT,
  domain                TEXT,
  cloudflare_record_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'provisioning',
  version               TEXT,
  health_status         TEXT DEFAULT 'unknown',
  last_health_check     TEXT,
  admin_username        TEXT,
  customer_email        TEXT,
  suspended_at          TEXT,
  archived_at           TEXT,
  snapshot_url          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_instances_org ON dv_customer_instances(org_id);
CREATE INDEX IF NOT EXISTS idx_instances_status ON dv_customer_instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_domain ON dv_customer_instances(domain);
```

**Step 2: Add DB functions**

In `server/db.js`, add at the end:

```javascript
// --- Customer Instances ---

export function createInstance(data) {
  return db.prepare(
    'INSERT INTO dv_customer_instances (org_id, railway_project_id, railway_service_id, railway_environment_id, domain, cloudflare_record_id, status, admin_username, customer_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
  ).get(
    data.org_id, data.railway_project_id || null, data.railway_service_id || null,
    data.railway_environment_id || null, data.domain || null,
    data.cloudflare_record_id || null, data.status || 'provisioning',
    data.admin_username || null, data.customer_email || null
  );
}

export function getInstance(id) {
  return db.prepare('SELECT * FROM dv_customer_instances WHERE id = ?').get(id);
}

export function getInstanceByOrg(orgId) {
  return db.prepare('SELECT * FROM dv_customer_instances WHERE org_id = ? ORDER BY created_at DESC LIMIT 1').get(orgId);
}

export function getInstanceByDomain(domain) {
  return db.prepare('SELECT * FROM dv_customer_instances WHERE domain = ?').get(domain);
}

export function listInstances(filters) {
  var where = [];
  var params = [];
  if (filters && filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters && filters.org_id) { where.push('org_id = ?'); params.push(filters.org_id); }
  var sql = 'SELECT * FROM dv_customer_instances' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT ' + ((filters && filters.limit) || 100);
  return db.prepare(sql).all(...params);
}

export function updateInstance(id, updates) {
  var sets = ["updated_at = datetime('now')"];
  var params = [];
  var allowed = ['railway_project_id', 'railway_service_id', 'railway_environment_id',
    'domain', 'cloudflare_record_id', 'status', 'version', 'health_status',
    'last_health_check', 'admin_username', 'customer_email',
    'suspended_at', 'archived_at', 'snapshot_url'];
  for (var key of allowed) {
    if (updates[key] !== undefined) { sets.push(key + ' = ?'); params.push(updates[key]); }
  }
  if (sets.length <= 1) return getInstance(id);
  params.push(id);
  db.prepare('UPDATE dv_customer_instances SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
  return getInstance(id);
}
```

**Step 3: Verify** - Start server locally, confirm table created without errors.

**Step 4: Commit**

```
git add server/schema.sql server/db.js
git commit -m "feat: add dv_customer_instances table + CRUD functions"
```

---

## Task 2: Wire Billing Webhook to Provisioning

When checkout.session.completed fires, auto-provision a customer instance.

**Files:**
- Modify: `server/plugins/billing/routes.js` (lines 50-91, the checkout handler)
- Modify: `server/plugins/billing/plugin.json` (add config keys for Railway/CF)

**Step 1: Add provisioning config keys to plugin.json**

Add to the config_schema section:

```json
"railway_token": { "type": "string", "required": false, "description": "Railway API token for auto-provisioning" },
"cloudflare_token": { "type": "string", "required": false, "description": "Cloudflare API token" },
"cloudflare_zone_id": { "type": "string", "required": false, "description": "Cloudflare zone ID for mycelium.fyi" },
"base_domain": { "type": "string", "required": false, "default": "mycelium.fyi", "description": "Base domain for customer subdomains" },
"github_repo": { "type": "string", "required": false, "default": "https://github.com/SoftBacon-Software/mycelium", "description": "Repo to deploy from" },
"auto_provision": { "type": "boolean", "required": false, "default": false, "description": "Enable auto-provisioning on payment" }
```

**Step 2: Add provisioning call to checkout handler**

In `server/plugins/billing/routes.js`, after the `db.createSubscription(...)` call (line 78) and before `core.emitEvent(...)` (line 81), add the auto-provisioning block:

- Read plugin config for auto_provision flag, railway_token, cloudflare_token, cloudflare_zone_id
- If auto_provision is enabled and credentials present:
  - Generate slug from customer email or ID
  - Generate temp password and admin key
  - Create instance record (status: provisioning) via createInstance()
  - Kick off async provisioning (don't block webhook response):
    - Call provisionCustomerInstance() from server/provisioning.js
    - On success: update instance record with Railway/CF IDs, set status=active
    - Send templateInstanceReady() welcome email with dashboard URL and temp credentials
    - Create inbox item for operators confirming provisioning
    - On failure: update instance status, create urgent inbox alert

The provisioning runs async inside an IIFE so the webhook returns 200 immediately to Stripe.

**Step 3: Verify** - Import check: `node -e "import('./server/plugins/billing/routes.js')"`

**Step 4: Commit**

```
git add server/plugins/billing/routes.js server/plugins/billing/plugin.json
git commit -m "feat: wire billing webhook to auto-provisioning pipeline"
```

---

## Task 3: Add Instance API Endpoints

Expose customer instances for the dashboard and deploy workflow.

**Files:**
- Modify: `server/routes/mycelium.js` (add endpoints near other admin routes)
- Modify: `server/db.js` (ensure instance functions are exported)

**Step 1: Add instance endpoints**

Add after the organizations section in routes/mycelium.js:

- `GET /instances` (admin) - List instances with status/org_id filters
- `GET /instances/:id` (admin) - Get single instance
- `PUT /instances/:id` (admin) - Update instance fields
- `POST /instances/:id/health-check` (admin) - Poll instance health using pollHealth() from provisioning.js, update health_status and last_health_check

**Step 2: Add db imports** - Add createInstance, getInstance, getInstanceByOrg, getInstanceByDomain, listInstances, updateInstance to the db import at top of routes/mycelium.js.

**Step 3: Verify**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" http://localhost:3002/api/mycelium/instances
```

Expected: `{ "instances": [] }`

**Step 4: Commit**

```
git add server/routes/mycelium.js
git commit -m "feat: add customer instance API endpoints"
```

---

## Task 4: Support Ticket Classification + Tiered Routing

Add L1/L2 classification, requires_approval and draft_response fields, agent assignment.

**Files:**
- Modify: `server/schema.sql` (add columns via ALTER TABLE migration)
- Modify: `server/db.js` (update updateSupportTicket allowed fields, line ~2897)
- Modify: `server/routes/mycelium.js` (modify POST /support/tickets handler at ~line 4802)

**Step 1: Add schema migration columns**

Append to server/schema.sql (wrap in the same try/catch pattern as existing migrations):

```sql
ALTER TABLE dv_support_tickets ADD COLUMN tier TEXT NOT NULL DEFAULT 'L2';
ALTER TABLE dv_support_tickets ADD COLUMN assigned_agent TEXT;
ALTER TABLE dv_support_tickets ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dv_support_tickets ADD COLUMN draft_response TEXT;
```

**Step 2: Add classifyTicket() helper**

Add near the support ticket routes (~line 4800) in routes/mycelium.js:

```javascript
function classifyTicket(subject, description) {
  var text = ((subject || '') + ' ' + (description || '')).toLowerCase();
  if (/password|reset|login|sign.?in|locked.?out|can.?t.?log/i.test(text)) {
    return { tier: 'L1', category: 'password_reset', auto_action: 'password_reset' };
  }
  if (/config|setup|how.?to|setting|install|getting.?started/i.test(text)) {
    return { tier: 'L1', category: 'config' };
  }
  if (/billing|charge|invoice|payment|cancel|refund|subscription/i.test(text)) {
    return { tier: 'L2', category: 'billing' };
  }
  if (/data.?loss|delete|missing|gone|corrupt/i.test(text)) {
    return { tier: 'L2', category: 'data_issue' };
  }
  // Check if matches existing open bug
  var bugs = db.listBugs({ status: 'open', limit: 50 });
  for (var bug of (bugs.bugs || bugs || [])) {
    if (bug.title && text.includes(bug.title.toLowerCase())) {
      return { tier: 'L1', category: 'known_bug', linked_bug_id: bug.id };
    }
  }
  return { tier: 'L2', category: 'general' };
}
```

**Step 3: Modify POST /support/tickets handler**

After ticket creation and bug linking, add classification logic:
- Call classifyTicket(subject, description)
- L1: auto-assign to available online agent (pick first non-drone), requires_approval=0
- L2: route to operator inbox as urgent, requires_approval=1
- If classification found a known bug, link it
- Update ticket with tier, category, assigned_agent, requires_approval

**Step 4: Update db.js allowed fields**

In updateSupportTicket (~line 2897), update allowed array:

```javascript
var allowed = ['subject', 'description', 'category', 'priority', 'status', 'assignee',
  'resolution', 'tier', 'assigned_agent', 'requires_approval', 'draft_response'];
```

**Step 5: Verify**

```bash
curl -s -X POST http://localhost:3002/api/mycelium/support/tickets \
  -H "Content-Type: application/json" \
  -d '{"subject":"I cant login","description":"password not working","reporter_email":"test@example.com"}'
```

Expected: Ticket with tier=L1, category=password_reset

**Step 6: Commit**

```
git add server/schema.sql server/db.js server/routes/mycelium.js
git commit -m "feat: tiered support ticket classification (L1/L2) with agent routing"
```

---

## Task 5: Mount Plan Enforcement Middleware

The checkBillingEnforcement function exists (~line 452 of mycelium.js) but is not mounted. Update it for the full plan lifecycle and mount on org-scoped routes.

**Files:**
- Modify: `server/routes/mycelium.js` (~line 452)

**Step 1: Update the enforcement function**

Replace the existing checkBillingEnforcement with:
- free, managed: full access (next())
- past_due: full access (grace period)
- suspended: read-only (GET/HEAD/OPTIONS pass, all writes return 403 with message)
- archived, deleted: all requests return 403

Read org_id from query, body, or X-Org-Id header. Skip if no org context.

**Step 2: Mount selectively**

Don't mount globally (would break the main instance). Mount on plugin routes and future customer-scoped routes. The main Mycelium instance at mycelium.fyi runs plan=managed and is never affected.

**Step 3: Verify** - Create test org with plan=suspended, attempt POST with X-Org-Id header, expect 403.

**Step 4: Commit**

```
git add server/routes/mycelium.js
git commit -m "feat: mount plan enforcement middleware (suspended=read-only, archived=blocked)"
```

---

## Task 6: Churn Lifecycle — Webhook Handlers + Emails + Daily Check

Wire Stripe webhook events to the churn timeline. Add email templates and daily check endpoint.

**Files:**
- Modify: `server/email.js` (add 4 churn email templates)
- Modify: `server/plugins/billing/routes.js` (update webhook handlers)
- Modify: `server/routes/mycelium.js` (add POST /admin/churn-check)

**Step 1: Add churn email templates to email.js**

Add 4 templates after existing ones:
- `templatePaymentFailed(name, email, portalUrl)` - "Payment failed, update your card, 7-day grace"
- `templateInstanceSuspended(name, email, domain)` - "Instance suspended, read-only for 30 days"
- `templateInstanceArchived(name, email)` - "Instance archived, 90 days to reactivate"
- `templateDataDeleted(name, email)` - "Data permanently deleted"

All use existing wrapEmail() helper and Mycelium earth-tone color scheme.

**Step 2: Update invoice.payment_failed webhook handler**

In billing/routes.js, update the handler to:
- Set subscription status to past_due
- Set org plan to past_due
- Look up customer instance, email customer with templatePaymentFailed
- Create urgent inbox item for all operators

**Step 3: Update customer.subscription.deleted webhook handler**

Update to:
- Set subscription status to canceled
- Set org plan to suspended
- Update instance status to suspended, set suspended_at timestamp
- Email customer with templateInstanceSuspended
- Create urgent inbox item

**Step 4: Add POST /admin/churn-check endpoint**

In routes/mycelium.js, add admin endpoint that:
- Lists suspended instances older than 30 days, archives them (TODO: S3 snapshot first)
- Lists archived instances older than 90 days, deletes snapshots and marks deleted
- Sends appropriate emails at each transition
- Returns { ok, results: { archived: [], deleted: [], errors: [] } }

This endpoint is called daily by an agent or cron job.

**Step 5: Verify**

```bash
curl -s -X POST -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  http://localhost:3002/api/mycelium/admin/churn-check
```

Expected: `{ "ok": true, "results": { "archived": [], "deleted": [], "errors": [] } }`

**Step 6: Commit**

```
git add server/plugins/billing/routes.js server/routes/mycelium.js server/email.js
git commit -m "feat: churn lifecycle — payment failed emails, suspension, archive/delete checks"
```

---

## Task 7: Deploy Workflow Endpoints

Add endpoints for canary health checking, deploy status, and deploy recording.

**Files:**
- Modify: `server/routes/mycelium.js`

**Step 1: Add deploy endpoints**

- `POST /admin/deploy/health-check-all` (admin) - Poll health of all active instances using pollHealth() from provisioning.js. Update each instance's health_status and last_health_check. Return results array.

- `GET /admin/deploy/status` (admin) - Return all active instances with id, org_id, domain, version, health_status, last_health_check.

- `POST /admin/deploy/record` (admin) - Takes version string and optional instance_ids array. Updates version field on specified instances (or all active if none specified). Used after merge to stable to record what version is deployed.

**Step 2: Verify**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  http://localhost:3002/api/mycelium/admin/deploy/status
```

Expected: `{ "instances": [] }`

**Step 3: Commit**

```
git add server/routes/mycelium.js
git commit -m "feat: deploy workflow endpoints — health-check-all, status, record"
```

---

## Task 8: Include Instances in Admin Overview

The dashboard overview (GET /admin/overview) should include customer instance data.

**Files:**
- Modify: `server/routes/mycelium.js` (the overview endpoint)

**Step 1:** Find the GET /admin/overview handler. Add `instances: db.listInstances({})` to the response object.

**Step 2: Verify**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  "http://localhost:3002/api/mycelium/admin/overview" | python -c "import sys,json; d=json.load(sys.stdin); print('instances' in d)"
```

Expected: True

**Step 3: Commit**

```
git add server/routes/mycelium.js
git commit -m "feat: include customer instances in admin overview"
```

---

## Task 9: Integration Smoke Test

Verify the full pipeline works end-to-end.

**Step 1:** Start server, confirm clean startup with no errors.

**Step 2:** Hit all new endpoints with curl:
- GET /instances
- GET /admin/deploy/status
- POST /admin/churn-check
- POST /support/tickets (with password-related subject for L1, novel subject for L2)
- GET /admin/overview (confirm instances key present)

**Step 3:** Final commit if any fixes needed.

---

## Task 10: Push Feature Branch + Create PR

Per the new git workflow, all changes go on a feature branch.

**Step 1:** Create branch from master: `feature/dev-claude/ops-model-pipeline`

**Step 2:** Push and create PR with summary of all changes.

**Step 3:** Squash-merge after review.

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | dv_customer_instances table + CRUD | schema.sql, db.js |
| 2 | Billing webhook to auto-provision | billing/routes.js, billing/plugin.json |
| 3 | Instance API endpoints | routes/mycelium.js |
| 4 | Support ticket L1/L2 classification | schema.sql, db.js, routes/mycelium.js |
| 5 | Plan enforcement middleware | routes/mycelium.js |
| 6 | Churn lifecycle (emails + webhooks + daily check) | billing/routes.js, routes/mycelium.js, email.js |
| 7 | Deploy workflow endpoints | routes/mycelium.js |
| 8 | Instances in admin overview | routes/mycelium.js |
| 9 | Integration smoke test | all |
| 10 | Feature branch + PR | git |

**Deferred (not in scope):**
- S3/R2 snapshot on archive (needs cloud storage credentials)
- Stripe Customer Portal URL generation (needs portal config in Stripe dashboard)
- Railway service teardown on archive (needs Railway API delete call)
- Dashboard UI for instances, deploy status, ticket triage
