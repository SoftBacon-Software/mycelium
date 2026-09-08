import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rejudgeRun } from '../../bench/memory/rejudge.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';
import { JUDGE_PROMPT_VERSION } from '../../bench/memory/judge.mjs';

// Hermetic rejudge: a fake saved-run dir on disk + a fake judge. No network,
// no platform, no dataset.

function writeRunDir(root) {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const regime = {
    date_utc: '2026-09-08T00:00:00Z', git_sha: 'abc123', git_dirty: false, harness: 'test',
    dataset: { name: 'fixture', sha256: 'deadbeef' },
    answerer: { model: 'fake-answerer', url_host: 'fake' },
    judge: { model: 'old-judge', url_host: 'old:8780' },
    retrieval: { budget: 5, namespace: 'bench-p1-run-a' },
    platform: { url_host: 'fake:3002' },
    n: 3, selection_rule: 'test', notes: [],
  };
  const arms = {
    none: { n: 2, write: { docs: 0, rows: 0, skipped: false }, elapsed_ms: 1, score: { n: 2, counts: { exact: 0, partial: 2, wrong: 0 }, unparsed: 0, p1_score: 0.5 } },
    mycelium: { n: 1, write: { docs: 2, rows: 2, skipped: false }, elapsed_ms: 2, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ run_id: 'run-a', n: 3, regime, arms }, null, 2));
  const row = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(dir, 'none.rows.jsonl'), [
    row({ question_id: 'q1', question_type: 'multi-session', question: 'How many years?', gold: '43', answer: 'I do not have that in my memory.' }),
    row({ question_id: 'q2', question_type: 'multi-session', question: 'Which city?', gold: 'Lisbon', answer: 'Lisbon.' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'mycelium.rows.jsonl'), [
    row({ question_id: 'q1', question_type: 'multi-session', question: 'How many years?', gold: '43', answer: 'The difference is 43 years.' }),
  ].join('\n'));
  return dir;
}

