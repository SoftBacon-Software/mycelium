// Route-manifest stdout-purity gate — runs under `npx vitest run` (test/**/*.test.js).
//
// Spawns the extractor as a REAL process and asserts its STDOUT is exactly the
// route manifest: every non-empty line is `METHOD /path`, and the line count
// equals the committed snapshot. The manifest contract lives on stdout — F-mycelium/19
// derives the endpoint count from these output lines, so any import-time
// side-effect in a route module (e.g. a `console.log` at boot) would inflate it.
//
// This reads LIVE stdout, not a frozen expectation: restoring an import-time log
// in server/routes/mycelium.js (e.g. the smart-boot dependency loader) makes this
// test RED. It complements route-manifest.mjs --check, which is unaffected by
// stdout noise because it diffs the in-memory manifest against the snapshot.
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = join(HERE, 'route-manifest.mjs');
const SNAPSHOT = join(HERE, 'route-manifest.snapshot');

// A valid route-manifest line: METHOD, a space, then a path beginning with /.
const ROUTE_LINE = /^(GET|POST|PUT|DELETE|PATCH) \//;

// Run the extractor in PRINT mode and capture ONLY stdout. stderr is discarded so
// a legitimately noisy boot log there can't mask or mimic a stdout contaminant.
function extractorStdout() {
  return execFileSync('node', [EXTRACTOR], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('route-manifest extractor — stdout purity', () => {
  test('every stdout line is a route line (no import-time side-effects)', () => {
    const out = extractorStdout();
    const lines = out.split('\n').filter((l) => l !== '');
    const offenders = lines.filter((l) => !ROUTE_LINE.test(l));

    expect(
      offenders,
      `non-route stdout lines leaked by an import-time side-effect: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  test('stdout line count equals the snapshot route count', () => {
    const out = extractorStdout();
    const stdoutRoutes = out.split('\n').filter((l) => l !== '').length;

    const snapshot = readFileSync(SNAPSHOT, 'utf8');
    const snapshotRoutes = snapshot.trim().split('\n').length;

    expect(stdoutRoutes).toBe(snapshotRoutes);
  });
});
