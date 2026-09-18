// rejudge — re-run the judge over a SAVED run's answers.
//
// The answers on disk (<arm>.rows.jsonl) are the evidence; only the judge
// labels re-compute. No answerer calls, no platform calls. Outputs land
// beside the originals as judged.rejudge.jsonl + summary.rejudge.json —
// the originals are never written, and an existing rejudge output is
// refused rather than silently overwritten (a rejudge run is evidence too).
// A SUFFIXED pass (--rejudge-suffix <tag>) is how a SECOND rejudge happens
// when one already ran: judged.rejudge-<tag>.jsonl + summary.rejudge-<tag>.json
// + the <runId>-rejudge-<tag> receipt, all beside the first pass — a new
// evidence file, never an overwrite of the old one.
//
// run.mjs --from-results <dir> --rejudge is the CLI; this module is what the
// hermetic tests drive with a fake judge.

import fs from 'node:fs';
import path from 'node:path';
import { tally, JUDGE_PROMPT_SHA256 } from './judge.mjs';

function readJsonlFile(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Output naming for a rejudge pass — the single source of truth shared by
// rejudgeRun (which refuses on its own output) and run.mjs (which opens the
// files). A tag must be filename-safe: it becomes part of three artifact names.
export function rejudgeOutputNames(dir, { suffix = null } = {}) {
  if (suffix != null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix)) {
    throw new Error(`rejudge: invalid --rejudge-suffix '${suffix}' — letters, digits, dot, dash, underscore only`);
  }
  const stem = suffix ? `rejudge-${suffix}` : 'rejudge';
  return {
    stem,
    judgedFile: path.join(dir, `judged.${stem}.jsonl`),
    summaryFile: path.join(dir, `summary.${stem}.json`),
  };
}

// The refusal BEFORE any judge call: either of this pass's output files already
// existing is a stop, never an overwrite. run.mjs calls this with
// rejudgeOutputNames' result; rejudgeRun re-checks its judged file so the
// module stays safe on its own.
export function assertRejudgeOutputsFree({ judgedFile, summaryFile }) {
  for (const f of [judgedFile, summaryFile]) {
    if (fs.existsSync(f)) throw new Error(`rejudge: ${f} already exists — move or delete it explicitly before re-running`);
  }
}

// The dir's PRIOR rejudge summaries (summary.rejudge*.json), oldest first — the
// receipt renders their numbers under "previous judge" when this pass is a
// rejudge of a rejudge. exclude = this pass's own output paths. A prior that
// does not parse or lacks run_id/arms is a refusal, not a silent skip.
export function loadPreviousRejudges(dir, { exclude = [] } = {}) {
  const excl = new Set(exclude.map((e) => path.resolve(e)));
  const found = [];
  for (const f of fs.readdirSync(dir).filter((f) => /^summary\.rejudge.*\.json$/.test(f)).sort()) {
    const full = path.join(dir, f);
    if (excl.has(path.resolve(full))) continue;
    const s = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!s?.run_id || !s?.arms) throw new Error(`rejudge: ${full} is not a rejudge summary (run_id/arms missing)`);
    found.push({
      full,
      file: f,
      run_id: s.run_id,
      judge_prompt_version: s.judge_prompt_version ?? null,
      generated_at_utc: s.generated_at_utc ?? '',
      arms: s.arms,
    });
  }
  return found.sort((a, b) =>
    a.generated_at_utc !== b.generated_at_utc
      ? (a.generated_at_utc < b.generated_at_utc ? -1 : 1)
      : (a.file < b.file ? -1 : 1)
  );
}

// The saved run's summary.json, or — when the run died before writing it (the
// 2026-09-18 r2 run answered all 50 questions and then lost its judge to a
// seat refusal, so the finally-cleanup ran and summary.json never existed) — a
// reconstruction from the evidence that IS on disk: every <arm>.rows.jsonl row
// carries the run's regime stamp (answerer, judge, retrieval, git_sha…), the
// arm is the file's name and n is its row count. The reconstruction is stamped
// as such in the rejudge summary; nothing is invented (no original scores, no
// write_info) and a rows file whose rows disagree on the regime is refused.
// task 223: a run that stamps its write-phase summary before the judge starts
// (summary.json present, phase "write") is read HERE — the run's own write
// evidence (write_info) rides through, and only truly summary-less runs
// reconstruct from rows.
function loadOriginal(dir) {
  const summaryPath = path.join(dir, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    const original = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    if (!original?.run_id || !original?.regime || !original?.arms) {
      throw new Error(`rejudge: ${summaryPath} is not a bench summary (run_id/regime/arms missing)`);
    }
    return { original, summaryMissing: false };
  }
  const rowFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.rows.jsonl')).sort();
  if (rowFiles.length === 0) {
    throw new Error(`rejudge: ${summaryPath} is missing and ${dir} holds no <arm>.rows.jsonl — nothing to re-judge`);
  }
  const arms = {};
  let regime = null;
  for (const f of rowFiles) {
    const arm = f.slice(0, -'.rows.jsonl'.length);
    const armRows = readJsonlFile(path.join(dir, f));
    for (const r of armRows) {
      if (!r?.regime?.judge || !r?.regime?.answerer) {
        throw new Error(`rejudge: ${summaryPath} is missing and a row in ${f} carries no regime stamp — cannot reconstruct the run's regime`);
      }
      const stamp = JSON.stringify(r.regime);
      if (regime === null) regime = { json: stamp, value: r.regime };
      else if (regime.json !== stamp) {
        throw new Error(`rejudge: ${summaryPath} is missing and the rows in ${dir} disagree on the regime stamp — refusing to reconstruct`);
      }
    }
    arms[arm] = { n: armRows.length };
  }
  return {
    original: { run_id: path.basename(dir), regime: regime.value, arms },
    summaryMissing: true,
  };
}