describe('rejudgeRun — re-judge a saved run\'s answers (hermetic)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rejudge-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function fakeJudge(labelFor) {
    const calls = [];
    return {
      calls,
      judgeFn: async ({ question, gold, answer }) => {
        calls.push({ question, gold, answer });
        return { label: labelFor({ question, gold, answer }), raw: 'RAW', hadThink: false };
      },
    };
  }

  it('re-labels every saved answer in arm order and streams rows via onJudged', async () => {
    const dir = writeRunDir(root);
    const { judgeFn, calls } = fakeJudge(({ gold, answer }) => (answer.includes(gold) ? 'exact' : 'wrong'));
    const streamed = [];
    const result = await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-08T22:00:00Z',
      onJudged: (r) => streamed.push(r),
    });
    expect(calls).toHaveLength(3); // every saved answer went back through the judge
    expect(calls[0]).toEqual({ question: 'How many years?', gold: '43', answer: 'I do not have that in my memory.' });
    expect(streamed.map((r) => `${r.arm}/${r.question_id}`)).toEqual(['none/q1', 'none/q2', 'mycelium/q1']);
    for (const r of streamed) {
      expect(r).toHaveProperty('label');
      expect(r.judge_raw).toBe('RAW');
      expect(r.judge_had_think).toBe(false);
      expect(typeof r.answer).toBe('string');
    }
    expect(result.judged).toHaveLength(3);
  });

  it('summary carries the new tallies, the version stamp, the rejudge marker — and the original numbers untouched', async () => {
    const dir = writeRunDir(root);
    const { judgeFn } = fakeJudge(({ gold, answer }) => (answer.includes(gold) ? 'exact' : 'wrong'));
    const { summary } = await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-08T22:00:00Z',
    });
    expect(summary.run_id).toBe('run-a-rejudge');
    expect(summary.rejudged_from).toBe('run-a');
    expect(summary.judge_prompt_version).toBe('judge-prompt.2');
    // new labels: refusals are wrong now, stated facts are exact
    expect(summary.arms.none.score.counts).toEqual({ exact: 1, partial: 0, wrong: 1 });
    expect(summary.arms.mycelium.score.counts).toEqual({ exact: 1, partial: 0, wrong: 0 });
    // the original run's own numbers ride along for the before/after read
    expect(summary.original.arms.none.score.counts.partial).toBe(2);
    expect(summary.original.judge).toEqual({ model: 'old-judge', url_host: 'old:8780' });
    // regime: answers keep the original stamp; judge block + rejudge marker say what changed
    expect(summary.regime.dataset).toEqual({ name: 'fixture', sha256: 'deadbeef' });
    expect(summary.regime.judge).toEqual({ model: 'fake-judge', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' });
    expect(summary.regime.rejudge).toMatchObject({ of_run_id: 'run-a', answers_modified: false });
  });

  it('never writes the originals: rows files and summary.json are byte-identical after a rejudge', async () => {
    const dir = writeRunDir(root);
    const before = ['summary.json', 'none.rows.jsonl', 'mycelium.rows.jsonl']
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
    const { judgeFn } = fakeJudge(() => 'wrong');
    await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-08T22:00:00Z',
    });
    for (const [f, content] of before) expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(content);
    expect(fs.existsSync(path.join(dir, 'judged.rejudge.jsonl'))).toBe(false); // run.mjs owns that file
  });

  it('refuses when a rejudge output already exists — evidence is not silently overwritten', async () => {
    const dir = writeRunDir(root);
    fs.writeFileSync(path.join(dir, 'judged.rejudge.jsonl'), '');
    const { judgeFn } = fakeJudge(() => 'exact');
    await expect(rejudgeRun({
      dir, judgeFn,
      judge: { model: 'j', url_host: 'h' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: 'now',
    })).rejects.toThrow(/already exists/);
  });

  it('refuses a run whose rows file is missing (the saved answers ARE the evidence)', async () => {
    const dir = writeRunDir(root);
    fs.unlinkSync(path.join(dir, 'mycelium.rows.jsonl'));
    const { judgeFn } = fakeJudge(() => 'exact');
    await expect(rejudgeRun({
      dir, judgeFn,
      judge: { model: 'j', url_host: 'h' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: 'now',
    })).rejects.toThrow(/missing .*mycelium\.rows\.jsonl/);
  });

  it('refuses when the rows on disk disagree with the summary counts', async () => {
    const dir = writeRunDir(root);
    fs.appendFileSync(path.join(dir, 'none.rows.jsonl'), '\n' + JSON.stringify({ question_id: 'q9', question: 'x', gold: 'y', answer: 'z' }));
    const { judgeFn } = fakeJudge(() => 'exact');
    await expect(rejudgeRun({
      dir, judgeFn,
      judge: { model: 'j', url_host: 'h' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: 'now',
    })).rejects.toThrow(/3 rows but summary\.json says n=2/);
  });
});

describe('rejudge receipt rendering', () => {
  const summary = {
    run_id: 'run-a-rejudge',
    rejudged_from: 'run-a',
    judge_prompt_version: 'judge-prompt.2',
    regime: {
      date_utc: '2026-09-08T00:00:00Z', git_sha: 'abc123', git_dirty: false, harness: 'test',
      dataset: { sha256: 'deadbeef' }, answerer: {}, judge: { model: 'fake-judge', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' },
      retrieval: {}, platform: {}, n: 3, selection_rule: 'test', notes: [],
      rejudge: { of_run_id: 'run-a', date_utc: '2026-09-08T22:00:00Z', answers_modified: false },
    },
    arms: {
      none: { n: 2, score: { n: 2, counts: { exact: 0, partial: 0, wrong: 2 }, unparsed: 0, p1_score: 0 } },
      mycelium: { n: 1, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
    },
    original: {
      run_id: 'run-a',
      judge: { model: 'old-judge', url_host: 'old:8780' },
      arms: {
        none: { n: 2, score: { n: 2, counts: { exact: 0, partial: 2, wrong: 0 }, unparsed: 0, p1_score: 0.5 } },
        mycelium: { n: 1, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
      },
    },
  };

  it('names the source run + prompt version, renders BOTH score tables, and points at the rejudge artifacts', () => {
    const md = renderReceipt({
      runId: 'run-a-rejudge',
      summary,
      agreement: { n: 20, agree: 19, rate: 0.95, disagree: [{ question_id: 'q1', arm: 'none', hand: 'wrong', judge: 'partial' }] },
      handlabels: { hand_scorer: 'tester', path: 'hl.json', n: 20 },
      rejudge: { ofRunId: 'run-a', judgePromptVersion: 'judge-prompt.2' },
      generatedAt: '2026-09-08T22:00:00Z',
    });
    expect(md).toContain('Re-judge of run `run-a` with judge prompt version `judge-prompt.2`');
    expect(md).toContain('| none | 2 | 0 | 0 | 2 | 0.000 |'); // new table
    expect(md).toContain('Original run `run-a` scores (pre-rejudge');
    expect(md).toContain('| none | 2 | 0 | 2 | 0 | 0.500 |'); // original table
    expect(md).toContain('judged.rejudge.jsonl');
    expect(md).toContain('summary.rejudge.json');
    expect(md).toContain('"judge_prompt_version": "judge-prompt.2"'); // regime block records it
    expect(md).toContain('"of_run_id": "run-a"'); // regime block records the source run
    expect(md).not.toContain('NOT RECORDED in this receipt');
  });

  it('a plain (fresh-run) receipt is unchanged — no rejudge block, no second table', () => {
    const md = renderReceipt({
      runId: 'run-a',
      summary: { run_id: 'run-a', regime: summary.regime, arms: summary.arms },
      generatedAt: '2026-09-08T22:00:00Z',
    });
    expect(md).not.toMatch(/Re-judge of run/);
    expect(md).not.toMatch(/pre-rejudge/);
    expect(md).toContain('| none | 2 | 0 | 0 | 2 | 0.000 |');
    expect(md).toContain('- summary: `bench/memory/results/run-a/summary.json`');
  });
});
