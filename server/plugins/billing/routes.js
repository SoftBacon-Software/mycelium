import { Router } from 'express';
import Stripe from 'stripe';
import crypto from 'crypto';
import createBillingDB from './db.js';
import { createInstance, updateInstance, getInstanceByOrg } from '../../db.js';
import { provisionCustomerInstance } from '../../provisioning.js';
import { sendEmail, templateInstanceReady, templatePaymentFailed, templateInstanceSuspended } from '../../email.js';

export default function (core) {
  var router = Router();
  var db = createBillingDB(core.db);
  // Lazy-init: Stripe SDK only needed for webhook signature verification.
  // Constructing with empty string throws, so defer until first webhook call.
  var stripe = null;
  function getStripe() {
    if (!stripe) stripe = new Stripe(getConfig('stripe_secret_key', 'sk_none'));
    return stripe;
  }
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
      event = getStripe().webhooks.constructEvent(req.rawBody, sig, webhookSecret);
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

          // ---- Auto-Provisioning ----
          var autoProvision = getConfig('auto_provision', 'false');
          if (autoProvision === 'true') {
            var railwayToken = getConfig('railway_token', '');
            var cloudflareToken = getConfig('cloudflare_token', '');
            var cloudflareZoneId = getConfig('cloudflare_zone_id', '');

            if (railwayToken && cloudflareToken && cloudflareZoneId) {
              var baseDomain = getConfig('base_domain', 'mycelium.fyi');
              var githubRepo = getConfig('github_repo', 'https://github.com/SoftBacon-Software/mycelium');

              // Generate slug from email (before @, sanitized) or customer ID
              var slug = customerEmail
                ? customerEmail.split('@')[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase().substring(0, 32)
                : customerId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().substring(0, 32);

              var tempPassword = crypto.randomBytes(16).toString('base64url');
              var adminKey = 'dvk_' + crypto.randomBytes(24).toString('hex');
              var jwtSecret = crypto.randomBytes(32).toString('hex');
              var adminUsername = 'admin';
              var customerDomain = slug + '.' + baseDomain;

              // Create instance record with status='provisioning'
              var instance = createInstance({
                org_id: orgId,
                domain: customerDomain,
                status: 'provisioning',
                admin_username: adminUsername,
                customer_email: customerEmail
              });

              console.log('[billing] Auto-provisioning instance', instance.id, 'for', slug, 'at', customerDomain);

              // Run provisioning async — don't block the webhook 200 response
              (async () => {
                try {
                  var result = await provisionCustomerInstance({
                    customerName: slug,
                    railwayToken: railwayToken,
                    repoUrl: githubRepo,
                    cloudflareToken: cloudflareToken,
                    cloudflareZoneId: cloudflareZoneId,
                    baseDomain: baseDomain,
                    adminKey: adminKey,
                    jwtSecret: jwtSecret,
                    adminUsername: adminUsername,
                    adminPassword: tempPassword,
                    onProgress: function (step, detail) {
                      console.log('[billing] Provisioning', slug, '-', step + ':', detail);
                    }
                  });

                  // Update instance record with Railway/CF IDs and status
                  updateInstance(instance.id, {
                    railway_project_id: result.railway.projectId,
                    railway_service_id: result.railway.serviceId,
                    railway_environment_id: result.railway.environmentId,
                    cloudflare_record_id: result.dns.recordId,
                    status: result.health.ok ? 'active' : 'deployed',
                    health_status: result.health.ok ? 'healthy' : 'unhealthy',
                    last_health_check: new Date().toISOString()
                  });

                  console.log('[billing] Provisioning complete for', slug, '- healthy:', result.health.ok);

                  // Send welcome email if health check passed and customer email exists
                  if (result.health.ok && customerEmail) {
                    try {
                      var dashboardUrl = 'https://' + customerDomain + '/studio/';
                      var emailData = templateInstanceReady(
                        customerEmail.split('@')[0],
                        customerEmail,
                        customerDomain,
                        dashboardUrl,
                        adminUsername,
                        tempPassword
                      );
                      await sendEmail(emailData);
                      console.log('[billing] Welcome email sent to', customerEmail);
                    } catch (emailErr) {
                      console.error('[billing] Failed to send welcome email:', emailErr.message);
                    }
                  }

                  // Notify operators
                  core.inbox.createInboxItemForAllOperators(
                    'instance_provisioned', 'instance', String(instance.id),
                    'Instance provisioned: ' + customerDomain,
                    (result.health.ok ? 'Healthy' : 'Health check timed out') + ' — ' + customerEmail,
                    { org_id: orgId, domain: customerDomain, healthy: result.health.ok },
                    'normal'
                  );

                } catch (provisionErr) {
                  console.error('[billing] Provisioning FAILED for', slug, ':', provisionErr.message);

                  updateInstance(instance.id, {
                    status: 'failed',
                    health_status: 'error'
                  });

                  core.inbox.createInboxItemForAllOperators(
                    'instance_provision_failed', 'instance', String(instance.id),
                    'FAILED: Instance provisioning for ' + slug,
                    provisionErr.message,
                    { org_id: orgId, slug: slug, error: provisionErr.message },
                    'urgent'
                  );
                }
              })();
            } else {
              console.log('[billing] Auto-provision enabled but missing credentials (railway_token, cloudflare_token, or cloudflare_zone_id) — skipping');
            }
          }

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
          db.updateOrgPlan(subRecord.org_id, 'suspended');
          console.log('[billing] Subscription canceled for org:', subRecord.org_id);

          // Suspend the customer instance
          var inst = getInstanceByOrg(subRecord.org_id);
          if (inst) {
            updateInstance(inst.id, {
              status: 'suspended',
              suspended_at: new Date().toISOString()
            });
            console.log('[billing] Instance', inst.id, 'suspended for org:', subRecord.org_id);

            // Send suspension email (fire-and-forget)
            if (inst.customer_email) {
              (async () => {
                try {
                  await sendEmail(templateInstanceSuspended(null, inst.customer_email, inst.domain));
                  console.log('[billing] Suspension email sent to', inst.customer_email);
                } catch (emailErr) {
                  console.error('[billing] Failed to send suspension email:', emailErr.message);
                }
              })();
            }
          }

          core.inbox.createInboxItemForAllOperators(
            'subscription_canceled', 'subscription', sub.id,
            'Subscription canceled: ' + subRecord.org_id,
            'Customer subscription canceled — instance suspended',
            { org_id: subRecord.org_id },
            'urgent'
          );
          break;
        }

        case 'invoice.payment_failed': {
          var invoice = event.data.object;
          var subRecord = db.getSubscriptionByCustomer(invoice.customer);
          if (!subRecord) break;

          db.updateSubscriptionStatus(subRecord.stripe_subscription_id, 'past_due', subRecord.current_period_end || '');
          db.updateOrgPlan(subRecord.org_id, 'past_due');
          console.log('[billing] Payment failed for org:', subRecord.org_id);

          // Send payment failed email (fire-and-forget)
          var inst = getInstanceByOrg(subRecord.org_id);
          if (inst && inst.customer_email) {
            (async () => {
              try {
                var portalUrl = ''; // TODO: generate Stripe billing portal URL
                await sendEmail(templatePaymentFailed(null, inst.customer_email, portalUrl));
                console.log('[billing] Payment failed email sent to', inst.customer_email);
              } catch (emailErr) {
                console.error('[billing] Failed to send payment failed email:', emailErr.message);
              }
            })();
          }

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
