// task 235 — keyword-fallback reads mark a column PROVISIONAL.
//
// The timeline arm's number is quotable only when its reads actually ran
// hybrid: a keyword-fallback read (the embed index degraded, the server
// answered `mode: 'keyword'`) is not the hybrid number the §3 bars were
// pre-committed against. Three pieces:
//   1. core.mjs stamps summary.arms[arm].fallback_share = {fallback, answered,
//      unstamped} — rows with NO retrieval_mode field count unstamped, never
//      guessed into either side.
//   2. receipt.mjs renders a PROVISIONAL banner under the scores table on ANY
//      fallback read; unstamped rows render n/a with their count.
//   3. grid.mjs marks the composed column and reads the win-condition verdict
//      UNDECIDED when the share exceeds BENCH_GRID_MAX_FALLBACK_SHARE
//      (pre-committed default 0.05) — regardless of the cells.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runBench, summarizeFromResults } from '../../bench/memory/core.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';
import { composeGrid, loadRun, renderGridReceipt } from '../../bench/memory/grid.mjs';
import {
  DEFAULT_MAX_FALLBACK_SHARE,
  armFallbackState,
  computeFallbackShare,
  maxFallbackShare,
} from '../../bench/memory/fallback_provisional.mjs';

const ENV_VAR = 'BENCH_GRID_MAX_FALLBACK_SHARE';
const GENERATED = '2026-09-18T12:00:00Z';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-memory-fallback-'));
});

