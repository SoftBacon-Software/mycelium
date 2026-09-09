// runBench — the orchestrator. Everything injectable: arms, judge, split items.
// run.mjs is the thin CLI shell; this module is what the hermetic tests drive
// with a fake arm and a fake judge.

import { tally } from './judge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runBench({
  items,            // selected split items (already sliced to n)
  armFactories,     // [{ name, factory }] in run order
  armContext,       // passed straight to each factory: {answerChat, platform, runId, namespace, budget, ...}
  judgeFn,          // async ({question, gold, answer}) => {label, raw}  (omit to skip judging)
  regime,           // the regime stamp (regime.mjs); required — rows refuse to exist without it
  runId,
  afterWrite,       // async ({arm, writeInfo}) => void — e.g. wait for embedding coverage
  onRow,            // (row) => void — incremental persistence hook
  onJudged,         // (row) => void
  requestDelayMs = 0, // pacing between model calls
}) {
  if (!regime) throw new Error('runBench requires a regime stamp — rows are written without one is a bug by construction');
  if (!Array.isArray(items) || items.length === 0) throw new Error('runBench: no items selected');

  const armsOut = {};
  const allRows = [];

  for (const { name, factory } of armFactories) {
    const t0 = Date.now();
    const arm = factory(armContext);
    if (arm.name !== name) throw new Error(`Arm factory reported name '${arm.name}', expected '${name}'`);

    // -- write phase ---------------------------------------------------------
    const writeInfo = { docs: 0, rows: 0, skipped: true };
    if (typeof arm.write === 'function') {
      writeInfo.skipped = false;
      for (const item of items) {
        const w = await arm.write(item.haystack_sessions, { questionId: item.question_id });
        if (w) {
          writeInfo.docs += w.docs ?? 0;
          writeInfo.rows += w.rows ?? 0;
        }
      }
    }
    if (afterWrite) await afterWrite({ arm: name, writeInfo });

    // -- answer phase --------------------------------------------------------
    const rows = [];
    for (const item of items) {
      const t1 = Date.now();
      const ans = await arm.answer(item.question);
      const text = typeof ans === 'string' ? ans : ans.text;
      const meta = typeof ans === 'string' ? {} : (ans.meta ?? {});
      if (!text || typeof text !== 'string') throw new Error(`Arm ${name} returned no text for ${item.question_id}`);
      const row = {
        question_id: item.question_id,
        question_type: item.question_type,
        question: item.question,
        gold: item.answer,
        answer: text,
        elapsed_ms: Date.now() - t1,
        meta,
        regime,
      };
      rows.push(row);
      allRows.push({ ...row, arm: name });
      if (onRow) onRow({ ...row, arm: name });
      if (requestDelayMs) await sleep(requestDelayMs);
    }

    armsOut[name] = { arm: name, rows, write: writeInfo, elapsed_ms: Date.now() - t0 };
    // the arm is done — release what it holds (e.g. the mem0 sidecar). Arms
    // without lifecycle needs don't implement dispose; a dispose failure is a
    // real failure (a leaked port is a loud problem, not a warning).
    if (typeof arm.dispose === 'function') await arm.dispose();
  }

  // -- judge phase -----------------------------------------------------------
  let judged = null;
  if (judgeFn) {
    judged = [];
    for (const row of allRows) {
      const j = await judgeFn({ question: row.question, gold: row.gold, answer: row.answer });
      const jr = {
        question_id: row.question_id,
        arm: row.arm,
        question_type: row.question_type,
        gold: row.gold,
        answer: row.answer,
        label: j.label,
        judge_raw: j.raw,
        judge_had_think: !!j.had_think,
      };
      judged.push(jr);
      if (onJudged) onJudged(jr);
      if (requestDelayMs) await sleep(requestDelayMs);
    }
  }

  // -- summary ----------------------------------------------------------------
  const summary = {
    run_id: runId,
    n: items.length,
    regime,
    arms: {},
  };
  for (const { name } of armFactories) {
    const rows = armsOut[name].rows;
    const t = tally(judged ? judged.filter((j) => j.arm === name).map((j) => j.label) : rows.map(() => null));
    summary.arms[name] = {
      n: rows.length,
      write: armsOut[name].write,
      elapsed_ms: armsOut[name].elapsed_ms,
      score: t,
    };
    const modes = {};
    for (const r of rows) {
      const m = r.meta?.retrieval_mode;
      if (m) modes[m] = (modes[m] || 0) + 1;
    }
    if (Object.keys(modes).length) summary.arms[name].retrieval_modes = modes;
  }

  return { summary, rows: allRows, judged };
}

// Rebuild summary + tally from a results dir (the --from-results mode): the
// receipt must be regenerable from the run's own output alone.
export function summarizeFromResults({ runId, regime, rows, judged }) {
  const armNames = [...new Set(rows.map((r) => r.arm))];
  const summary = { run_id: runId, n: new Set(rows.map((r) => r.question_id)).size, regime, arms: {} };
  for (const name of armNames) {
    const j = judged ? judged.filter((x) => x.arm === name) : [];
    const t = tally(judged ? j.map((x) => x.label) : []);
    summary.arms[name] = { n: rows.filter((r) => r.arm === name).length, score: t };
    const modes = {};
    for (const r of rows.filter((x) => x.arm === name)) {
      const m = r.meta?.retrieval_mode;
      if (m) modes[m] = (modes[m] || 0) + 1;
    }
    if (Object.keys(modes).length) summary.arms[name].retrieval_modes = modes;
  }
  return summary;
}
