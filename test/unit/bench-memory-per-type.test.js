// task 199 — the grid judges the timeline arm by its pre-committed cells.
//
// §3 of BRIEF-lab-alive-memory-program pre-commits the win condition per
// question type (knowledge-update >= 0.60, single-session-assistant >= 1.00,
// temporal-reasoning >= 0.40) + a cost bound (<= 2x extract), but the one-number
// score row cannot say whether the arm won or lost its own cells. This pins the
// per-question-type table, the win-condition block, and the seconds-per-session
// stamp — every number from the runs' own rows/stamps, never hand-typed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  QUESTION_TYPES,
  WIN_CONDITION,
  judgeCell,
  judgeCostBound,
  loadDatasetTypes,
  p1ScoreOf,
  renderCostBound,
  renderPerTypeTable,
  renderWinCondition,
  secondsPerSessionStamp,
  tallyByType,
  winVerdict,
} from '../../bench/memory/per_type.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';
import { composeGrid, loadRun, renderGridReceipt } from '../../bench/memory/grid.mjs';
import { runBench } from '../../bench/memory/core.mjs';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-memory-per-type-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- fixtures ---------------------------------------------------------------

// judged rows: perType = { question_type: [labels...] }
function judgedRows(arm, perType, { idPrefix = 'q' } = {}) {
  const rows = [];
  let i = 0;
  for (const [type, labels] of Object.entries(perType)) {
    for (const label of labels) {
      rows.push({ question_id: `${idPrefix}-${i++}`, arm, question_type: type, label });
    }
  }
  return rows;
}

const COMPACT_REGIME = {
  dataset: { name: 'LongMemEval-S (cleaned)', sha256: 'd6f21ea9' },
  judge: { model: 'judge-model', judge_prompt_version: 'judge-prompt.2' },
  answerer: { model: 'answerer-model', max_tokens: 4096 },
  retrieval: { budget: 5 },
};

