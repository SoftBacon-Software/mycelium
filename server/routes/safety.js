// Safety routes — the read surface the MCP tools
// mycelium_list_safety_events / mycelium_safety_stats have pointed at since
// they shipped, and which 404'd until now (09-26 memory-safety audit,
// finding 1: dead tools). TRUST LAYER P1.5 wires them to the append-only,
// hash-chained memory audit log (server/lib/memory-audit.js): the memory
// layer's write/edit/delete/purge/import stream IS its safety event stream,
// and this module projects it into the exact shape the tools render.
//
// Admin-only — cross-agent activity is an admin read; an agent key gets the
// same 403 every other cross-agent surface gives it.

import { getDB } from '../db.js';
import createMemoryAudit from '../lib/memory-audit.js';

export function registerSafetyRoutes(router, deps) {
  const { checkAdmin } = deps;

  // Lazy — the route manifest imports this module statically with no database
  // (the same reason admin.js calls getDB() inside its handlers), so the audit
  // helper attaches on first request, not at mount.
  var audit = null;
  function theAudit() {
    if (!audit) audit = createMemoryAudit(getDB());
    return audit;
  }

  // GET /safety/events?agent_id=&action=&since=&limit= — the projected audit
  // stream, newest first. `since` is a store-clock timestamp (at >= since).
  router.get('/safety/events', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var events = theAudit().safetyEvents({
      actor: req.query.agent_id || undefined,
      action: req.query.action || undefined,
      since: req.query.since || undefined,
      limit: parseInt(req.query.limit) || 50
    });
    res.json(events);
  });

  // GET /safety/events/stats?agent_id=&since= — {total, breakdown:[{action,
  // count}]} — what mycelium_safety_stats renders.
  router.get('/safety/events/stats', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    res.json(theAudit().safetyStats({
      actor: req.query.agent_id || undefined,
      since: req.query.since || undefined
    }));
  });
}
