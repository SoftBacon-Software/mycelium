#!/usr/bin/env node
// Render the retrieval-audit section for ONE finished run, standalone.
//
// Why this exists (task 304, review B 2026-11-03): the grid's honesty laws
// refuse a single-run receipt (no comparable partner in the bank), but the
// task-264 numbers needed re-rendering over the banked 2026-09-19 run after
// R@k became question-scoped. This tool loads the run EXACTLY the way
// composeGrid does — same loadRun, same loadArmRows, same gold index, same
// section renderer — and writes the section plus a provenance header. No
// hand-typed numbers: every cell in the output is computed from the run's own
// rows + the dataset's gold evidence ids at render time.
//
// Usage:
//   node bench/memory/tools/render_retrieval_audit.mjs <runDir> [--out FILE]
//
// <runDir>  a results/<runId> dir with summary.json + judged.jsonl + <arm>.rows.jsonl
// --out     receipt file to write (default: receipts/<runId>-retrieval-audit.md)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGoldIndex,
  computeRetrievalAudit,
} from '../retrieval_stamp.mjs';
import {
  buildTranscriptGroups,
  loadArmRows,
  loadAuditItems,
  loadRun,
  poolDiagnostic,
  renderRetrievalAuditSection,
  writeCap,
} from '../grid.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECEIPTS_DIR = path.join(ROOT, 'bench', 'memory', 'receipts');

function fail(msg) {
  console.error(`render_retrieval_audit: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const runDir = argv.find((a) => !a.startsWith('--'));
if (!runDir) fail('usage: node bench/memory/tools/render_retrieval_audit.mjs <runDir> [--out FILE]');
const outFlag = argv.indexOf('--out');
const out = outFlag !== -1 ? argv[outFlag + 1] : path.join(RECEIPTS_DIR, `${path.basename(runDir)}-retrieval-audit.md`);

const run = loadRun(runDir);
const budget = run.summary.regime?.retrieval?.budget;
const capValue = writeCap(run.summary);

const rowsByArm = {};
const errors = [];
for (const arm of Object.keys(run.summary.arms ?? {})) {
  try {
    rowsByArm[arm] = loadArmRows(run.dir, arm);
  } catch (e) {
    errors.push(`${run.runId}/${arm}: ${e.message}`);
  }
}
if (!Object.keys(rowsByArm).length) fail(`no rows files readable (${errors.join('; ')})`);

// judged labels keyed by RAW arm name — the same join computeRetrievalAudit runs
const judgedByArm = {};
for (const j of run.judged ?? []) if (j.arm) (judgedByArm[j.arm] ??= []).push(j);

const goldIndex = buildGoldIndex(await loadAuditItems(run.summary));
const audit = computeRetrievalAudit({ runs: [{ runId: run.runId, summary: run.summary, judgedByArm, rowsByArm, labelByArm: run.labelByArm }], goldIndex, budget, writeCap: capValue });
const diagnostic = poolDiagnostic(audit, budget);
const transcripts = diagnostic.branch === 'answer-side-transcripts'
  ? buildTranscriptGroups({ runs: [{ runId: run.runId, rowsByArm, labelByArm: run.labelByArm, judged: run.judged }], goldIndex, writeCapValue: capValue })
  : null;

const L = [];
L.push(`# Retrieval audit — single-run render (task 207 + task 264)`);
L.push('');
L.push(`Run: ${run.runId} (\`bench/memory/results/${path.basename(run.dir)}\`).`);
L.push('');
L.push(
  `Rendered by \`bench/memory/tools/render_retrieval_audit.mjs\` over this run's OWN banked rows + the dataset's gold evidence ids — ` +
    'the exact section a grid receipt carries, computed at render time (no hand-typed numbers). ' +
    'R@k is QUESTION-SCOPED (task 304, review B 2026-11-03): a hit credits gold only when the retrieved session belongs to THIS question\'s haystack — ' +
    'banked hits resolve their owning question from the `<runId>-<qid>-s<idx>` source id. ' +
    'Protocol: retrieval runs over the run\'s POOLED store (all questions\' haystacks share it), not LongMemEval\'s per-question collection — ' +
    'this R@k is NOT comparable to a published per-question R@k (e.g. MemPalace\'s 96.6% R@5).'
);
L.push('');
L.push(
  'A composed 2-run grid REFUSES here today when no comparable partner exists in the bank (judge-prompt drift across runs, duplicate arms) — ' +
    'the grid\'s own honesty laws; this file is the section render, not a quotable grid.'
);
if (errors.length) {
  L.push('');
  L.push(`**Rows files that could not be read: ${errors.join('; ')}.**`);
}
L.push('');
L.push(...renderRetrievalAuditSection({
  audit,
  goldCoverage: goldIndex.coverage,
  writeCapValue: capValue,
  diagnostic,
  budget,
  transcripts,
}));
L.push('');
L.push(`---`);
L.push(`Rendered: ${new Date().toISOString()} — \`node bench/memory/tools/render_retrieval_audit.mjs ${path.relative(ROOT, run.dir)}\``);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, L.join('\n') + '\n');
console.log(`wrote ${out} (branch: ${diagnostic.branch})`);
