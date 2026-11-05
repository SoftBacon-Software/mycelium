#!/usr/bin/env node
// task 333 — the regime table: every banked run file, one row per run × arm,
// grouped by regime, with a MIXED audit over every composed grid receipt.
//
// Why: a composed grid can quote rows from more than one regime (the 330
// survey's banked timeline numbers are the 3090-qwen3.8 regime; a Mac-XS pilot
// number beside them is another regime) and nothing made that visible. This
// table makes it visible; bench/memory/grid.mjs (same task) makes the composer
// REFUSE it unless --allow-mixed-regime is passed.
//
// Everything here is RENDERED from the run files and the receipts — no
// hand-typed numbers (the bench's own law). Run: node bench/memory/regimes.mjs
// → writes bench/memory/regimes.md, prints the row count, exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  effectiveJudgePromptVersion,
  effectiveN,
  findRegimeDifferences,
  loadRun,
  regimeIdentity,
  rejudgeJudgePromptStamp,
} from './grid.mjs';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCH_DIR, '..', '..');
const DEFAULT_RESULTS = path.join(BENCH_DIR, 'results');
const DEFAULT_RECEIPTS = path.join(BENCH_DIR, 'receipts');
const DEFAULT_OUT = path.join(BENCH_DIR, 'regimes.md');

const PRIMARY_SUMMARY = 'summary.json';
const REJUDGE_STEM = 'summary.rejudge'; // summary.rejudge.json + summary.rejudge-<tag>.json

const fmtInt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));

/** A run-like for the grid.mjs effective readers: rejudge files mark themselves. */
export function runLike(entry) {
  return entry.kind === 'primary'
    ? { runId: entry.runId, summary: entry.summary, rejudge: null }
    : {
        runId: entry.runId,
        summary: entry.summary,
        rejudge: {
          // task 333-F2: the ONE stamp reader (grid.mjs's) — a second inline
          // parser beside the composer's is how the table and the grid drift
          judge_prompt_version: rejudgeJudgePromptStamp(entry.summary),
          pair: [],
          stem: entry.tag ?? 'rejudge',
        },
      };
}

