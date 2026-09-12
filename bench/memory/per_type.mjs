// Per-question-type scoring + the timeline arm's pre-committed win condition
// (task 199; the bars are §3 of BRIEF-lab-alive-memory-program).
//
// The one-number p1_score cannot say whether the timeline arm won the cells it
// was BUILT for — the brief pre-committed knowledge-update ≥ 0.60 (Mem0's cell)
// while holding single-session-assistant ≥ 1.00 and temporal-reasoning ≥ 0.40,
// plus a cost bound (≤ 2× the extract arm's seconds per session). This module
// renders those cells from the runs' own per-question rows and write stamps.
// Every number is computed from evidence; an absent row set or stamp renders as
// its absence ("per-question rows absent", "not stamped") — never a number from
// nothing.

import { createHash } from 'node:crypto';
import fs from 'node:fs';

// LongMemEval-S question types (the dataset's own taxonomy), canonical order.
export const QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
];

// The pre-committed bars (brief §3, verbatim in structure). Changing these is a
// director decision, not a rendering choice — the grid judges the arm by THEM.
export const WIN_CONDITION = {
  arm: 'mycelium-timeline',
  comparators: ['mem0', 'mycelium-extract'],
  cells: [
    { type: 'knowledge-update', min: 0.6 },
    { type: 'single-session-assistant', min: 1.0 },
    { type: 'temporal-reasoning', min: 0.4 },
  ],
  minN: 5,
  costBound: { ratio: 2, vs: 'mycelium-extract' },
};

const fmtScore = (s) => s.toFixed(3);
const fmtMin = (m) => m.toFixed(2);

// (exact + 0.5×partial) / n — the same p1_score the summary uses, per cell.
export function p1ScoreOf({ n, exact, partial }) {
  if (!n) return null;
  return (exact + 0.5 * partial) / n;
}

/**
 * Tally judged rows per question type. Type resolution per row:
 *   1. the row's own question_type;
 *   2. else typesByQuestionId.get(question_id) — joined from the dataset, with
 *      joinRule quoted (see loadDatasetTypes);
 *   3. else the row lands in `unknown` under its raw type value (or 'absent') —
 *      counted, never guessed.
 * A label outside exact/partial/wrong throws: the judged contract is three
 * labels, and a tally that shrugs at a fourth is a lying table.
 */
export function tallyByType(rows, { typesByQuestionId = null, joinRule = null } = {}) {
  const byType = Object.fromEntries(QUESTION_TYPES.map((t) => [t, { n: 0, exact: 0, partial: 0, wrong: 0 }]));
  const unknown = {};
  for (const row of rows) {
    const label = row.label;
    if (label !== 'exact' && label !== 'partial' && label !== 'wrong') {
      throw new Error(`judged row ${row.arm ?? '?'}/${row.question_id}: label '${label}' is not exact/partial/wrong — refusing to tally a lying table`);
    }
    let type = typeof row.question_type === 'string' && row.question_type ? row.question_type : null;
    if (!type && typesByQuestionId) type = typesByQuestionId.get(row.question_id) ?? null;
    const bucket = type ? byType[type] : null;
    if (!bucket) {
      const key = type ?? row.question_type ?? 'absent';
      unknown[key] = (unknown[key] ?? 0) + 1;
      continue;
    }
    bucket.n += 1;
    bucket[label] += 1;
  }
  return { byType, unknown, joinRule };
}

/** The per-arm per-type table. Unknown rows render explicitly so n still sums. */
export function renderPerTypeTable(arm, tally) {
  const L = [];
  L.push(`#### ${arm}`);
  L.push('');
  L.push('| question_type | n | exact | partial | wrong | p1_score |');
  L.push('|---|---|---|---|---|---|');
  for (const type of QUESTION_TYPES) {
    const c = tally.byType[type] ?? { n: 0, exact: 0, partial: 0, wrong: 0 };
    const s = p1ScoreOf(c);
    L.push(`| ${type} | ${c.n} | ${c.exact} | ${c.partial} | ${c.wrong} | ${s === null ? 'n/a' : fmtScore(s)} |`);
  }
  for (const [key, n] of Object.entries(tally.unknown ?? {})) {
    const label = key === 'absent' ? 'unknown (question_type absent)' : `unknown (${key})`;
    L.push(`| ${label} | ${n} | - | - | - | n/a |`);
  }
  if (Object.keys(tally.unknown ?? {}).length) {
    L.push(
      tally.joinRule
        ? `Rows lacking question_type were joined from the dataset — ${tally.joinRule}.`
        : 'Rows lacking question_type could not be resolved: no dataset was supplied for the join — unresolved rows are listed as unknown, never guessed.'
    );
  }
  return L;
}

