// =============== MYCELIUM — per-route usage counters ===============
// The traffic instrument the plugin-removal audits read zero-write evidence
// from (P-product 173/174+): which METHOD + route PATTERNs actually get hit,
// on THIS instance, measured — not inferred from GET-side row counts.
//
// Mounted at the /api/mycelium seam (server/index.js, directly before the
// routes router). The pattern is captured at response-finish time, when
// Express has populated req.route for the matched route — so we record the
// route PATH (/tasks/:id), never the raw URL. :id values therefore cannot
// explode cardinality. Requests that match no route (404 fallthrough) record
// the single sentinel pattern '<unmatched>' per method, so even 404-hammering
// shows up as usage evidence while staying cardinality-bounded.
//
// Everything is counted by default — including 4xx/5xx — because a client
// hammering a failing route is still traffic evidence. Prune later if the
// table proves noisy.
import { getDB } from '../db.js';

export var UNMATCHED_PATTERN = '<unmatched>';

// Daily-bucket upsert: one row per (method, route_pattern, UTC day).
// first_seen survives the upsert (INSERT-only default); last_seen advances.
var _upsertSql = 'INSERT INTO route_usage (method, route_pattern, day, count)' +
  " VALUES (?, ?, strftime('%Y-%m-%d', 'now'), 1)" +
  ' ON CONFLICT(method, route_pattern, day)' +
  " DO UPDATE SET count = count + 1, last_seen = datetime('now')";

export function recordRouteUsage(method, routePattern) {
  getDB().prepare(_upsertSql).run(method, routePattern);
}

// Throttled failure log — an instrument must never take request handling down
// (fail-soft), but it must not fail SILENTLY either: first failure logs at
// once, repeats coalesce to one line per minute with a suppression count.
var _lastErrLog = 0;
var _suppressed = 0;
function logCountError(e) {
  var now = Date.now();
  _suppressed += 1;
  if (now - _lastErrLog < 60 * 1000) return;
  var skipped = _suppressed - 1;
  _suppressed = 0;
  _lastErrLog = now;
  console.error('[route-usage] count failed (' + (skipped > 0 ? skipped + ' similar suppressed; ' : '') + e.message + ')');
}

export function routeUsageCounter(req, res, next) {
  res.on('finish', function () {
    try {
      var pattern = (req.route && req.route.path) ? String(req.route.path) : UNMATCHED_PATTERN;
      recordRouteUsage(req.method, pattern);
    } catch (e) {
      logCountError(e);
    }
  });
  next();
}
