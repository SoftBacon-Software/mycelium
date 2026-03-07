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
    }
  };
}
