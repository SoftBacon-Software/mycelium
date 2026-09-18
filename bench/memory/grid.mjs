// The P1 grid receipt, composed from SEPARATE runs (task 183).
//
// renderIngestionGrid draws the {Mycelium, Mem0} × {raw, extract} 2×2 only
// when all four grid arms live in ONE run — but the 3090 window serves two
// 32k slots, so the mem0 pair and the mycelium pair run side by side as two
// runs and the grid would have to be composed by hand. This module makes
// that mechanical: it loads two or more FINISHED run dirs, refuses loudly
// unless the runs are comparable, and on a match writes ONE receipt whose
// 2×2 is renderIngestionGrid over the UNION of the runs' arms — the same
// renderer a single-run receipt uses, never a re-implementation.
//
// A composed grid is quotable only if every run under it is: a capped write
// phase or a cleanup that left rows indexed is stamped in bold at the top.
// A REJUDGED run (summary.json absent, summary.rejudge.json + judged.rejudge.jsonl
// present — what every judge-prompt bump leaves behind) is a finished run too:
// the pair loads, the run is marked from its own rejudge stamp, and the header
// names it so a rejudged column is never mistaken for a primary run (task 224).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderIngestionGrid, factsStatLine, dropStatLine, GRID_ROWS } from './ingestion.mjs';
import { RECEIPTS_DIR } from './receipt.mjs';
import { autopsyRun, renderAutopsySection, DEFAULT_AUTOPSY_ARM } from './miss_autopsy.mjs';
import {
  buildGoldIndex,
  computeRetrievalAudit,
  decideDiagnostic,
  classifyRow,
} from './retrieval_stamp.mjs';
import { SPLITS, loadSplit, selectItems } from './split.mjs';
import { WIN_CONDITION, renderPerTypeTable, renderWinCondition, tallyByType, factsLayerOf, timelineArmLabel } from './per_type.mjs';
import { agreement } from './judge.mjs';

/** Where the director's hand-label files live, keyed by run id (<run_id>.json). */
export const HANDLABELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'handlabels');

// The rejudge pair — what rejudge.mjs writes beside (or instead of) a run's
// own summary.json. The grid admits the pair when the primary summary is gone.
const REJUDGE_SUMMARY_FILE = 'summary.rejudge.json';
const REJUDGE_JUDGED_FILE = 'judged.rejudge.jsonl';

/** A set of runs that cannot share a grid: the message names every differing key. */
export class GridRefusal extends Error {
  constructor(differences, runIds) {
    super(formatRefusal(differences, runIds));
    this.name = 'GridRefusal';
    this.differences = differences;
  }
}

/** A dir that is not a finished run (missing summary/judged) — refuse before comparing. */
export class GridInputError extends Error {}

const defaultReadFile = (f) => fs.readFileSync(f, 'utf8');

