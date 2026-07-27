// SSRF Guard - Prevent Server-Side Request Forgery
//
// Validates a URL: http/https only, resolves the hostname via DNS, and refuses
// any resolved IP in a private / loopback / link-local / metadata range.
// Fails CLOSED: an unresolvable or unparseable host is rejected, not dispatched.
// See: https://en.wikipedia.org/wiki/Reserved_IP_addresses

import net from 'net';

/** Custom error for SSRF violations. */
export class SSRFBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}

/**
 * Is this IP literal in a private / closed range?
 * @param {string} ip - a literal IPv4 or IPv6 address (no brackets)
 * @returns {boolean}
 */
function isPrivateIP(ip) {
  // IPv4
  if (net.isIP(ip) === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127) return true;                        // 127.0.0.0/8 loopback
    if (o[0] === 10) return true;                         // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;        // 192.168.0.0/16
    if (o[0] === 169 && o[1] === 254) return true;        // 169.254.0.0/16 link-local + cloud metadata
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64.0.0/10 CGNAT
    if (o[0] === 0) return true;                          // 0.0.0.0/8
    return false;
  }
  // IPv6
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;        // loopback / unspecified
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 unique-local (ULA)
    if (low.startsWith('fe80')) return true;               // fe80::/10 link-local
    // IPv4-mapped IPv6 — embedded v4 may be dotted (::ffff:10.0.0.1) or
    // hex-normalized by URL parsing (::ffff:a00:1). Decode both and check.
    if (low.startsWith('::ffff:')) {
      const tail = low.slice('::ffff:'.length);
      let v4 = null;
      if (tail.includes('.')) {
        v4 = tail;
      } else {
        const g = tail.split(':');
        if (g.length === 2) {
          const hi = parseInt(g[0], 16), lo = parseInt(g[1], 16);
          if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
            v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          }
        }
      }
      if (v4 && net.isIP(v4) === 4 && isPrivateIP(v4)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Assert a URL points to a public host. Resolves hostnames and checks every
 * returned record. Fails CLOSED.
 * @param {string} url
 * @param {{allowLoopback?: boolean}} options
 * @returns {Promise<{hostname: string, ip: string}>}
 * @throws {SSRFBlockedError}
 */
export async function assertPublicHost(url, { allowLoopback = false } = {}) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    throw new SSRFBlockedError(`Invalid URL: ${url}`);
  }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new SSRFBlockedError(`Invalid URL scheme: ${urlObj.protocol}. Only http and https are allowed.`);
  }

  // URL.hostname keeps IPv6 brackets ([::1]) — strip them
  const host = urlObj.hostname.replace(/^\[|\]$/g, '');

  const check = (ip) => {
    const isLoopback = ip === '127.0.0.1' || ip === '::1';
    if (isPrivateIP(ip) && !(allowLoopback && isLoopback)) {
      throw new SSRFBlockedError(`URL points to private IP address: ${ip}`);
    }
  };

  const fam = net.isIP(host);
  if (fam === 4 || fam === 6) {
    // Literal IP — check directly, no DNS needed
    check(host);
    return { hostname: host, ip: host };
  }

  // It's a hostname — ALWAYS resolve and check EVERY resolved address (A + AAAA)
  let records;
  try {
    const dns = (await import('dns')).promises;
    records = await dns.lookup(host, { all: true, family: 0 });
  } catch (dnsError) {
    // Fail CLOSED: an unresolvable host is not provably public
    throw new SSRFBlockedError(`DNS resolution failed for ${host}: ${dnsError.message}`);
  }
  if (!records || records.length === 0) {
    throw new SSRFBlockedError(`No DNS records for ${host}`);
  }
  for (const r of records) check(r.address);
  return { hostname: host, ip: records[0].address };
}

// HTTP statuses that constitute a redirect the guard must follow manually so it
// can re-validate the target. Matches fetch's own redirect set.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Upper bound on manual redirect following. Tighter than fetch's built-in 20 —
// these are server-to-server webhook/discover calls, not a browser.
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * fetch() that re-runs `assertPublicHost` on the initial URL **and on the
 * resolved target of every redirect hop**, then bounds the hop count.
 *
 * `assertPublicHost` alone only vetoes the *first* hop. With Node's default
 * `redirect: 'follow'`, a public host can answer `302 → http://127.0.0.1/…`
 * (or any internal/metadata address) and `fetch` will silently follow it — an
 * SSRF bypass. By forcing `redirect: 'manual'` and re-validating each
 * `Location` before following, every hop is gated. Re-resolving DNS at each hop
 * also narrows (does not eliminate) the DNS-rebinding TOCTOU window between
 * validation and connect.
 *
 * Note: Node's global `fetch` (undici), unlike the browser WHATWG fetch, exposes
 * the real 3xx status and a readable `Location` header under `redirect:
 * 'manual'` — so no extra dependency is needed to follow hops manually.
 *
 * @param {string} url
 * @param {object} [options] - standard fetch options; `redirect` is forced to 'manual'
 * @param {{ allowLoopback?: boolean, maxRedirects?: number }} [guardOptions]
 * @returns {Promise<Response>} the final (non-redirect) response
 * @throws {SSRFBlockedError} if any hop targets a private/internal host, on a
 *   malformed `Location`, or when the hop count is exceeded
 */
export async function guardedFetch(url, options = {}, { allowLoopback = false, maxRedirects = DEFAULT_MAX_REDIRECTS } = {}) {
  let fetchOpts = { ...options, redirect: 'manual' };
  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate the host on EVERY hop — first hop and each redirect target.
    await assertPublicHost(currentUrl, { allowLoopback });

    const response = await fetch(currentUrl, fetchOpts);
    const status = response.status;
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(status) || !location) {
      return response;
    }
    if (hop === maxRedirects) {
      throw new SSRFBlockedError(`Too many redirects (>${maxRedirects}) following ${url}`);
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch (e) {
      throw new SSRFBlockedError(`Malformed redirect Location: ${location}`);
    }
    currentUrl = nextUrl;
    // Match fetch redirect semantics: 301/302/303 downgrade the method to GET
    // and drop the body; 307/308 preserve method and body. (A body on a GET
    // would make undici throw, so it must be cleared.)
    if (status === 301 || status === 302 || status === 303) {
      const method = (fetchOpts.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        fetchOpts = { ...fetchOpts, method: 'GET', body: undefined };
      }
    }
  }
  // Unreachable when maxRedirects >= 0, but fail CLOSED rather than returning
  // undefined if the loop ever exits without resolving.
  throw new SSRFBlockedError(`Too many redirects following ${url}`);
}
