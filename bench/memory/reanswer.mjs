// reanswer — re-run the ANSWER + judge phases over a SAVED run's write side.
//
// A kept run (--keep) leaves its rows in the platform namespaces its regime
// stamped. reanswer reads that regime for the namespace and run id, checks
// /memory/list that the rows are still there (refusing — before any answer
// call or output file — when a namespace was purged), then re-answers every
// saved question through the arm's READ path under the CURRENT read policy and
// re-judges. No write-side calls: the timeline arm's write is ~9 h of the
// 3090; a read-policy change must cost an hour of answering, not a night.
//
// Outputs land beside the originals as <arm>.rows.reanswer-<policy>.jsonl +
// judged.reanswer-<policy>.jsonl (+ summary.reanswer-<policy>.json, written by
// run.mjs). The originals are never written; an existing reanswer output is
// refused rather than silently overwritten — a reanswer run is evidence too.
//
// run.mjs --from-results <dir> --reanswer is the CLI; this module is what the
// hermetic tests drive with a fake arm/platform/judge.

import fs from 'node:fs';
import path from 'node:path';
import { tally } from './judge.mjs';
import { BENCH_SOURCE_TYPE } from './arms/arm_mycelium.mjs';

// Arms whose rows live in platform namespaces a --keep run leaves behind. The
// competitor arms (mem0/mem0-raw/zep/letta) live in sidecar stores that die
// with the run — there is nothing on the platform to re-answer against.
export const REANSWERABLE_ARMS = ['none', 'mycelium', 'mycelium-extract', 'mycelium-timeline'];

// Which namespaces hold an arm's rows — read from the run's OWN regime, never
// recomputed from the current code's naming rules (the regime is the record).
export function namespacesForArm(arm, regime) {
  if (arm === 'none') return [];
  const base = regime?.retrieval?.namespace;
  if (!base) throw new Error(`reanswer: ${arm}'s namespaces are not in the run's regime (retrieval.namespace missing)`);
  if (arm === 'mycelium') return [base];
  if (arm === 'mycelium-extract') return [base, regime?.mycelium_extract?.namespace].filter(Boolean);
  if (arm === 'mycelium-timeline') {
    const layers = regime?.mycelium_timeline?.layers;
    const found = [base, layers?.episodic?.namespace, layers?.reconciled?.namespace].filter(Boolean);
    return found.filter((ns, i) => found.indexOf(ns) === i); // the episodic layer IS the base namespace
  }
  throw new Error(
    `reanswer: arm '${arm}' is not re-answerable — its store died with its sidecar (re-answerable: ${REANSWERABLE_ARMS.join(', ')})`
  );
}

