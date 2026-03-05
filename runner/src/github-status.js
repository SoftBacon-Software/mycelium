// GitHub status checker — polls githubstatus.com and caches result
// Fail-open: if we can't reach status page, assume operational (don't block work)

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check every 5 minutes
const STATUS_URL = 'https://www.githubstatus.com/api/v2/status.json';

let _cache = null;       // { operational, indicator, description, checkedAt }
let _checking = false;   // prevent concurrent fetches

export async function getGitHubStatus() {
  const now = Date.now();

  // Return cached result if fresh
  if (_cache && now - _cache.checkedAt < CHECK_INTERVAL_MS) {
    return _cache;
  }

  // If already fetching, return stale cache or assume operational
  if (_checking) {
    return _cache || { operational: true, indicator: 'none', description: 'Unknown' };
  }

  _checking = true;
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const indicator = data?.status?.indicator || 'none';
    const description = data?.status?.description || 'Unknown';
    const operational = indicator === 'none' || indicator === 'minor';
    _cache = { operational, indicator, description, checkedAt: now };
  } catch {
    // Can't reach status page — fail open (assume operational)
    _cache = { operational: true, indicator: 'unknown', description: 'Status page unreachable', checkedAt: now };
  } finally {
    _checking = false;
  }

  return _cache;
}

export function isGitHubDown() {
  if (!_cache) return false; // no data yet — assume fine
  return !_cache.operational;
}