/** One pre-committed cell: PASS / FAIL at the bar, or refused when n < minN. */
export function judgeCell(counts, min, minN = WIN_CONDITION.minN) {
  const score = p1ScoreOf(counts);
  if (counts.n < minN) return { n: counts.n, score, verdict: 'n too small', undecided: true };
  return {
    n: counts.n,
    score,
    verdict: score >= min ? 'PASS' : 'FAIL',
    undecided: false,
  };
}

/**
 * The overall verdict. Pre-committed rule, stated in the rendered block:
 *   any cell FAIL or a judged cost-bound FAIL → MISS;
 *   else any cell undecided (n < 5)           → UNDECIDED (smallest such n);
 *   else WIN.
 * An UNJUDGED cost bound (a missing stamp) never decides the verdict.
 */
export function winVerdict({ cells, cost }) {
  const reasons = [];
  for (const c of cells) {
    if (c.verdict === 'FAIL') reasons.push(`${c.type} ${fmtScore(c.score)} < ${fmtMin(c.min)}`);
  }
  if (cost?.verdict === 'FAIL') reasons.push(`cost ×${cost.ratio.toFixed(2)} > ${WIN_CONDITION.costBound.ratio}×`);
  if (reasons.length) return { verdict: 'MISS', reasons, line: `MISS — ${reasons.join('; ')}` };
  const undecided = cells.filter((c) => c.undecided || c.verdict === 'n too small');
  if (undecided.length) {
    const k = Math.min(...undecided.map((c) => c.n));
    return { verdict: 'UNDECIDED', reasons: [], line: `UNDECIDED (n=${k})` };
  }
  return { verdict: 'WIN', reasons: [], line: 'WIN' };
}

/**
 * Seconds per session for one arm's write phase, from the arm's OWN stamp.
 * Prefers the wall-clock write_ms stamp (core.mjs stamps it on every arm since
 * task 199); falls back to the LLM-time stamps the extract/timeline arms
 * stamped before it existed (extract_ms [+ reconcile_ms]). Null when neither
 * exists or docs is missing — the caller renders "not stamped", never a number.
 */
export function secondsPerSessionStamp(writeInfo) {
  const w = writeInfo;
  if (!w || typeof w.docs !== 'number' || !w.docs) return null;
  if (typeof w.write_ms === 'number') {
    return {
      kind: 'write_ms',
      seconds: w.write_ms / w.docs / 1000,
      label: `stamped write_ms ${w.write_ms} ms / ${w.docs} docs (wall clock of the write phase)`,
    };
  }
  if (typeof w.extract_ms === 'number') {
    const hasRec = typeof w.reconcile_ms === 'number';
    const ms = w.extract_ms + (hasRec ? w.reconcile_ms : 0);
    return {
      kind: 'extract_ms',
      seconds: ms / w.docs / 1000,
      label: `stamped extract_ms ${w.extract_ms} ms${hasRec ? ` + reconcile_ms ${w.reconcile_ms} ms` : ''} / ${w.docs} docs (LLM time of the write phase)`,
    };
  }
  return null;
}

/** The ≤2×-of-extract cost bound, judged only when BOTH stamps exist. */
export function renderCostBound({ timeline, extract, timelineRegime = null, notStampedPhrase = 'not stamped' }) {
  const tl = secondsPerSessionStamp(timeline);
  const ex = secondsPerSessionStamp(extract);
  const L = [];
  if (!tl) {
    L.push(`Cost bound (timeline write cost ≤ ${WIN_CONDITION.costBound.ratio}× extract): NOT JUDGED — mycelium-timeline seconds-per-session ${notStampedPhrase}.`);
    return L;
  }
  if (!ex) {
    L.push(`Cost bound (timeline write cost ≤ ${WIN_CONDITION.costBound.ratio}× extract): NOT JUDGED — mycelium-extract seconds-per-session ${notStampedPhrase}.`);
    return L;
  }
  const ratio = tl.seconds / ex.seconds;
  const verdict = ratio <= WIN_CONDITION.costBound.ratio ? 'PASS' : 'FAIL';
  L.push(
    `Cost bound (timeline write cost ≤ ${WIN_CONDITION.costBound.ratio}× extract): mycelium-timeline ${tl.seconds.toFixed(2)} s/session (${tl.label}) ` +
      `vs mycelium-extract ${ex.seconds.toFixed(2)} s/session (${ex.label}) — ×${ratio.toFixed(2)} — ${verdict}.`
  );
  const reused = timelineRegime?.facts_reused_from ?? timelineRegime?.mycelium_timeline?.facts_reused_from ?? null;
  if (reused?.run_id) {
    L.push(
      `Note: mycelium-timeline reused its extraction facts from run ${reused.run_id} — its extract_ms excludes the extraction wall time; ` +
        'the stamped figure is the reconcile phase the reuse still paid.'
    );
  }
  return L;
}