/** Every banked run FILE under resultsDir (a dir can bank several: primary + rejudge passes). */
export function collectRunFiles(resultsDir, readFileFn = (f) => fs.readFileSync(f, 'utf8')) {
  const out = [];
  let dirNames;
  try {
    dirNames = fs
      .readdirSync(resultsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return out;
  }
  for (const dirName of dirNames) {
    const dir = path.join(resultsDir, dirName);
    let summaries;
    try {
      summaries = fs
        .readdirSync(dir)
        .filter((f) => f === PRIMARY_SUMMARY || (f.startsWith(REJUDGE_STEM) && f.endsWith('.json')))
        .sort();
    } catch {
      continue;
    }
    for (const file of summaries) {
      const relFile = path.join('bench/memory/results', dirName, file);
      // kind comes from the FILENAME (not the tag): summary.json is the primary;
      // summary.rejudge.json is the UNSUFFIXED rejudge pair (tag null);
      // summary.rejudge-<tag>.json is a named pass (task 229)
      let kind, tag;
      if (file === PRIMARY_SUMMARY) {
        kind = 'primary';
        tag = null;
      } else if (file === `${REJUDGE_STEM}.json`) {
        kind = 'rejudge';
        tag = null;
      } else {
        kind = 'rejudge';
        tag = file.slice(`${REJUDGE_STEM}-`.length, -'.json'.length);
      }
      let summary;
      try {
        summary = JSON.parse(readFileFn(path.join(dir, file)));
      } catch (e) {
        out.push({ dir, dirName, file: relFile, kind: 'unreadable', tag: null, runId: null, summary: null, error: e.message });
        continue;
      }
      out.push({
        dir,
        dirName,
        file: relFile,
        kind,
        tag,
        runId: summary.run_id ?? dirName,
        summary,
      });
    }
  }
  return out;
}

/** The judged-rows file paired with a run file (primary ↔ judged.jsonl; pass ↔ its tagged file). */
function judgedRowsFile(entry) {
  if (entry.kind === 'primary') return path.join(entry.dir, 'judged.jsonl');
  const tagged = entry.tag ? `judged.rejudge-${entry.tag}.jsonl` : 'judged.rejudge.jsonl';
  return path.join(entry.dir, tagged);
}

function readJsonlSafe(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

/** Per-question-type exact/total from the run file's OWN judged rows (typed rows only). */
export function tallyByType(rows, arm) {
  const tally = {};
  for (const r of rows ?? []) {
    if (arm !== null && r.arm !== arm) continue;
    if (!r.question_type) continue;
    const t = (tally[r.question_type] ??= { exact: 0, total: 0 });
    t.total += 1;
    if (r.label === 'exact') t.exact += 1;
  }
  return tally;
}

/** Write decisions summed from the arm's rows file meta.write_decisions (the 224225 shape). */
export function writeDecisions(dir, arm) {
  const rows = readJsonlSafe(path.join(dir, `${arm}.rows.jsonl`));
  if (!rows) return null;
  const totals = { adds: 0, supersedes: 0, keeps: 0, candidates: 0 };
  let seen = 0;
  for (const r of rows) {
    const w = r.meta?.write_decisions;
    if (!w) continue;
    seen += 1;
    for (const k of Object.keys(totals)) totals[k] += w[k] ?? 0;
  }
  return seen > 0 ? { ...totals, rows_with_decisions: seen } : null;
}

/** The embedder a run's retrieval actually used — platform-stamped, sidecar-stamped, or none. */
export function resolveEmbedder(regime) {
  const p = regime?.platform ?? {};
  if (p.embedding_provider || p.embedding_model) {
    return `${p.embedding_model} (platform ${p.embedding_provider ?? ''} @ ${p.url_host ?? '?'})`;
  }
  const m = regime?.mem0?.embedder;
  if (m) return `${m.model} (mem0 sidecar @ ${m.base_url_host}${m.dims ? `, ${m.dims}d` : ''})`;
  const z = regime?.zep?.embedder;
  if (z) return `${z.model} (zep sidecar @ ${z.base_url_host ?? z.host ?? '?'})`;
  const l = regime?.letta?.embedder;
  if (l) return `${l.model} (letta sidecar @ ${l.base_url_host ?? l.host ?? '?'})`;
  return '—';
}

/** Thinking on/off for the run's extraction arms (answerer arms don't think by harness rule). */
export function thinkingStamp(regime) {
  const stamps = [];
  for (const [block, label] of [['mycelium_timeline', 'timeline'], ['mycelium_extract', 'extract'], ['mem0', 'mem0']]) {
    const b = regime?.[block];
    const t = b?.extraction_thinking ?? b?.decision_thinking;
    if (t) stamps.push(`${label}:${t}`);
  }
  return stamps.length ? stamps.join(' ') : '—';
}

/** One line per arm of one run file, rendered from its own evidence. */
export function headline(entry) {
  const parts = [];
  const rows = readJsonlSafe(judgedRowsFile(entry));
  for (const [arm, a] of Object.entries(entry.summary.arms ?? {})) {
    const c = a?.score?.counts;
    if (!c) continue;
    parts.push(
      `${arm}: p1 ${Number(a.score.p1_score ?? 0).toFixed(3)} (${c.exact}/${c.partial}/${c.wrong} of ${a.n ?? c.exact + c.partial + c.wrong})`
    );
    const tally = tallyByType(rows, arm);
    for (const t of Object.keys(tally).sort()) {
      const { exact, total } = tally[t];
      parts.push(`${t} ${exact}/${total}`);
    }
    const w = writeDecisions(entry.dir, arm);
    if (w) {
      parts.push(
        `write: ADD ${fmtInt(w.adds)} / SUP ${fmtInt(w.supersedes)} / KEEP ${fmtInt(w.keeps)} (${fmtInt(w.candidates)} candidates over ${fmtInt(w.rows_with_decisions)} rows)`
      );
    }
  }
  return parts.join(' · ');
}

/** The human one-liner that names a regime (shown as the group heading). */
export function regimeLabel(run) {
  const r = run.summary.regime ?? {};
  const a = r.answerer ?? {};
  const j = r.judge ?? {};
  return [
    `${a.model ?? '?'} @ ${a.url_host ?? '?'}`,
    `judge ${j.model ?? '?'} @ ${j.url_host ?? '?'}`,
    `judge prompt ${effectiveJudgePromptVersion(run) ?? '<unstamped>'}`,
    `budget ${r.retrieval?.budget ?? '?'}`,
    `n ${effectiveN(run) ?? '?'}`,
    `dataset ${r.dataset?.name ?? '?'}`,
  ].join(' · ');
}

/** Group run files by the canonical regime identity — ONE definition, grid.mjs's regimeIdentity. */
export function groupByRegime(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.kind === 'unreadable') continue;
    const run = runLike(entry);
    const id = regimeIdentity(run);
    if (!groups.has(id)) groups.set(id, { label: regimeLabel(run), entries: [] });
    groups.get(id).entries.push(entry);
  }
  return [...groups.values()];
}