export async function rejudgeRun({
  dir,                 // the saved run's results dir (summary.json + <arm>.rows.jsonl)
  judgeFn,             // async ({question, gold, answer}) => {label, raw, hadThink}
  judge,               // {model, url_host} actually used this pass — stamped into the regime
  judgePromptVersion,  // e.g. 'judge-prompt.2' — stamped into the regime + summary
  generatedAtUtc,
  suffix = null,       // 'prompt3' — names this pass judged.rejudge-<tag>.jsonl etc. beside any earlier one
  onJudged,            // (row) => void — incremental persistence hook (run.mjs streams to the judged file)
  log = () => {},
}) {
  const { original, summaryMissing } = loadOriginal(dir);
  const rejudgedFrom = original.run_id;
  const { judgedFile: outFile } = rejudgeOutputNames(dir, { suffix });
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
    // task 226: the question_id rides along — the _abs marker is stage A's
    // source of truth, and the judge classifies the GOLD before choosing the
    // prompt. Every row is stamped with the class it was judged under.
    const j = await judgeFn({ question: row.question, gold: row.gold, answer: row.answer, questionId: row.question_id });
    const jr = {
      question_id: row.question_id,
      arm: row.arm,
      question_type: row.question_type ?? null,
      gold: row.gold,
      answer: row.answer,
      label: j.label,
      judge_raw: j.raw,
      judge_had_think: !!j.hadThink,
      gold_class: j.gold_class ?? null,
      gold_class_source: j.gold_class_source ?? null,
      ...(j.gold_class_parsed !== undefined ? { gold_class_parsed: j.gold_class_parsed } : {}),
      prompt_kind: j.prompt_kind ?? null,
    };
    judged.push(jr);
    log(`[${judged.length}/${rows.length}] ${jr.arm}/${jr.question_id} -> ${jr.label}`);
    if (onJudged) onJudged(jr);
  }

  // Stage A provenance (task 226): how this pass's golds were classified, and
  // which prompt texts judged them — computed from THIS pass's own rows, never
  // hand-typed. `unstamped` counts rows from a judge that did not stamp a
  // class (an older judge.mjs); `parse_failures` counts YES/NO classify calls
  // whose reply did not parse (each was treated as fact — the skeptical prior).
  const goldClass = {
    counts: { fact: 0, abstention: 0 },
    sources: { 'dataset-marker': 0, judge: 0 },
    parse_failures: 0,
    unstamped: 0,
  };
  for (const j of judged) {
    if (j.gold_class === 'fact' || j.gold_class === 'abstention') {
      goldClass.counts[j.gold_class]++;
      if (j.gold_class_source === 'dataset-marker' || j.gold_class_source === 'judge') goldClass.sources[j.gold_class_source]++;
      if (j.gold_class_parsed === null) goldClass.parse_failures++;
    } else {
      goldClass.unstamped++;
    }
  }

  // The answers keep the original run's regime (same split, same answerer, same
  // platform conditions); the judge block and the rejudge marker say what
  // actually changed: the labels were re-computed under a new rubric version.
  const regime = {
    ...original.regime,
    judge: {
      ...original.regime.judge,
      ...judge,
      judge_prompt_version: judgePromptVersion,
      prompt_sha256: JUDGE_PROMPT_SHA256,
      gold_class: goldClass,
    },
    rejudge: {
      of_run_id: rejudgedFrom,
      date_utc: generatedAtUtc,
      answers_modified: false,
      note: `labels re-computed from the saved answers (${path.basename(outFile)}); no answerer or platform calls`,
      ...(suffix ? { suffix } : {}),
      ...(summaryMissing ? { original_summary: 'missing — run_id, arms and regime reconstructed from <arm>.rows.jsonl (the run died before writing summary.json); no original scores exist' } : {}),
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
    run_id: `${rejudgedFrom}-rejudge${suffix ? `-${suffix}` : ''}`,
    rejudged_from: rejudgedFrom,
    judge_prompt_version: judgePromptVersion,
    generated_at_utc: generatedAtUtc,
    n: judged.length,
    regime,
    arms,
    // task 223: when the run's own summary.json exists, its write-phase
    // evidence rides through — the receipt's cost line, the ingestion section
    // and the miss autopsy's candidates ledger survive a judge death instead
    // of vanishing with it. Reconstruction (no summary.json) carries nothing:
    // nothing is invented.
    ...(original.write_info ? { write_info: original.write_info } : {}),
    // the run's own pre-rejudge numbers, carried for the before/after read —
    // the receipt renders them, nothing is re-typed. A WRITE-phase original
    // (the run died in its judge AFTER stamping summary.json) has no scores:
    // its arms skeleton must not ride, or the receipt would render a zeros
    // table — the phase + note say what the original summary is instead.
    original: {
      run_id: rejudgedFrom,
      judge: original.regime.judge,
      ...(original.phase !== 'write' ? { arms: original.arms } : {}),
      ...(original.phase === 'write'
        ? { phase: 'write', note: 'the original died in its judge phase — its summary.json is the WRITE-phase stamp (write-phase evidence, no original scores)' }
        : {}),
      ...(summaryMissing ? { summary_missing: true } : {}),
    },
  };

  return { summary, judged, judgedFilePath: outFile };
}
