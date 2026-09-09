import { describe, it, expect } from 'vitest';
import {
  GRID_ROWS,
  INGESTION_POLICY,
  assertNoExtractionThinkingMix,
  extractionThinkingByArm,
  factsStatLine,
  dropStatLine,
  renderIngestionGrid,
} from '../../bench/memory/ingestion.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';

function armEntry(n, exact, partial, wrong) {
  return {
    n: exact + partial + wrong,
    score: {
      counts: { exact, partial, wrong },
      p1_score: (exact + 0.5 * partial) / (exact + partial + wrong),
    },
  };
}

// fixture: all four grid arms, the 2×2 the task asks the receipt to render
const FULL_ARMS = {
  none: armEntry('none', 1, 0, 1),
  mycelium: armEntry('mycelium', 3, 1, 0), // Mycelium × raw
  'mycelium-extract': armEntry('mycelium-extract', 2, 2, 0), // Mycelium × extract
  'mem0-raw': armEntry('mem0-raw', 1, 1, 2), // Mem0 × raw
  mem0: armEntry('mem0', 2, 0, 2), // Mem0 × extract
};

describe('the ingestion-control grid (task 182)', () => {
  it('grid wiring: the cell map is internally consistent with the policy map', () => {
    for (const row of GRID_ROWS) {
      expect(INGESTION_POLICY[row.raw]).toBe('raw');
      expect(INGESTION_POLICY[row.extract]).toBe('extract');
    }
    expect(INGESTION_POLICY.mycelium).toBe('raw'); // as shipped: one row per session
    expect(INGESTION_POLICY.mem0).toBe('extract'); // as shipped: LLM extraction
  });

  it('renders the 2×2 ONLY when all four arms exist — a controls-only smoke has no grid', () => {
    const grid = renderIngestionGrid(FULL_ARMS, null);
    expect(grid).not.toBeNull();
    const text = grid.join('\n');
    expect(text).toContain('| system \\ ingestion | raw | extract |');
    expect(text).toContain('| Mycelium |');
    expect(text).toContain('| Mem0 |');
    // cells: p1_score with raw counts, correct position per column
    expect(text).toContain('| 0.875 (3/1/0) |'); // mycelium: raw column
    expect(text).toContain('| 0.750 (2/2/0) |'); // mycelium-extract: extract column
    expect(text).toContain('| 0.375 (1/1/2) |'); // mem0-raw: raw column
    expect(text).toContain('| 0.500 (2/0/2) |'); // mem0: extract column

    // a smoke carrying just the controls (the capped command) renders NOTHING
    expect(renderIngestionGrid({ 'mem0-raw': FULL_ARMS['mem0-raw'], 'mycelium-extract': FULL_ARMS['mycelium-extract'] }, null)).toBeNull();
    expect(renderIngestionGrid({}, null)).toBeNull();
    expect(renderIngestionGrid(undefined, null)).toBeNull();
  });

  it('renders facts-per-session stats when the extract arm reported them', () => {
    const grid = renderIngestionGrid(FULL_ARMS, {
      'mycelium-extract': { docs: 5, rows: 21, facts: 21, facts_counts: [5, 0, 9, 3, 4], extract_ms: 12_000 },
    });
    const text = grid.join('\n');
    expect(text).toContain('Facts per session (mycelium-extract): 21 facts over 5 sessions — mean 4.20, min 0, max 9.');
    expect(text).not.toContain('Facts per session (mem0'); // none reported
  });

  it('factsStatLine: null without counts, honest min/max otherwise', () => {
    expect(factsStatLine(null)).toBeNull();
    expect(factsStatLine({ facts: 5 })).toBeNull(); // total without a per-session list is not enough
    expect(factsStatLine({ facts_counts: [2, 4] })).toBe('6 facts over 2 sessions — mean 3.00, min 2, max 4');
  });

  it('dropStatLine: null when the arm reports no count, a real zero otherwise, percent of docs when known', () => {
    expect(dropStatLine(null)).toBeNull();
    expect(dropStatLine({ docs: 5 })).toBeNull(); // raw arms have no extractor
    expect(dropStatLine({ docs: 200, parse_failures: 0 })).toBe('0 of 200 sessions dropped by the extractor (reply unparseable) (0.0%)');
    expect(dropStatLine({ docs: 160, parse_failures: 1 })).toBe('1 of 160 sessions dropped by the extractor (reply unparseable) (0.6%)');
    expect(dropStatLine({ parse_failures: 2 })).toBe('2 sessions dropped by the extractor (reply unparseable)');
  });

  it('the receipt carries the grid section when the run has all four arms', () => {
    const md = renderReceipt({
      runId: 'run-grid',
      summary: { run_id: 'run-grid', arms: FULL_ARMS, regime: { n: 2 } },
      writeInfo: {
        'mycelium-extract': { docs: 2, rows: 3, facts: 3, facts_counts: [2, 1], extract_ms: 900 },
        mycelium: { docs: 2, rows: 2 },
      },
      generatedAt: '2026-09-09T18:00:00Z',
    });
    expect(md).toContain('## Ingestion controls ({Mycelium, Mem0} × {raw, extract})');
    expect(md).toContain('| system \\ ingestion | raw | extract |');
    expect(md).toContain('mean 1.50');
  });

  it('the receipt omits the grid section for a controls-only run', () => {
    const md = renderReceipt({
      runId: 'run-smoke',
      summary: { run_id: 'run-smoke', arms: { 'mem0-raw': FULL_ARMS['mem0-raw'], 'mycelium-extract': FULL_ARMS['mycelium-extract'] }, regime: { n: 1 } },
      generatedAt: '2026-09-09T18:00:00Z',
    });
    expect(md).not.toContain('Ingestion controls');
  });
});

describe('the unstamped-mix refusal (addendum 6)', () => {
  it('one run, one extraction-thinking mode — mem0 on + extract off refuses, naming the fix', () => {
    const arms = ['mycelium-extract', 'mem0'];
    const thinking = { 'mycelium-extract': 'off', mem0: 'on' };
    expect(() => assertNoExtractionThinkingMix(arms, thinking)).toThrow(
      /unstamped extraction-thinking mix.*mycelium-extract=thinking off, mem0=thinking on[\s\S]*MEM0_NO_THINK=1/s
    );
  });

  it('both off passes; raw arms (no extraction) are exempt', () => {
    expect(
      assertNoExtractionThinkingMix(['mycelium-extract', 'mem0'], { 'mycelium-extract': 'off', mem0: 'off' })
    ).toBe('off');
    expect(
      assertNoExtractionThinkingMix(['mem0-raw', 'mycelium-extract'], { 'mycelium-extract': 'off' })
    ).toBe('off');
    expect(assertNoExtractionThinkingMix(['none', 'mycelium'], {})).toBeNull();
  });

  it('extractionThinkingByArm: mem0 resolves from the sidecar /health, extract is hardcoded off, raw exempt', () => {
    expect(extractionThinkingByArm(['mem0'], { mem0Health: { extraction_thinking: 'off' } })).toEqual({ mem0: 'off' });
    expect(extractionThinkingByArm(['mem0'], { mem0Health: null })).toEqual({ mem0: 'on' }); // unstamped sidecar counts as on
    expect(extractionThinkingByArm(['mycelium-extract', 'mem0-raw', 'mycelium'], {})).toEqual({ 'mycelium-extract': 'off' });
  });
});
