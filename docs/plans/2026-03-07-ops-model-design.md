# Mycelium Operations Model — End-to-End Design

**Date:** 2026-03-07
**Author:** Greatness + dev-claude
**Status:** Approved

## Overview

This document defines how Mycelium manages the full customer lifecycle: acquisition, onboarding, operations (support + deploys), and churn. The goal is to connect the existing islands (billing, provisioning, email, bugs, approvals) into a single automated pipeline with human gates where they matter.

**Current state:** Each subsystem works independently. Provisioning is 6 manual steps. Support tickets and bugs aren't classified. Deploys are YOLO pushes. No churn handling.

**Target state:** One-click onboarding from operator inbox. Tiered support with agent L1 and human L2. Canary deploys with approval gates. Automated churn lifecycle with grace periods and data archival.

---

## Customer Lifecycle

```
ACQUIRE          ONBOARD              OPERATE              RETAIN/CHURN
-------          -------              -------              ------------
Landing page     You approve          Customer uses        Payment fails
    |            from inbox           their instance           |
    v                |                    |                    v
Waitlist signup      v                    v              7-day grace
    |            One-click            Support ticket      (full access)
    v            provision:              |                    |
Operator gets    Railway + CF +       L1: agent auto       v
inbox alert      health poll +         handles          Read-only mode
    |            admin user +             |              (can export)
    v            welcome email        L2+: escalates         |
Stripe Payment       |               to you                 v
Link sent to         v                    |              30-day archive
customer         Instance ready       Bug filed if        (snapshot DB)
    |            email sent           needed                  |
    v                |                    |                   v
Webhook fires        v                    v              Tear down
    |            Customer logs        Resolution email    instance
    v            into their           sent to customer
Subscription     dashboard
created, org
plan = managed
```

---

## 1. Onboarding Pipeline

### Flow

1. Customer joins waitlist (public endpoint, rate-limited)
2. Operator gets inbox alert + email notification
3. Operator vets customer, sends Stripe Payment Link manually
4. Customer pays. Stripe fires `checkout.session.completed` webhook
5. Webhook handler triggers automated pipeline:
   - Create org (if needed)
   - Create subscription record
   - Call `provisionCustomerInstance()`:
     - Create Railway project + service
     - Add Cloudflare CNAME (`{slug}.mycelium.fyi`)
     - Poll `/health` until ready (2-min timeout)
     - Create admin user on new instance
   - Create `dv_customer_instances` record (status: active)
   - Send `templateInstanceReady()` email with dashboard URL + temp credentials
   - Notify operator inbox: "Instance provisioned for {org}"
6. If provisioning fails: urgent inbox alert with error, manual fallback

### What stays manual (for now)

- Vetting waitlist signups
- Sending Stripe Payment Link

### Self-serve upgrade path (later)

- Remove waitlist gate, embed Stripe checkout on landing page
- Same pipeline fires, zero manual steps

---

## 2. Support — Tiered Ticket Routing

### Classification (keyword-based, no ML)

| Pattern | Level | Action |
|---------|-------|--------|
| `password`, `reset`, `login` | L1 | Auto-trigger password reset flow |
| `config`, `setup`, `how to` | L1 | Assign to available agent |
| Matches existing open bug title | L1 | Link to bug, send "we're aware" template |
| Everything else | L2 | Route to operator inbox (urgent) |

### L1 Flow (agent handles directly)

1. Ticket auto-assigned to available agent
2. Agent investigates, resolves
3. Agent sends response directly — customer gets email
4. Ticket closed

### L2 Flow (agent drafts, you approve)

1. Ticket routes to operator inbox (priority: urgent)
2. You triage, assign to agent if needed
3. Agent investigates, writes draft response (`draft_response` field on ticket)
4. Ticket flagged `requires_approval = true`
5. You review/edit draft in inbox
6. You approve — response sent to customer
7. Ticket closed

### Auto-responses

- Password reset tickets: agent triggers reset flow, auto-closes ticket
- Known bug tickets: links ticket to bug, sends "we're aware and working on it" template

### Schema changes

```sql
ALTER TABLE dv_support_tickets ADD COLUMN requires_approval BOOLEAN DEFAULT false;
ALTER TABLE dv_support_tickets ADD COLUMN draft_response TEXT;
ALTER TABLE dv_support_tickets ADD COLUMN tier TEXT DEFAULT 'L2'; -- L1 or L2
ALTER TABLE dv_support_tickets ADD COLUMN assigned_agent TEXT;
```

---

## 3. Deployment — Canary + Approval Gate

### Branch strategy

- `master` — development branch, runs on mycelium.fyi (canary)
- `stable` — customer-facing branch, customer Railway services auto-deploy from this

### Flow