/**
 * Audit every composed grid receipt: which runs did it cite, are their regimes
 * one or many (the composer's own rule — findRegimeDifferences), and is any
 * cited run file gone from the tree (named, never silent)?
 */
export function auditGridReceipts(receiptsDir, entries, { loadRunFn = loadRun } = {}) {
  let files;
  try {
    files = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('-grid.md')).sort();
  } catch {
    return [];
  }
  const byRunId = new Map(entries.filter((e) => e.kind !== 'unreadable').map((e) => [e.runId, e]));
  const audits = [];
  for (const file of files) {
    const md = fs.readFileSync(path.join(receiptsDir, file), 'utf8');
    const titleMatch = md.match(/^# Receipt — memory benchmark P1 grid \(([^)]*)\)/m);
    const cited = titleMatch
      ? titleMatch[1].split(' + ').map((s) => s.trim()).filter(Boolean)
      : [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
    const resolved = [];
    const unverifiable = [];
    for (const id of cited) {
      const e = byRunId.get(id);
      if (!e) unverifiable.push(id);
      else resolved.push(e);
    }
    let mixed = [];
    const unloadable = [];
    if (resolved.length >= 2) {
      const runs = [];
      for (const e of resolved) {
        try {
          runs.push(loadRunFn(e.dir));
        } catch (err) {
          // a parsed summary that is not a LOADABLE run (no judged side, …)
          // yields no regime read — named in the verdict, never a silent
          // "one regime" over an uncompared pair
          unloadable.push(`${e.runId} (${err.message.split('\n')[0]})`);
        }
      }
      if (runs.length >= 2) mixed = findRegimeDifferences(runs);
    }
    audits.push({
      file: path.join('bench/memory/receipts', file),
      cited,
      unverifiable,
      unloadable,
      mixed,
      regimeLabels: [...new Set(resolved.map((e) => regimeLabel(runLike(e))))],
    });
  }
  return audits;
}

const TABLE_HEADER =
  '| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |';

function renderEntryRow(entry) {
  const r = entry.summary.regime ?? {};
  const a = r.answerer ?? {};
  const j = r.judge ?? {};
  const run = runLike(entry);
  const cells = [
    r.date_utc ?? '?',
    r.dataset?.name ?? '?',
    String(effectiveN(run) ?? '?'),
    a.model ?? '?',
    a.url_host ?? '?',
    resolveEmbedder(r),
    `${j.model ?? '?'} @ ${j.url_host ?? '?'}`,
    effectiveJudgePromptVersion(run) ?? '<unstamped>',
    thinkingStamp(r),
    headline(entry),
    entry.file,
  ];
  return `| ${cells.map((c) => String(c).replaceAll('|', '\\|')).join(' | ')} |`;
}

function auditVerdict(au) {
  const parts = [];
  if (au.mixed.length) parts.push(`**MIXED** — ${au.mixed.map((d) => d.key).join(', ')}`);
  if (au.unverifiable.length) {
    parts.push(`UNVERIFIABLE: ${au.unverifiable.join(', ')} — no run file in the tree`);
  }
  if (au.unloadable?.length) {
    parts.push(`UNREADABLE AS A RUN: ${au.unloadable.join('; ')} — the regime comparison could not include it`);
  }
  if (parts.length) return parts.join('; ');
  return au.regimeLabels.length >= 2
    ? 'one regime (differs only in fields the composer does not refuse on)'
    : 'one regime';
}

export function renderRegimesMd({ groups, audits, unreadable, noSummaryDirs, generatedAt, resultsDir, receiptsDir }) {
  const L = [];
  L.push('# Memory benchmark — every banked run, by regime (task 333)');
  L.push('');
  // task 333-F3: the stamp is DERIVED (the newest banked run's date_utc), so
  // regenerating on a clean tree is byte-identical — no wall-clock line
  L.push(`Generated: ${generatedAt} (the newest banked run file's date_utc — regeneration is byte-stable)`);
  L.push('');
  L.push(
    `Rendered from the run files under \`${path.relative(REPO_ROOT, resultsDir)}/\` ` +
      '(primary `summary.json` + every `summary.rejudge*.json` pass) — no hand-typed numbers. ' +
      'One row per run file × arm; grouped by regime. A number is quotable only beside numbers from the SAME regime; ' +
      'the grid composer now refuses a cross-regime composition (bench/memory/grid.mjs: `regime.answerer.url_host`, ' +
      '`regime.judge.url_host`, `regime.answerer.temperature`, stamped platform fields) unless `--allow-mixed-regime` ' +
      'is passed — and then the receipt prints the regimes side by side.'
  );
  L.push('');
  const total = groups.reduce((acc, g) => acc + g.entries.length, 0);
  for (const [i, g] of groups.entries()) {
    L.push(`## Regime ${i + 1} of ${groups.length}`);
    L.push('');
    L.push(g.label);
    L.push('');
    L.push(TABLE_HEADER);
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const e of g.entries) L.push(renderEntryRow(e));
    L.push('');
  }
  L.push(`**${total} banked run files in ${groups.length} regimes.**`);
  L.push('');
  L.push('## Composed grids — regime audit (every `receipts/*-grid.md`)');
  L.push('');
  if (audits.length === 0) {
    L.push(`No composed grid receipts under \`${path.relative(REPO_ROOT, receiptsDir)}/\`.`);
    L.push('');
  } else {
    L.push('| grid receipt | cited runs | regimes found | verdict |');
    L.push('|---|---|---|---|');
    for (const au of audits) {
      L.push(`| ${au.file} | ${au.cited.join(' + ') || '—'} | ${au.regimeLabels.length || 0} | ${auditVerdict(au)} |`);
    }
    L.push('');
    const mixedCount = audits.filter((au) => au.mixed.length).length;
    const unverifiableIds = [...new Set(audits.flatMap((au) => au.unverifiable))];
    const unloadableCount = audits.reduce((acc, au) => acc + (au.unloadable?.length ?? 0), 0);
    L.push(
      `**${audits.length} composed grids audited: ${mixedCount} MIXED, ${unverifiableIds.length} unverifiable citation(s)` +
        `${unverifiableIds.length ? ` (${unverifiableIds.join(', ')})` : ''}` +
        `${unloadableCount ? `, ${unloadableCount} run(s) unreadable as a run` : ''}.**` +
        (unverifiableIds.length
          ? ' A grid citing a run file that no longer exists in the tree cannot be re-checked — named, never silent.'
          : '')
    );
    L.push('');
  }
  if (unreadable.length) {
    L.push(`Unreadable banked summaries (shown, never swallowed): ${unreadable.map((u) => u.file).join(', ')}`);
    L.push('');
  }
  if (noSummaryDirs.length) {
    L.push(
      `Result dirs with NO banked summary (route smokes / evidence-gone dirs — excluded from the table): ${noSummaryDirs.join(', ')}.`
    );
    L.push('');
  }
  return L.join('\n');
}

