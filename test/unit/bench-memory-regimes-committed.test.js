// task 341 — THE COMMITTED TABLE IS A TEST. Nothing kept 337's F3 proof
// (`node bench/memory/regimes.mjs` → empty `git diff`) from silently breaking:
// the next banked run, or a rename of a stamp field, drifts the committed
// bench/memory/regimes.md from the tool that renders it. This test IS that
// proof, permanent: it renders through the CLI's own pipeline —
// regimes.mjs's exported renderRegimes(), ONE function, no second renderer —
// and fails the suite the moment the committed file diverges.
//
// Hermetic-by-construction against the TRACKED tree: it reads the committed
// bench/memory/{results,receipts,regimes.md} of this checkout, so it is
// deterministic from git content alone (no wall clock, no network).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRunFiles, generatedFromRuns, renderRegimes } from '../../bench/memory/regimes.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMITTED = path.join(REPO_ROOT, 'bench/memory/regimes.md');
const REAL_RESULTS = path.join(REPO_ROOT, 'bench/memory/results');

// ---- a minimal unified diff (regimes.md is ~150 lines; the O(n·m) LCS is trivial)

function lcsOps(a, b) {
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push(['-', a[i]]);
      i += 1;
    } else {
      ops.push(['+', b[j]]);
      j += 1;
    }
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  return ops;
}

/** Unified diff, first `maxLines` lines — the failure message, not a library. */
function unifiedDiff(committedLines, renderedLines, { context = 3, maxLines = 40 } = {}) {
  const ops = lcsOps(committedLines, renderedLines);
  const changed = ops.map((op, idx) => (op[0] === ' ' ? -1 : idx)).filter((idx) => idx >= 0);
  if (!changed.length) return '  (no LINE differs — compare bytes: trailing newline / whitespace?)';
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = changed[0];
  for (const c of changed.slice(1)) {
    if (c - end <= 2 * context + 1) end = c;
    else {
      hunks.push([start, end]);
      start = Math.max(0, c - context);
      end = c;
    }
  }
  hunks.push([start, end]);

  const linesBefore = (idx, addMarker) => ops.slice(0, idx).filter((op) => op[0] !== addMarker).length;
  const out = [];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, Math.min(ops.length, to + context + 1));
    const aStart = linesBefore(from, '+') + 1;
    const bStart = linesBefore(from, '-') + 1;
    const aCount = slice.filter((op) => op[0] !== '+').length;
    const bCount = slice.filter((op) => op[0] !== '-').length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const [marker, line] of slice) out.push(`${marker}${line}`);
  }
  const overflow = out.length > maxLines ? `\n  … (${out.length - maxLines} more diff lines)` : '';
  return out.slice(0, maxLines).join('\n') + overflow;
}

describe('task 341 — the committed regimes.md IS the tool\'s output', () => {
  it('regenerating the table equals the committed file byte for byte (mismatch → unified diff + the fix command)', () => {
    const committed = fs.readFileSync(COMMITTED, 'utf8');
    const { md } = renderRegimes();
    expect(
      md,
      'regenerated regimes.md != the committed bench/memory/regimes.md — ' +
        'the table and the tool have DRIFTED. Unified diff (committed → regenerated, first 40 lines):\n' +
        unifiedDiff(committed.split('\n'), md.split('\n')) +
        '\nfix: node bench/memory/regimes.mjs  (then commit bench/memory/regimes.md)'
    ).toBe(committed);
  });

  it('deterministic: two renders are byte-identical, and the stamp is the runs\' newest date_utc — never the wall clock (333-F3 holds)', () => {
    const first = renderRegimes().md;
    const second = renderRegimes().md;
    expect(second).toBe(first);
    // if the wall clock ever sneaks back into the stamp, this line stops
    // matching the content-derived generatedFromRuns() and the test fails
    const stamp = generatedFromRuns(collectRunFiles(REAL_RESULTS));
    expect(first).toContain(`Generated: ${stamp} (the newest banked run file's date_utc — regeneration is byte-stable)`);
  });
});