function fmtValue(v) {
  if (v === undefined) return '<absent>';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function truncate(s, max = 160) {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// One entry per comparability key: [dotted key, reader]. All runs must agree
// on every one of these or there is no grid — quoting numbers from runs that
// answered different questions, or were judged by different prompts, is a rumour.
export const COMPARABILITY_KEYS = [
  ['dataset.name', (r) => r.summary.regime?.dataset?.name],
  ['dataset.sha256', (r) => r.summary.regime?.dataset?.sha256],
  ['judge.model', (r) => r.summary.regime?.judge?.model],
  ['judge.judge_prompt_version', (r) => r.summary.regime?.judge?.judge_prompt_version],
  ['answerer.model', (r) => r.summary.regime?.answerer?.model],
  ['answerer.max_tokens', (r) => r.summary.regime?.answerer?.max_tokens],
  ['retrieval.budget', (r) => r.summary.regime?.retrieval?.budget],
  ['n', (r) => r.summary.n ?? r.summary.regime?.n],
];

// regime.n mirrors summary.n — same check; keep it out of the allowed-differences list
const COMPARABILITY_PATHS = new Set([...COMPARABILITY_KEYS.map(([k]) => k), 'n']);

/** The stamped write cap, wherever the run put it (regime.write and/or top level). */
export function writeCap(summary) {
  return summary.regime?.write?.max_sessions_per_question ?? summary.max_sessions_per_question ?? null;
}

/** Hand-vs-judge agreement for a rejudged run, from <handlabelsDir>/<of_run_id>.json when it exists; null when it doesn't. */
function handlabelsAgreement(ofRunId, judged, { existsFn, readFileFn, handlabelsDir }) {
  if (!ofRunId) return null;
  const file = path.join(handlabelsDir, `${ofRunId}.json`);
  if (!existsFn(file)) return null;
  let hand;
  try {
    hand = JSON.parse(readFileFn(file));
  } catch (e) {
    throw new GridInputError(`${file}: handlabels file does not parse — ${e.message}`);
  }
  if (!Array.isArray(hand?.items)) {
    throw new GridInputError(`${file}: handlabels file carries no items array — the agreement leg refuses to invent one`);
  }
  const a = agreement(judged, hand.items);
  return { n: a.n, agree: a.agree, rate: a.rate, hand_scorer: hand.hand_scorer ?? null, file };
}

/**
 * Load one run dir: summary.json + the judged rows (for the question-id sets).
 * When summary.json is ABSENT but the rejudge pair (summary.rejudge.json +
 * judged.rejudge.jsonl) is present, the dir is a FINISHED REJUDGED run: the
 * pair loads and the run is marked `rejudge` — of_run_id + judge_prompt_version
 * from the summary's own rejudge stamp. A rejudged run is never again called
 * "not finished". A pair half-present is refused naming the missing file; a
 * dir with neither summary refuses exactly as before. When the rejudged run's
 * of_run_id has a handlabels file, the hand-vs-judge agreement of the rejudged
 * labels is computed at load (the quoting law's judge-agreement leg).
 */
export function loadRun(dir, { existsFn = fs.existsSync, readFileFn = defaultReadFile, parseJsonlFn = null, handlabelsDir = HANDLABELS_DIR } = {}) {
  const parseJsonl = parseJsonlFn ?? ((text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const buildIdSets = (rows) => {
    const judgedIds = new Set();
    const judgedIdsByArm = {};
    for (const row of rows) {
      if (typeof row.question_id !== 'string' || row.question_id.length === 0) continue;
      judgedIds.add(row.question_id);
      if (row.arm) (judgedIdsByArm[row.arm] ??= new Set()).add(row.question_id);
    }
    return { judgedIds, judgedIdsByArm };
  };
  // task 225: each arm's rendered identity from THIS run's regime — the audit
  // keys its cells by it so two same-named arms from differently-stamped runs
  // (memory-rows vs am_facts) stay separate measurements
  const armLabels = (summary) =>
    Object.fromEntries(Object.keys(summary.arms ?? {}).map((a) => [a, timelineArmLabel(summary.regime, a)]));
  const summaryFile = path.join(dir, 'summary.json');
  if (!existsFn(summaryFile)) {
    const rejSummaryFile = path.join(dir, REJUDGE_SUMMARY_FILE);
    const rejJudgedFile = path.join(dir, REJUDGE_JUDGED_FILE);
    const hasRejSummary = existsFn(rejSummaryFile);
    const hasRejJudged = existsFn(rejJudgedFile);
    if (!hasRejSummary && !hasRejJudged) {
      throw new GridInputError(`${dir}: no summary.json — a run without its summary is not finished (in flight, crashed, or not a run dir)`);
    }
    if (!hasRejSummary || !hasRejJudged) {
      const missing = hasRejSummary ? REJUDGE_JUDGED_FILE : REJUDGE_SUMMARY_FILE;
      throw new GridInputError(
        `${dir}: no summary.json and the rejudge pair is incomplete — ${missing} is missing ` +
          `(a rejudged run needs ${REJUDGE_SUMMARY_FILE} + ${REJUDGE_JUDGED_FILE})`
      );
    }
    const summary = JSON.parse(readFileFn(rejSummaryFile));
    const judged = parseJsonl(readFileFn(rejJudgedFile));
    const { judgedIds, judgedIdsByArm } = buildIdSets(judged);
    const ofRunId = summary.regime?.judge?.rejudge?.of_run_id ?? summary.rejudged_from ?? null;
    return {
      dir,
      runId: summary.run_id ?? path.basename(dir),
      summary,
      judged,
      judgedIds,
      judgedIdsByArm,
      labelByArm: armLabels(summary),
      rejudge: {
        of_run_id: ofRunId,
        judge_prompt_version: summary.judge_prompt_version ?? summary.regime?.judge?.judge_prompt_version ?? null,
        agreement: handlabelsAgreement(ofRunId, judged, { existsFn, readFileFn, handlabelsDir }),
      },
    };
  }
  const summary = JSON.parse(readFileFn(summaryFile));
  const judgedFile = path.join(dir, 'judged.jsonl');
  if (!existsFn(judgedFile)) {
    throw new GridInputError(`${dir}: no judged.jsonl — the question-id check needs the judged rows`);
  }
  const judged = parseJsonl(readFileFn(judgedFile));
  const { judgedIds, judgedIdsByArm } = buildIdSets(judged);
  const runId = summary.run_id ?? path.basename(dir);
  return { dir, runId, summary, judged, judgedIds, judgedIdsByArm, labelByArm: armLabels(summary), rejudge: null };
}

function idSetSample(a, b) {
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  const sample = [...onlyA, ...onlyB].sort().slice(0, 5);
  const rest = onlyA.length + onlyB.length - sample.length;
  return { sample, rest, total: onlyA.length + onlyB.length };
}

export function findDifferences(runs) {
  const differences = [];
  for (const [key, read] of COMPARABILITY_KEYS) {
    const values = runs.map((r) => read(r));
    const allSame = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));
    if (!allSame) {
      differences.push({
        key,
        values: runs.map((r, i) => ({ run: r.runId, value: values[i], display: fmtValue(values[i]) })),
      });
    }
  }
  // question ids as SETS — row order does not matter, membership does
  const idSets = runs.map((r) => r.judgedIds);
  const sameIds = idSets.every((s) => s.size === idSets[0].size && [...s].every((x) => idSets[0].has(x)));
  if (!sameIds) differences.push({ key: 'question_ids', idSetMismatch: true });

  // one arm may appear in at most one run — the union would otherwise quote
  // the same arm twice (last writer wins is not evidence). TASK 225: for a run
  // that stamps regime.mycelium_timeline, the arm's identity carries that run's
  // facts layer — the rows-path n=50 and the flag-path n=50 are DIFFERENT
  // measurements that both name their arm `mycelium-timeline`, and they compose
  // as two labeled columns. The same layer appearing twice is still a duplicate,
  // named as such; unstamped regimes key (and render) exactly as before.
  const seen = new Map();
  for (const r of runs) {
    const layer = factsLayerOf(r.summary.regime);
    for (const arm of Object.keys(r.summary.arms ?? {})) {
      const key = JSON.stringify([arm, layer]);
      if (!seen.has(key)) seen.set(key, { arm, layer, runIds: [] });
      seen.get(key).runIds.push(r.runId);
    }
  }
  for (const { arm, layer, runIds } of seen.values()) {
    if (runIds.length > 1) {
      differences.push({
        key: 'duplicate_arm',
        note: layer
          ? `an arm may appear in at most one run per facts layer — '${arm}' [${layer}] is quoted twice`
          : 'an arm may appear in at most one run — the union would quote it twice',
        values: runIds.map((id) => ({ run: id, value: arm, display: layer ? `'${arm}' [${layer}]` : `'${arm}'` })),
      });
    }
  }
  // within one run, every arm must have judged the same question set — an arm
  // that missed questions would sit in the table with a hidden n
  for (const r of runs) {
    for (const [arm, ids] of Object.entries(r.judgedIdsByArm)) {
      if (ids.size !== r.judgedIds.size || [...ids].some((x) => !r.judgedIds.has(x))) {
        differences.push({
          key: `question_ids.by_arm[${arm}]`,
          note: 'every arm in a run must judge the same question set',
          values: [
            {
              run: r.runId,
              value: arm,
              display: `arm '${arm}' judged ${ids.size} of ${r.judgedIds.size} questions`,
            },
          ],
        });
      }
    }
  }
  return differences;
}

function formatRefusal(differences, runIds) {
  const L = ['runs are not comparable — no grid receipt written', `  runs: ${runIds.join(' | ')}`];
  for (const d of differences) {
    if (d.idSetMismatch) {
      const sizes = runIds.map((id, i) => `${id}=${d.sizes[i]} ids`).join(' | ');
      const { sample, rest, total } = d;
      L.push(
        `  question_ids: ${sizes} (symmetric difference ${total}` +
          `${sample.length ? `: ${sample.join(', ')}${rest > 0 ? `, … ${rest} more` : ''}` : ''})` +
          ' — the runs must have judged the SAME questions (compared as sets; order does not matter)'
      );
      continue;
    }
    const note = d.note ? ` (${d.note})` : '';
    L.push(`  ${d.key}${note}: ${d.values.map((v) => `${v.run}=${v.display}`).join(' | ')}`);
  }
  L.push('Fix the runs (or pick comparable ones) and re-run; a grid over incomparable runs is a rumour.');
  return L.join('\n');
}

/** Refuse unless every run matches every other on all comparability keys. Throws GridRefusal. */
export function assertComparable(runs) {
  if (!Array.isArray(runs) || runs.length < 2) {
    throw new GridInputError(`comparability needs at least two runs (got ${runs?.length ?? 0})`);
  }
  const differences = findDifferences(runs);
  for (const d of differences) {
    if (!d.idSetMismatch) continue;
    const sizes = runs.map((r) => r.judgedIds.size);
    const { sample, rest, total } = idSetSample(runs[0].judgedIds, runs[1].judgedIds);
    Object.assign(d, { sizes, sample, rest, total });
  }
  if (differences.length > 0) throw new GridRefusal(differences, runs.map((r) => r.runId));
  return true;
}

/** Flatten a regime object into dotted leaf paths (arrays and nulls are leaves). */
export function flattenRegime(regime, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(regime ?? {})) {
    const key = `${prefix}${k}`;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flattenRegime(v, `${key}.`, out);
    else out[key] = v;
  }
  return out;
}

/** Regime keys that differ across runs but are NOT comparability keys. */
export function allowedDifferences(runs) {
  const flat = runs.map((r) => flattenRegime(r.summary.regime));
  const paths = [...new Set(flat.flatMap((f) => Object.keys(f)))].sort();
  const out = [];
  for (const p of paths) {
    if (COMPARABILITY_PATHS.has(p)) continue;
    const values = flat.map((f) => f[p]);
    if (values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]))) continue;
    out.push({ path: p, values: runs.map((r, i) => ({ run: r.runId, display: truncate(fmtValue(values[i])) })) });
  }
  return out;
}