1. Code merged to `master`
2. Deploys to mycelium.fyi automatically (canary)
3. 2-hour soak period — agents monitor `/health` endpoint
4. If healthy: agent creates approval request (`action_type: 'deploy'`, payload: commit hash + changelog)
5. Operator approves from inbox/dashboard
6. Agent merges `master` → `stable`
7. Railway auto-deploys customer instances from `stable`
8. Agent polls each customer instance `/health` after deploy
9. All healthy → done. Any failure → pause rollout, alert operator

### What's needed

- `dv_customer_instances` table with instance URLs and Railway IDs
- Deploy workflow for agents (scripted rollout with health checks)
- Soak timer (2 hours after canary deploy before requesting approval)

---

## 4. Churn — Grace Period + Deprovisioning

### Timeline

| Day | Trigger | Status | Access | Action |
|-----|---------|--------|--------|--------|
| 0 | `invoice.payment_failed` | `past_due` | Full | Email: "Payment failed." Inbox alert. Stripe retries. |
| 7 | `customer.subscription.deleted` | `suspended` | Read-only | Email: "Suspended, 30 days to export." API writes return 403. |
| 37 | Scheduled check | `archived` | None | Snapshot DB → S3/R2. Tear down Railway + CF. Email: "Archived, 90 days to reactivate." |
| 127 | Scheduled check | `deleted` | None | Delete snapshot. Final email: "Data permanently deleted." |

### Plan enforcement middleware

Already scaffolded in billing plugin. Mount it to enforce:

| Org plan | Access |
|----------|--------|
| `managed` | Full access |
| `free` | Full access (no paid features) |
| `past_due` | Full access (grace period) |
| `suspended` | Read-only (GET only, POST/PUT/DELETE → 403) |
| `archived` | No access (instance torn down) |

### What's needed

- Daily scheduled check (agent task or cron) for suspension/archive dates
- S3/R2 integration for DB snapshots
- Reactivation flow: restore from snapshot, re-provision instance

---

## 5. The Glue — `dv_customer_instances` Table

This connects billing, provisioning, deployment, and churn:

```sql
CREATE TABLE IF NOT EXISTS dv_customer_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  railway_project_id TEXT,
  railway_service_id TEXT,
  domain TEXT,
  cloudflare_record_id TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning',
  -- provisioning, active, suspended, archived, deleted
  version TEXT,
  health_status TEXT DEFAULT 'unknown',
  last_health_check TEXT,
  suspended_at TEXT,
  archived_at TEXT,
  snapshot_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_instances_org ON dv_customer_instances(org_id);
CREATE INDEX idx_instances_status ON dv_customer_instances(status);
```

### How each system uses it

- **Billing webhook** → creates row on provision, updates status on churn events
- **Deploy agent** → reads active instances, polls health, updates version
- **Support agent** → checks instance health/status when investigating tickets
- **Churn workflow** → reads suspended_at/archived_at to determine next action

---

## 6. Agent Roles in Operations

| Function | Primary agent | Escalation |
|----------|--------------|------------|
| L1 support | macbook-claude or greatness-claude (whoever's free) | Operator inbox |
| L2 support | Assigned by operator | Operator reviews draft |
| Bug investigation | Assigned agent | Operator if unresolved > 48h |
| Deploy canary monitoring | macbook-claude | Operator on failure |
| Deploy rollout execution | macbook-claude | Operator approves, agent executes |
| Churn lifecycle checks | greatness-claude (daily) | Operator on archive/delete |
| Provisioning | Automated (webhook → pipeline) | Operator on failure |

---

## 7. Notification Map

| Event | Customer email | Operator inbox | Agent message |
|-------|---------------|----------------|---------------|
| Waitlist signup | Confirmation | Alert (urgent) | — |
| Payment received | — | Alert (normal) | — |
| Instance provisioned | Ready email (URL + creds) | Confirmation | — |
| Support ticket filed | Confirmation | Alert (L2 only) | Assignment (L1) |
| Ticket resolved | Resolution email | — | — |
| Bug filed from ticket | — | — | Assignment |
| Bug fixed (linked to ticket) | Resolution email (auto) | — | — |
| Deploy approval needed | — | Approval request | — |
| Deploy failed | — | Alert (urgent) | Pause + alert |
| Payment failed | "Update your card" | Alert (urgent) | — |
| Instance suspended | "Suspended, export data" | Alert (normal) | — |
| Instance archived | "Archived, 90 days left" | Alert (normal) | — |
| Data deleted | "Permanently deleted" | — | — |

---

## Non-Goals (for now)

- Multi-region deployment (single Railway region)
- Usage-based billing / metered pricing
- Customer self-service portal (beyond their Mycelium dashboard)
- SLA commitments or uptime guarantees
- Automated scaling of customer instances
- Multi-provider support (Fly.io, AWS — designed for but not built)
