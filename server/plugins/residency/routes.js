// residency plugin — Express adapter for the mycelium platform loader
//
// The platform loader (server/plugins.js) dynamically imports this module and
// calls the default export with a `core` object whose `db` is the shared
// mycelium better-sqlite3 connection. Mounted under routePrefix "/residency",
// so GET / here resolves to GET /api/mycelium/residency.
//
// P1 is read-only: only the map endpoint is exposed. State is seeded through
// db.js helpers (by tests today; by a future ingestion/actuator step later).

import { Router } from 'express';
import createResidencyDB from './db.js';

export default function residencyRoutes(core) {
  var router = Router();
  var store = createResidencyDB(core.db);
  var auth = core && core.auth ? core.auth.checkAgentOrAdmin : function (_req, _res, next) { next(); };

  // GET /api/mycelium/residency — live map: nodes + budgets, resident set per
  // node, and seat routes.
  router.get('/', auth, function (_req, res) {
    try {
      res.json({ ok: true, residency: store.getMap() });
    } catch (err) {
      core.apiError(res, 500, 'failed to read residency map: ' + err.message);
    }
  });

  return router;
}