/** Arms across all runs, grid order first (so the 2×2 reads row-wise), then the rest. */
export function unionArms(runs) {
  const gridOrder = GRID_ROWS.flatMap((r) => [r.raw, r.extract]);
  const names = [];
  for (const r of runs) for (const arm of Object.keys(r.summary.arms ?? {})) if (!names.includes(arm)) names.push(arm);
  return [
    ...names.filter((n) => gridOrder.includes(n)).sort((a, b) => gridOrder.indexOf(a) - gridOrder.indexOf(b)),
    ...names.filter((n) => !gridOrder.includes(n)),
  ];
}

/** Merge every run's arms + write_info into one map each (duplicate arms are refused upstream). */
export function buildUnion(runs) {
  const armsUnion = {};
  const writeUnion = {};
  for (const r of runs) {
    for (const [arm, a] of Object.entries(r.summary.arms ?? {})) armsUnion[arm] = a;
    for (const [arm, w] of Object.entries(r.summary.write_info ?? {})) writeUnion[arm] = w;
  }
  return { armsUnion, writeUnion };
}

function slotLockNotes(regime) {
  return (regime?.notes ?? []).filter((n) => /slot lock/i.test(n));
}

function thinkingNotes(regime) {
  return (regime?.notes ?? []).filter((n) => /think/i.test(n));
}

// 'seconds per add where stamped': the extract arm stamps extract_ms (total LLM
// extraction ms) + docs (sessions written) — the honest s/add is their quotient.
// The timeline arm adds reconcile_ms (its per-candidate ADD/SUPERSEDE/KEEP
// decision calls — the DOMINANT cost, ~10× the extraction): when stamped it is
// part of the write cost and pretending otherwise printed 1.30 s/session for a
// 12.26 s/session phase (r3). Arms that only log per-add timing stay honest by
// absence.
function secondsPerAdd(writeInfo) {
  if (typeof writeInfo?.extract_ms !== 'number' || !writeInfo?.docs) return null;
  const ms = writeInfo.extract_ms + (typeof writeInfo.reconcile_ms === 'number' ? writeInfo.reconcile_ms : 0);
  return (ms / writeInfo.docs / 1000).toFixed(2);
}

