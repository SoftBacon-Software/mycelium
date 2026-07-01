// residency plugin — Express adapter for the mycelium platform loader
//
// The platform loader (server/plugins.js) dynamically imports this module and
// calls the default export with a `core` object whose `db` is the shared
// mycelium better-sqlite3 connection. Mounted under routePrefix "/residency",
// so GET / here resolves to GET /api/mycelium/residency.
//
// Auth is IMPERATIVE, not middleware. core.auth.checkAgentOrAdmin(req, res)
// sends a 401/403 itself and returns the authenticated principal (or falsy);
// it never calls next(). Using it as Express middleware therefore hangs every
// authenticated request (the handler never runs). We call it inline and bail
// on a falsy return, matching the pattern used in routes/mycelium.js.

import { Router } from 'express';
import createResidencyDB from './db.js';
import { decideResidency } from './src/policy.js';

export default function residencyRoutes(core) {
  var router = Router();
  var store = createResidencyDB(core.db);

  // Imperative auth: returns the principal on success, or falsy after it has
  // already sent a 401/403. When no auth is wired (factory/test path), allow.
  function authenticate(req, res) {
    if (core && core.auth && core.auth.checkAgentOrAdmin) {
      return core.auth.checkAgentOrAdmin(req, res);
    }
    return true;
  }

  // GET /api/mycelium/residency — live map: nodes + budgets, resident set per
  // node, and seat routes.
  router.get('/', function (req, res) {
    var who = authenticate(req, res);
    if (!who) return; // 401/403 already sent
    try {
      res.json({ ok: true, residency: store.getMap() });
    } catch (err) {
      core.apiError(res, 500, 'failed to read residency map: ' + err.message);
    }
  });

  // POST /api/mycelium/residency/decide — run the residency policy engine on a
  // candidate model against the current resident set, given a RAM budget.
  // Body: { resident_set: string[], candidate: string, ram_budget_gb: number }
  // Response: { ok: true, decision: { action: 'co-reside'|'swap', reason, total_gb } }
  router.post('/decide', function (req, res) {
    var who = authenticate(req, res);
    if (!who) return; // 401/403 already sent
    var body = req.body || {};
    var residentSet = body.resident_set;
    var candidate = body.candidate;
    var ramBudgetGb = body.ram_budget_gb;
    if (
      !Array.isArray(residentSet) ||
      typeof candidate !== 'string' || candidate.length === 0 ||
      typeof ramBudgetGb !== 'number'
    ) {
      return core.apiError(
        res,
        400,
        'missing or invalid fields: resident_set (string[]), candidate (string), ram_budget_gb (number)'
      );
    }
    try {
      var decision = decideResidency(residentSet, candidate, ramBudgetGb);
      res.json({ ok: true, decision: decision });
    } catch (err) {
      core.apiError(res, 500, 'failed to decide residency: ' + err.message);
    }
  });

  return router;
}
