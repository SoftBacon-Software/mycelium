// Marketing & Growth — unified plugin.
//
// Collapses the former build-in-public / social-posting / x-posting / outreach
// plugins into one. Each area keeps its own routes/db/schema/tools in a
// subdirectory; this router mounts them at their original sub-prefixes so the
// external API (/bip, /social, /x, /outreach) and the MCP tool endpoints are
// unchanged — the consolidation is in the packaging, not the surface.
//
// The plugin mounts at routePrefix "/" (see plugin.json) so these sub-prefixes
// resolve to /api/mycelium/{bip,social,x,outreach}/... exactly as before.

import { Router } from 'express';
import bipRoutes from './bip/routes.js';
import outreachRoutes from './outreach/routes.js';
import socialRoutes from './social/routes.js';
import xRoutes from './x/routes.js';

export default function (core) {
  var router = Router();
  // Calling each area builder registers its event hooks (e.g. build-in-public
  // watches milestones) and returns its router — same side effects as when
  // each was a standalone plugin.
  router.use('/bip', bipRoutes(core));
  router.use('/outreach', outreachRoutes(core));
  router.use('/social', socialRoutes(core));
  router.use('/x', xRoutes(core));
  return router;
}
