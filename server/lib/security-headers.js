// Security-header policy — applied to every response the platform serves.
//
// This is the HTTP security-header contract for BOTH the mycelium.fyi public
// static site (served from public/ via express.static) and the /api/mycelium
// API. It is centralised here so the policy is a single source of truth and is
// unit-tested (test/unit/security-headers.test.js); server/index.js mounts it
// as global middleware.
//
// Why HSTS and CSP live HERE (not in the site repo):
//   - mycelium.fyi is served by THIS platform's Express server (server: railway-
//     hikari), not by the `serve` package. The site repo's serve.json / railway
//     json only govern isolated local preview; production headers come from this
//     middleware. Before this module existed the site shipped with no HSTS and
//     only a weak <meta> CSP — see PR "security(.fyi): harden the public site".
//   - Strict-Transport-Security can ONLY be enforced via an HTTP response header
//     (a <meta> tag cannot set it), so this middleware is the sole HSTS origin.
//   - The CSP is tuned for the static export: Next.js App Router hydrates via an
//     inline <script> (the RSC payload), so script-src needs 'unsafe-inline';
//     Tailwind v4 inline styles need style-src 'unsafe-inline'. The same policy
//     is mirrored as a defense-in-depth <meta> tag in the site's layout.tsx.

// max-age=2 years; includeSubDomains. `preload` intentionally omitted — it is a
// one-way door (requires submitting to the HSTS preload list and guarantees that
// every subdomain of mycelium.fyi is HTTPS forever); add it only with explicit
// operator sign-off once all subdomains are confirmed HTTPS-only.
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains';

// Locked down: no 'unsafe-eval', no wildcard hosts, no plugins, no external
// framing. Mirrors the site repo's serve.json CSP exactly.
export const CSP_VALUE = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

/**
 * The full policy as ordered [header, value] pairs. Order-stable so tests can
 * assert the whole set in one pass. X-Frame-Options: DENY backs up the CSP
 * frame-ancestors 'none' for legacy browsers; X-XSS-Protection: 0 disables the
 * buggy, exploitable legacy IE XSS auditor (modern guidance).
 */
export const SECURITY_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['X-XSS-Protection', '0'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ['Strict-Transport-Security', HSTS_VALUE],
  ['Content-Security-Policy', CSP_VALUE]
];

/**
 * Express middleware: stamp the full security-header policy onto every response.
 * CSP on JSON API responses is harmless (browsers apply CSP only to rendered
 * documents), and HSTS is desirable on every response, so applying it globally
 * is both safe and defense-in-depth.
 */
export function securityHeadersMiddleware() {
  return function securityHeaders(req, res, next) {
    for (const [key, value] of SECURITY_HEADERS) {
      res.set(key, value);
    }
    next();
  };
}

export default securityHeadersMiddleware;
