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
