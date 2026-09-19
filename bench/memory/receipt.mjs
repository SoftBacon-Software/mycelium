// The receipt: markdown, generated from the run's own output objects. No hand-
// typed numbers — if a number appears here, it was read from summary/judged.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderIngestionGrid } from './ingestion.mjs';
import { renderAutopsySection } from './miss_autopsy.mjs';
import { WIN_CONDITION, renderPerTypeTable, renderWinCondition, tallyByType, timelineArmLabel } from './per_type.mjs';
import { ADOPTION_GATE, adoptionGate, gateAppliesToRun } from './adoption.mjs';
import { maxFallbackShare, renderFallbackBound } from './fallback_provisional.mjs';

export const RECEIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipts');

// THE COST LINE (task 234): the timeline arm's write cost renders ONCE per
// receipt — the win-condition block's `Cost bound (timeline write cost ≤ 2×
// extract)` line (per_type.mjs renderCostBound), whose denominator is the
// extract ARM'S OWN stamped seconds_per_session from the SAME run. A second
// renderer here (the old task-188 `Write cost (…): cost ×N of extract` line,
// LLM-time numerator over a hard-coded 2026-09-10 extract stamp) quoted a
// DIFFERENT ratio in the same receipt (×1.45 beside the bound's ×5.71 —
// receipts/2026-09-18-p1-154254.md lines 39 vs 77); it was deleted, and the
// one-renderer contract is pinned by test/unit/bench-memory-reconcile-batch.test.js.

// The per-candidate decision ledgers live in summary.json — in the receipt's
// Write-phase block they render as a count only, or a 50-question receipt
// carries a megabyte of candidate records nobody reads in markdown.
export function stripCandidateLedgers(writeInfo) {
  if (!writeInfo || typeof writeInfo !== 'object') return writeInfo;
  return Object.fromEntries(
    Object.entries(writeInfo).map(([arm, w]) => {
      const perQuestion = w?.timeline?.per_question;
      if (!Array.isArray(perQuestion)) return [arm, w];
      return [
        arm,
        {
          ...w,
          timeline: {
            ...w.timeline,
            per_question: perQuestion.map((pq) =>
              Array.isArray(pq?.candidates_ledger)
                ? { ...pq, candidates_ledger: `<${pq.candidates_ledger.length} candidate records — see summary.json write_info.${arm}.timeline.per_question>` }
                : pq
            ),
          },
        },
      ];
    })
  );
}

