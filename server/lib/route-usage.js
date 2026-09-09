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
// Mount attribution (P-product 184): a route pattern alone is only relative
// to the router that declares it, so semantic-memory's GET /stats and
// auto-memory's GET /stats used to collapse into ONE row — the removal
// audits could not tell which surface was dead. The stored pattern is
// therefore the FULL seam-relative path (GET /memory/stats, GET
// /auto-memory/stats, GET /workflows/), built by prefixing the mount a
// plugin's router was mounted under. That mount cannot be read from
// req.baseUrl at finish time — Express 4 restores req.baseUrl to its
// pre-dispatch value as the middleware stack unwinds (express/lib/router/
// index.js: `restore(out, req, 'baseUrl', ...)` + the `req.baseUrl =
// parentUrl` reset in next()) — so plugins.js stamps the mount onto the
// request at mount time via routeUsageMountStamp(prefix), where the prefix
// (manifest.routePrefix || '/' + name) is already in hand. Core routes
// carry no stamp: their req.route.path is already seam-relative.
//
// prefix_resolved marks the row cohort: 1 = written after this fix (pattern
// is mount-qualified or verifiably seam-relative), 0 = a legacy row from
// before the deploy, whose shape mixed mounts. The removal audits filter on
// it to read the post-fix window without mixing shapes.
//
// Everything is counted by default — including 4xx/5xx — because a client
// hammering a failing route is still traffic evidence. Prune later if the
// table proves noisy.
import { getDB } from '../db.js';

export var UNMATCHED_PATTERN = '<unmatched>';

// Daily-bucket upsert: one row per (method, route_pattern, UTC day).
// first_seen survives the upsert (INSERT-only default); last_seen advances.
// prefix_resolved = 1 on insert — every row THIS binary writes is post-fix;
// only rows written by the pre-fix binary (legacy rows backfilled by the
// db/core.js migrations bridge) carry 0. A same-day conflict re-enters the
// UPDATE branch, which leaves the marker untouched.
var _upsertSql = 'INSERT INTO route_usage (method, route_pattern, day, count, prefix_resolved)' +
  " VALUES (?, ?, strftime('%Y-%m-%d', 'now'), 1, 1)" +
  ' ON CONFLICT(method, route_pattern, day)' +
  " DO UPDATE SET count = count + 1, last_seen = datetime('now')";

export function recordRouteUsage(method, routePattern) {
  getDB().prepare(_upsertSql).run(method, routePattern);
}

// Stamp the mount a plugin router is mounted under onto the request, so the
// finish-time counter can build the full seam-relative pattern. Installed by
// plugins.js directly before guardPluginRouter(pluginRouter, ...) at the
// router.use(prefix, ...) mount. A routePrefix of '/' (root-mounted plugins,
// e.g. marketing) means "no additional mount" — the plugin's route paths are
// already seam-relative. The stamp is a private req field on purpose: at
// finish time Express has already restored req.baseUrl, and mutating
// req.baseUrl itself would leak into downstream Express machinery. The stamp
// survives a fallthrough (mount holds until the request ends), which is safe
// because surface mounts are disjoint prefixes — a request that falls
// through a plugin router matches no later route and records the global
// sentinel, which deliberately ignores the stamp to stay cardinality-bounded.
export function routeUsageMountStamp(mountPrefix) {
  var mount = (mountPrefix === '/' || mountPrefix === undefined || mountPrefix === null)
    ? ''
    : String(mountPrefix);
  return function stampRouteMount(req, res, next) {
    req._mycRouteMount = mount;
    next();
  };
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
      var pattern;
      if (req.route && req.route.path) {
        // Full seam-relative pattern: mount (stamped by routeUsageMountStamp
        // for plugin routers, '' for core routes) + the router-relative path.
        // Plain concatenation is intentional — it is what yields GET
        // /workflows/ for a '/' route under the /workflows mount.
        pattern = (req._mycRouteMount || '') + String(req.route.path);
      } else {
        // 404 fallthrough: the one global sentinel per method. The mount is
        // deliberately NOT applied — a raw-URL-free, cardinality-bounded
        // unmatched bucket is the contract, and per-mount sentinels would
        // multiply it by surface count for zero audit value.
        pattern = UNMATCHED_PATTERN;
      }
      recordRouteUsage(req.method, pattern);
    } catch (e) {
      logCountError(e);
    }
  });
  next();
}
