# Mycelium Billing Design

**Goal:** Accept payment via Stripe Payment Links, sync subscription status to the server via webhooks, enforce plan status on API calls.

## Flow

1. Operator creates a Stripe Payment Link (in Stripe dashboard) for the managed tier ($20-50/mo subscription)
2. Customer clicks link, pays via Stripe-hosted checkout
3. Stripe fires webhooks to `mycelium.fyi/api/webhooks/stripe`
4. Server records subscription — links Stripe customer ID to an org, sets `plan = 'managed'`
5. Server enforces plan — API middleware checks org plan status. Lapsed subscription = API calls rejected (403)
6. Operator manually deploys customer instance when a new payment comes through

## Server Changes

### New plugin: `billing`

Handles webhook ingestion, subscription tracking, and plan enforcement.

### New table: `dv_subscriptions`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| org_id | TEXT NOT NULL | FK to dv_organizations |
| stripe_customer_id | TEXT NOT NULL | Stripe customer ID |
| stripe_subscription_id | TEXT NOT NULL | Stripe subscription ID |
| status | TEXT NOT NULL | active, past_due, canceled, unpaid |
| plan | TEXT NOT NULL DEFAULT 'managed' | Plan tier |
| current_period_end | TEXT | ISO timestamp of current billing period end |
| created_at | TEXT | Auto-set |
| updated_at | TEXT | Auto-set on change |

### Webhook events handled

- `checkout.session.completed` — New customer. Create org (if needed), create subscription record, set org plan to 'managed'.
- `customer.subscription.updated` — Status change (e.g. active -> past_due). Update subscription record + org plan.
- `customer.subscription.deleted` — Canceled. Mark subscription canceled, set org plan back to 'free'.
- `invoice.payment_failed` — Payment failed. Update subscription status to 'past_due'.

### Webhook security

Verify Stripe webhook signatures using `STRIPE_WEBHOOK_SECRET` env var. Reject unsigned or invalid requests.

### Middleware: plan enforcement

On each API request that is org-scoped, check org's subscription status:
- `plan = 'free'` — allowed (free tier, no subscription needed)
- `plan = 'managed'` + active subscription — allowed
- `plan = 'managed'` + no active subscription — 403 "Subscription required"
- Grace period: allow `past_due` status for 7 days before enforcing

### Dashboard indicator

Show subscription status on the org page: active (green), past_due (yellow), canceled (red), none (gray).

## Dependencies

- `stripe` npm package (for webhook signature verification only — no Stripe API calls needed for Payment Links flow)
- `STRIPE_WEBHOOK_SECRET` env var

## Out of Scope

- No pricing page UI (Stripe Payment Links handles checkout)
- No instance auto-provisioning (operator does this manually)
- No customer portal (can add Stripe Customer Portal link later)
- No multiple plan tiers yet (just free vs managed)
- No usage-based billing or metering
