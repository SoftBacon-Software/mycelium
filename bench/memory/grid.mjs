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

import fs from 'node:fs';
import path from 'node:path';

import { renderIngestionGrid, factsStatLine, dropStatLine, GRID_ROWS } from './ingestion.mjs';
import { RECEIPTS_DIR } from './receipt.mjs';

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

/** Load one run dir: summary.json + the judged rows (for the question-id sets). */
export function loadRun(dir, { existsFn = fs.existsSync, readFileFn = defaultReadFile, parseJsonlFn = null } = {}) {
  const parseJsonl = parseJsonlFn ?? ((text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const summaryFile = path.join(dir, 'summary.json');
  if (!existsFn(summaryFile)) {
    throw new GridInputError(`${dir}: no summary.json — a run without its summary is not finished (in flight, crashed, or not a run dir)`);
  }
  const summary = JSON.parse(readFileFn(summaryFile));
  const judgedFile = path.join(dir, 'judged.jsonl');
  if (!existsFn(judgedFile)) {
    throw new GridInputError(`${dir}: no judged.jsonl — the question-id check needs the judged rows`);
  }
  const judged = parseJsonl(readFileFn(judgedFile));
  const judgedIds = new Set();
  const judgedIdsByArm = {};
  for (const row of judged) {
    if (typeof row.question_id !== 'string' || row.question_id.length === 0) continue;
    judgedIds.add(row.question_id);
    if (row.arm) (judgedIdsByArm[row.arm] ??= new Set()).add(row.question_id);
  }
  const runId = summary.run_id ?? path.basename(dir);
  return { dir, runId, summary, judged, judgedIds, judgedIdsByArm };
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
  // the same arm twice (last writer wins is not evidence)
  const seen = new Map();
  for (const r of runs) {
    for (const arm of Object.keys(r.summary.arms ?? {})) {
      if (!seen.has(arm)) seen.set(arm, []);
      seen.get(arm).push(r.runId);
    }
  }
  for (const [arm, runIds] of seen) {
    if (runIds.length > 1) {
      differences.push({
        key: 'duplicate_arm',
        note: 'an arm may appear in at most one run — the union would quote it twice',
        values: runIds.map((id) => ({ run: id, value: arm, display: `'${arm}'` })),
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
// Arms that only log per-add timing (mem0/zep/letta) stay honest by absence.
function secondsPerAdd(writeInfo) {
  if (typeof writeInfo?.extract_ms !== 'number' || !writeInfo?.docs) return null;
  return (writeInfo.extract_ms / writeInfo.docs / 1000).toFixed(2);
}

export function renderGridReceipt({ runs, generatedAt, commands = [] }) {
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

  // scores: every arm of every run, one row each
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
      L.push(`| ${arm} | ${r.runId} | ${a.n} | ${c.exact} | ${c.partial} | ${c.wrong} | ${a.score?.p1_score?.toFixed(3) ?? 'n/a'} |`);
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

  // ingestion stats per arm (facts per session, seconds per add where stamped)
  L.push('## Ingestion stats per arm');
  L.push('');
  for (const arm of unionArms(runs)) {
    const w = writeUnion[arm];
    const owner = runs.find((r) => r.summary.arms?.[arm]);
    if (!w) {
      L.push(`- ${arm} (${owner?.runId ?? '?'}): no write-phase stats stamped.`);
      continue;
    }
    const facts = factsStatLine(w);
    const perAdd = secondsPerAdd(w);
    const bits = [`- ${arm} (${owner?.runId ?? '?'}): docs ${w.docs ?? 'n/a'}, rows ${w.rows ?? 'n/a'}.`];
    if (facts) bits.push(`Facts per session: ${facts}.`);
    const dropped = dropStatLine(w);
    if (dropped) bits.push(`Ingestion loss: ${dropped}.`);
    bits.push(
      perAdd !== null
        ? `Seconds per add (stamped extract_ms ${w.extract_ms} ms / ${w.docs} docs): ${perAdd} s/session.`
        : 'Seconds per add: not stamped.'
    );
    L.push(bits.join(' '));
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
    L.push(`- rows + summary: \`${r.dir}\` (summary.json, judged.jsonl, <arm>.rows.jsonl)`);
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
  existsFn = fs.existsSync,
  readFileFn = defaultReadFile,
  writeFn = fs.writeFileSync,
  mkdirFn = fs.mkdirSync,
  commandLine = null,
}) {
  if (!Array.isArray(dirs) || dirs.length < 2) {
    throw new GridInputError(`--grid-from-results needs at least two run dirs (got ${dirs?.length ?? 0})`);
  }
  const runs = dirs.map((d) => loadRun(d, { existsFn, readFileFn }));
  assertComparable(runs);
  const runIds = runs.map((r) => r.runId);
  const commands =
    commandLine != null ? [commandLine] : [`node bench/memory/run.mjs --grid-from-results ${dirs.join(',')} --receipt`];
  const { armsUnion } = buildUnion(runs);
  const gridRendered = GRID_ROWS.flatMap((r) => [r.raw, r.extract]).every((n) => armsUnion[n]);
  if (!write) return { file: null, runIds, gridRendered, receipt: null };
  const md = renderGridReceipt({ runs, generatedAt, commands });
  mkdirFn(receiptsDir, { recursive: true });
  const file = path.join(receiptsDir, `${runIds.join('+')}-grid.md`);
  writeFn(file, md);
  return { file, runIds, gridRendered };
}