// --- retrieval audit (task 207) ------------------------------------------------
//
// The collapsed cells (single-session-preference 0.071, multi-session ≤ 0.333
// in EVERY arm) cannot be diagnosed from banked rows: meta.hits is a count.
// This section renders the read side — hit@budget, median gold rank, MRR per
// question_type × arm — over STAMPED rows only, plus the pre-committed
// diagnostic rule's mechanical branch. Banked rows (stamped before the
// instrument) are counted as `banked` and never assigned ranks.

/** One run's <arm>.rows.jsonl — where the per-row read stamps live. */
export function loadArmRows(dir, arm, { existsFn = fs.existsSync, readFileFn = defaultReadFile } = {}) {
  const file = path.join(dir, `${arm}.rows.jsonl`);
  if (!existsFn(file)) throw new GridInputError(`${file}: no rows file for arm '${arm}'`);
  return readFileFn(file)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Resolve the split a run ran on (regime.dataset.name → SPLITS key) and re-select its items. */
export async function loadAuditItems(summary, { loadSplitFn = loadSplit, selectItemsFn = selectItems } = {}) {
  const name = summary?.regime?.dataset?.name;
  const key = Object.keys(SPLITS).find((k) => SPLITS[k].name === name);
  if (!key) throw new GridInputError(`no split matches regime.dataset.name '${name}' — the audit refuses to guess the corpus`);
  const split = await loadSplitFn(key);
  const n = summary.n ?? summary.regime?.n;
  return selectItemsFn(split.items, n);
}

const AUDIT_COLUMNS = [
  ['rows', 'rows'],
  ['stamped', 'stamped'],
  ['unstamped_banked', 'banked'],
  ['null_error', 'err-null'],
  ['null_no_retrieval', 'no-retr'],
  ['unmapped', 'unmapped'],
  ['gold_not_written', 'gold≥cap'],
  ['no_provenance', 'no-prov'],
  ['ranked', 'ranked'],
];

function fmt1(v) {
  return v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** The per-arm monotone pooling: any arm's replay branch fires the replay; else the first answer-side verdict. */
export function poolDiagnostic(audit, budget) {
  const perArm = Object.entries(audit.cells).map(([arm, byType]) => ({
    arm,
    decision: decideDiagnostic(byType['single-session-preference'] ?? null, budget),
  }));
  const branch = perArm.some((d) => d.decision.branch === 'budget-10-replay')
    ? 'budget-10-replay'
    : perArm.some((d) => d.decision.branch === 'answer-side-transcripts')
      ? 'answer-side-transcripts'
      : 'insufficient-stamps';
  return { branch, perArm };
}

/** Per-question transcript block: what every arm was asked, held, retrieved, and answered. */
export function renderTranscripts(groups) {
  const L = [];
  for (const g of groups) {
    L.push(`#### ${g.question_id} — ${g.question_type}`);
    L.push('');
    L.push(`**Q:** ${g.question}`);
    L.push('');
    L.push(`**Gold:** ${g.gold}`);
    L.push('');
    L.push('| arm | judged | gold rank (1-based) | answer |');
    L.push('|---|---|---|---|');
    for (const a of g.perArm) {
      L.push(`| ${a.arm} | ${a.label ?? '—'} | ${a.gold_rank ?? '—'} | ${truncate(a.answer ?? '', 200)} |`);
    }
    L.push('');
  }
  return L;
}

export function renderRetrievalAuditSection({ audit, goldCoverage, writeCapValue, diagnostic, budget: _budget, transcripts = null }) {
  const L = [];
  L.push('## Retrieval audit — read-side provenance (task 207)');
  L.push('');
  L.push(
    `Gold mapping method + coverage: ${goldCoverage.mapped}/${goldCoverage.total} questions mapped ` +
      `(methods: ${Object.entries(goldCoverage.methods).map(([m, c]) => `\`${m}\` ${c}`).join(', ')}; ` +
      `unmapped ${goldCoverage.unmapped} — counted, EXCLUDED from rank stats` +
      `${goldCoverage.sample_unmapped.length ? `; e.g. ${goldCoverage.sample_unmapped.join(', ')}` : ''}).`
  );
  L.push('');
  L.push(
    `Retrieval budget: ${audit.budget}. ` +
      (writeCapValue != null
        ? `Write phase was CAPPED at ${writeCapValue} sessions/question — a gold session at index ≥ cap was never written and is counted \`gold≥cap\`, never charged against retrieval.`
        : 'No write cap stamped.') +
      ' Rows stamped before this instrument carry counts only (`meta.hits`) — they appear as `banked` and are never assigned ranks. ' +
      'Rank stats run over STAMPED, mapped, gold-written, provenance-carrying rows only (`ranked`).'
  );
  L.push('');
  L.push(`| arm | question_type | ${AUDIT_COLUMNS.map(([, h]) => h).join(' | ')} | hit@budget | med gold rank | MRR |`);
  L.push(`|---|---|${AUDIT_COLUMNS.map(() => '---').join('|')}|---|---|---|`);
  for (const [arm, byType] of Object.entries(audit.cells)) {
    for (const [qtype, cell] of Object.entries(byType)) {
      L.push(
        `| ${arm} | ${qtype} | ${AUDIT_COLUMNS.map(([k]) => cell[k]).join(' | ')} | ${fmt1(cell.hit_at_budget)} | ${fmt1(cell.median_gold_rank)} | ${fmt1(cell.mrr)} |`
      );
    }
  }
  L.push('');
  L.push('### Pre-committed diagnostic rule (decided by the stamped ranks alone)');
  L.push('');
  for (const d of diagnostic.perArm) {
    L.push(`- ${d.arm} / single-session-preference: ${d.decision.reason}`);
  }
  L.push('');
  L.push(`**Pooled branch: \`${diagnostic.branch}\`.**`);
  L.push('');
  if (diagnostic.branch === 'budget-10-replay') {
    L.push(
      'NEXT (director, after this receipt): replay the single-session-preference questions at `--budget 10`, all arms — ' +
        '`node bench/memory/run.mjs --split longmemeval --arms <arms> --n 50 --question-type single-session-preference --budget 10 --receipt` — ' +
        'and stamp the receipt `diagnostic: budget-10, NON-COMPARABLE`: budget is a comparability key, so a budget-10 run can never enter a grid with the banked budget-5 runs.'
    );
    L.push('');
  } else if (diagnostic.branch === 'answer-side-transcripts') {
    L.push(
      'The gold already sits within the top-budget context — the collapsed cells are an ANSWER-side miss. ' +
        'Transcripts below (all single-session-preference questions + the 12 worst multi-session rows by gold rank) are for hand labels.'
    );
    L.push('');
    if (transcripts?.length) {
      L.push('### Transcripts for hand labels');
      L.push('');
      L.push(...renderTranscripts(transcripts));
    } else {
      L.push('(No transcripts rendered — no ranked rows met the selection.)');
      L.push('');
    }
  }
  return L;
}

