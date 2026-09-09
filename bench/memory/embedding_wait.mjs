// bench/memory/embedding_wait.mjs — wait for the platform's embedding coverage
// to return to ~100% after a write burst.
//
// A failed poll is "not settled yet", never fatal: on 2026-09-09 run B died
// 30 s into a 65-minute wait because ONE /memory/stats call timed out while
// the Jetson was embedding 7,767 fresh rows and serving another arm's embedder
// at the same time. The cap bounds the wait; the poll failures are counted
// and reported so a slow platform is visible in the receipt, not a crash.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForEmbeddings(
  platform,
  { beforeStats = null, timeoutMs = 8 * 60 * 1000, pollMs = 15000, sleep = defaultSleep, log = () => {}, now = Date.now } = {},
) {
  const t0 = now();
  let last = beforeStats;
  let pollFailures = 0;
  while (now() - t0 < timeoutMs) {
    await sleep(pollMs);
    let s;
    try {
      s = await platform.stats();
    } catch (e) {
      pollFailures++;
      log(`embedding poll failed (${pollFailures} so far): ${e.message} — platform busy, still waiting`);
      continue;
    }
    last = s;
    if (s.embedding_coverage >= 99.9) {
      return { waited_ms: now() - t0, coverage_after: s.embedding_coverage, settled: true, poll_failures: pollFailures };
    }
  }
  return {
    waited_ms: now() - t0,
    coverage_after: last?.embedding_coverage ?? null,
    settled: false,
    poll_failures: pollFailures,
    note: 'embedding coverage did not return to ~100% before the wait timeout — searches may have run keyword-fallback; per-query modes are recorded in the rows',
  };
}
