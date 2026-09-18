// The receipt: markdown, generated from the run's own output objects. No hand-
// typed numbers — if a number appears here, it was read from summary/judged.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderIngestionGrid } from './ingestion.mjs';
import { renderAutopsySection } from './miss_autopsy.mjs';
import { WIN_CONDITION, renderPerTypeTable, renderWinCondition, tallyByType } from './per_type.mjs';

export const RECEIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipts');

// The bound's denominator, provenance-stamped (task 188): the extract control's
// n=50 run — extract_ms 11,370,052 over 2,355 docs = 4.83 s/session. The
// timeline arm's write cost is quoted as a RATIO of this figure; if the extract
// arm ever re-runs its n=50 write, re-stamp these three numbers from the new
// summary.json (never retype the ratio — the line computes it).
export const EXTRACT_ARM_STAMPED = {
  run_id: '2026-09-10-p1-001549',
  extract_ms: 11_370_052,
  docs: 2355,
};

// The timeline arm's write cost INCLUDING its reconcile phase (extract_ms alone
// understates it ~10×: the ADD/SUPERSEDE/KEEP decision calls dominate), as a
// ratio of the extract arm's stamped figure — the brief's ≤2× bound. Returns
// null when the run carries no timeline write stats (no line for other arms).
export function timelineCostLine(writeInfo) {
  const w = writeInfo?.['mycelium-timeline'];
  if (!w || typeof w.extract_ms !== 'number' || !w.docs) return null;
  const sPerSession = (w.extract_ms + (w.reconcile_ms ?? 0)) / w.docs / 1000;
  const extractSPerSession = EXTRACT_ARM_STAMPED.extract_ms / EXTRACT_ARM_STAMPED.docs / 1000;
  const ratio = sPerSession / extractSPerSession;
  return `Write cost (mycelium-timeline): ${sPerSession.toFixed(2)} s/session — cost ×${ratio.toFixed(2)} of extract; bound ≤ 2×`;
}

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
  rejudge = null, // {ofRunId, judgePromptVersion} — present on a rejudge receipt
  reanswer = null, // {ofRunId, readPolicy} — present on a re-answer receipt
  generatedAt,
}) {
  const scoreRow = ([name, a]) => {
    const c = a.score?.counts ?? { exact: 0, partial: 0, wrong: 0 };
    return `| ${name} | ${a.n} | ${c.exact} | ${c.partial} | ${c.wrong} | ${a.score?.p1_score?.toFixed(3) ?? 'n/a'} |`;
  };
  const L = [];
  L.push(`# Receipt — memory benchmark P1 skeleton (${runId})`);
  L.push('');
  L.push(`Generated: ${generatedAt}`);
  if (rejudge) {
    L.push('');
    L.push(`Re-judge of run \`${rejudge.ofRunId}\` with judge prompt version \`${rejudge.judgePromptVersion}\`.`);
    L.push('The answers are the original run\'s own (no answerer calls, no platform calls) — only the');
    L.push('judge labels were re-computed. The original run\'s scores are rendered below the new ones.');
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
  for (const [name, a] of Object.entries(summary.arms)) L.push(scoreRow([name, a]));
  L.push('');
  L.push('`p1_score` = (exact + 0.5×partial) / n. Raw counts are the primary record; the score is the one-number comparison.');
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
    for (const [name, a] of Object.entries(summary.original.arms)) L.push(scoreRow([name, a]));
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
  // task 188: the timeline arm's write cost against the extract control —
  // computed from the run's own stamps, never hand-typed
  const costLine = timelineCostLine(writeInfo ?? summary.write_info ?? null);
  if (costLine) {
    L.push(costLine);
    L.push('');
  }
  // task 199: per-question-type scores + (when the timeline arm is in the run)
  // its pre-committed win-condition block. The table needs the run's judged
  // rows; their absence renders as its absence, never a number from nothing.
  if (Array.isArray(judged)) {
    const perType = {};
    L.push('## Per-question-type scores');
    L.push('');
    for (const name of Object.keys(summary.arms)) {
      perType[name] = tallyByType(judged.filter((r) => r.arm === name));
      for (const line of renderPerTypeTable(name, perType[name])) L.push(line);
      L.push('');
    }
    if (summary.arms[WIN_CONDITION.arm]) {
      for (const line of renderWinCondition({
        talliesByArm: perType,
        writeInfoByArm: writeInfo ?? summary.write_info ?? {},
        regimeByArm: { [WIN_CONDITION.arm]: summary.regime ?? {} },
        absentLabel: 'not in this run',
        notStampedPhrase: 'not stamped in this run',
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
  L.push('## Regime');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(summary.regime, null, 2));
  L.push('```');
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
    L.push(`- rows (the saved answers, unchanged): \`bench/memory/results/${rejudge.ofRunId}/\` (<arm>.rows.jsonl)`);
    L.push(`- judged (rejudge): \`bench/memory/results/${rejudge.ofRunId}/judged.rejudge.jsonl\``);
    L.push(`- summary (rejudge): \`bench/memory/results/${rejudge.ofRunId}/summary.rejudge.json\``);
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