/**
 * The table's generation stamp — the NEWEST banked run file's own regime
 * date_utc, NOT the wall clock (task 333-F3): a regenerated table must be
 * byte-identical to the committed one, so the only thing allowed to move the
 * stamp is a newly banked run. Deterministic from file CONTENT, so it survives
 * a fresh clone (where file mtimes would all be checkout time).
 */
export function generatedFromRuns(entries) {
  const stamps = entries
    .filter((e) => e.kind !== 'unreadable' && typeof e.summary?.regime?.date_utc === 'string')
    .map((e) => e.summary.regime.date_utc)
    .sort();
  return stamps.at(-1) ?? 'no banked run stamps a date_utc';
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsDir = args.results ? path.resolve(args.results) : DEFAULT_RESULTS;
  const receiptsDir = args.receipts ? path.resolve(args.receipts) : DEFAULT_RECEIPTS;
  const outFile = args.out ? path.resolve(args.out) : DEFAULT_OUT;

  const collected = collectRunFiles(resultsDir);
  const unreadable = collected.filter((e) => e.kind === 'unreadable');
  const groups = groupByRegime(collected);
  const audits = auditGridReceipts(receiptsDir, collected);
  let allDirs;
  try {
    allDirs = fs
      .readdirSync(resultsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    allDirs = [];
  }
  const withSummary = new Set(collected.map((e) => e.dirName));
  const noSummaryDirs = allDirs.filter((d) => !withSummary.has(d));

  const md = renderRegimesMd({ groups, audits, unreadable, noSummaryDirs, generatedAt: generatedFromRuns(collected), resultsDir, receiptsDir });
  fs.writeFileSync(outFile, md);

  const total = groups.reduce((acc, g) => acc + g.entries.length, 0);
  const mixed = audits.filter((au) => au.mixed.length).length;
  const unverifiable = audits.reduce((acc, au) => acc + au.unverifiable.length, 0);
  console.log(
    `regimes: ${total} banked run files in ${groups.length} regimes; ` +
      `${audits.length} composed grids audited (mixed: ${mixed}, unverifiable citations: ${unverifiable}) -> ${path.relative(process.cwd(), outFile)}`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