afterEach(() => {
  delete process.env[ENV_VAR];
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- shared fixtures ---------------------------------------------------------

const REGIME = {
  date_utc: '2026-09-18T12:00:00Z',
  git_sha: 'sha-x',
  git_dirty: false,
  harness: 'p1-skeleton.1',
  dataset: {
    name: 'LongMemEval-S (cleaned)',
    sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
  },
  judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', judge_prompt_version: 'judge-prompt.2' },
  answerer: { model: 'qwen3.8:27b', max_tokens: 4096 },
  retrieval: { budget: 5 },
};

// 15 questions, 5 per win-condition cell — every cell reaches n ≥ 5, so with
// all-exact labels the pre-committed verdict is WIN and with all-wrong it is
// MISS; the fallback rule must override BOTH.
const CELL_TYPES = [
  ...Array(5).fill('knowledge-update'),
  ...Array(5).fill('single-session-assistant'),
  ...Array(5).fill('temporal-reasoning'),
];
const QUESTION_IDS = CELL_TYPES.map((_, i) => `q-${String(i + 1).padStart(2, '0')}`);

function armEntry(n, exact, wrong, extra = {}) {
  return {
    n,
    elapsed_ms: 42000,
    score: { n, counts: { exact, partial: 0, wrong }, unparsed: 0, p1_score: (exact + 0.5 * 0) / n },
    ...extra,
  };
}

function judgedRowsFor(arm, label) {
  return QUESTION_IDS.map((question_id, i) => ({
    question_id,
    arm,
    question_type: CELL_TYPES[i],
    gold: 'a year',
    answer: 'Over a year.',
    label,
    judge_raw: label.toUpperCase(),
    judge_had_think: false,
  }));
}

function writeRun(name, { runId, arms, label = 'exact', stamps = true }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const regime = { ...REGIME, retrieval: { ...REGIME.retrieval, namespace: `bench-p1-${runId}` }, n: QUESTION_IDS.length };
  const summary = {
    run_id: runId,
    n: QUESTION_IDS.length,
    regime,
    arms,
    write_info: Object.fromEntries(Object.keys(arms).map((a) => [a, { docs: 10, rows: 90, extract_ms: 1000 }])),
    commands: [`node bench/memory/run.mjs --split longmemeval --arms ${Object.keys(arms).join(',')} --n ${QUESTION_IDS.length} --receipt`],
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const rows = [];
  for (const [arm, a] of Object.entries(arms)) {
    QUESTION_IDS.forEach((question_id, i) => {
      rows.push({ question_id, arm, question_type: CELL_TYPES[i], gold: 'a year', answer: 'x', label, judge_raw: label.toUpperCase(), judge_had_think: false });
    });
    if (stamps && arm === 'mycelium-timeline' && !a.fallback_share) {
      throw new Error('fixture bug: pass fallback_share explicitly (or stamps:false for a pre-mode run)');
    }
  }
  fs.writeFileSync(path.join(dir, 'judged.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

// Pair in the live-window shape: run A carries Mem0's column, run B the
// timeline arm — the only arm the win condition judges.
function writePair({ timelineExtra = {}, label = 'exact', stampsB = true } = {}) {
  const dirA = writeRun('run-a', {
    runId: 'run-a',
    arms: { mem0: armEntry(15, 15, 0), 'mem0-raw': armEntry(15, 15, 0) },
    stamps: false,
  });
  const dirB = writeRun('run-b', {
    runId: 'run-b',
    arms: { 'mycelium-timeline': armEntry(15, label === 'exact' ? 15 : 0, label === 'exact' ? 0 : 15, timelineExtra) },
    label,
    stamps: stampsB,
  });
  return [dirA, dirB];
}

function winSection(md) {
  const start = md.indexOf('## Timeline arm win condition');
  expect(start).toBeGreaterThan(-1);
  const end = md.indexOf('\n## ', start + 1);
  return md.slice(start, end === -1 ? md.length : end);
}

// ---- 1. the fallback_share stamp ---------------------------------------------

describe('the fallback_share stamp (task 235)', () => {
  it('computeFallbackShare: keyword counts fallback, hybrid counts answered, missing mode counts unstamped — never guessed', () => {
    expect(
      computeFallbackShare([
        { meta: { retrieval_mode: 'hybrid' } },
        { meta: { retrieval_mode: 'keyword' } },
        { meta: { retrieval_mode: 'hybrid' } },
        { meta: { hits: 5 } },
      ])
    ).toEqual({ fallback: 1, answered: 3, unstamped: 1 });
    expect(computeFallbackShare([])).toEqual({ fallback: 0, answered: 0, unstamped: 0 });
    expect(computeFallbackShare([{ meta: { retrieval_mode: undefined } }])).toEqual({ fallback: 0, answered: 0, unstamped: 1 });
  });

  it('runBench stamps fallback_share per arm into the summary AND the write-phase summary', async () => {
    const items = QUESTION_IDS.slice(0, 2).map((question_id, i) => ({
      question_id,
      question_type: 'knowledge-update',
      question: `q${i}?`,
      answer: 'a year',
      haystack_sessions: [[]],
    }));
    let writeSummary = null;
    const result = await runBench({
      items,
      runId: 'run-stamp',
      regime: { ...REGIME, n: 2 },
      armFactories: [
        {
          name: 'mycelium',
          factory: () => ({
            name: 'mycelium',
            async answer(_q, item) {
              // q-1 read keyword-fallback, q-2 read hybrid
              return { text: 'x', meta: { hits: 1, retrieval_mode: item.question_id === 'q-01' ? 'keyword' : 'hybrid' } };
            },
          }),
        },
        { name: 'none', factory: () => ({ name: 'none', async answer() { return { text: 'I do not know.', meta: {} }; } }) },
      ],
      armContext: {},
      judgeFn: () => ({ label: 'exact', raw: 'RAW' }),
      beforeJudge: ({ summary }) => { writeSummary = summary; },
    });
    expect(result.summary.arms.mycelium.fallback_share).toEqual({ fallback: 1, answered: 2, unstamped: 0 });
    expect(result.summary.arms.none.fallback_share).toEqual({ fallback: 0, answered: 0, unstamped: 2 });
    // the write-phase summary (what survives a judge death) carries the same stamp
    expect(writeSummary.arms.mycelium.fallback_share).toEqual({ fallback: 1, answered: 2, unstamped: 0 });
  });

  it('summarizeFromResults rebuilds the stamp from the run rows — the receipt stays regenerable', () => {
    const rebuilt = summarizeFromResults({
      runId: 'run-rebuild',
      regime: { ...REGIME, n: 3 },
      rows: [
        { arm: 'mycelium', meta: { retrieval_mode: 'hybrid' } },
        { arm: 'mycelium', meta: { retrieval_mode: 'keyword' } },
        { arm: 'mycelium', meta: {} },
      ],
      judged: null,
    });
    expect(rebuilt.arms.mycelium.fallback_share).toEqual({ fallback: 1, answered: 2, unstamped: 1 });
  });
});

// ---- 2. the receipt banner ----------------------------------------------------

describe('the receipt PROVISIONAL banner (task 235)', () => {
  const MODES = { hybrid: 3, keyword: 1 };

  function fallbackArms(share, modes) {
    return {
      mycelium: armEntry(4, 3, 1, {
        ...(modes ? { retrieval_modes: modes } : {}),
        ...(share ? { fallback_share: share } : {}),
      }),
    };
  }

  it('(a) one keyword-fallback row of four renders the banner directly under the scores table', () => {
    const md = renderReceipt({
      runId: 'r-fallback',
      summary: { run_id: 'r-fallback', regime: { n: 4 }, arms: fallbackArms({ fallback: 1, answered: 4, unstamped: 0 }, MODES) },
      writeInfo: { mycelium: { docs: 2, rows: 2, embed_wait: { scope: 'namespaces', namespaces: ['bench-p1-x'], waited_ms: 481844, settled: false, poll_failures: 2, coverage_after: 0 } } },
      generatedAt: GENERATED,
    });
    expect(md).toContain('PROVISIONAL — 1/4 reads ran keyword-fallback (embed wait settled=false)');
    // directly under the scores table: after the legend, before the next section
    const legend = md.indexOf('`p1_score` = (exact + 0.5×partial) / n');
    const banner = md.indexOf('PROVISIONAL — 1/4 reads');
    expect(banner).toBeGreaterThan(legend);
    expect(md.indexOf('##', banner)).toBe(md.indexOf('##', legend));
  });

  it('(b) all-hybrid renders NO banner and the win-condition block stays byte-identical to today', () => {
    const judged = judgedRowsFor('mycelium-timeline', 'exact');
    const writeInfo = { 'mycelium-timeline': { docs: 10, rows: 90, extract_ms: 1000, reconcile_ms: 2000 } };
    const summaryWith = (stamps) => ({
      run_id: 'r-clean',
      regime: { n: 15 },
      arms: {
        'mycelium-timeline': armEntry(15, 15, 0, stamps ? { retrieval_modes: { hybrid: 15 }, fallback_share: { fallback: 0, answered: 15, unstamped: 0 } } : {}),
      },
    });
    const mdWith = renderReceipt({ runId: 'r-clean', summary: summaryWith(true), judged, writeInfo, generatedAt: GENERATED });
    const mdWithout = renderReceipt({ runId: 'r-clean', summary: summaryWith(false), judged, writeInfo, generatedAt: GENERATED });
    expect(mdWith).not.toContain('PROVISIONAL');
    expect(mdWith).not.toContain('pre-mode run');
    // byte-identical verdicts: the whole win-condition block, not just the line
    expect(winSection(mdWith)).toBe(winSection(mdWithout));
  });

  it('(d) unstamped rows render n/a with their count, no banner; a pre-stamp arm renders nothing at all', () => {
    const md = renderReceipt({
      runId: 'r-unstamped',
      summary: {
        run_id: 'r-unstamped',
        regime: { n: 3 },
        arms: {
          mycelium: armEntry(3, 0, 3, { fallback_share: { fallback: 0, answered: 0, unstamped: 3 } }),
          mem0: armEntry(2, 0, 2), // pre-mode run shape: neither field
        },
      },
      generatedAt: GENERATED,
    });
    expect(md).toContain('Retrieval mode unstamped (pre-mode run) on 3 of 3 rows — fallback share n/a');
    expect(md).not.toContain('PROVISIONAL');
    // an old summary carrying only retrieval_modes derives its unstamped count, never a guess
    const mdDerived = renderReceipt({
      runId: 'r-derived',
      summary: { run_id: 'r-derived', regime: { n: 3 }, arms: { mycelium: armEntry(3, 0, 3, { retrieval_modes: { hybrid: 2 } }) } },
      generatedAt: GENERATED,
    });
    expect(mdDerived).toContain('Retrieval mode unstamped (pre-mode run) on 1 of 3 rows — fallback share n/a');
  });

  it('(e) the bound is read from the env and stamped in the receipt regime block', () => {
    const mk = () => renderReceipt({
      runId: 'r-bound',
      summary: { run_id: 'r-bound', regime: { n: 1 }, arms: { mycelium: armEntry(1, 1, 0) } },
      generatedAt: GENERATED,
    });
    let md = mk();
    expect(md).toContain(`Fallback-provisional bound: ${DEFAULT_MAX_FALLBACK_SHARE} (BENCH_GRID_MAX_FALLBACK_SHARE=default)`);
    expect(md.indexOf('Fallback-provisional bound:')).toBeGreaterThan(md.indexOf('## Regime'));
    process.env[ENV_VAR] = '0.2';
    md = mk();
    expect(md).toContain('Fallback-provisional bound: 0.2 (BENCH_GRID_MAX_FALLBACK_SHARE=env)');
  });
});

// ---- 3. the grid column -------------------------------------------------------

describe('the grid PROVISIONAL column (task 235)', () => {
  const PROVISIONAL_SHARE = { fallback: 1, answered: 15, unstamped: 0 }; // 0.067 > 0.05
  const PROVISIONAL_MODES = { hybrid: 14, keyword: 1 };

  it('(c) above the bound, UNDECIDED overrides a would-be WIN and the column gets the header stamp', () => {
    const dirs = writePair({ timelineExtra: { fallback_share: PROVISIONAL_SHARE, retrieval_modes: PROVISIONAL_MODES } });
    const out = composeGrid({ dirs, generatedAt: GENERATED, receiptsDir: path.join(root, 'receipts') });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('mycelium-timeline (PROVISIONAL — fallback 1/15)');
    expect(md).toContain('Keyword-fallback rule (pre-committed, task 235): 1/15 reads ran keyword-fallback — share 0.067 > bound 0.05 (BENCH_GRID_MAX_FALLBACK_SHARE=default)');
    expect(winSection(md)).toContain('VERDICT: UNDECIDED (keyword-fallback 1/15 > bound 0.05)');
    expect(md).not.toContain('VERDICT: WIN');
  });

  it("(c) above the bound, UNDECIDED overrides a would-be MISS too", () => {
    const dirs = writePair({ label: 'wrong', timelineExtra: { fallback_share: PROVISIONAL_SHARE, retrieval_modes: PROVISIONAL_MODES } });
    const out = composeGrid({ dirs, generatedAt: GENERATED, receiptsDir: path.join(root, 'receipts') });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(winSection(md)).toContain('VERDICT: UNDECIDED (keyword-fallback 1/15 > bound 0.05)');
    expect(md).not.toContain('VERDICT: MISS');
  });

  it('(d) missing stamps on old runs: the column renders unstamped, composes as today, verdicts untouched', () => {
    const dirs = writePair({ stampsB: false });
    const out = composeGrid({ dirs, generatedAt: GENERATED, receiptsDir: path.join(root, 'receipts') });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('mycelium-timeline (retrieval-mode unstamped (pre-mode run))');
    expect(md).toContain('mem0 (retrieval-mode unstamped (pre-mode run))'); // the banked mem0 columns must not orphan
    expect(winSection(md)).toContain('VERDICT: WIN'); // unchanged — not overridden
    expect(md).not.toContain('PROVISIONAL');
  });

  it('a clean stamped column renders byte-identical to today (no suffix, no override)', () => {
    const clean = { fallback_share: { fallback: 0, answered: 15, unstamped: 0 }, retrieval_modes: { hybrid: 15 } };
    const dirsA = writePair({ timelineExtra: clean });
    const runsA = dirsA.map((d) => loadRun(d)); // load before the second pair overwrites the dir names
    const dirsB = writePair({ stampsB: false });
    const mdA = renderGridReceipt({ runs: runsA, generatedAt: GENERATED });
    const mdB = renderGridReceipt({ runs: dirsB.map((d) => loadRun(d)), generatedAt: GENERATED });
    expect(mdA).not.toContain('PROVISIONAL');
    // the clean timeline column renders bare — exactly today's cell
    expect(mdA).toContain('| mycelium-timeline | run-b | 15 | 15 | 0 | 0 | 1.000 |');
    expect(winSection(mdA)).toBe(winSection(mdB)); // byte-identical verdict block
  });

  it('(e) the bound is env-overridable: a share under the env bound stays clean and WIN', () => {
    process.env[ENV_VAR] = '0.5';
    const dirs = writePair({ timelineExtra: { fallback_share: PROVISIONAL_SHARE, retrieval_modes: PROVISIONAL_MODES } });
    const out = composeGrid({ dirs, generatedAt: GENERATED, receiptsDir: path.join(root, 'receipts') });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('Fallback-provisional bound: 0.5 (BENCH_GRID_MAX_FALLBACK_SHARE=env)');
    expect(md).not.toContain('PROVISIONAL — fallback');
    expect(winSection(md)).toContain('VERDICT: WIN');
  });

  it('the boundary is honest: exactly the bound is clean, a hair over is provisional', () => {
    const bound = DEFAULT_MAX_FALLBACK_SHARE;
    expect(armFallbackState({ fallback_share: { fallback: 1, answered: 20, unstamped: 0 } }, bound).kind).toBe('clean'); // 0.05
    expect(armFallbackState({ fallback_share: { fallback: 1, answered: 19, unstamped: 0 } }, bound).kind).toBe('provisional');
    expect(armFallbackState({ fallback_share: { fallback: 0, answered: 0, unstamped: 5 } }, bound).kind).toBe('unstamped');
    expect(armFallbackState({}, bound).kind).toBe('unstamped');
  });
});

// ---- the bound itself ----------------------------------------------------------

describe('BENCH_GRID_MAX_FALLBACK_SHARE (pre-committed at 0.05)', () => {
  it('defaults to 0.05 from the default source, and the env overrides with its source stamped', () => {
    expect(maxFallbackShare({})).toEqual({ bound: 0.05, source: 'default' });
    expect(maxFallbackShare({ [ENV_VAR]: '' })).toEqual({ bound: 0.05, source: 'default' });
    expect(maxFallbackShare({ [ENV_VAR]: '0.5' })).toEqual({ bound: 0.5, source: 'env' });
    expect(() => maxFallbackShare({ [ENV_VAR]: 'abc' })).toThrow(/BENCH_GRID_MAX_FALLBACK_SHARE/);
    expect(() => maxFallbackShare({ [ENV_VAR]: '1.5' })).toThrow(/BENCH_GRID_MAX_FALLBACK_SHARE/);
    expect(() => maxFallbackShare({ [ENV_VAR]: '-0.1' })).toThrow(/BENCH_GRID_MAX_FALLBACK_SHARE/);
  });
});
