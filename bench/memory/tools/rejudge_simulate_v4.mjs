#!/usr/bin/env node
// rejudge_simulate_v4 — SIMULATION of a judge-prompt.4 rejudge over a saved
// run's answers, with a SCRIPTED judge backend. No live judge calls, no writes
// into the run's real results dir: the rows are copied to a temp dir, the
// rejudge runs THERE through the real stage A/B machinery (makeJudge +
// rejudgeRun), and every artifact stays in the temp dir. The report JSON lands
// beside this script (committed — tmp artifacts die).
//
//   node bench/memory/tools/rejudge_simulate_v4.mjs bench/memory/results/<run> \
//     [--suffix v4] [--v2-pass judged.rejudge.jsonl] \
//     [--handlabels bench/memory/handlabels/<run>.json] [--keep]
//
// The scripted backend: fact-gold label calls REPLAY the v2 pass's label (the
// v4 fact prompt is v2 verbatim, so a v4 fact-row label IS a v2 label — the
// sim proves the plumbing, the director's live leg produces the real ones);
// abstention-gold label calls take explicit scripted verdicts below. An
// abstention row without an explicit verdict REFUSES the sim — no silent
// defaults on evidence.
//
// The adoption rule is checked mechanically: a v4 that moves any
// NON-abstention row relative to the v2 pass is not adopted (task 226
// pre-commitment) — the sim exits 1 if its own backend does that.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rejudgeRun } from '../rejudge.mjs';
import { makeJudge, agreement, JUDGE_PROMPT_VERSION } from '../judge.mjs';
import { renderReceipt } from '../receipt.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

// Explicit scripted verdicts for abstention-gold rows. The four the task 226
// pre-commitment names EXACT are not listed — an abstention row absent from
// this map defaults to EXACT (decline-without-inventing), EXCEPT nothing is
// silent: the report prints every abstention row and its verdict.
const SIM_ABSTENTION_WRONG = {
  // the deliberately-unpredicated abstention row of run 2026-09-17-p1-224225:
  // its answer asserts a pet record ("your dairy goat named Ginger") that the
  // gold contradicts ("You mentioned your cat Luna but not your hamster") —
  // under the abstention prompt's strict reading that is inventing. The LIVE
  // leg decides; the sim only proves the plumbing.
  '0862e8bf_abs': 'answer asserts a pet record the gold contradicts (goat Ginger vs cat Luna) — inventing under the strict abstention reading',
};

function die(msg) {
  console.error(`rejudge_simulate_v4: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    out[key] = key === 'keep' ? true : argv[++i];
  }
  return out;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Reconstruct (gold, answer) from a label prompt's fixed header — the sim's
// backend keys its replay by exactly these two strings.
function parseLabelPrompt(user) {
  const gAt = user.indexOf('\nGold reference answer: ');
  const aAt = user.indexOf('\nAssistant answer: ');
  if (gAt === -1 || aAt === -1) return null;
  return {
    gold: user.slice(gAt + '\nGold reference answer: '.length, aAt),
    answer: user.slice(aAt + '\nAssistant answer: '.length).split('\n\n')[0],
  };
}

const args = parseArgs(process.argv.slice(2));
const runDir = path.resolve(args._[0] ?? die('usage: rejudge_simulate_v4.mjs <resultsDir> [--suffix v4] [--v2-pass <file>] [--handlabels <file>] [--keep]'));
if (!fs.existsSync(runDir)) die(`no such dir: ${runDir}`);
const runId = path.basename(runDir);
const suffix = args.suffix ?? 'v4';
const v2File = args['v2-pass'] ?? path.join(runDir, 'judged.rejudge.jsonl');
if (!fs.existsSync(v2File)) die(`no v2 pass to replay: ${v2File} (the sim replays it for fact golds)`);

const v2Rows = readJsonl(v2File);
const v2Label = new Map(v2Rows.map((r) => [`${r.arm ?? ''}|${r.question_id}`, r.label]));
const v2LabelById = new Map(v2Rows.map((r) => [r.question_id, r.label]));

// the temp run dir: rows copied, EVERYTHING else left behind — the real dir is
// never written, and the reconstruction path (no summary.json) mirrors the
// pre-rejudge state of the 2026-09-17-p1-224225 run.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rejudge-sim-${runId}-`));
const simDir = path.join(tmpRoot, runId);
fs.mkdirSync(simDir);
for (const f of fs.readdirSync(runDir).filter((f) => f.endsWith('.rows.jsonl'))) {
  fs.copyFileSync(path.join(runDir, f), path.join(simDir, f));
}