export function renderReceipt({
  runId,
  summary,
  agreement: judgeAgreement = null,
  commands = [],
  cleanup = null,
  handlabels = null,
  writeInfo = null,
  autopsy = null, // computed autopsy (miss_autopsy.mjs) — rendered beside the cell table
  judged = null, // the run's per-question judged rows (bench/memory/results/<run>/judged.jsonl)
  rejudge = null, // {ofRunId, judgePromptVersion, suffix?} — present on a rejudge receipt
  handlabelsItems = null, // the handlabels file's items — the adoption gate's second leg (task 229)
  previousJudges = null, // [{file, run_id, judge_prompt_version, arms}] — prior rejudge summaries (rejudgeOutputNames' siblings)
  reanswer = null, // {ofRunId, readPolicy} — present on a re-answer receipt
  generatedAt,
}) {
  // The arm's rendered name comes from the run's own regime (task 225): a run
  // that stamps facts_layer shows `mycelium-timeline [am_facts]`, so a lone
  // receipt says which store it measured without its run dir. Old regimes
  // render the bare arm name.
  const scoreRow = ([name, a], regime = null) => {
    const c = a.score?.counts ?? { exact: 0, partial: 0, wrong: 0 };
    return `| ${regime ? timelineArmLabel(regime, name) : name} | ${a.n} | ${c.exact} | ${c.partial} | ${c.wrong} | ${a.score?.p1_score?.toFixed(3) ?? 'n/a'} |`;
  };
  const L = [];
  L.push(`# Receipt — memory benchmark P1 skeleton (${runId})`);
  L.push('');
  L.push(`Generated: ${generatedAt}`);
  if (rejudge) {
    L.push('');
    L.push(`Re-judge of run \`${rejudge.ofRunId}\` with judge prompt version \`${rejudge.judgePromptVersion}\`${rejudge.suffix ? `, tagged \`${rejudge.suffix}\`` : ''}.`);
    L.push('The answers are the original run\'s own (no answerer calls, no platform calls) — only the');
    L.push('judge labels were re-computed. The original run\'s scores are rendered below the new ones.');
    // task 229: when THIS pass is the one the adoption gate was pre-committed
    // on, its verdict renders here — before the scores — whatever it says.
    const gateRun = { rejudge: { of_run_id: rejudge.ofRunId, judge_prompt_version: rejudge.judgePromptVersion } };
    if (gateAppliesToRun(gateRun) && judged) {
      const gate = adoptionGate({ judged, handItems: handlabelsItems });
      L.push('');
      L.push('## Judge adoption gate (pre-committed, task 226)');
      L.push('');
      L.push(
        `The pre-committed gate decides whether ${ADOPTION_GATE.judge_prompt_version} becomes the quoted judge:`
      );
      L.push('');
      for (const c of gate.conditions) L.push(`- [${c.ok ? 'x' : ' '}] ${c.detail}`);
      if (gate.unpredicated_abs_rows.length) {
        L.push(`- unpredicated abstention row(s) — decided by the live leg, never gated: ${gate.unpredicated_abs_rows.join(', ')}`);
      }
      L.push('');
      L.push(`**VERDICT: ${gate.verdict}**`);
      if (gate.verdict !== 'ADOPTED') {
        L.push('');
        if (!gate.evaluable) L.push(`NOT EVALUABLE — ${gate.unevaluable_reason}`);
        L.push(
          `${ADOPTION_GATE.judge_prompt_version} is NOT the quoted judge: judge-prompt.2's knowledge-update ${ADOPTION_GATE.v2_quoted_ku} remains the arm's quoted cell; ` +
            'no downstream artifact may quote a judge-prompt.4 number as the arm number.'
        );
      }
    }
  }
  if (reanswer) {
    L.push('');
    L.push(`Re-answer of run \`${reanswer.ofRunId}\` under read policy \`${reanswer.readPolicy}\`.`);
    L.push('The write side is the original run\'s own (no write-side calls) — the answers AND the judge');
    L.push('labels were re-computed against the run\'s kept namespaces. The original run\'s scores are');
    L.push('rendered below the new ones.');
  }
  L.push('');
  L.push('## Scores');
  L.push('');
  L.push('| arm | n | exact | partial | wrong | p1_score |');
  L.push('|---|---|---|---|---|---|');
  for (const [name, a] of Object.entries(summary.arms)) L.push(scoreRow([name, a], summary.regime));
  L.push('');
  L.push('`p1_score` = (exact + 0.5×partial) / n. Raw counts are the primary record; the score is the one-number comparison.');
  // task 235: keyword-fallback reads mark a column PROVISIONAL — the number is
  // quotable only when its reads actually ran hybrid. The receipt marks on ANY
  // fallback read (the grid's pre-committed bound is what decides verdicts);
  // unstamped rows render n/a with their count, never guessed into either side.
  const fallbackBoundStamp = maxFallbackShare();
  const armsWriteInfo = writeInfo ?? summary.write_info ?? {};
  for (const [name, a] of Object.entries(summary.arms)) {
    const share = a.fallback_share ?? null;
    const unstamped = share
      ? (share.unstamped ?? 0)
      : a.retrieval_modes
        ? (a.n ?? 0) - Object.values(a.retrieval_modes).reduce((s, c) => s + c, 0)
        : 0;
    if (share && (share.answered ?? 0) > 0 && (share.fallback ?? 0) > 0) {
      const settled = armsWriteInfo[name]?.embed_wait?.settled;
      L.push(
        `PROVISIONAL — ${share.fallback}/${share.answered} reads ran keyword-fallback ` +
          `(embed wait settled=${settled === undefined ? 'not stamped' : String(settled)})`
      );
      L.push('');
    }
    if (unstamped > 0) {
      const total = share ? unstamped + (share.answered ?? 0) : (a.n ?? 0);
      L.push(`Retrieval mode unstamped (pre-mode run) on ${unstamped} of ${total} rows — fallback share n/a`);
      L.push('');
    }
  }
  // task 182: the ingestion-control 2×2 renders only when ALL FOUR grid arms
  // are in the run — a smoke carrying just the controls has no grid.
  const grid = renderIngestionGrid(summary.arms, writeInfo ?? summary.write_info ?? null);
  if (grid) {
    L.push('');
    L.push('## Ingestion controls ({Mycelium, Mem0} × {raw, extract})');
    L.push('');
    for (const line of grid) L.push(line);
    L.push('');
  }
  // task 205: the knowledge-update miss autopsy renders beside the cell table —
  // the miss must be diagnosable, not just countable
  if (autopsy) {
    L.push(renderAutopsySection(autopsy));
    L.push('');
  }
  if ((rejudge || reanswer) && summary.original?.summary_missing) {
    L.push('');
    L.push(`Original run \`${(rejudge ?? reanswer).ofRunId}\` wrote NO summary.json (it died before its judge finished); there are no pre-${rejudge ? 'rejudge' : 'reanswer'} scores — run_id, arms and regime above were reconstructed from the saved <arm>.rows.jsonl.`);
  } else if ((rejudge || reanswer) && summary.original?.arms) {
    L.push('');
    L.push(`Original run \`${(rejudge ?? reanswer).ofRunId}\` scores (pre-${rejudge ? 'rejudge' : 'reanswer'}, from the run's own summary):`);
    L.push('');
    L.push('| arm | n | exact | partial | wrong | p1_score |');
    L.push('|---|---|---|---|---|---|');
    for (const [name, a] of Object.entries(summary.original.arms)) L.push(scoreRow([name, a], summary.regime));
  }
  // a rejudge of a rejudge: the earlier pass's numbers render under "previous
  // judge", read from its own summary — never retyped, never overwritten
  if (rejudge && Array.isArray(previousJudges) && previousJudges.length) {
    for (const p of previousJudges) {
      L.push('');
      L.push(`Previous judge \`${p.run_id}\` (prompt version \`${p.judge_prompt_version ?? 'unstamped'}\`, from \`${p.file}\`):`);
      L.push('');
      L.push('| arm | n | exact | partial | wrong | p1_score |');
      L.push('|---|---|---|---|---|---|');
      for (const [name, a] of Object.entries(p.arms)) L.push(scoreRow([name, a]));
    }
  }
  L.push('');
  for (const [name, a] of Object.entries(summary.arms)) {
    if (a.retrieval_modes) {
      L.push(`Retrieval modes observed (${name} arm, per query): ${JSON.stringify(a.retrieval_modes)}`);
      L.push('');
    }
  }
  // task 214: the per-arm embedding wait, honestly stamped — which scope the
  // wait actually polled (this run's namespaces vs the global index), how long
  // it held the run, whether it settled. An arm without a platform write has
  // no wait; its absence renders as its absence.
  for (const [name, w] of Object.entries(writeInfo ?? summary.write_info ?? {})) {
    if (!w?.embed_wait) continue;
    const ew = w.embed_wait;
    const bits = [
      `Embedding wait (${name} arm): scope=${ew.scope}`,
      ew.namespaces ? ` namespaces=${JSON.stringify(ew.namespaces)}` : '',
      ` waited_ms=${ew.waited_ms} settled=${ew.settled} poll_failures=${ew.poll_failures}`,
      ew.coverage_after != null ? ` coverage_after=${ew.coverage_after}` : '',
      ew.fallback_reason ? ` fallback=${ew.fallback_reason}` : '',
    ];
    L.push(bits.join(''));
    L.push('');
  }
  // task 234: the timeline arm's write cost renders ONCE — inside the
  // win-condition block below (renderWinCondition → renderCostBound), judged
  // from the run's own seconds_per_session stamps on BOTH sides. No second
  // cost line here: two renderers quoted two ratios in one receipt
  // (receipts/2026-09-18-p1-154254.md), and a quotable artifact quotes one.
  // task 199: per-question-type scores + (when the timeline arm is in the run)
  // its pre-committed win-condition block. The table needs the run's judged
  // rows; their absence renders as its absence, never a number from nothing.
  if (Array.isArray(judged)) {
    const perType = {};
    L.push('## Per-question-type scores');
    L.push('');
    for (const name of Object.keys(summary.arms)) {
      perType[name] = tallyByType(judged.filter((r) => r.arm === name));
      for (const line of renderPerTypeTable(timelineArmLabel(summary.regime, name), perType[name])) L.push(line);
      L.push('');
    }
    if (summary.arms[WIN_CONDITION.arm]) {
      for (const line of renderWinCondition({
        talliesByArm: perType,
        writeInfoByArm: writeInfo ?? summary.write_info ?? {},
        regimeByArm: { [WIN_CONDITION.arm]: summary.regime ?? {} },
        absentLabel: 'not in this run',
        notStampedPhrase: 'not stamped in this run',
        armDisplay: timelineArmLabel(summary.regime, WIN_CONDITION.arm),
      })) {
        L.push(line);
      }
      L.push('');
    }
  } else if (summary.arms[WIN_CONDITION.arm]) {
    L.push(`per-question rows absent for ${runId} — the per-question-type table and the win-condition block need the run's judged rows (bench/memory/results/${runId}/judged.jsonl)`);
    L.push('');
  }
  if (judgeAgreement) {
    L.push('## Judge validation (vs hand-scored set)');
    L.push('');
    L.push(`- Agreement: ${judgeAgreement.agree}/${judgeAgreement.n} = ${(judgeAgreement.rate * 100).toFixed(1)}%`);
    if (handlabels) {
      L.push(`- Hand scorer: ${handlabels.hand_scorer}`);
      L.push(`- Hand-label set: ${handlabels.path} (${handlabels.n} items)`);
    }
    if (judgeAgreement.disagree?.length) {
      L.push('- Disagreements (hand vs judge):');
      for (const d of judgeAgreement.disagree) L.push(`  - ${d.arm}/${d.question_id}: hand=${d.hand} judge=${d.judge}`);
    }
    L.push('');
  } else {
    L.push('## Judge validation');
    L.push('');
    L.push('NOT RECORDED in this receipt — no hand-labels file was supplied. A receipt without a judge-agreement number is provisional.');
    L.push('');
  }
  // task 226: the judge's stage-A provenance — how the golds were classified
  // and which prompt texts judged them — renders from the regime's judge block
  // (rejudgeRun computes it from the pass's own rows). A pre-v4 summary carries
  // neither field; its absence renders as its absence.
  const judgeStamp = summary.regime?.judge ?? null;
  if (judgeStamp?.prompt_sha256 || judgeStamp?.gold_class) {
    L.push('## Judge prompt (classify the gold first)');
    L.push('');
    if (judgeStamp.gold_class) {
      const gc = judgeStamp.gold_class;
      L.push(`- Gold classes: ${gc.counts.fact} fact, ${gc.counts.abstention} abstention ` +
        `(sources: dataset-marker=${gc.sources['dataset-marker']}, judge=${gc.sources.judge}, ` +
        `unstamped=${gc.unstamped}, parse_failures=${gc.parse_failures})`);
    }
    if (judgeStamp.prompt_sha256) {
      L.push(`- fact prompt sha256: \`${judgeStamp.prompt_sha256.fact}\``);
      L.push(`- abstention prompt sha256: \`${judgeStamp.prompt_sha256.abstention}\``);
    }
    L.push('');
  }
  L.push('## Regime');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(summary.regime, null, 2));
  L.push('```');
  L.push('');
  // task 235: the pre-committed fallback bound + its provenance — a bound
  // tuned after seeing a run is not pre-committed, so the source is stamped
  L.push(renderFallbackBound(fallbackBoundStamp));
  L.push('');
  if (writeInfo) {
    L.push('## Write phase');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(stripCandidateLedgers(writeInfo), null, 2));
    L.push('```');
    L.push('');
  }
  if (cleanup) {
    L.push('## Platform cleanup');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(cleanup, null, 2));
    L.push('```');
    L.push('');
  }
  L.push('## Exact commands');
  L.push('');
  L.push('```bash');
  for (const c of commands) L.push(c);
  L.push('```');
  L.push('');
  L.push('## Artifacts');
  L.push('');
  if (rejudge) {
    const stem = rejudge.suffix ? `rejudge-${rejudge.suffix}` : 'rejudge';
    L.push(`- rows (the saved answers, unchanged): \`bench/memory/results/${rejudge.ofRunId}/\` (<arm>.rows.jsonl)`);
    L.push(`- judged (${stem}): \`bench/memory/results/${rejudge.ofRunId}/judged.${stem}.jsonl\``);
    L.push(`- summary (${stem}): \`bench/memory/results/${rejudge.ofRunId}/summary.${stem}.json\``);
    L.push(summary.original?.summary_missing
      ? '- original receipt: none — the run died before writing summary.json or a receipt'
      : `- original receipt: \`bench/memory/receipts/${rejudge.ofRunId}.md\``);
    L.push(`- this receipt: \`bench/memory/receipts/${runId}.md\``);
  } else if (reanswer) {
    L.push(`- rows (re-answer of the kept namespaces): \`bench/memory/results/${reanswer.ofRunId}/\` (<arm>.rows.reanswer-${reanswer.readPolicy}.jsonl)`);
    L.push(`- rows (the original write-side answers, unchanged): \`bench/memory/results/${reanswer.ofRunId}/\` (<arm>.rows.jsonl)`);
    L.push(`- judged (reanswer): \`bench/memory/results/${reanswer.ofRunId}/judged.reanswer-${reanswer.readPolicy}.jsonl\``);
    L.push(`- summary (reanswer): \`bench/memory/results/${reanswer.ofRunId}/summary.reanswer-${reanswer.readPolicy}.json\``);
    L.push(`- original receipt: \`bench/memory/receipts/${reanswer.ofRunId}.md\``);
    L.push(`- this receipt: \`bench/memory/receipts/${runId}.md\``);
  } else {
    L.push(`- rows: \`bench/memory/results/${runId}/\` (<arm>.rows.jsonl + judged.jsonl — the raw evidence for every number above)`);
    L.push(`- summary: \`bench/memory/results/${runId}/summary.json\``);
    L.push(`- this receipt: \`bench/memory/receipts/${runId}.md\``);
  }
  L.push('');
  return L.join('\n');
}

export function writeReceipt(runId, markdown, { dir = RECEIPTS_DIR, writeFileFn = fs.writeFileSync, mkdir = true } = {}) {
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.md`);
  writeFileFn(file, markdown);
  return file;
}