/** The transcript groups behind the answer-side branch: all preference questions + the 12 worst multi-session rows. */
export function buildTranscriptGroups({ runs, goldIndex, writeCapValue, limit = 12 }) {
  const perRow = [];
  for (const run of runs) {
    for (const [arm, rows] of Object.entries(run.rowsByArm ?? {})) {
      // rendered under the arm's labeled identity from its own run's regime;
      // judged-row joins stay on the raw arm name (task 225)
      const label = run.labelByArm?.[arm] ?? arm;
      for (const row of rows ?? []) {
        const mapping = goldIndex.byQuestion.get(row.question_id) ?? null;
        const c = classifyRow({
          readHits: row.meta?.read_hits,
          readHitsAvailable: row.meta?.read_hits_available,
          mapping,
          writeCap: writeCapValue,
        });
        const judged = run.judged?.find((j) => j.arm === arm && j.question_id === row.question_id);
        perRow.push({
          question_id: row.question_id,
          question_type: row.question_type,
          question: row.question,
          gold: row.gold,
          arm: label,
          answer: row.answer,
          label: judged?.label ?? null,
          gold_rank: c.gold_rank,
          ranked: c.stamp === 'stamped' && !c.unmapped && c.gold_written !== false && c.session_provenance && c.gold_rank != null,
        });
      }
    }
  }
  const byQuestion = new Map();
  for (const r of perRow) {
    if (!byQuestion.has(r.question_id)) {
      byQuestion.set(r.question_id, {
        question_id: r.question_id,
        question_type: r.question_type,
        question: r.question,
        gold: r.gold,
        perArm: [],
      });
    }
    byQuestion.get(r.question_id).perArm.push({ arm: r.arm, label: r.label, answer: r.answer, gold_rank: r.gold_rank });
  }
  const preference = [...byQuestion.values()].filter((g) => g.question_type === 'single-session-preference');
  const multiWorst = perRow
    .filter((r) => r.question_type === 'multi-session' && r.ranked)
    .sort((a, b) => (b.gold_rank ?? 0) - (a.gold_rank ?? 0))
    .slice(0, limit)
    .map((r) => r.question_id);
  const multi = [...new Set(multiWorst)].map((qid) => byQuestion.get(qid)).filter(Boolean);
  return [...preference, ...multi];
}

