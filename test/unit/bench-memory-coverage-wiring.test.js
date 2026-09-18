// task 214 wiring — the run's namespace list reaches the embedding wait, and
// the wait's scope stamp reaches the run's artifacts.
//
// Two of the three pins here are SOURCE pins on run.mjs (the afterWrite call
// site and the embed_wait stamp): run.mjs is a CLI script whose main() runs on
// invocation, so its wiring is pinned by source and proven end-to-end by the
// capped smoke (bench/memory/results/<task-214-smoke>/summary.json carries
// embed_wait.scope = 'namespace'). The receipt half is a REAL behavior test:
// renderReceipt must render the wait block when the run's write info carries
// one, and stay silent when it doesn't (an arm without a platform write —
// 'none', mem0, zep, letta — has no wait to render).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { renderReceipt } from '../../bench/memory/receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = join(HERE, '..', '..', 'bench', 'memory', 'run.mjs');

describe('task 214 — run.mjs passes the run\'s namespaces to the wait', () => {
  const src = readFileSync(RUN_MJS, 'utf8');

  it('afterWrite waits through waitForArmEmbeddings with namespaces: runNamespaces', () => {
    expect(src).toMatch(/waitForArmEmbeddings\(platform,\s*\{[^}]*namespaces:\s*runNamespaces/s);
  });

  it('the wait result is still stamped onto the arm\'s write info (the summary seam)', () => {
    expect(src).toMatch(/\.embed_wait\s*=\s*wait/);
  });

  it('run.mjs no longer imports the bare wait (one caller, one seam)', () => {
    expect(src).not.toMatch(/waitForEmbeddings/);
  });
});

describe('task 214 — the receipt renders the wait stamp per arm-write', () => {
  const base = {
    runId: '2026-09-17-p1-test',
    summary: { arms: { mycelium: { n: 1 } }, write_info: {} },
    generatedAt: '2026-09-17T00:00:00Z',
  };

  it('renders scope, namespaces, waited_ms, settled and poll_failures for a namespace-scoped wait', () => {
    const md = renderReceipt({
      ...base,
      writeInfo: {
        mycelium: {
          docs: 5,
          rows: 120,
          embed_wait: {
            scope: 'namespace',
            namespaces: ['bench-p1-x', 'bench-p1-x-amfacts'],
            waited_ms: 41234,
            settled: true,
            poll_failures: 2,
            coverage_after: 100,
          },
        },
      },
    });
    expect(md).toMatch(/Embedding wait \(mycelium arm\): scope=namespace/);
    expect(md).toMatch(/waited_ms=41234/);
    expect(md).toMatch(/settled=true/);
    expect(md).toMatch(/poll_failures=2/);
    expect(md).toMatch(/bench-p1-x-amfacts/);
  });

  it('renders the 404 fallback honestly when the wait demoted to global', () => {
    const md = renderReceipt({
      ...base,
      writeInfo: {
        mycelium: {
          embed_wait: {
            scope: 'global',
            namespaces: ['bench-p1-x'],
            fallback_reason: 'GET /memory/coverage answered 404 (older platform)',
            waited_ms: 900,
            settled: true,
            poll_failures: 0,
          },
        },
      },
    });
    expect(md).toMatch(/scope=global/);
    expect(md).toMatch(/fallback=GET \/memory\/coverage answered 404/);
  });

  it('no embed_wait (a non-platform arm) → no wait block, never an invented line', () => {
    const md = renderReceipt({
      ...base,
      writeInfo: { none: { docs: 0, rows: 0 }, mycelium: { docs: 5, rows: 10 } },
    });
    expect(md).not.toMatch(/Embedding wait/);
  });
});
