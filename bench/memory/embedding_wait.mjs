// bench/memory/embedding_wait.mjs — wait for the platform's embedding coverage
// to return to ~100% after a write burst.
//
// A failed poll is "not settled yet", never fatal: on 2026-09-09 run B died
// 30 s into a 65-minute wait because ONE /memory/stats call timed out while
// the Jetson was embedding 7,767 fresh rows and serving another arm's embedder
// at the same time. The cap bounds the wait; the poll failures are counted
// and reported so a slow platform is visible in the receipt, not a crash.
//
// task 214 — namespace scope. The global number is the LAB's number: lessons
// and Aria's facts land all day, so after a burst the global index can sit
// ~40% for ~25 min while ONE run's own namespaces are long since at 100% —
// the r2 run burned its 65-min-capped wait on rows it would never read. When
// the caller names `namespaces` AND the platform answers
// GET /memory/coverage?namespace=<ns>, settle = EVERY named namespace ≥ 99.9
// and the global number gets no vote (not even a poll). A 404 — an older
// platform without the route — falls back to the global poll, sticky for the
// whole wait; the result stamps which scope actually decided:
//   wait.scope = 'namespace' | 'global'   (+ fallback_reason on a demotion)
// Poll failures stay non-fatal in both scopes (the 09-09 lesson).

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The platform client throws `METHOD /path -> <status>: …` for a non-2xx.
// ONLY a 404 says "this platform doesn't have the route yet" — that is the
// fallback. A 401/400/5xx/timeout is a poll failure like any other: counted,
// never a silent demotion to the global number.
function isRouteMissing(e) {
  return /-> 404(\b|:)/.test(String(e?.message ?? ''));
}

export async function waitForEmbeddings(
  platform,
  { beforeStats = null, namespaces = null, timeoutMs = 8 * 60 * 1000, pollMs = 15000, sleep = defaultSleep, log = () => {}, now = Date.now } = {},
) {
  const wanted = Array.isArray(namespaces) && namespaces.length > 0 ? namespaces.slice() : null;
  const t0 = now();
  let pollFailures = 0;
  let scope = null; // decided by the polls: 'namespace' | 'global' — stamped either way
  let fallbackReason = null;
  let lastGlobal = beforeStats;
  let lastByNs = null;

  while (now() - t0 < timeoutMs) {
    await sleep(pollMs);

    if (wanted && scope !== 'global') {
      const byNs = {};
      let demoted = false;
      let pollFailed = false;
      for (const ns of wanted) {
        let c;
        try {
          c = await platform.coverage(ns);
        } catch (e) {
          if (isRouteMissing(e)) {
            demoted = true;
            fallbackReason = 'GET /memory/coverage answered 404 (older platform) — fell back to the global poll';
            log(fallbackReason);
          } else {
            pollFailed = true;
          }
          break;
        }
        byNs[ns] = c.coverage_pct;
      }
      if (demoted) {
        scope = 'global'; // same iteration falls through to the global poll: an older
        // platform's wait behaves exactly as before, now stamped with its scope
      } else if (pollFailed) {
        pollFailures++;
        log(`coverage poll failed (${pollFailures} so far): platform busy, still waiting`);
        continue;
      } else {
        scope = 'namespace';
        lastByNs = byNs;
        const min = Math.min(...Object.values(byNs));
        if (min >= 99.9) {
          return {
            scope,
            namespaces: wanted,
            waited_ms: now() - t0,
            settled: true,
            poll_failures: pollFailures,
            coverage_after: min,
            coverage_by_namespace: byNs,
          };
        }
        continue;
      }
    }

    let s;
    try {
      s = await platform.stats();
    } catch (e) {
      pollFailures++;
      log(`embedding poll failed (${pollFailures} so far): ${e.message} — platform busy, still waiting`);
      continue;
    }
    lastGlobal = s;
    scope = scope ?? 'global';
    if (s.embedding_coverage >= 99.9) {
      const out = { scope: 'global', waited_ms: now() - t0, settled: true, poll_failures: pollFailures, coverage_after: s.embedding_coverage };
      if (wanted) {
        out.namespaces = wanted;
        if (fallbackReason) out.fallback_reason = fallbackReason;
      }
      return out;
    }
  }

  const namespaceAttempted = wanted && scope !== 'global';
  const out = {
    scope: scope ?? (wanted ? 'namespace' : 'global'),
    waited_ms: now() - t0,
    settled: false,
    poll_failures: pollFailures,
    coverage_after: namespaceAttempted
      ? (lastByNs ? Math.min(...Object.values(lastByNs)) : null)
      : (lastGlobal?.embedding_coverage ?? null),
  };
  if (wanted) out.namespaces = wanted;
  if (scope === 'namespace' && lastByNs) out.coverage_by_namespace = lastByNs;
  if (fallbackReason) out.fallback_reason = fallbackReason;
  out.note = namespaceAttempted
    ? 'namespace coverage did not return to ~100% before the wait timeout — searches may have run keyword-fallback; per-query modes are recorded in the rows'
    : 'embedding coverage did not return to ~100% before the wait timeout — searches may have run keyword-fallback; per-query modes are recorded in the rows';
  return out;
}

// The wait cap run.mjs has always computed per arm-write: the Jetson's ollama
// embedder is sequential (~0.3–0.5 s/row), so the wait scales with the write
// size above an 8-minute floor. Extracted (task 214) so the run and the tests
// share one definition.
export function armWaitTimeoutMs(expectedRows) {
  return Math.max(8 * 60 * 1000, expectedRows * 500);
}

// run.mjs's afterWrite wait, as one seam: the computed cap plus the run's own
// namespace list. Everything the run's receipt stamps about the wait — scope,
// waited_ms, settled, poll_failures — comes from the waitForEmbeddings result
// this returns.
export async function waitForArmEmbeddings(platform, { expected = 0, namespaces = null, beforeStats = null, log = () => {}, ...rest } = {}) {
  return waitForEmbeddings(platform, { beforeStats, namespaces, log, timeoutMs: armWaitTimeoutMs(expected), ...rest });
}