export function renderGridReceipt({ runs, generatedAt, commands = [], autopsies = null, auditSection = null, datasetTypes = null }) {
  const runIds = runs.map((r) => r.runId);
  const L = [];
  L.push(`# Receipt — memory benchmark P1 grid (${runIds.join(' + ')})`);
  L.push('');
  L.push(`Generated: ${generatedAt}`);
  L.push('');
  L.push(
    `Composed from ${runs.length} separate runs; one regime each, one grid. Comparability was checked ` +
      'mechanically (see below) — this receipt contains no hand-typed numbers.'
  );

  // A capped or unclean run is NOT a quotable grid — say so at the top, in bold.
  const warnings = [];
  for (const r of runs) {
    const cap = writeCap(r.summary);
    if (cap !== null) warnings.push(`${r.runId} write phase CAPPED at ${cap} sessions/question (regime.write.max_sessions_per_question)`);
    const remaining = r.summary.cleanup?.rows_remaining_after;
    if (typeof remaining === 'number' && remaining > 0) {
      warnings.push(`${r.runId} platform cleanup left ${remaining} rows indexed (cleanup.rows_remaining_after)`);
    }
  }
  if (warnings.length) {
    L.push('');
    L.push(`**NOT A QUOTABLE GRID: ${warnings.join('; ')}. A capped or unclean run is not a quotable grid.**`);
  }

  // task 224: a rejudged run is named at the top, beside the bold stamps — a
  // reader must not be able to mistake a rejudged column for a primary run.
  // The judge-agreement leg rides the stamp when the run's handlabels file
  // exists (the quoting law: the number is quoted only with its agreement
  // leg); its absence is stated, never silent.
  const rejudgedNotes = runs
    .filter((r) => r.rejudge)
    .map((r) => {
      const jpv = r.rejudge.judge_prompt_version ?? '<unstamped>';
      const leg = r.rejudge.agreement
        ? `; hand-vs-judge agreement ${r.rejudge.agreement.rate.toFixed(3)} (n=${r.rejudge.agreement.n}, ${path.basename(r.rejudge.agreement.file)})`
        : r.rejudge.of_run_id
          ? `; no handlabels file for ${r.rejudge.of_run_id} — the judge-agreement leg is NOT rendered`
          : '; no of_run_id in the rejudge stamp — the judge-agreement leg is NOT rendered';
      return `${r.runId} is a REJUDGE of ${r.rejudge.of_run_id ?? '<unknown>'} — labels re-computed under ${jpv}${leg}`;
    });
  if (rejudgedNotes.length) {
    L.push('');
    L.push(
      `**CONTAINS REJUDGED RUN(S): ${rejudgedNotes.join('; ')}.** ` +
        'A rejudged run has no summary.json — its column is the rejudge pair (summary.rejudge.json + judged.rejudge.jsonl), its labels re-computed from the saved answers. It is not a primary run.'
    );
  }

  // scores: every arm of every run, one row each — the arm named from ITS OWN
  // run's regime (task 225: `mycelium-timeline [memory-rows]` vs `… [am_facts]`)
  L.push('');
  L.push('## Scores');
  L.push('');
  L.push('| arm | run | n | exact | partial | wrong | p1_score |');
  L.push('|---|---|---|---|---|---|---|');
  for (const arm of unionArms(runs)) {
    for (const r of runs) {
      const a = r.summary.arms?.[arm];
      if (!a) continue;
      const c = a.score?.counts ?? { exact: 0, partial: 0, wrong: 0 };
      L.push(`| ${timelineArmLabel(r.summary.regime, arm)} | ${r.runId} | ${a.n} | ${c.exact} | ${c.partial} | ${c.wrong} | ${a.score?.p1_score?.toFixed(3) ?? 'n/a'} |`);
    }
  }
  L.push('');
  L.push('`p1_score` = (exact + 0.5×partial) / n. Raw counts are the primary record; the score is the one-number comparison.');

  // the 2×2 — renderIngestionGrid over the UNION (the same renderer a
  // single-run receipt uses; it draws only when all four grid arms are present)
  const { armsUnion, writeUnion } = buildUnion(runs);
  L.push('');
  L.push('## Ingestion controls ({Mycelium, Mem0} × {raw, extract})');
  L.push('');
  const grid = renderIngestionGrid(armsUnion, writeUnion);
  if (grid) {
    for (const line of grid) L.push(line);
  } else {
    const missing = GRID_ROWS.flatMap((r) => [r.raw, r.extract]).filter((n) => !armsUnion[n]);
    L.push(
      `The 2×2 is NOT rendered — the union of these runs is missing grid arm(s): ${missing.join(', ')}. ` +
        'A grid needs all four ({Mycelium, Mem0} × {raw, extract}) across the composed runs.'
    );
  }
  L.push('');

  // task 207: the read-side retrieval audit — rendered only when asked for
  // (--retrieval-audit); it reads the runs' stamped rows, never invents ranks
  // for banked ones, and decides the pre-committed diagnostic branch.
  if (auditSection) {
    L.push(...auditSection);
    L.push('');
  }

  // task 205: per-run knowledge-update miss autopsies, rendered beside the
  // cell table — a run whose stamps are present must be diagnosable from the
  // receipt, not re-derived by hand. Runs without the arm simply don't appear.
  if (autopsies) {
    for (const a of autopsies) {
      if (!a) continue;
      L.push(`## Knowledge-update miss autopsy (${a.label ?? a.arm} — ${a.run_id})`);
      L.push('');
      if (a.error) {
        L.push(`NOT COMPUTED — ${a.error}`);
      } else {
        L.push(renderAutopsySection(a, { heading: null }));
      }
      L.push('');
    }
  }

  // ingestion stats per arm (facts per session, seconds per add where stamped) —
  // one entry per (run, arm): a layer-aware composite can carry the same arm
  // name twice, each with its own write stamps (task 225)
  L.push('## Ingestion stats per arm');
  L.push('');
  for (const arm of unionArms(runs)) {
    for (const owner of runs) {
      if (!owner.summary.arms?.[arm]) continue;
      const label = timelineArmLabel(owner.summary.regime, arm);
      const w = owner.summary.write_info?.[arm];
      if (!w) {
        L.push(`- ${label} (${owner.runId}): no write-phase stats stamped.`);
        continue;
      }
      const facts = factsStatLine(w);
      const perAdd = secondsPerAdd(w);
      const bits = [`- ${label} (${owner.runId}): docs ${w.docs ?? 'n/a'}, rows ${w.rows ?? 'n/a'}.`];
      if (facts) bits.push(`Facts per session: ${facts}.`);
      const dropped = dropStatLine(w);
      if (dropped) bits.push(`Ingestion loss: ${dropped}.`);
      bits.push(
        perAdd !== null
          ? typeof w.reconcile_ms === 'number'
            ? `Seconds per add (stamped extract_ms ${w.extract_ms} ms + reconcile_ms ${w.reconcile_ms} ms / ${w.docs} docs): ${perAdd} s/session.`
            : `Seconds per add (stamped extract_ms ${w.extract_ms} ms / ${w.docs} docs): ${perAdd} s/session.`
          : 'Seconds per add: not stamped.'
      );
      L.push(bits.join(' '));
    }
  }

  // task 199: per-question-type scores — the one-number score row cannot say
  // whether an arm won the CELLS it was built for (brief §3). From each arm's
  // own judged rows; a run whose per-question rows are absent renders that
  // absence (never a number from nothing). One table per (run, arm): a
  // layer-aware composite can carry the same arm name on both sides of the
  // facts-layer comparison, and each side is judged from ITS OWN rows (task 225).
  const talliesByArm = {};
  const regimeByArm = {};
  const timelineEntries = []; // [{run, tally, label}] — the win condition renders one block per timeline-carrying run
  L.push('');
  L.push('## Per-question-type scores');
  L.push('');
  for (const arm of unionArms(runs)) {
    for (const owner of runs) {
      if (!owner.summary.arms?.[arm]) continue;
      const label = timelineArmLabel(owner.summary.regime, arm);
      if (!Array.isArray(owner.judged)) {
        L.push(`per-question rows absent for ${owner.runId}`);
        L.push('');
        continue;
      }
      talliesByArm[arm] = tallyByType(owner.judged.filter((r) => r.arm === arm), {
        typesByQuestionId: datasetTypes?.typesByQuestionId ?? null,
        joinRule: datasetTypes?.joinRule ?? null,
      });
      regimeByArm[arm] = owner.summary.regime ?? {};
      if (arm === WIN_CONDITION.arm) timelineEntries.push({ run: owner, tally: talliesByArm[arm], label });
      for (const line of renderPerTypeTable(label, talliesByArm[arm])) L.push(line);
      L.push('');
    }
  }

  // the timeline arm judged by its pre-committed cells — its own bar, not the
  // one number (renderWinCondition states the bars + the verdict rule).
  // TASK 225: when the composite carries the timeline arm on BOTH sides of the
  // facts-layer comparison, each side gets its own block under the SAME bars —
  // the §3 greenfield question (does the product's am_facts table match the
  // namespace simulation cell-for-cell?) is answered per column, never merged.
  if (armsUnion[WIN_CONDITION.arm]) {
    const timelineRuns = runs.filter((r) => r.summary.arms?.[WIN_CONDITION.arm]);
    if (timelineRuns.length <= 1) {
      const only = timelineRuns[0];
      for (const line of renderWinCondition({
        talliesByArm,
        writeInfoByArm: writeUnion,
        regimeByArm,
        armDisplay: only ? timelineArmLabel(only.summary.regime, WIN_CONDITION.arm) : WIN_CONDITION.arm,
      })) {
        L.push(line);
      }
      L.push('');
    } else {
      for (const r of timelineRuns) {
        const entry = timelineEntries.find((e) => e.run === r);
        const label = timelineArmLabel(r.summary.regime, WIN_CONDITION.arm);
        for (const line of renderWinCondition({
          talliesByArm: { ...talliesByArm, [WIN_CONDITION.arm]: entry?.tally },
          writeInfoByArm: { ...writeUnion, [WIN_CONDITION.arm]: r.summary.write_info?.[WIN_CONDITION.arm] },
          regimeByArm: { ...regimeByArm, [WIN_CONDITION.arm]: r.summary.regime ?? {} },
          armDisplay: label,
          headingNote: `\`${label}\` — run ${r.runId}`,
        })) {
          L.push(line);
        }
        L.push('');
      }
    }
  }

  // comparability: the keys that were checked and their shared value
  L.push('');
  L.push('## Comparability (checked, all equal)');
  L.push('');
  L.push('| key | value |');
  L.push('|---|---|');
  for (const [key, read] of COMPARABILITY_KEYS) {
    L.push(`| ${key} | ${truncate(fmtValue(read(runs[0])), 80)} |`);
  }
  L.push(`| question_ids | ${runs[0].judgedIds.size} ids (identical set across runs; order ignored) |`);
  L.push('');

  // per-run provenance
  L.push('## Per-run provenance');
  for (const r of runs) {
    const reg = r.summary.regime ?? {};
    L.push('');
    L.push(`### ${r.runId}`);
    L.push('');
    L.push(`- results dir: \`${r.dir}\``);
    L.push(`- generated_at: ${reg.date_utc ?? '<absent>'}`);
    L.push(`- git: \`${reg.git_sha ?? '<absent>'}\`${reg.git_dirty ? ' (dirty)' : ''}`);
    L.push(`- harness: ${reg.harness ?? '<absent>'}`);
    L.push(`- arms: ${Object.keys(r.summary.arms ?? {}).join(', ')}`);
    const cleanup = r.summary.cleanup;
    L.push(
      `- cleanup: ${
        cleanup
          ? `deleted ${cleanup.deleted ?? 0} rows, ${cleanup.rows_remaining_after ?? 0} remaining${cleanup.kept ? ' (KEPT --keep)' : ''}`
          : 'not recorded (no platform arm ran, or --keep)'
      }`
    );
    for (const n of slotLockNotes(reg)) L.push(`- slot lock: ${n}`);
    for (const n of thinkingNotes(reg)) L.push(`- thinking: ${n}`);
  }

  // differences that were allowed
  const allowed = allowedDifferences(runs);
  L.push('');
  L.push('## Differences that were allowed');
  L.push('');
  if (allowed.length === 0) {
    L.push('None — the regimes agree outside the comparability keys.');
  } else {
    L.push('These regime keys differ between the runs but are NOT comparability keys (per-run identity, timestamps, which slot, which namespace):');
    L.push('');
    for (const d of allowed) {
      L.push(`- ${d.path}: ${d.values.map((v) => `${v.run}=${v.display}`).join(' | ')}`);
    }
  }

  L.push('');
  L.push('## Exact commands');
  L.push('');
  L.push('```bash');
  for (const c of commands) L.push(c);
  L.push('```');
  L.push('');
  L.push('## Artifacts');
  L.push('');
  for (const r of runs) {
    const pair = r.rejudge ? 'summary.rejudge.json, judged.rejudge.jsonl' : 'summary.json, judged.jsonl';
    L.push(`- rows + summary: \`${r.dir}\` (${pair}, <arm>.rows.jsonl)`);
  }
  L.push('');
  return L.join('\n');
}