// one fixture run dir: summary.json + judged.jsonl (the loadRun contract)
function writeFixtureRun(name, { runId, arms, judged, writeInfo = {}, regimePatch = {} }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const armsSummary = Object.fromEntries(
    Object.entries(arms).map(([arm, perType]) => {
      const counts = { exact: 0, partial: 0, wrong: 0 };
      for (const labels of Object.values(perType)) for (const l of labels) counts[l] += 1;
      const n = counts.exact + counts.partial + counts.wrong;
      return [arm, { n, score: { n, counts, unparsed: 0, p1_score: (counts.exact + 0.5 * counts.partial) / n } }];
    })
  );
  const nQuestions = new Set(judged.map((r) => r.question_id)).size;
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify({
      run_id: runId,
      n: nQuestions,
      regime: { ...COMPACT_REGIME, ...regimePatch },
      arms: armsSummary,
      write_info: writeInfo,
    })
  );
  fs.writeFileSync(path.join(dir, 'judged.jsonl'), judged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

// ---- tallyByType ------------------------------------------------------------

describe('tallyByType', () => {
  it('counts n/exact/partial/wrong per question type from the judged rows', () => {
    const rows = judgedRows('mycelium-timeline', {
      'knowledge-update': ['exact', 'exact', 'wrong'],
      'temporal-reasoning': ['partial', 'wrong'],
    });
    const t = tallyByType(rows);
    expect(t.byType['knowledge-update']).toEqual({ n: 3, exact: 2, partial: 0, wrong: 1 });
    expect(t.byType['temporal-reasoning']).toEqual({ n: 2, exact: 0, partial: 1, wrong: 1 });
    expect(t.unknown).toEqual({});
  });

  it('joins question_type from the dataset by question_id when a row lacks it, quoting the join rule', () => {
    const rows = [
      { question_id: 'q-1', arm: 'a', label: 'exact' }, // no question_type
      { question_id: 'q-2', arm: 'a', question_type: 'multi-session', label: 'wrong' },
    ];
    const t = tallyByType(rows, {
      typesByQuestionId: new Map([['q-1', 'knowledge-update']]),
      joinRule: 'question_type joined from longmemeval_s_cleaned.json (sha256 d6f21ea9) on question_id',
    });
    expect(t.byType['knowledge-update']).toEqual({ n: 1, exact: 1, partial: 0, wrong: 0 });
    expect(t.byType['multi-session'].n).toBe(1);
    expect(t.joinRule).toMatch(/joined from longmemeval_s_cleaned\.json/);
  });

  it('lands unresolvable rows in unknown (never guessed) and says the join was unavailable', () => {
    const rows = [{ question_id: 'q-9', arm: 'a', label: 'wrong' }];
    const t = tallyByType(rows);
    expect(t.unknown).toEqual({ absent: 1 });
    expect(t.byType['knowledge-update'].n).toBe(0);
  });

  it('refuses a label outside exact/partial/wrong (a lying table is worse than no table)', () => {
    const rows = [{ question_id: 'q-1', arm: 'a', question_type: 'multi-session', label: 'sort-of' }];
    expect(() => tallyByType(rows)).toThrow(/sort-of/);
  });
});

describe('p1ScoreOf', () => {
  it('computes (exact + 0.5*partial)/n and null on n=0', () => {
    expect(p1ScoreOf({ n: 4, exact: 1, partial: 2, wrong: 1 })).toBe(0.5);
    expect(p1ScoreOf({ n: 0, exact: 0, partial: 0, wrong: 0 })).toBeNull();
  });
});

// ---- renderPerTypeTable -------------------------------------------------------

describe('renderPerTypeTable', () => {
  it('renders all six LongMemEval-S types in canonical order with n/exact/partial/wrong/score', () => {
    const rows = judgedRows('mem0', {
      'knowledge-update': ['exact', 'exact', 'wrong'],
      'single-session-assistant': ['exact', 'exact', 'exact', 'exact', 'partial'],
    });
    const lines = renderPerTypeTable('mem0', tallyByType(rows));
    const text = lines.join('\n');
    expect(text).toContain('#### mem0');
    expect(text).toContain('| question_type | n | exact | partial | wrong | p1_score |');
    const order = QUESTION_TYPES.map((t) => text.indexOf(`| ${t} |`));
    expect(order).toEqual([...order].sort((a, b) => a - b)); // canonical order
    expect(text).toContain('| knowledge-update | 3 | 2 | 0 | 1 | 0.667 |');
    expect(text).toContain('| single-session-assistant | 5 | 4 | 1 | 0 | 0.900 |');
    expect(text).toContain('| single-session-user | 0 | 0 | 0 | 0 | n/a |');
  });

  it('renders unknown rows explicitly so n still sums, with the join note', () => {
    const rows = [
      { question_id: 'q-1', arm: 'a', question_type: 'multi-session', label: 'exact' },
      { question_id: 'q-x', arm: 'a', label: 'wrong' }, // type absent, no dataset supplied
    ];
    const lines = renderPerTypeTable('a', tallyByType(rows));
    const text = lines.join('\n');
    expect(text).toContain('| unknown (question_type absent) | 1 |');
    expect(text).toContain('no dataset was supplied for the join — unresolved rows are listed as unknown, never guessed');
  });
});

// ---- the win condition --------------------------------------------------------

describe('judgeCell + winVerdict', () => {
  it('passes at exactly the bar and fails below it', () => {
    expect(judgeCell({ n: 5, exact: 2, partial: 0, wrong: 3 }, 0.4).verdict).toBe('PASS');
    expect(judgeCell({ n: 15, exact: 7, partial: 0, wrong: 8 }, 0.6).verdict).toBe('FAIL');
  });

  it('refuses a verdict when the cell has fewer than 5 rows', () => {
    const c = judgeCell({ n: 3, exact: 3, partial: 0, wrong: 0 }, 0.6);
    expect(c.verdict).toBe('n too small');
    expect(c.undecided).toBe(true);
    expect(c.score).toBe(1);
  });

  it('WIN when every cell passes and the cost bound passes', () => {
    const v = winVerdict({
      cells: [
        { type: 'knowledge-update', verdict: 'PASS', score: 0.6, min: 0.6 },
        { type: 'single-session-assistant', verdict: 'PASS', score: 1, min: 1 },
      ],
      cost: { verdict: 'PASS', ratio: 1.5 },
    });
    expect(v.verdict).toBe('WIN');
    expect(v.line).toBe('WIN');
  });

  it('MISS on any cell FAIL, with the failing cells as reasons; cost FAIL decides too', () => {
    const v = winVerdict({
      cells: [
        { type: 'knowledge-update', verdict: 'FAIL', score: 0.467, min: 0.6 },
        { type: 'single-session-assistant', verdict: 'PASS', score: 1, min: 1 },
      ],
      cost: { verdict: 'FAIL', ratio: 2.17 },
    });
    expect(v.verdict).toBe('MISS');
    expect(v.reasons.join('; ')).toMatch(/knowledge-update 0\.467 < 0\.6/);
    expect(v.reasons.join('; ')).toMatch(/cost ×2\.17 > 2×/);
  });

  it('UNDECIDED (n) when no FAIL but a cell is undecided; an unjudged cost bound never decides', () => {
    const v = winVerdict({
      cells: [
        { type: 'temporal-reasoning', verdict: 'n too small', score: 1, min: 0.4, n: 3 },
        { type: 'knowledge-update', verdict: 'PASS', score: 0.6, min: 0.6, n: 15 },
      ],
      cost: null,
    });
    expect(v.verdict).toBe('UNDECIDED');
    expect(v.line).toBe('UNDECIDED (n=3)');
  });
});

// ---- the cost stamp -------------------------------------------------------------

describe('secondsPerSessionStamp', () => {
  it('prefers the wall-clock write_ms stamp and names it', () => {
    const s = secondsPerSessionStamp({ docs: 100, rows: 100, write_ms: 50_000, extract_ms: 10 });
    expect(s.kind).toBe('write_ms');
    expect(s.seconds).toBe(0.5);
    expect(s.label).toMatch(/write_ms 50000 ms \/ 100 docs/);
  });

  it('falls back to extract_ms (+reconcile_ms) — the LLM-time stamp — and names it', () => {
    const s = secondsPerSessionStamp({ docs: 2355, extract_ms: 104, reconcile_ms: 24_683_199 });
    expect(s.kind).toBe('extract_ms');
    expect(s.seconds).toBeCloseTo(10.48, 2);
    expect(s.label).toMatch(/extract_ms 104 ms \+ reconcile_ms 24683199 ms \/ 2355 docs/);
  });

  it('returns null when no stamp exists or docs is missing — the receipt shows "not stamped", never a number', () => {
    expect(secondsPerSessionStamp({ docs: 2355 })).toBeNull();
    expect(secondsPerSessionStamp({ extract_ms: 100 })).toBeNull();
    expect(secondsPerSessionStamp(null)).toBeNull();
  });
});

// ---- the per-session stamps (task 230) --------------------------------------------
//
// BRIEF-lab-alive-memory-program §3: "Cost bound: ≤ 2× the extract arm's
// seconds per session." Both mycelium-family arms stamp the SAME per-question
// shape — seconds_per_session arrays inside their per_question blocks — so the
// bound's two sides are read by ONE reader, and the finest instrument (the
// arm's own per-session wall clock) outranks the coarser write_ms / extract_ms
// fallbacks whenever it exists.

describe('secondsPerSessionStamp — the per-session arrays (task 230)', () => {
  it('reads the EXTRACT channel and says it used the per-session stamps', () => {
    const s = secondsPerSessionStamp({
      docs: 3,
      extract: { per_question: [{ question_id: 'q1', seconds_per_session: [1, 2] }, { question_id: 'q2', seconds_per_session: [6] }] },
    });
    expect(s.kind).toBe('seconds_per_session');
    expect(s.seconds).toBe(3);
    expect(s.label).toMatch(/seconds_per_session over 3 sessions/);
  });

  it('reads the TIMELINE channel the same way — one reader, both sides', () => {
    const s = secondsPerSessionStamp({
      docs: 2,
      timeline: { per_question: [{ question_id: 'q1', seconds_per_session: [8.3, 8.3, 6.1, 6.9, 0.6] }] },
    });
    expect(s.kind).toBe('seconds_per_session');
    expect(s.seconds).toBeCloseTo(6.04, 2);
  });

  it('non-numeric stamp entries are skipped, never crashed on', () => {
    const s = secondsPerSessionStamp({
      docs: 3,
      extract: { per_question: [{ question_id: 'q1', seconds_per_session: ['x', null, 2.5] }] },
    });
    expect(s.kind).toBe('seconds_per_session');
    expect(s.seconds).toBe(2.5);
    expect(s.label).toMatch(/over 1 sessions/);
  });

  it('the arrays outrank write_ms when both exist — the finer instrument wins', () => {
    const s = secondsPerSessionStamp({
      docs: 10,
      write_ms: 50_000,
      extract: { per_question: [{ question_id: 'q1', seconds_per_session: [1, 1, 1] }] },
    });
    expect(s.kind).toBe('seconds_per_session');
    expect(s.seconds).toBe(1);
  });

  it('an EMPTY per_question list is not a stamp — the legacy fallbacks still apply (banked runs re-render identically)', () => {
    const s = secondsPerSessionStamp({ docs: 100, write_ms: 50_000, timeline: { per_question: [] } });
    expect(s.kind).toBe('write_ms');
    expect(s.seconds).toBe(0.5);
  });

  it('docs missing → null even with arrays (the stamp only ever rides a real write phase)', () => {
    expect(secondsPerSessionStamp({ extract: { per_question: [{ seconds_per_session: [1] }] } })).toBeNull();
  });
});

// ---- the pure comparison (task 230) ------------------------------------------------

describe('judgeCostBound — the pure ≤2× comparison over the two stamps', () => {
  it('exactly 2.0× is a PASS (the bound is inclusive)', () => {
    expect(judgeCostBound({ timelineSeconds: 10, extractSeconds: 5 })).toEqual({ judged: true, verdict: 'PASS', ratio: 2 });
  });

  it('2.0001× is a FAIL', () => {
    const j = judgeCostBound({ timelineSeconds: 20.001, extractSeconds: 10 });
    expect(j.judged).toBe(true);
    expect(j.verdict).toBe('FAIL');
    expect(j.ratio).toBeCloseTo(2.0001, 6);
  });

  it('under the bound is a PASS', () => {
    expect(judgeCostBound({ timelineSeconds: 6.04, extractSeconds: 4.83 }).verdict).toBe('PASS');
  });

  it('a missing stamp on either side is NOT JUDGED — never a crash, never a guessed verdict', () => {
    for (const bad of [null, undefined, NaN, 'x', 0, -1, Infinity]) {
      expect(judgeCostBound({ timelineSeconds: bad, extractSeconds: 5 })).toEqual({ judged: false, verdict: null, ratio: null });
      expect(judgeCostBound({ timelineSeconds: 5, extractSeconds: bad })).toEqual({ judged: false, verdict: null, ratio: null });
    }
    expect(judgeCostBound({})).toEqual({ judged: false, verdict: null, ratio: null });
  });

  it('the bound is the pre-committed WIN_CONDITION.costBound.ratio', () => {
    // 2.4/1.2 = exactly 2 → PASS at the pre-committed bound; the same pair at
    // any tighter bound would FAIL — the function reads the bar from the spec
    expect(WIN_CONDITION.costBound.ratio).toBe(2);
    expect(judgeCostBound({ timelineSeconds: 2.4, extractSeconds: 1.2 }).verdict).toBe('PASS');
  });
});

describe('renderCostBound', () => {
  it('judges the ≤2× bound from both stamps and says which stamps', () => {
    const lines = renderCostBound({
      timeline: { docs: 2355, extract_ms: 104, reconcile_ms: 24_683_199 },
      extract: { docs: 2355, extract_ms: 11_370_052 },
    });
    const text = lines.join('\n');
    expect(text).toMatch(/mycelium-timeline 10\.48 s\/session/);
    expect(text).toMatch(/mycelium-extract 4\.83 s\/session/);
    expect(text).toMatch(/×2\.17 — FAIL/);
  });

  it('refuses to judge when either side is unstamped — names the arm, never a number', () => {
    const text = renderCostBound({ timeline: null, extract: { docs: 10, extract_ms: 5 } }).join('\n');
    expect(text).toMatch(/NOT JUDGED — mycelium-timeline seconds-per-session not stamped/);
    expect(text).not.toMatch(/×\d/);
  });

  it('notes extraction reuse — a reused extract_ms understates the timeline cost', () => {
    const text = renderCostBound({
      timeline: { docs: 10, extract_ms: 4, reconcile_ms: 16 },
      extract: { docs: 10, extract_ms: 20 },
      timelineRegime: { facts_reused_from: { run_id: '2026-09-09-p1-195034' } },
    }).join('\n');
    expect(text).toMatch(/reused its extraction facts from run 2026-09-09-p1-195034/);
  });
});

// ---- the cost row on per-session stamps (task 230) ---------------------------------

describe('renderCostBound — JUDGED from the per-session arrays (task 230)', () => {
  const stampedTimeline = { docs: 5, timeline: { per_question: [{ question_id: 'q1', seconds_per_session: [8.3, 8.3, 6.1, 6.9, 0.6] }] } };
  const stampedExtract = { docs: 5, extract: { per_question: [{ question_id: 'q1', seconds_per_session: [2, 2, 2, 2, 2] }] } };

  it('both sides carrying the arrays renders the judged line: seconds, ratio, verdict — and names the stamps', () => {
    const text = renderCostBound({ timeline: stampedTimeline, extract: stampedExtract }).join('\n');
    expect(text).toMatch(/mycelium-timeline 6\.04 s\/session \(stamped seconds_per_session over 5 sessions/);
    expect(text).toMatch(/mycelium-extract 2\.00 s\/session \(stamped seconds_per_session over 5 sessions/);
    expect(text).toMatch(/×3\.02 — FAIL/);
  });

  it('mixed kinds are disclosed — each side names the stamp it actually used', () => {
    const text = renderCostBound({
      timeline: { docs: 5, timeline: { per_question: [{ seconds_per_session: [2, 2] }] } },
      extract: { docs: 5, extract_ms: 20_000 },
    }).join('\n');
    expect(text).toMatch(/mycelium-timeline 2\.00 s\/session \(stamped seconds_per_session/);
    expect(text).toMatch(/mycelium-extract 4\.00 s\/session \(stamped extract_ms 20000 ms \/ 5 docs/);
    expect(text).toMatch(/×0\.50 — PASS/);
  });

  it('arrays on one side and NO stamp on the other → NOT JUDGED, naming the unstamped arm', () => {
    const text = renderCostBound({ timeline: stampedTimeline, extract: { docs: 5 } }).join('\n');
    expect(text).toMatch(/NOT JUDGED — mycelium-extract seconds-per-session not stamped/);
    expect(text).not.toMatch(/×\d/);
  });

  it('a degenerate stamp (all-zero arrays, a reuse-only write) is NOT JUDGED — dividing by zero is not a verdict', () => {
    const text = renderCostBound({
      timeline: stampedTimeline,
      extract: { docs: 5, extract: { per_question: [{ seconds_per_session: [0, 0, 0, 0, 0] }] } },
    }).join('\n');
    expect(text).toMatch(/NOT JUDGED/);
    expect(text).not.toMatch(/×\d/);
  });

  it('BANKED back-compat: the 2026-09-09 grid union write_info re-renders the 2026-09-18 composed receipt cost row unchanged', () => {
    // the real union, byte-for-byte from results/2026-09-09-p1-195034/summary.json —
    // the composition the banked grid receipt (line 76) rendered NOT JUDGED from
    const writeInfo = {
      mem0: { docs: 2355, rows: 14440, skipped: false, parse_failures: 27 },
      'mem0-raw': { docs: 2355, rows: 24303, skipped: false, parse_failures: 0 },
    };
    const text = renderCostBound({
      timeline: writeInfo['mycelium-timeline'] ?? null,
      extract: writeInfo['mycelium-extract'] ?? null,
    }).join('\n');
    expect(text).toBe('Cost bound (timeline write cost ≤ 2× extract): NOT JUDGED — mycelium-timeline seconds-per-session not stamped.');
  });
});

// ---- the win-condition block -----------------------------------------------------

describe('renderWinCondition', () => {
  const tlRows = judgedRows('mycelium-timeline', {
    'knowledge-update': ['exact', 'exact', 'exact', 'wrong', 'wrong', 'exact', 'exact', 'wrong', 'exact', 'wrong', 'exact', 'wrong', 'wrong', 'wrong', 'wrong'], // 7/15 = 0.467
    'single-session-assistant': ['exact', 'exact', 'exact', 'exact', 'exact'], // 1.00
    'temporal-reasoning': ['exact', 'exact', 'wrong', 'wrong', 'wrong'], // 0.40
  });
  const mem0Rows = judgedRows('mem0', {
    'knowledge-update': ['exact', 'exact', 'exact', 'wrong', 'wrong', 'exact', 'exact', 'wrong', 'exact', 'wrong', 'exact', 'wrong', 'wrong', 'exact', 'exact'], // 9/15 = 0.600
    'single-session-assistant': ['exact', 'exact', 'exact', 'partial', 'wrong'], // 0.70
    'temporal-reasoning': ['exact', 'exact', 'wrong', 'wrong', 'wrong'], // 0.40
  });
  const extractRows = judgedRows('mycelium-extract', {
    'knowledge-update': ['exact', 'exact', 'exact', 'wrong', 'wrong', 'exact', 'exact', 'wrong', 'exact', 'wrong', 'exact', 'wrong', 'wrong', 'wrong', 'wrong'], // 7/15 = 0.467
    'single-session-assistant': ['partial', 'wrong', 'wrong', 'wrong', 'wrong'], // 0.10
    'temporal-reasoning': ['exact', 'wrong', 'wrong', 'wrong', 'wrong'], // 0.20
  });

  it('renders the pre-committed cells beside Mem0 and the extract arm, with the verdict line last', () => {
    const lines = renderWinCondition({
      talliesByArm: {
        'mycelium-timeline': tallyByType(tlRows),
        mem0: tallyByType(mem0Rows),
        'mycelium-extract': tallyByType(extractRows),
      },
      writeInfoByArm: {
        'mycelium-timeline': { docs: 2355, extract_ms: 104, reconcile_ms: 24_683_199 },
        'mycelium-extract': { docs: 2355, extract_ms: 11_370_052 },
      },
    });
    const text = lines.join('\n');
    expect(text).toMatch(/knowledge-update ≥ 0\.60/);
    expect(text).toMatch(/single-session-assistant ≥ 1\.00/);
    expect(text).toMatch(/temporal-reasoning ≥ 0\.40/);
    expect(text).toMatch(/\| knowledge-update \| ≥ 0\.60 \| 0\.467 \(n=15\) \| 0\.600 \(n=15\) \| 0\.467 \(n=15\) \| FAIL/);
    expect(text).toMatch(/\| single-session-assistant \| ≥ 1\.00 \| 1\.000 \(n=5\) \| 0\.700 \(n=5\) \| 0\.100 \(n=5\) \| PASS/);
    expect(text).toMatch(/×2\.17 — FAIL/);
    expect(lines[lines.length - 1]).toMatch(/^VERDICT: MISS — /);
  });

  it('a comparator arm outside the grid renders "not in grid" without inventing a number', () => {
    const lines = renderWinCondition({
      talliesByArm: { 'mycelium-timeline': tallyByType(tlRows) },
      writeInfoByArm: {},
    });
    const text = lines.join('\n');
    expect(text).toContain('not in grid');
    expect(lines[lines.length - 1]).toMatch(/^VERDICT: MISS — /); // the timeline cells alone still decide
  });

  it('UNDECIDED when a cell is undecided and nothing fails', () => {
    const small = judgedRows('mycelium-timeline', {
      'knowledge-update': ['exact', 'exact', 'exact', 'exact', 'wrong'], // 0.8 PASS
      'single-session-assistant': ['exact', 'exact', 'exact', 'exact', 'exact'], // PASS
      'temporal-reasoning': ['exact', 'exact', 'exact'], // n=3 → undecided
    });
    const lines = renderWinCondition({
      talliesByArm: { 'mycelium-timeline': tallyByType(small) },
      writeInfoByArm: {
        'mycelium-timeline': { docs: 100, write_ms: 10_000 },
        'mycelium-extract': { docs: 100, write_ms: 10_000 },
      },
    });
    expect(lines[lines.length - 1]).toBe('VERDICT: UNDECIDED (n=3)');
  });

  // task 230: a cost verdict computed from the per-session arrays must move the
  // pre-committed verdict exactly like a write_ms/extract_ms one does.
  const cellsAllPass = () => {
    const rows = judgedRows('mycelium-timeline', {
      'knowledge-update': ['exact', 'exact', 'exact', 'exact', 'wrong'], // 0.8 PASS
      'single-session-assistant': ['exact', 'exact', 'exact', 'exact', 'exact'], // 1.0 PASS
      'temporal-reasoning': ['exact', 'exact', 'wrong', 'wrong', 'wrong'], // 0.4 PASS
    });
    return { 'mycelium-timeline': tallyByType(rows) };
  };

  it('cells all PASS + cost exactly at 2.0× from the arrays → WIN', () => {
    const lines = renderWinCondition({
      talliesByArm: cellsAllPass(),
      writeInfoByArm: {
        'mycelium-timeline': { docs: 5, timeline: { per_question: [{ question_id: 'q', seconds_per_session: [10, 10, 10, 10, 10] }] } },
        'mycelium-extract': { docs: 5, extract: { per_question: [{ question_id: 'q', seconds_per_session: [5, 5, 5, 5, 5] }] } },
      },
    });
    const text = lines.join('\n');
    expect(text).toMatch(/×2\.00 — PASS/);
    expect(lines[lines.length - 1]).toBe('VERDICT: WIN');
  });

  it('cells all PASS + cost 2.0001× from the arrays → MISS with the cost reason', () => {
    const lines = renderWinCondition({
      talliesByArm: cellsAllPass(),
      writeInfoByArm: {
        'mycelium-timeline': { docs: 5, timeline: { per_question: [{ question_id: 'q', seconds_per_session: [10.001, 10.001, 10.001, 10.001, 10.001] }] } },
        'mycelium-extract': { docs: 5, extract: { per_question: [{ question_id: 'q', seconds_per_session: [5, 5, 5, 5, 5] }] } },
      },
    });
    expect(lines[lines.length - 1]).toBe('VERDICT: MISS — cost ×2.00 > 2×');
  });
});

// ---- wiring: grid receipt ---------------------------------------------------------

describe('grid receipt wiring (renderGridReceipt / composeGrid)', () => {
  // mem0 run: knowledge-update 9/15, assistant 0.7, temporal 0.4
  const mem0PerType = {
    'knowledge-update': ['exact', 'exact', 'exact', 'wrong', 'wrong', 'exact', 'exact', 'wrong', 'exact', 'wrong', 'exact', 'wrong', 'wrong', 'exact', 'exact'],
    'single-session-assistant': ['exact', 'exact', 'exact', 'partial', 'wrong'],
    'temporal-reasoning': ['exact', 'exact', 'wrong', 'wrong', 'wrong'],
  };
  // timeline run: knowledge-update 7/15, assistant 1.0, temporal 0.4
  const tlPerType = {
    'knowledge-update': ['exact', 'exact', 'exact', 'wrong', 'wrong', 'exact', 'exact', 'wrong', 'exact', 'wrong', 'exact', 'wrong', 'wrong', 'wrong', 'wrong'],
    'single-session-assistant': ['exact', 'exact', 'exact', 'exact', 'exact'],
    'temporal-reasoning': ['exact', 'exact', 'wrong', 'wrong', 'wrong'],
  };
  const extractPerType = {
    'knowledge-update': ['exact', 'exact', 'exact', 'wrong', 'wrong', 'exact', 'exact', 'wrong', 'exact', 'wrong', 'exact', 'wrong', 'wrong', 'wrong', 'wrong'],
    'single-session-assistant': ['partial', 'wrong', 'wrong', 'wrong', 'wrong'],
    'temporal-reasoning': ['exact', 'wrong', 'wrong', 'wrong', 'wrong'],
  };

  function writeGridFixtures({ timelineWriteInfo = { docs: 100, extract_ms: 104, reconcile_ms: 2_468_896 }, extractWriteInfo = { docs: 100, extract_ms: 1_000_000 } } = {}) {
    const rowsMem0 = judgedRows('mem0', mem0PerType);
    const rowsRaw = judgedRows('mem0-raw', mem0PerType);
    const rowsTl = judgedRows('mycelium-timeline', tlPerType);
    const rowsEx = judgedRows('mycelium-extract', extractPerType);
    // same 25 question ids for every arm/run — the comparability gate
    const ids = rowsTl.map((r) => r.question_id);
    const reId = (rows, arm) => rows.map((r, i) => ({ ...r, arm, question_id: ids[i % ids.length] }));
    const dirA = writeFixtureRun('run-a', {
      runId: 'run-a',
      arms: { mem0: mem0PerType, 'mem0-raw': mem0PerType },
      judged: [...reId(rowsMem0, 'mem0'), ...reId(rowsRaw, 'mem0-raw')],
      writeInfo: { mem0: { docs: 100, extract_ms: 1_000_000 } },
    });
    const dirB = writeFixtureRun('run-b', {
      runId: 'run-b',
      arms: { 'mycelium-timeline': tlPerType, 'mycelium-extract': extractPerType },
      judged: [...reId(rowsTl, 'mycelium-timeline'), ...reId(rowsEx, 'mycelium-extract')],
      writeInfo: {
        'mycelium-timeline': timelineWriteInfo,
        'mycelium-extract': extractWriteInfo,
      },
      regimePatch: { mycelium_timeline: { facts_reused_from: { run_id: 'run-a' } } },
    });
    return [dirA, dirB];
  }

  it('renders a per-type table for EVERY arm in the union + the win-condition block + cost bound', () => {
    const dirs = writeGridFixtures();
    composeGrid({ dirs, generatedAt: 'now', write: false }); // dry run: comparability holds
    const md = renderGridReceipt({ runs: dirs.map((d) => loadRun(d)), generatedAt: 'now' });
    expect(md).toContain('## Per-question-type scores');
    for (const arm of ['mem0', 'mem0-raw', 'mycelium-timeline', 'mycelium-extract']) {
      expect(md).toContain(`#### ${arm}`);
    }
    expect(md).toContain('## Timeline arm win condition (pre-committed, brief §3)');
    expect(md).toMatch(/\| knowledge-update \| ≥ 0\.60 \| 0\.467 \(n=15\) \| 0\.600 \(n=15\) \| 0\.467 \(n=15\) \| FAIL/);
    expect(md).toMatch(/VERDICT: MISS — /);
    // timeline (104 + 2,468,896) ms / 100 docs = 24.69 s/session vs extract 10.00 → ×2.47
    expect(md).toMatch(/mycelium-timeline 24\.69 s\/session/);
    expect(md).toMatch(/×2\.47/);
    expect(md).toMatch(/reused its extraction facts from run run-a/);
  });

  it('a grid without the timeline arm renders per-type tables but no win-condition block', () => {
    const rowsA = judgedRows('mem0', mem0PerType);
    const dirA = writeFixtureRun('solo-a', {
      runId: 'solo-a',
      arms: { mem0: mem0PerType },
      judged: rowsA,
    });
    const md = renderGridReceipt({ runs: [loadRun(dirA)], generatedAt: 'now' });
    expect(md).toContain('## Per-question-type scores');
    expect(md).not.toContain('win condition');
  });

  // task 230: the composed grid judges the cost bound from the per-session
  // stamps when BOTH sides of the composition carry them — through the REAL
  // buildUnion → renderWinCondition path, not the unit-level function.
  it('a composition whose timeline AND extract runs carry seconds_per_session stamps renders the cost row JUDGED', () => {
    const dirs = writeGridFixtures({
      timelineWriteInfo: { docs: 5, timeline: { per_question: [{ question_id: 'q', seconds_per_session: [8.3, 8.3, 6.1, 6.9, 0.6] }] } },
      extractWriteInfo: { docs: 5, extract: { per_question: [{ question_id: 'q', seconds_per_session: [2, 2, 2, 2, 2] }] } },
    });
    const md = renderGridReceipt({ runs: dirs.map((d) => loadRun(d)), generatedAt: 'now' });
    expect(md).toMatch(/mycelium-timeline 6\.04 s\/session \(stamped seconds_per_session over 5 sessions/);
    expect(md).toMatch(/mycelium-extract 2\.00 s\/session \(stamped seconds_per_session over 5 sessions/);
    expect(md).toMatch(/×3\.02 — FAIL/);
    // the pre-committed verdict: the cost FAIL is a MISS reason beside the cells'
    expect(md).toMatch(/cost ×3\.02 > 2×/);
    expect(md).toMatch(/VERDICT: MISS/);
  });

  it('BANKED composition shape (a mem0-only run + a rejudged timeline run with no write_info) renders the cost row NOT JUDGED exactly as banked', () => {
    // the 2026-09-18 composed receipt's union: run-a carries {mem0, mem0-raw},
    // the timeline side carries NO write_info at all (its summary died with the
    // judge; only the rejudge rows exist)
    const dirs = writeGridFixtures({ timelineWriteInfo: {} });
    const md = renderGridReceipt({ runs: dirs.map((d) => loadRun(d)), generatedAt: 'now' });
    expect(md).toContain('Cost bound (timeline write cost ≤ 2× extract): NOT JUDGED — mycelium-timeline seconds-per-session not stamped.');
  });
});

// ---- wiring: single-run receipt -----------------------------------------------------

describe('receipt wiring (renderReceipt)', () => {
  const summary = {
    run_id: 'r1',
    regime: {
      dataset: { name: 'LongMemEval-S (cleaned)', sha256: 'd6f21ea9' },
      judge: { model: 'j', judge_prompt_version: 'judge-prompt.2' },
      answerer: { model: 'a', max_tokens: 4096 },
      retrieval: { budget: 5 },
    },
    arms: {
      'mycelium-timeline': { n: 2, score: { n: 2, counts: { exact: 1, partial: 0, wrong: 1 }, unparsed: 0, p1_score: 0.5 } },
    },
  };
  const judged = [
    { question_id: 'q-1', arm: 'mycelium-timeline', question_type: 'knowledge-update', label: 'exact' },
    { question_id: 'q-2', arm: 'mycelium-timeline', question_type: 'knowledge-update', label: 'wrong' },
  ];

  it('renders the per-type table from the judged rows + the win-condition block when the timeline arm is present', () => {
    const md = renderReceipt({
      runId: 'r1',
      summary,
      judged,
      writeInfo: { 'mycelium-timeline': { docs: 10, write_ms: 100 } },
      generatedAt: 'now',
    });
    expect(md).toContain('## Per-question-type scores');
    expect(md).toContain('| knowledge-update | 2 | 1 | 0 | 1 | 0.500 |');
    expect(md).toContain('## Timeline arm win condition (pre-committed, brief §3)');
    expect(md).toMatch(/not in this run/);
    expect(md).toMatch(/NOT JUDGED — mycelium-extract seconds-per-session not stamped in this run/);
  });

  it('says "per-question rows absent for <run>" when the run carries no judged rows — never a number from nothing', () => {
    const md = renderReceipt({ runId: 'r1', summary, judged: null, generatedAt: 'now' });
    expect(md).toMatch(/per-question rows absent for r1/);
  });

  it('no per-type section when the run has no judged rows AND no timeline arm is in play', () => {
    const noTl = { ...summary, arms: { mycelium: summary.arms['mycelium-timeline'] } };
    const md = renderReceipt({ runId: 'r1', summary: noTl, judged: null, generatedAt: 'now' });
    expect(md).not.toContain('Per-question-type');
    expect(md).not.toContain('win condition');
  });
});

// ---- the run-side stamp (core.mjs) ----------------------------------------------------

describe('runBench stamps write_ms on the ingestion path', () => {
  it('stamps write_ms for arms with a write phase and leaves write-less arms unstamped', async () => {
    const ticks = [1000, 1500, 1500, 2000]; // fake's write phase: 1000→1500 = 500ms
    let t = 0;
    const arm = (name) => (_ctx) => ({
      name,
      ...(name === 'fake'
        ? {
            async write() {
              return { docs: 1, rows: 1 };
            },
          }
        : {}),
      async answer() {
        return { text: 'x' };
      },
    });
    const result = await runBench({
      items: [{ question_id: 'q-1', question_type: 'multi-session', question: 'q', answer: 'a', haystack_sessions: [[]] }],
      runId: 'r',
      regime: { dataset: {}, n: 1 },
      armFactories: [
        { name: 'none', factory: arm('none') },
        { name: 'fake', factory: arm('fake') },
      ],
      armContext: {},
      nowFn: () => ticks[t++ % ticks.length],
    });
    expect(result.summary.arms.fake.write.write_ms).toBe(500);
    expect(result.summary.arms.none.write.write_ms).toBeUndefined();
    expect(result.summary.arms.none.write.skipped).toBe(true);
  });
});

// ---- the dataset join loader --------------------------------------------------------

describe('loadDatasetTypes', () => {
  it('builds the question_id → question_type map and quotes the join rule with the file sha256', async () => {
    const file = path.join(root, 'ds.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        { question_id: 'q-1', question_type: 'knowledge-update' },
        { question_id: 'q-2', question_type: 'temporal-reasoning' },
      ])
    );
    const { typesByQuestionId, joinRule } = await loadDatasetTypes(file);
    expect(typesByQuestionId.get('q-1')).toBe('knowledge-update');
    expect(joinRule).toMatch(/question_type joined from ds\.json \(sha256 [0-9a-f]{64}\) on question_id/);
  });
});

// ---- the pre-committed spec is load-bearing -----------------------------------------

describe('WIN_CONDITION', () => {
  it('carries the brief §3 bars verbatim', () => {
    expect(WIN_CONDITION.arm).toBe('mycelium-timeline');
    expect(WIN_CONDITION.cells).toEqual([
      { type: 'knowledge-update', min: 0.6 },
      { type: 'single-session-assistant', min: 1.0 },
      { type: 'temporal-reasoning', min: 0.4 },
    ]);
    expect(WIN_CONDITION.minN).toBe(5);
    expect(WIN_CONDITION.costBound).toEqual({ ratio: 2, vs: 'mycelium-extract' });
  });
});
