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
