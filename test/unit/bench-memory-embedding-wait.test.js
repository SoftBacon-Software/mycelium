import { describe, it, expect } from 'vitest';
import { waitForEmbeddings } from '../../bench/memory/embedding_wait.mjs';

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
});
