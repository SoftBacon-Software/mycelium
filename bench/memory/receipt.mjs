// The receipt: markdown, generated from the run's own output objects. No hand-
// typed numbers — if a number appears here, it was read from summary/judged.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RECEIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipts');

export function renderReceipt({
  runId,
  summary,
  agreement: judgeAgreement = null,
  commands = [],
  cleanup = null,
  handlabels = null,
  writeInfo = null,
  rejudge = null, // {ofRunId, judgePromptVersion} — present on a rejudge receipt
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
  L.push('');
  L.push('## Scores');
  L.push('');
  L.push('| arm | n | exact | partial | wrong | p1_score |');
  L.push('|---|---|---|---|---|---|');
  for (const [name, a] of Object.entries(summary.arms)) L.push(scoreRow([name, a]));
  L.push('');
  L.push('`p1_score` = (exact + 0.5×partial) / n. Raw counts are the primary record; the score is the one-number comparison.');
  if (rejudge && summary.original?.arms) {
    L.push('');
    L.push(`Original run \`${rejudge.ofRunId}\` scores (pre-rejudge, from the run's own summary):`);
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
    L.push(JSON.stringify(writeInfo, null, 2));
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
    L.push(`- original receipt: \`bench/memory/receipts/${rejudge.ofRunId}.md\``);
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