const script = { classifyCalls: 0, labelCalls: 0, abstentionVerdicts: [] };
const chat = async ({ user }) => {
  if (/YES or NO\.$/.test(user)) {
    // stage A's classify leg — this run's golds are all marked, so this must stay 0
    script.classifyCalls++;
    return { text: 'NO', hadThink: false }; // skeptical: unmarked golds are facts
  }
  const parsed = parseLabelPrompt(user);
  if (!parsed) die(`cannot parse label prompt:\n${user.slice(0, 200)}`);
  const row = v2Rows.find((r) => String(r.gold) === parsed.gold && r.answer === parsed.answer);
  if (!row) die(`no saved row matches the label prompt (gold=${parsed.gold.slice(0, 60)}… answer=${parsed.answer.slice(0, 60)}…)`);
  script.labelCalls++;
  if (/declines to assert the missing fact/.test(user)) {
    const why = SIM_ABSTENTION_WRONG[row.question_id] ?? null;
    script.abstentionVerdicts.push({ question_id: row.question_id, label: why ? 'wrong' : 'exact', why: why ?? 'clean decline (pre-committed EXACT or unpredicated abstention)' });
    return { text: why ? 'WRONG' : 'EXACT', hadThink: false };
  }
  const replay = v2Label.get(`${row.arm ?? ''}|${row.question_id}`) ?? v2LabelById.get(row.question_id);
  if (!replay) die(`no v2 label to replay for ${row.question_id}`);
  return { text: replay.toUpperCase(), hadThink: false };
};

const result = await rejudgeRun({
  dir: simDir,
  judgeFn: makeJudge({ chat }),
  suffix,
  judge: { model: 'SIMULATED (scripted backend — task 226 lane sim)', url_host: 'localhost:8780' },
  judgePromptVersion: JUDGE_PROMPT_VERSION,
  generatedAtUtc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  log: () => {},
});
fs.writeFileSync(path.join(simDir, `summary.rejudge-${suffix}.json`), JSON.stringify(result.summary, null, 2));
fs.writeFileSync(path.join(simDir, `judged.rejudge-${suffix}.jsonl`), result.judged.map((r) => JSON.stringify(r) + '\n').join(''));
const receiptMd = renderReceipt({
  runId: result.summary.run_id,
  summary: result.summary,
  judged: result.judged,
  rejudge: { ofRunId: result.summary.rejudged_from, judgePromptVersion: JUDGE_PROMPT_VERSION, suffix },
  generatedAt: result.summary.generated_at_utc,
});
fs.writeFileSync(path.join(simDir, `${result.summary.run_id}.md`), `> SIMULATION — scripted judge backend, NOT a live leg. Temp dir: ${simDir}\n\n` + receiptMd);

// adoption check: no NON-abstention row may move relative to the v2 pass
const simById = new Map(result.judged.map((r) => [r.question_id, r]));
const moved = [];
for (const r of v2Rows) {
  const s = simById.get(r.question_id);
  if (s && s.label !== r.label) moved.push({ question_id: r.question_id, gold_class: s.gold_class, v2: r.label, v4: s.label });
}
const violations = moved.filter((m) => m.gold_class !== 'abstention');

const report = {
  simulation: true,
  note: 'scripted judge backend — NOT a live leg; fact golds replay the v2 pass, abstention golds take explicit scripted verdicts',
  run_id: runId,
  suffix,
  judge_prompt_version: JUDGE_PROMPT_VERSION,
  prompt_sha256: result.summary.regime.judge.prompt_sha256,
  gold_class: result.summary.regime.judge.gold_class,
  classify_calls: script.classifyCalls,
  abstention_verdicts: script.abstentionVerdicts,
  arms: Object.fromEntries(Object.entries(result.summary.arms).map(([a, v]) => [a, v.score])),
  knowledge_update: (() => {
    const rows = result.judged.filter((r) => r.question_type === 'knowledge-update');
    const exact = rows.filter((r) => r.label === 'exact').length;
    return rows.length ? { n: rows.length, exact, read: `${exact}/${rows.length}` } : null;
  })(),
  moved_v2_to_v4: moved,
  adoption_check: violations.length === 0
    ? 'PASS — no non-abstention row moved relative to the v2 pass'
    : `FAIL — ${violations.length} non-abstention row(s) moved: ${violations.map((v) => v.question_id).join(', ')}; not adopted`,
  ...(args.handlabels
    ? (() => {
        const hl = JSON.parse(fs.readFileSync(args.handlabels, 'utf8'));
        return { agreement: agreement(result.judged, hl.items), handlabels: { path: args.handlabels, n: hl.items.length, hand_scorer: hl.hand_scorer } };
      })()
    : {}),
  sim_artifacts_dir: simDir,
};
const reportFile = args.report ?? path.join(TOOL_DIR, `${runId}.rejudge-${suffix}.sim.json`);
if (!args.keep) report.sim_artifacts_dir += ' (removed — re-run with --keep to inspect)';
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
if (!args.keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
if (violations.length) process.exit(1);
