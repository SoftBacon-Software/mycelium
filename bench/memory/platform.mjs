// Mycelium platform client for the memory benchmark.
//
// The platform address is NEVER hardcoded here: it resolves from
// MYCELIUM_URL, else from ~/.claude/hooks/substrate.conf (MYCELIUM_URL).
// The admin key resolves from MYCELIUM_ADMIN_KEY, else the macOS keychain
// service named by substrate.conf (MYCELIUM_KEYCHAIN_SERVICE).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// mDNS names (jetson01.local) carry AAAA records for addresses that do not
// route on this LAN; undici tries v6 and dies with EHOSTUNREACH where curl's
// happy-eyeballs falls back to v4. Prefer v4 — still the NAME, never a literal.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node; keep default */ }

export function parseSubstrateConf(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// env wins; then substrate.conf; else throw — a missing address is a loud
// failure, not a fallback to some IP that used to be right.
export function resolvePlatformEnv({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  let conf = {};
  const confPath = path.join(home, '.claude', 'hooks', 'substrate.conf');
  try {
    conf = parseSubstrateConf(readFile(confPath, 'utf8'));
  } catch {
    // no conf file — env is the only source then
  }
  const baseUrl = env.MYCELIUM_URL || conf.MYCELIUM_URL;
  if (!baseUrl) {
    throw new Error(
      'No Mycelium address: set MYCELIUM_URL or provide ~/.claude/hooks/substrate.conf with MYCELIUM_URL. ' +
      'This harness never hardcodes an address.'
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    keychainService: conf.MYCELIUM_KEYCHAIN_SERVICE || null,
    box3090Url: (env.BOX_3090_URL || conf.BOX_3090_URL || '').replace(/\/+$/, ''),
  };
}

export async function resolveAdminKey({ env = process.env, keychainService, run = execFileP } = {}) {
  if (env.MYCELIUM_ADMIN_KEY) return env.MYCELIUM_ADMIN_KEY;
  if (!keychainService) return null;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', keychainService, '-w']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transport: node fetch cannot reach 192.168.50.x from this Mac (v26.8.1,
// EHOSTUNREACH where /usr/bin/curl connects — router reachable, both curl
// interfaces OK, sandbox-independent; see receipt notes). When fetch dies at
// the network layer we fall back to spawning system curl, sticky per client,
// and the engine actually used is reported for the regime stamp.
function curlRequest({ method, url, headers, body, timeoutMs = 30000, run = execFileP }) {
  const args = ['-sS', '-X', method, '--max-time', String(Math.ceil(timeoutMs / 1000)), '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) args.push('--data-binary', body);
  args.push(url);
  return run('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).then(({ stdout }) => {
    const at = stdout.lastIndexOf('\n');
    const status = parseInt(stdout.slice(at + 1), 10);
    const text = stdout.slice(0, at);
    return { status, text };
  });
}

const NETWORK_LAYER = /EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR|fetch failed|network|abort|socket hang up/i;

// undici's failed fetch is a TypeError('fetch failed') whose CAUSE carries the
// socket code (UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT, ECONNRESET, …). Testing
// `cause.code || message` alone let 'UND_ERR_SOCKET' fall through as
// non-transient: run B3 (2026-09-09) died at question 43/50 on a bare
// "fetch failed" that neither switched to curl nor retried. Test every field.
export function isNetworkLayerError(e) {
  const text = [e?.cause?.code, e?.cause?.message, e?.code, e?.name, e?.message].filter(Boolean).join(' ');
  return NETWORK_LAYER.test(text);
}

function status_429_5xx(e) {
  const m = String(e?.message || '').match(/-> (\d{3})/);
  if (!m) return false;
  const s = parseInt(m[1], 10);
  return s === 429 || s >= 500;
}

export function createPlatform({ baseUrl, headers = {}, fetchImpl = fetch, maxRetries = 4, engine = 'auto', timeoutMs = 30000, curlRun = execFileP }) {
  const api = `${baseUrl}/api/mycelium`;
  let usingCurl = engine === 'curl';

  async function transport(method, urlPath, body) {
    const url = `${api}${urlPath}`;
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (!usingCurl) {
      try {
        const res = await fetchImpl(url, {
          method,
          headers: hdrs,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, text: await res.text() };
      } catch (e) {
        if (engine !== 'auto' || !isNetworkLayerError(e)) throw e;
        usingCurl = true; // sticky: stop paying the dead fetch on every call
      }
    }
    return curlRequest({ method, url, headers: hdrs, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs, run: curlRun });
  }

  async function call(method, urlPath, body) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { status, text } = await transport(method, urlPath, body);
        if (status === 429 || status >= 500) {
          lastErr = new Error(`${method} ${urlPath} -> ${status}`);
          if (attempt < maxRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw lastErr;
        }
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (status >= 400) throw new Error(`${method} ${urlPath} -> ${status}: ${text.slice(0, 200)}`);
        return json;
      } catch (e) {
        const transient = status_429_5xx(e) || isNetworkLayerError(e);
        lastErr = e;
        if (!transient || attempt >= maxRetries) throw lastErr;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  return {
    baseUrl,
    get engine() { return usingCurl ? 'curl' : 'fetch'; },
    // Chunk-aware: the server splits oversized content itself; returns rows written.
    async indexBulk(items) {
      const out = [];
      for (let i = 0; i < items.length; i += 100) {
        const batch = items.slice(i, i + 100);
        const r = await call('POST', '/memory/index/bulk', { items: batch });
        out.push(r);
      }
      return out;
    },
    async search({ query, namespace, sourceTypes, limit }) {
      const body = { query, limit, mode: 'hybrid' };
      if (namespace) body.namespace = namespace;
      if (sourceTypes && sourceTypes.length) body.source_types = sourceTypes;
      return call('POST', '/memory/search', body);
    },
    async deleteIndex(sourceType, sourceId) {
      return call('DELETE', `/memory/index/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceId)}`);
    },
    async listByType(sourceType, { namespace, limit } = {}) {
      const q = new URLSearchParams({ source_type: sourceType });
      if (namespace) q.set('namespace', namespace);
      if (limit) q.set('limit', String(limit));
      return call('GET', `/memory/list?${q}`);
    },
    async stats() { return call('GET', '/memory/stats'); },
    async config() { return call('GET', '/memory/config'); },
    async health() {
      // /health is served at the server ROOT, not under /api/mycelium
      const url = `${baseUrl}/health`;
      if (!usingCurl) {
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
          return JSON.parse(await res.text());
        } catch (e) {
          if (engine !== 'auto' || !isNetworkLayerError(e)) throw e;
          usingCurl = true;
        }
      }
      const { text } = await curlRequest({ method: 'GET', url, headers: {}, timeoutMs, run: curlRun });
      return JSON.parse(text);
    },
  };
}