/**
 * Compose the grid receipt from finished run dirs. Refuses loudly (GridRefusal,
 * exit 1 via the CLI's catch) unless the runs are comparable; on a match writes
 * ONE receipt `receipts/<idA>+<idB>-grid.md` and returns its path.
 */
export function composeGrid({
  dirs,
  generatedAt,
  receiptsDir = RECEIPTS_DIR,
  write = true, // false = dry run: check comparability, write nothing
  autopsy = false, // render per-run knowledge-update miss autopsies beside the 2×2
  audit = false, // task 207: render the retrieval audit + the pre-committed diagnostic branch
  existsFn = fs.existsSync,
  readFileFn = defaultReadFile,
  handlabelsDir = HANDLABELS_DIR, // where a rejudged run's hand-label file is looked up
  writeFn = fs.writeFileSync,
  mkdirFn = fs.mkdirSync,
  commandLine = null,
  loadSplitFn = loadSplit, // test seams for the audit's corpus resolution
  selectItemsFn = selectItems,
  datasetTypes = null, // {typesByQuestionId, joinRule} — for rows lacking question_type (--dataset)
}) {
  if (!Array.isArray(dirs) || dirs.length < 2) {
    throw new GridInputError(`--grid-from-results needs at least two run dirs (got ${dirs?.length ?? 0})`);
  }
  const runs = dirs.map((d) => loadRun(d, { existsFn, readFileFn, handlabelsDir }));
  assertComparable(runs);
  const runIds = runs.map((r) => r.runId);
  const commands =
    commandLine != null
      ? [commandLine]
      : [`node bench/memory/run.mjs --grid-from-results ${dirs.join(',')} --receipt${autopsy ? ' --autopsy' : ''}${audit ? ' --retrieval-audit' : ''}`];
  const { armsUnion } = buildUnion(runs);
  const gridRendered = GRID_ROWS.flatMap((r) => [r.raw, r.extract]).every((n) => armsUnion[n]);
  if (!write) return { file: null, runIds, gridRendered, receipt: null };

  // the autopsies need the arm's rows file — loaded only when asked for, and
  // only for runs that carry the arm; a run without it just doesn't appear
  const autopsies = autopsy
    ? runs
        .filter((r) => r.summary.arms?.[DEFAULT_AUTOPSY_ARM])
        .map((r) => {
          try {
            return {
              ...autopsyRun({ dir: r.dir, arm: DEFAULT_AUTOPSY_ARM, existsFn, readFileFn }),
              run_id: r.runId,
              label: timelineArmLabel(r.summary.regime, DEFAULT_AUTOPSY_ARM),
            };
          } catch (e) {
            // a finished run missing its rows file must not sink the grid — but it is said, not swallowed
            return { arm: DEFAULT_AUTOPSY_ARM, run_id: r.runId, wrong_knowledge_update: 0, classes: {}, flags: {}, stamps: { rows: 0 }, details: [], ledger_coverage: null, error: e.message };
          }
        })
    : null;

  // task 207: the retrieval audit. Loads each run's <arm>.rows.jsonl (a missing
  // rows file is an ERROR line in the section, not a silent absence), maps the
  // dataset's gold answer sessions, computes the per-type × arm stats over
  // STAMPED rows, and runs the pre-committed rule — mechanical, no judgement.
  let auditMeta = null;
  if (audit) {
    const budget = runs[0].summary.regime?.retrieval?.budget;
    const capValue = writeCap(runs[0].summary);
    auditMeta = (async () => {
      const loaded = runs.map((r) => {
        const rowsByArm = {};
        const errors = [];
        for (const arm of Object.keys(r.summary.arms ?? {})) {
          try {
            rowsByArm[arm] = loadArmRows(r.dir, arm, { existsFn, readFileFn });
          } catch (e) {
            errors.push(`${r.runId}/${arm}: ${e.message}`);
          }
        }
        return { runId: r.runId, summary: r.summary, judged: r.judged, rowsByArm, errors, labelByArm: r.labelByArm };
      });
      const goldIndex = buildGoldIndex(await loadAuditItems(runs[0].summary, { loadSplitFn, selectItemsFn }));
      const anyRows = loaded.some((r) => Object.keys(r.rowsByArm).length > 0);
      if (!anyRows) {
        return {
          lines: [
            '## Retrieval audit — read-side provenance (task 207)',
            '',
            `NOT COMPUTED — no run carried a rows file this audit could read (${[...loaded.flatMap((r) => r.errors)].join('; ') || 'no arms resolved'}).`,
            '',
          ],
          branch: null,
        };
      }
      const aud = computeRetrievalAudit({ runs: loaded, goldIndex, budget, writeCap: capValue });
      const diagnostic = poolDiagnostic(aud, budget);
      const transcripts =
        diagnostic.branch === 'answer-side-transcripts' ? buildTranscriptGroups({ runs: loaded, goldIndex, writeCapValue: capValue }) : null;
      return {
        lines: renderRetrievalAuditSection({
          audit: aud,
          goldCoverage: goldIndex.coverage,
          writeCapValue: capValue,
          diagnostic,
          budget,
          transcripts,
        }),
        branch: diagnostic.branch,
      };
    })();
  }

  const finish = (resolvedAudit) => {
    const md = renderGridReceipt({ runs, generatedAt, commands, autopsies, auditSection: resolvedAudit?.lines ?? null, datasetTypes });
    mkdirFn(receiptsDir, { recursive: true });
    const file = path.join(receiptsDir, `${runIds.join('+')}-grid.md`);
    writeFn(file, md);
    return { file, runIds, gridRendered, diagnosticBranch: resolvedAudit?.branch ?? null };
  };
  if (audit && auditMeta) return auditMeta.then(finish);
  return finish(null);
}