function readJsonlFile(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function reanswerRun({
  dir,                 // the saved run's results dir (summary.json + <arm>.rows.jsonl)
  arms,                // arm names to re-answer (subset of the run's own)
  platform,            // live platform client — only /memory/list + the arm's reads
  sourceType = BENCH_SOURCE_TYPE, // the bench source_type the rows were written under
  makeArm,             // (ctx) => arm instance with .answer(question) — run.mjs passes the real factory
  judgeFn,             // async ({question, gold, answer}) => {label, raw, hadThink}
  judge,               // {model, url_host} actually used this pass — stamped into the regime
  judgePromptVersion = null,
  readPolicy,          // the CURRENT read policy's name — names every output file
  generatedAtUtc,
  onAnswer,            // (armName, row) => void — run.mjs streams to <arm>.rows.reanswer-<policy>.jsonl
  onJudged,            // (row) => void — run.mjs streams to judged.reanswer-<policy>.jsonl
  log = () => {},
}) {
  if (!Array.isArray(arms) || arms.length === 0) throw new Error('reanswer: no arms selected (--arms a,b)');
  const summaryPath = path.join(dir, 'summary.json');
  const original = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  if (!original?.run_id || !original?.regime || !original?.arms) {
    throw new Error(`reanswer: ${summaryPath} is not a bench summary (run_id/regime/arms missing)`);
  }
  const notInRun = arms.filter((a) => !(a in original.arms));
  if (notInRun.length) {
    throw new Error(`reanswer: run ${original.run_id} has no arm(s) ${notInRun.join(', ')} (has: ${Object.keys(original.arms).join(', ')})`);
  }

  const outFile = path.join(dir, `judged.reanswer-${readPolicy}.jsonl`);
  if (fs.existsSync(outFile)) {
    throw new Error(`reanswer: ${outFile} already exists — move or delete it explicitly before re-running`);
  }
  const rowsFilePaths = {};
  for (const arm of arms) {
    const p = path.join(dir, `${arm}.rows.reanswer-${readPolicy}.jsonl`);
    if (fs.existsSync(p)) throw new Error(`reanswer: ${p} already exists — move or delete it explicitly before re-running`);
    rowsFilePaths[arm] = p;
  }

  // the saved QUESTIONS are the evidence; count them against the summary first
  const savedRows = {};
  for (const arm of arms) {
    const file = path.join(dir, `${arm}.rows.jsonl`);
    if (!fs.existsSync(file)) {
      throw new Error(`reanswer: missing ${file} — the saved questions ARE the evidence; refusing to re-answer a partial run`);
    }
    const rows = readJsonlFile(file);
    if (rows.length !== original.arms[arm].n) {
      throw new Error(`reanswer: ${file} has ${rows.length} rows but summary.json says n=${original.arms[arm].n}`);
    }
    savedRows[arm] = rows;
  }

  // rows-present check BEFORE anything answers or lands on disk: a purged
  // namespace means there is nothing to read — the run was not kept.
  const namespacesChecked = {};
  for (const arm of arms) {
    namespacesChecked[arm] = namespacesForArm(arm, original.regime);
    for (const ns of namespacesChecked[arm]) {
      const r = await platform.listByType(sourceType, { namespace: ns, limit: 1 });
      if (!r || !Array.isArray(r.results) || r.results.length === 0) {
        throw new Error(
          `reanswer: namespace ${ns} has no ${sourceType} rows on the platform — the run's rows are gone; ` +
          'a run is only re-answerable when it was kept with --keep'
        );
      }
      log(`reanswer: ${arm}: rows present in ${ns}`);
    }
  }

  // the reanswer regime is fully determined before the first answer: it stamps
  // every row the same way runBench stamps a fresh run's rows
  const judgeStamp = judgePromptVersion
    ? { ...original.regime.judge, ...judge, judge_prompt_version: judgePromptVersion }
    : { ...original.regime.judge, ...judge };
  const regime = {
    ...original.regime,
    judge: judgeStamp,
    reanswer: {
      of_run_id: original.run_id,
      date_utc: generatedAtUtc,
      answers_modified: true, // vs rejudge's false: the ANSWERS are recomputed here
      write_side_untouched: true,
      read_policy: readPolicy,
      namespaces_checked: namespacesChecked,
      note: 'answers re-computed from the run\'s kept namespaces under the CURRENT read policy; write side untouched',
    },
  };

  // ANSWER + JUDGE — one arm at a time, in the run's own arm order; each new
  // answer is judged before the next question, so partial output is still
  // evidence (the streaming hooks make it durable)
  const judged = [];
  const rowsByArm = {};
  for (const arm of arms) {
    const budget = original.regime?.retrieval?.budget;
    const inst = makeArm({
      arm, // which arm to build (the CLI maps this through ARM_FACTORIES)
      platform,
      runId: original.run_id,
      namespace: original.regime?.retrieval?.namespace,
      budget,
      retrievalBudget: budget, // arms destructure either name (see run.mjs armContext)
      sourceType,
      regime,
    });
    const rows = [];
    for (let i = 0; i < savedRows[arm].length; i++) {
      const saved = savedRows[arm][i];
      if (typeof saved.question !== 'string' || !saved.question_id || !('gold' in saved)) {
        throw new Error(`reanswer: saved row ${i} (${arm}/${saved.question_id ?? '?'}) is missing question_id/gold/question`);
      }
      const t0 = Date.now();
      const a = await inst.answer(saved.question);
      const row = {
        question_id: saved.question_id,
        question_type: saved.question_type ?? null,
        question: saved.question,
        gold: saved.gold,
        answer: a.text,
        elapsed_ms: Date.now() - t0,
        meta: a.meta ?? {},
        regime,
      };
      rows.push(row);
      log(`[${arm} ${rows.length}/${savedRows[arm].length}] ${row.question_id} answered in ${row.elapsed_ms} ms`);
      if (onAnswer) onAnswer(arm, row);

      const j = await judgeFn({ question: row.question, gold: row.gold, answer: row.answer });
      const jr = {
        question_id: row.question_id,
        arm,
        question_type: row.question_type,
        gold: row.gold,
        answer: row.answer,
        label: j.label,
        judge_raw: j.raw,
        judge_had_think: !!j.hadThink,
      };
      judged.push(jr);
      log(`[${judged.length}] ${arm}/${jr.question_id} -> ${jr.label}`);
      if (onJudged) onJudged(jr);
    }
    rowsByArm[arm] = rows;
  }

  const outArms = {};
  for (const arm of arms) {
    outArms[arm] = {
      n: rowsByArm[arm].length,
      write: original.arms[arm].write ?? null, // reanswer does not re-write — the original write cost still owns these rows
      score: tally(judged.filter((x) => x.arm === arm).map((x) => x.label)),
    };
  }

  const summary = {
    run_id: `${original.run_id}-reanswer-${readPolicy}`,
    reanswered_from: original.run_id,
    read_policy: readPolicy,
    ...(judgePromptVersion ? { judge_prompt_version: judgePromptVersion } : {}),
    generated_at_utc: generatedAtUtc,
    n: judged.length,
    regime,
    arms: outArms,
    // the run's own pre-reanswer numbers, carried for the before/after read —
    // the receipt renders them, nothing is re-typed
    original: { run_id: original.run_id, judge: original.regime.judge, arms: original.arms },
  };

  return { summary, judged, rowsByArm, rowsFilePaths, judgedFilePath: outFile };
}
