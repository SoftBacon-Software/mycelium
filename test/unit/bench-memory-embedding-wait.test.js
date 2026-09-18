import { describe, it, expect } from 'vitest';
import { waitForEmbeddings, waitForArmEmbeddings, armWaitTimeoutMs } from '../../bench/memory/embedding_wait.mjs';

// a clock that advances by pollMs on every sleep, so the loop is deterministic
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

describe('waitForEmbeddings — a slow platform is a wait, not a crash', () => {
  it('settles when coverage returns to ~100%', async () => {
    const c = clock();
    const polls = [{ embedding_coverage: 40 }, { embedding_coverage: 99.95 }];
    const platform = { stats: async () => polls.shift() };
    const r = await waitForEmbeddings(platform, { pollMs: 10, timeoutMs: 1000, ...c });
    expect(r).toMatchObject({ settled: true, coverage_after: 99.95, poll_failures: 0, waited_ms: 20 });
  });

  it('tolerates failed polls (timeouts on a busy platform), counts and logs them, then settles', async () => {
    const c = clock();
    const logs = [];
    const polls = [
      () => { throw new Error('curl: (28) Operation timed out after 30003 milliseconds'); },
      () => { throw new Error('GET /memory/stats -> 503'); },
      () => ({ embedding_coverage: 100 }),
    ];
    const platform = { stats: async () => polls.shift()() };
    const r = await waitForEmbeddings(platform, { pollMs: 10, timeoutMs: 1000, log: (m) => logs.push(m), ...c });
    expect(r).toMatchObject({ settled: true, poll_failures: 2 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/timed out.*still waiting/);
  });

  it('gives up at the cap with settled:false, the last good coverage and the failure count', async () => {
    const c = clock();
    let n = 0;
    const platform = { stats: async () => { n++; if (n % 2) throw new Error('slow'); return { embedding_coverage: 70 }; } };
    const r = await waitForEmbeddings(platform, { pollMs: 10, timeoutMs: 55, beforeStats: { embedding_coverage: 10 }, ...c });
    expect(r.settled).toBe(false);
    expect(r.coverage_after).toBe(70);
    expect(r.poll_failures).toBeGreaterThan(0);
    expect(r.note).toMatch(/did not return/);
  });

  it('when every poll fails, reports the pre-write coverage it was given', async () => {
    const c = clock();
    const platform = { stats: async () => { throw new Error('down'); } };
    const r = await waitForEmbeddings(platform, { pollMs: 10, timeoutMs: 25, beforeStats: { embedding_coverage: 12 }, ...c });
    expect(r).toMatchObject({ settled: false, coverage_after: 12, poll_failures: 3 });
  });

  it('a global wait stamps scope:"global" (the shape both scopes now carry)', async () => {
    const c = clock();
    const polls = [{ embedding_coverage: 40 }, { embedding_coverage: 100 }];
    const platform = { stats: async () => polls.shift() };
    const r = await waitForEmbeddings(platform, { pollMs: 10, timeoutMs: 1000, ...c });
    expect(r.scope).toBe('global');
    expect(r.namespaces).toBeUndefined();
  });
});

// task 214 — the wait learns to ask about ONE run's namespaces. The lab writes
// lessons and Aria writes facts all day: the GLOBAL number can sit ~40% for
// ~25 min after a burst while the run's own namespaces are long since at 100%
// (measured, bench r2: the global wait burned its 65-min cap on rows the run
// would never read). When the caller names namespaces AND the platform answers
// GET /memory/coverage, settle = EVERY named namespace ≥ 99.9 — the global
// number gets no vote. A 404 (older platform) falls back to today's global
// poll; a failed poll stays non-fatal (the 09-09 lesson), counted, never fatal.
describe('waitForEmbeddings — namespace scope (task 214)', () => {
  it('settles on namespace coverage while the global index sits frozen at 40 — and never polls stats', async () => {
    const c = clock();
    let statsCalls = 0;
    let poll = 0;
    const perNs = () => {
      poll++;
      return poll === 1
        ? { 'bench-p1-x': 33, 'bench-p1-x-amfacts': 100 }
        : { 'bench-p1-x': 100, 'bench-p1-x-amfacts': 100 };
    };
    const platform = {
      stats: async () => { statsCalls++; return { embedding_coverage: 40 }; },
      coverage: async (ns) => ({ namespace: ns, coverage_pct: perNs()[ns] }),
    };
    const r = await waitForEmbeddings(platform, {
      namespaces: ['bench-p1-x', 'bench-p1-x-amfacts'],
      pollMs: 10, timeoutMs: 1000, ...c,
    });
    expect(r).toMatchObject({
      scope: 'namespace',
      namespaces: ['bench-p1-x', 'bench-p1-x-amfacts'],
      settled: true,
      waited_ms: 20,
      poll_failures: 0,
      coverage_after: 100,
    });
    expect(r.coverage_by_namespace).toEqual({ 'bench-p1-x': 100, 'bench-p1-x-amfacts': 100 });
    expect(statsCalls).toBe(0); // the global freeze gets no vote, not even a poll
  });

  it('does NOT settle while any named namespace is below the bar (min rule)', async () => {
    const c = clock();
    const platform = {
      stats: async () => ({ embedding_coverage: 40 }),
      coverage: async (ns) => ({ namespace: ns, coverage_pct: ns === 'bench-p1-x' ? 100 : 60 }),
    };
    const r = await waitForEmbeddings(platform, {
      namespaces: ['bench-p1-x', 'bench-p1-x-amfacts'],
      pollMs: 10, timeoutMs: 45, ...c,
    });
    expect(r.settled).toBe(false);
    expect(r.scope).toBe('namespace');
    expect(r.coverage_after).toBe(60);
    expect(r.coverage_by_namespace).toEqual({ 'bench-p1-x': 100, 'bench-p1-x-amfacts': 60 });
    expect(r.note).toMatch(/namespace coverage did not return/);
  });

  it('a 404 from the coverage route (older platform) falls back to the global poll with scope:"global"', async () => {
    const c = clock();
    let coverageCalls = 0;
    const polls = [{ embedding_coverage: 40 }, { embedding_coverage: 100 }];
    const platform = {
      stats: async () => polls.shift(),
      coverage: async () => { coverageCalls++; throw new Error('GET /memory/coverage?namespace=x -> 404: {"error":"Not found"}'); },
    };
    const r = await waitForEmbeddings(platform, {
      namespaces: ['bench-p1-x'],
      beforeStats: { embedding_coverage: 40 },
      pollMs: 10, timeoutMs: 1000, ...c,
    });
    expect(r).toMatchObject({ scope: 'global', settled: true, coverage_after: 100, waited_ms: 20 });
    expect(r.namespaces).toEqual(['bench-p1-x']); // what the run WANTED, stamped beside what it got
    expect(r.fallback_reason).toMatch(/404/);
    expect(coverageCalls).toBe(1); // demotion is sticky — the route is not asked again
  });

  it('a failed namespace poll (timeout/5xx, NOT a 404) is non-fatal: counted, then it settles', async () => {
    const c = clock();
    const logs = [];
    let poll = 0;
    const platform = {
      stats: async () => ({ embedding_coverage: 40 }),
      coverage: async (ns) => {
        poll++;
        if (poll === 1) throw new Error('curl: (28) Operation timed out after 30003 milliseconds');
        return { namespace: ns, coverage_pct: 100 };
      },
    };
    const r = await waitForEmbeddings(platform, {
      namespaces: ['bench-p1-x'],
      pollMs: 10, timeoutMs: 1000, log: (m) => logs.push(m), ...c,
    });
    expect(r).toMatchObject({ scope: 'namespace', settled: true, poll_failures: 1 });
    expect(logs[0]).toMatch(/coverage poll failed.*still waiting/);
  });

  it('every namespace poll failing to the cap is an honest unsettled namespace wait', async () => {
    const c = clock();
    const platform = {
      stats: async () => ({ embedding_coverage: 40 }),
      coverage: async () => { throw new Error('down'); },
    };
    const r = await waitForEmbeddings(platform, {
      namespaces: ['bench-p1-x'],
      pollMs: 10, timeoutMs: 25, ...c,
    });
    expect(r.settled).toBe(false);
    expect(r.scope).toBe('namespace'); // it was ATTEMPTING namespace scope — it never fell back
    expect(r.coverage_after).toBeNull();
    expect(r.poll_failures).toBe(3); // 10 ms cadence under a 25 ms cap = three polls, same as the global test above
  });

  it('no namespaces given → today\'s global wait, unchanged', async () => {
    const c = clock();
    const platform = { stats: async () => ({ embedding_coverage: 100 }) };
    const r = await waitForEmbeddings(platform, { pollMs: 10, timeoutMs: 1000, ...c });
    expect(r.scope).toBe('global');
    expect(r.settled).toBe(true);
  });
});

// task 214 — the helper run.mjs's afterWrite actually calls: the wait cap the
// run computes (max(8 min, rows × 500 ms)) plus the run's namespace list, so
// the arm-write's stamp carries scope + namespaces without run.mjs knowing
// either detail.
describe('waitForArmEmbeddings — the run\'s wait, with its namespaces', () => {
  it('carries the namespace list and settles through the namespace route', async () => {
    const c = clock();
    let poll = 0;
    const platform = {
      stats: async () => ({ embedding_coverage: 40 }),
      coverage: async (ns) => {
        poll++;
        return { namespace: ns, coverage_pct: poll >= 2 ? 100 : 50 };
      },
    };
    const r = await waitForArmEmbeddings(platform, {
      expected: 500,
      namespaces: ['bench-p1-x', 'bench-p1-x-amfacts'],
      pollMs: 10, ...c,
    });
    expect(r.scope).toBe('namespace');
    expect(r.namespaces).toEqual(['bench-p1-x', 'bench-p1-x-amfacts']);
    expect(r.settled).toBe(true);
  });

  it('the cap scales with the write size exactly as run.mjs computed it before', () => {
    expect(armWaitTimeoutMs(0)).toBe(8 * 60 * 1000);
    expect(armWaitTimeoutMs(500)).toBe(8 * 60 * 1000); // 500 × 500 ms = 250 s < 8 min floor
    expect(armWaitTimeoutMs(2000)).toBe(1000000); // 2000 × 500 ms = 1000 s — scales past the floor
  });
});
