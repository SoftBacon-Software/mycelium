// Shared per-IP rate limiter for the API's write-ish surfaces (task 240 — the
// six CodeQL js/missing-rate-limiting alerts: voice TURN credentials, three
// auto-memory facts routes, three marketing publish/approve/reject routes).
//
// Built on express-rate-limit (a pinned runtime dependency) rather than a
// hand-rolled counter so the RateLimit-* draft headers and the 429 Retry-After
// come from the maintained implementation. One in-memory store per limiter —
// each rateLimited() call is its OWN bucket, so reverify's ceiling never
// shelters supersede — which is correct for this single-process SQLite server.
//
// THE CEILINGS ARE MEASURED, NOT INVENTED. The lab's squad and runners hit this
// daemon at machine cadence from a handful of LAN/Tailscale IPs, so a limit set
// by vibes is a self-inflicted outage of the substrate. The numbers at each
// call site are >= 10x the peak per-IP per-minute rate observed on the
// production instance (jetson01 route_usage table, 2026-09-09..09-18, floored
// at 120/min), stated in the PR body. There is no per-request access log to
// read — route_usage (daily buckets) plus the runners' poll intervals are the
// instruments.
//
// MYCELIUM_RATE_LIMIT=off disables every limiter this helper builds (the
// kill-switch an operator throws when a limiter itself misbehaves).

import rateLimit from 'express-rate-limit';

export function rateLimited(name, opts) {
  opts = opts || {};
  var windowMs = opts.windowMs || 60000;
  var max = opts.max || 120;
  return rateLimit({
    windowMs: windowMs,
    // express-rate-limit 8.x renamed `max` to `limit`; the helper keeps the
    // call-site vocabulary of the brief (`max`) and maps it here.
    limit: max,
    standardHeaders: true, // RateLimit-Limit / -Remaining / -Reset (draft-6)
    legacyHeaders: false,
    skip: function () { return process.env.MYCELIUM_RATE_LIMIT === 'off'; },
    // index.js defaults `trust proxy` to TRUE for proxied deploys, which trips
    // the library's ERR_ERL_PERMISSIVE_TRUST_PROXY validation — a hard throw
    // that would 500 every request through these routes in production. The
    // spoofing caveat it warns about is already platform-documented
    // (lib/trust-proxy.js: set TRUST_PROXY=false on direct-exposed instances);
    // the other validations stay armed.
    validate: { trustProxy: false },
    handler: function (req, res) {
      var retry = res.getHeader('Retry-After');
      res.status(429).json({
        error: 'Too many requests (' + name + '): ' + max +
          ' per ' + Math.round(windowMs / 1000) + 's window. Retry after ' + retry + 's.'
      });
    },
  });
}
