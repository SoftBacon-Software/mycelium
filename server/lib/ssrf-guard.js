// SSRF Guard - Prevent Server-Side Request Forgery
//
// This module provides a function to validate URLs and ensure they don't
// point to internal/private IP ranges that could be used for SSRF attacks.
//
// The function parses a URL, validates the scheme (http/https only), resolves the hostname
// to IP addresses, and checks that none of those IPs are in private ranges.
//
// See: https://en.wikipedia.org/wiki/Reserved_IP_addresses

/**
 * Check if an IP address is in a private/closed network range.
 * @param {string} ip - IP address string
 * @returns {boolean} True if the IP is in a private range
 */
function isPrivateIP(ip) {
  // Handle IPv4 addresses
  if (ip.includes('.')) {
    // Directly check against known private ranges
    if (ip.startsWith('127.')) return true; // 127.0.0.0/8
    if (ip.startsWith('10.')) return true; // 10.0.0.0/8
    if (ip.startsWith('172.') && parseInt(ip.split('.')[1]) >= 16 && parseInt(ip.split('.')[1]) <= 31) return true; // 172.16.0.0/12
    if (ip.startsWith('192.168.')) return true; // 192.168.0.0/16
    if (ip.startsWith('169.254.')) return true; // 169.254.0.0/16
    if (ip.startsWith('100.64.')) return true; // 100.64.0.0/10
    if (ip.startsWith('0.')) return true; // 0.0.0.0/8
  }
  
  // Handle IPv6 addresses
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true; // loopback / unspecified
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 unique-local (ULA)
    if (low.startsWith('fe80')) return true; // fe80::/10 link-local
  }
  
  return false;
}

/**
 * Assert that a URL points to a public host, not an internal/private IP.
 * 
 * @param {string} url - The URL to validate
 * @param {Object} options - Options for validation
 * @param {boolean} options.allowLoopback - Whether to allow localhost (127.0.0.1) addresses
 * @returns {Promise<{hostname: string, ip: string}>} Resolves with hostname and IP if valid
 * @throws {SSRFBlockedError} If the URL points to a private/internal IP
 */
export async function assertPublicHost(url, { allowLoopback = false } = {}) {
  try {
    const urlObj = new URL(url);
    
    // Only allow http and https schemes
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      throw new SSRFBlockedError(`Invalid URL scheme: ${urlObj.protocol}. Only http and https are allowed.`);
    }
    
    const hostname = urlObj.hostname;
    
    // If it's a direct IP address, check if it's private
    if (hostname.includes('.')) {
      // IPv4 address or localhost
      if (isPrivateIP(hostname) && !(allowLoopback && hostname === '127.0.0.1')) {
        throw new SSRFBlockedError(`URL points to private IP address: ${hostname}`);
      }
      return { hostname, ip: hostname };
    } else if (hostname.includes(':')) {
      // IPv6 address — URL.hostname keeps the brackets ([::1]); strip before checking
      const ip6 = hostname.replace(/^\[|\]$/g, '');
      if (isPrivateIP(ip6)) {
        throw new SSRFBlockedError(`URL points to private IPv6 address: ${ip6}`);
      }
      return { hostname, ip: ip6 };
    } else {
      // It's a hostname - resolve to IP addresses
      try {
        const dns = await import('dns').then(m => m.promises);
        const result = await dns.lookup(hostname, { all: true });
        
        for (const record of result) {
          const ip = record.address;
          
          // Check if it's a private IP
          if (isPrivateIP(ip) && !(allowLoopback && ip === '127.0.0.1')) {
            throw new SSRFBlockedError(`URL resolves to private IP address: ${ip}`);
          }
        }
        
        // Return the first IP (we only need one for the caller)
        return { hostname, ip: result[0].address };
      } catch (dnsError) {
        // If DNS lookup fails, we still allow the request but warn
        console.warn(`[ssrf] DNS resolution failed for ${hostname}: ${dnsError.message}`);
        return { hostname, ip: 'unknown' };
      }
    }
  } catch (error) {
    if (error instanceof SSRFBlockedError) {
      throw error;
    }
    // Re-throw with more context if needed
    throw new SSRFBlockedError(`Failed to validate URL: ${url} - ${error.message}`);
  }
}

/**
 * Custom error class for SSRF violations
 */
export class SSRFBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}