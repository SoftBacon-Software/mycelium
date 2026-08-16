// Resolves the value to pass to Express's `app.set('trust proxy', …)` from the
// TRUST_PROXY env var. Extracted from server/index.js so the resolution rule is
// unit-testable without booting the daemon (index.js calls app.listen() at import
// time, so it can't be imported into a test directly).
//
// Env vars arrive as STRINGS, so `TRUST_PROXY=false` in a .env / docker-compose
// file is the string "false", not boolean false. The documented forms are parsed
// explicitly:
//   - unset / empty / "true"  -> true   (DEFAULT; correct behind Railway/nginx/Cloudflare)
//   - "false"                 -> false  (for DIRECT-exposed instances, no proxy in front)
//   - a bare number           -> that hop count (e.g. "1")
//   - anything else           -> passed through verbatim (comma-separated CIDRs,
//                                e.g. "loopback, 10.0.0.0/8")
// See https://expressjs.com/en/guide/behind-proxies.html
//
// SECURITY: when trust proxy is ON and the instance is directly exposed (no
// reverse proxy in front), any client can forge X-Forwarded-For and spoof req.ip,
// walking past every per-IP rate limiter (login brute-force, agent-key guessing,
// admin-write limits). Operators of direct-exposed instances must set
// TRUST_PROXY=false.

export function resolveTrustProxy(env) {
  var raw = env && env.TRUST_PROXY;
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
}