function cellText(counts, min) {
  const c = judgeCell(counts, min);
  return { ...c, display: c.score === null ? 'n/a' : `${fmtScore(c.score)} (n=${counts.n})` };
}

/**
 * The win-condition block for the timeline arm. Cells judged on the timeline
 * arm's own rows; the comparator arms (mem0, mycelium-extract) render beside
 * for context, 'not in grid' when absent. Ends with the pre-committed verdict
 * line: WIN / MISS (reasons) / UNDECIDED (n=<k>).
 */
export function renderWinCondition({ talliesByArm, writeInfoByArm = {}, regimeByArm = {}, absentLabel = 'not in grid', notStampedPhrase = 'not stamped' }) {
  const arm = WIN_CONDITION.arm;
  const L = [];
  L.push('## Timeline arm win condition (pre-committed, brief §3)');
  L.push('');
  L.push(
    `Bars pre-committed in BRIEF-lab-alive-memory-program §3: ${WIN_CONDITION.cells.map((c) => `${c.type} ≥ ${fmtMin(c.min)}`).join('; ')} ` +
      `(${WIN_CONDITION.cells[0].type} is Mem0's cell; the other two are the cells extraction loses). ` +
      `Cell score = p1_score over the cell's rows; the n is that arm's cell n; a cell with n < ${WIN_CONDITION.minN} gets no verdict.`
  );
  L.push('');
  L.push(
    `Verdict rule (pre-committed): any cell FAIL, or a judged cost bound FAIL (≤ ${WIN_CONDITION.costBound.ratio}× the extract arm's seconds per session), → MISS; ` +
      `else any cell with n < ${WIN_CONDITION.minN} → UNDECIDED (smallest such n); else WIN. ` +
      'An unjudged cost bound never decides. Ingestion loss (≤ Mem0\'s 1.1%) is rendered in the ingestion stats above.'
  );
  L.push('');
  const header = ['cell', 'bar', arm, ...WIN_CONDITION.comparators, 'verdict'];
  L.push(`| ${header.join(' | ')} |`);
  L.push(`|${header.map(() => '---').join('|')}|`);
  const judgedCells = [];
  for (const cell of WIN_CONDITION.cells) {
    const own = talliesByArm[arm]?.byType[cell.type] ?? { n: 0, exact: 0, partial: 0, wrong: 0 };
    const judged = cellText(own, cell.min);
    judgedCells.push({ type: cell.type, min: cell.min, ...judged });
    const beside = WIN_CONDITION.comparators.map((name) => {
      const t = talliesByArm[name]?.byType[cell.type];
      if (!t || !t.n) return absentLabel;
      const s = p1ScoreOf(t);
      return `${fmtScore(s)} (n=${t.n})`;
    });
    const verdictText = judged.undecided ? `n too small (n=${own.n})` : `${judged.verdict} (${fmtScore(judged.score)} ${judged.verdict === 'PASS' ? '≥' : '<'} ${fmtMin(cell.min)})`;
    L.push(`| ${cell.type} | ≥ ${fmtMin(cell.min)} | ${judged.display} | ${beside.join(' | ')} | ${verdictText} |`);
  }
  L.push('');
  const cost = judgeCost({ writeInfoByArm, regimeByArm, notStampedPhrase });
  for (const line of cost.lines) L.push(line);
  const v = winVerdict({ cells: judgedCells, cost: cost.result });
  L.push('');
  L.push(`VERDICT: ${v.line}`);
  return L;
}

/** Judge the cost bound from the arms' stamps; null result = not judged. */
function judgeCost({ writeInfoByArm, regimeByArm, notStampedPhrase }) {
  const timeline = writeInfoByArm[WIN_CONDITION.arm] ?? null;
  const extract = writeInfoByArm[WIN_CONDITION.costBound.vs] ?? null;
  const lines = renderCostBound({
    timeline,
    extract,
    timelineRegime: regimeByArm[WIN_CONDITION.arm] ?? null,
    notStampedPhrase,
  });
  const tl = secondsPerSessionStamp(timeline);
  const ex = secondsPerSessionStamp(extract);
  let result = null;
  if (tl && ex) {
    const ratio = tl.seconds / ex.seconds;
    result = { verdict: ratio <= WIN_CONDITION.costBound.ratio ? 'PASS' : 'FAIL', ratio };
  }
  return { lines, result };
}

/**
 * question_id → question_type from a LongMemEval dataset file, for joining rows
 * that lack the type. The join rule quotes the file name + its sha256 so the
 * receipt names exactly what was joined.
 */
export async function loadDatasetTypes(file) {
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const typesByQuestionId = new Map();
  for (const it of items) {
    if (it?.question_id && it?.question_type) typesByQuestionId.set(it.question_id, it.question_type);
  }
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const base = file.split('/').pop();
  return {
    typesByQuestionId,
    joinRule: `question_type joined from ${base} (sha256 ${sha256}) on question_id`,
  };
}
