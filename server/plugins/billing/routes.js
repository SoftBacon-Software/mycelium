import { Router } from 'express';
import Stripe from 'stripe';
import createBillingDB from './db.js';

export default function (core) {
  var router = Router();
  var db = createBillingDB(core.db);
  // Only used for webhooks.constructEvent() — no API calls made
  var stripe = new Stripe('');
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
      if (!req.rawBody) {
        console.error('[billing] rawBody not captured — signature verification will fail');
        return apiError(res, 500, 'Raw body not available for signature verification');
      }
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
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

          var existing = db.getSubscriptionByStripeId(subscriptionId);
          if (existing) {
            console.log('[billing] Subscription already exists for', subscriptionId);
            break;
          }

          // Use Stripe customer ID as canonical org ID (stable, unlike email)
          var orgId = customerId;
          var org = db.getOrg(orgId);
          if (!org) {
            core.db.prepare(
              "INSERT INTO dv_organizations (id, name, description, plan) VALUES (?, ?, ?, 'managed')"
            ).run(orgId, customerEmail || 'Customer ' + customerId, customerEmail ? 'email:' + customerEmail : '');
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

          var newStatus = sub.status;
          var periodEnd = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : '';

          db.updateSubscriptionStatus(sub.id, newStatus, periodEnd);

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

          db.updateSubscriptionStatus(subRecord.stripe_subscription_id, 'past_due', subRecord.current_period_end || '');
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
