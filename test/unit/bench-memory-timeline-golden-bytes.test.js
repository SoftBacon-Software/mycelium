// The byte-identity gate (task 210): the merged tree's DEFAULT path must
// produce rows byte-identical to the pre-merge bench branch's. The golden was
// generated on bench/m5max/memory-p1-skeleton @ 219ba34d (the pre-merge head)
// by bench/memory/fixtures/gen-timeline-golden.mjs — the SAME generator runs
// here against the merged tree and the bytes are compared whole: one JSON per
// line, no re-parsing, no normalization. A meta field added, dropped, reordered
// or re-typed on the default path fails this gate.
//
// This is the test that keeps 206's pre-committed "byte-identical default"
// true of the MERGE, not just of 206's own commit. The flag path
// (MYCELIUM_TIMELINE_FACTS=am_facts) is deliberately NOT pinned here — it is
// new behaviour, pinned by bench-memory-arm-mycelium-timeline-facts.test.js.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { buildGoldenRowsJsonl } from '../../bench/memory/fixtures/gen-timeline-golden.mjs';

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../bench/memory/fixtures/timeline-default-golden.rows.jsonl'
);

describe('task 210 byte-identity gate — the default path survived the merge', () => {
  it('rows from the fixed fixture are byte-identical to the pre-merge golden', async () => {
    const golden = readFileSync(GOLDEN);
    const fresh = Buffer.from(await buildGoldenRowsJsonl(), 'utf8');
    const ok = golden.equals(fresh);
    if (!ok) {
      // say WHERE the first byte diverges and show the differing line, so a
      // red gate reads as a diagnosis, not a shrug
      const g = golden.toString('utf8').split('\n');
      const f = fresh.toString('utf8').split('\n');
      let line = 0;
      while (line < Math.min(g.length, f.length) && g[line] === f[line]) line += 1;
      const context = `first differing row: #${line}\n--- golden: ${g[line]?.slice(0, 400)}\n--- fresh:  ${f[line]?.slice(0, 400)}`;
      throw new Error(`default-path rows are NOT byte-identical to the pre-merge golden\n${context}`);
    }
    expect(ok).toBe(true);
  });

  it('the golden is a real instrument: three rows, each carrying the stamped default-path meta', () => {
    const lines = readFileSync(GOLDEN, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      const row = JSON.parse(l);
      expect(row.arm).toBe('mycelium-timeline');
      expect(row.meta.read_policy).toBe('fact-episode-interleave');
      // the default path's row shape: the 205/207 stamps present, the 206
      // routes-path stamp ABSENT (it lives in the regime block, not the rows)
      expect(row.meta).toHaveProperty('read_hits');
      expect(row.meta).toHaveProperty('write_decisions');
      expect(row.meta).toHaveProperty('budget');
      expect(row.meta).not.toHaveProperty('facts_layer');
    }
  });
});
