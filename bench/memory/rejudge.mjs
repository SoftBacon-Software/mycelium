// rejudge — re-run the judge over a SAVED run's answers.
//
// The answers on disk (<arm>.rows.jsonl) are the evidence; only the judge
// labels re-compute. No answerer calls, no platform calls. Outputs land
// beside the originals as judged.rejudge.jsonl + summary.rejudge.json —
// the originals are never written, and an existing rejudge output is
// refused rather than silently overwritten (a rejudge run is evidence too).
//
// run.mjs --from-results <dir> --rejudge is the CLI; this module is what the
// hermetic tests drive with a fake judge.

import fs from 'node:fs';
import path from 'node:path';
import { tally } from './judge.mjs';

function readJsonlFile(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function rejudgeRun({
  dir,                 // the saved run's results dir (summary.json + <arm>.rows.jsonl)
  judgeFn,             // async ({question, gold, answer}) => {label, raw, hadThink}
  judge,               // {model, url_host} actually used this pass — stamped into the regime
  judgePromptVersion,  // e.g. 'judge-prompt.2' — stamped into the regime + summary
  generatedAtUtc,
  onJudged,            // (row) => void — incremental persistence hook (run.mjs streams to judged.rejudge.jsonl)
  log = () => {},
}) {
  const summaryPath = path.join(dir, 'summary.json');
  const original = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  if (!original?.run_id || !original?.regime || !original?.arms) {
    throw new Error(`rejudge: ${summaryPath} is not a bench summary (run_id/regime/arms missing)`);
  }
  const rejudgedFrom = original.run_id;
  const outFile = path.join(dir, 'judged.rejudge.jsonl');
  if (fs.existsSync(outFile)) {
    throw new Error(`rejudge: ${outFile} already exists — move or delete it explicitly before re-running`);
  }

  // the saved answers, in the run's own arm order
  const rows = [];
  for (const arm of Object.keys(original.arms)) {
    const file = path.join(dir, `${arm}.rows.jsonl`);
    if (!fs.existsSync(file)) {
      throw new Error(`rejudge: missing ${file} — the saved answers ARE the evidence; refusing to re-judge a partial run`);
    }
    const armRows = readJsonlFile(file);
    if (armRows.length !== original.arms[arm].n) {
      throw new Error(`rejudge: ${file} has ${armRows.length} rows but summary.json says n=${original.arms[arm].n}`);
    }
    for (const r of armRows) rows.push({ ...r, arm });
  }
  if (rows.length === 0) throw new Error(`rejudge: no saved answers found in ${dir}`);

  const judged = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row.answer !== 'string' || !row.question_id || !('gold' in row)) {
      throw new Error(`rejudge: saved row ${i} (${row.arm}/${row.question_id ?? '?'}) is missing question_id/gold/answer`);
    }
    const j = await judgeFn({ question: row.question, gold: row.gold, answer: row.answer });
    const jr = {
      question_id: row.question_id,
      arm: row.arm,
      question_type: row.question_type ?? null,
      gold: row.gold,
      answer: row.answer,
      label: j.label,
      judge_raw: j.raw,
      judge_had_think: !!j.hadThink,
    };
    judged.push(jr);
    log(`[${judged.length}/${rows.length}] ${jr.arm}/${jr.question_id} -> ${jr.label}`);
    if (onJudged) onJudged(jr);
  }

  // The answers keep the original run's regime (same split, same answerer, same
  // platform conditions); the judge block and the rejudge marker say what
  // actually changed: the labels were re-computed under a new rubric version.
  const regime = {
    ...original.regime,
    judge: { ...original.regime.judge, ...judge, judge_prompt_version: judgePromptVersion },
    rejudge: {
      of_run_id: rejudgedFrom,
      date_utc: generatedAtUtc,
      answers_modified: false,
      note: 'labels re-computed from the saved answers (judged.rejudge.jsonl); no answerer or platform calls',
    },
  };

  const arms = {};
  for (const arm of Object.keys(original.arms)) {
    arms[arm] = {
      n: original.arms[arm].n,
      score: tally(judged.filter((x) => x.arm === arm).map((x) => x.label)),
    };
  }

  const summary = {
    run_id: `${rejudgedFrom}-rejudge`,
    rejudged_from: rejudgedFrom,
    judge_prompt_version: judgePromptVersion,
    generated_at_utc: generatedAtUtc,
    n: judged.length,
    regime,
    arms,
    // the run's own pre-rejudge numbers, carried for the before/after read —
    // the receipt renders them, nothing is re-typed
    original: { run_id: rejudgedFrom, judge: original.regime.judge, arms: original.arms },
  };

  return { summary, judged, judgedFilePath: outFile };
}
