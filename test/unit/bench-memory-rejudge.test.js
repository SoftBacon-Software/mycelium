import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rejudgeRun, rejudgeOutputNames, assertRejudgeOutputsFree, loadPreviousRejudges } from '../../bench/memory/rejudge.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';
import { computeAutopsy, DEFAULT_AUTOPSY_ARM } from '../../bench/memory/miss_autopsy.mjs';
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
    expect(summary.judge_prompt_version).toBe(JUDGE_PROMPT_VERSION);
    // new labels: refusals are wrong now, stated facts are exact
    expect(summary.arms.none.score.counts).toEqual({ exact: 1, partial: 0, wrong: 1 });
    expect(summary.arms.mycelium.score.counts).toEqual({ exact: 1, partial: 0, wrong: 0 });
    // the original run's own numbers ride along for the before/after read
    expect(summary.original.arms.none.score.counts.partial).toBe(2);
    expect(summary.original.judge).toEqual({ model: 'old-judge', url_host: 'old:8780' });
    // regime: answers keep the original stamp; judge block + rejudge marker say what changed
    expect(summary.regime.dataset).toEqual({ name: 'fixture', sha256: 'deadbeef' });
    expect(summary.regime.judge).toEqual({ model: 'fake-judge', url_host: 'localhost:8780', judge_prompt_version: JUDGE_PROMPT_VERSION });
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
    expect(md).not.toContain('Previous judge'); // no prior rejudge in the dir -> no previous-judge section
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
  it('reconstructs a run whose summary.json never existed from the regime-stamped rows, and stamps the reconstruction', async () => {
    // the 2026-09-18 shape: 50 answers on disk, judge died at q1, finally-cleanup ran, no summary.json
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rejudge-missing-'));
    const dir = path.join(root, '2026-09-17-p1-224225');
    fs.mkdirSync(dir);
    const regime = {
      date_utc: '2026-09-17T22:42:25Z', git_sha: 'd73978f0', git_dirty: false, harness: 'test',
      dataset: { name: 'fixture', sha256: 'deadbeef' },
      answerer: { model: 'qwen3.8:27b', url_host: '100.95.5.83:11434' },
      judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' },
      retrieval: { budget: 5, namespace: 'bench-p1-2026-09-17-p1-224225' },
      platform: { url_host: '192.168.50.106:3002' },
      n: 2, selection_rule: 'test', notes: [],
    };
    const row = (o) => JSON.stringify({ ...o, regime, arm: 'mycelium-timeline' });
    fs.writeFileSync(path.join(dir, 'mycelium-timeline.rows.jsonl'), [
      row({ question_id: 'q1', question_type: 'knowledge-update', question: 'Which city?', gold: 'Lisbon', answer: 'Lisbon.' }),
      row({ question_id: 'q2', question_type: 'knowledge-update', question: 'How many?', gold: '43', answer: 'I do not know.' }),
    ].join('\n'));
    expect(fs.existsSync(path.join(dir, 'summary.json'))).toBe(false);

    const calls = [];
    const judgeFn = async ({ question, gold, answer }) => { calls.push({ question, gold, answer }); return { label: answer.includes(gold) ? 'exact' : 'wrong', raw: 'RAW', hadThink: false }; };
    const result = await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', url_host: '127.0.0.1:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-18T06:30:00Z',
    });
    expect(calls).toHaveLength(2);
    expect(result.summary.rejudged_from).toBe('2026-09-17-p1-224225'); // the dir name IS the run id
    expect(result.summary.run_id).toBe('2026-09-17-p1-224225-rejudge');
    expect(result.summary.arms['mycelium-timeline'].n).toBe(2);
    expect(result.summary.arms['mycelium-timeline'].score.counts).toEqual({ exact: 1, partial: 0, wrong: 1 });
    // the regime is the rows' own stamp, not invented
    expect(result.summary.regime.answerer).toEqual(regime.answerer);
    expect(result.summary.regime.retrieval).toEqual(regime.retrieval);
    // and the reconstruction is stamped where the receipt reads
    expect(result.summary.regime.rejudge.original_summary).toMatch(/missing/);
    expect(result.summary.original.summary_missing).toBe(true);
    expect(result.summary.original.arms['mycelium-timeline']).toEqual({ n: 2 }); // no original score exists — none is typed
    // the receipt still renders from a reconstructed run
    const md = renderReceipt({
      runId: result.summary.run_id, summary: result.summary, judged: result.judged,
      rejudge: { ofRunId: result.summary.rejudged_from, judgePromptVersion: JUDGE_PROMPT_VERSION },
      generatedAt: '2026-09-18T06:30:00Z',
    });
    expect(md).toContain('Re-judge of run `2026-09-17-p1-224225`');
    expect(md).toContain('wrote NO summary.json'); // the receipt says so instead of rendering an invented original table
    expect(md).not.toContain('Original run `2026-09-17-p1-224225` scores');
    expect(md).toContain('original receipt: none');
    expect(md).toContain('| mycelium-timeline | 2 | 1 | 0 | 1 |'); // the NEW labels render
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses to reconstruct when the rows carry no regime stamp or disagree on it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rejudge-refuse-'));
    const dir = path.join(root, 'no-stamp');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'none.rows.jsonl'), JSON.stringify({ question_id: 'q1', question: 'x', gold: 'y', answer: 'y' }));
    const judgeFn = async () => ({ label: 'exact', raw: 'RAW', hadThink: false });
    await expect(rejudgeRun({ dir, judgeFn, judge: { model: 'j', url_host: 'h' }, judgePromptVersion: JUDGE_PROMPT_VERSION, generatedAtUtc: 'now' }))
      .rejects.toThrow(/carries no regime stamp/);

    const dir2 = path.join(root, 'disagree');
    fs.mkdirSync(dir2);
    const base = { answerer: { model: 'a', url_host: 'h' }, judge: { model: 'j', url_host: 'h' } };
    fs.writeFileSync(path.join(dir2, 'none.rows.jsonl'), [
      JSON.stringify({ question_id: 'q1', question: 'x', gold: 'y', answer: 'y', regime: { ...base, git_sha: 'aaa' } }),
      JSON.stringify({ question_id: 'q2', question: 'x', gold: 'y', answer: 'y', regime: { ...base, git_sha: 'bbb' } }),
    ].join('\n'));
    await expect(rejudgeRun({ dir: dir2, judgeFn, judge: { model: 'j', url_host: 'h' }, judgePromptVersion: JUDGE_PROMPT_VERSION, generatedAtUtc: 'now' }))
      .rejects.toThrow(/disagree on the regime stamp/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('rejudge — the suffixed second pass (task 221): writes beside, never over', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rejudge-suffix-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function fakeJudge(labelFor) {
    return async ({ question, gold, answer }) => (
      { label: labelFor({ question, gold, answer }), raw: 'RAW', hadThink: false }
    );
  }

  // a dir whose FIRST rejudge already happened — the exact state that refuses a plain --rejudge
  function writeRejudgedRunDir() {
    const dir = writeRunDir(root);
    fs.writeFileSync(path.join(dir, 'judged.rejudge.jsonl'), '{"planted": true}\n');
    fs.writeFileSync(path.join(dir, 'summary.rejudge.json'), JSON.stringify({
      run_id: 'run-a-rejudge', rejudged_from: 'run-a', judge_prompt_version: 'judge-prompt.2',
      generated_at_utc: '2026-09-18T06:26:01Z',
      arms: {
        none: { n: 2, score: { n: 2, counts: { exact: 0, partial: 1, wrong: 1 }, unparsed: 0, p1_score: 0.25 } },
        mycelium: { n: 1, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
      },
    }, null, 2));
    return dir;
  }

  it('rejudgeOutputNames: plain vs suffixed names — and a suffix that would wander the filesystem is refused', () => {
    expect(rejudgeOutputNames('/tmp/run-a')).toEqual({
      stem: 'rejudge',
      judgedFile: '/tmp/run-a/judged.rejudge.jsonl',
      summaryFile: '/tmp/run-a/summary.rejudge.json',
    });
    expect(rejudgeOutputNames('/tmp/run-a', { suffix: 'prompt3' })).toEqual({
      stem: 'rejudge-prompt3',
      judgedFile: '/tmp/run-a/judged.rejudge-prompt3.jsonl',
      summaryFile: '/tmp/run-a/summary.rejudge-prompt3.json',
    });
    for (const bad of ['../evil', 'a/b', 'has space', '', '.hidden']) {
      expect(() => rejudgeOutputNames('/tmp/run-a', { suffix: bad })).toThrow(/invalid --rejudge-suffix/);
    }
  });

  it('a suffixed rejudge runs where the plain one refuses — its outputs named beside the first pass', async () => {
    const dir = writeRejudgedRunDir();
    const firstPass = fs.readFileSync(path.join(dir, 'judged.rejudge.jsonl'), 'utf8');
    const result = await rejudgeRun({
      dir, judgeFn: fakeJudge(({ gold, answer }) => (answer.includes(gold) ? 'exact' : 'wrong')), suffix: 'prompt3',
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-18T07:00:00Z',
    });
    expect(result.judgedFilePath).toBe(path.join(dir, 'judged.rejudge-prompt3.jsonl'));
    expect(fs.readFileSync(path.join(dir, 'judged.rejudge.jsonl'), 'utf8')).toBe(firstPass); // the first rejudge is untouched
    expect(fs.existsSync(path.join(dir, 'judged.rejudge-prompt3.jsonl'))).toBe(false); // run.mjs owns the writing; rejudgeRun only names it
  });

  it('the suffixed summary is tagged: run_id <runId>-rejudge-<tag> and the suffix in the rejudge marker', async () => {
    const dir = writeRejudgedRunDir();
    const { summary } = await rejudgeRun({
      dir, judgeFn: fakeJudge(({ gold, answer }) => (answer.includes(gold) ? 'exact' : 'wrong')), suffix: 'prompt3',
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-18T07:00:00Z',
    });
    expect(summary.run_id).toBe('run-a-rejudge-prompt3'); // the receipt lands at <runId>-rejudge-<tag>.md, beside the first
    expect(summary.rejudged_from).toBe('run-a');
    expect(summary.regime.rejudge.suffix).toBe('prompt3');
    expect(summary.regime.rejudge.of_run_id).toBe('run-a');
  });

  it('refuses when its own suffixed output already exists — the suffix does not escape the evidence rule', async () => {
    const dir = writeRejudgedRunDir();
    fs.writeFileSync(path.join(dir, 'judged.rejudge-prompt3.jsonl'), '');
    await expect(rejudgeRun({
      dir, judgeFn: fakeJudge(() => 'exact'), suffix: 'prompt3',
      judge: { model: 'j', url_host: 'h' }, judgePromptVersion: JUDGE_PROMPT_VERSION, generatedAtUtc: 'now',
    })).rejects.toThrow(/judged\.rejudge-prompt3\.jsonl already exists/);
  });

  it('assertRejudgeOutputsFree: either artifact existing is a refusal before any judge call', () => {
    const dir = writeRejudgedRunDir();
    // both of THIS pass's outputs free -> passes (the first pass's files are different files)
    expect(() => assertRejudgeOutputsFree({
      judgedFile: path.join(dir, 'judged.rejudge-prompt3.jsonl'),
      summaryFile: path.join(dir, 'summary.rejudge-prompt3.json'),
    })).not.toThrow();
    expect(() => assertRejudgeOutputsFree({
      judgedFile: path.join(dir, 'judged.rejudge.jsonl'),
      summaryFile: path.join(dir, 'summary.rejudge-prompt3.json'),
    })).toThrow(/judged\.rejudge\.jsonl already exists/);
    expect(() => assertRejudgeOutputsFree({
      judgedFile: path.join(dir, 'judged.rejudge-prompt3.jsonl'),
      summaryFile: path.join(dir, 'summary.rejudge.json'),
    })).toThrow(/summary\.rejudge\.json already exists/);
  });

  it('loadPreviousRejudges: the dir\'s prior rejudge summaries, oldest first, never this pass\'s own output', () => {
    const dir = writeRejudgedRunDir();
    fs.writeFileSync(path.join(dir, 'summary.rejudge-aaa.json'), JSON.stringify({
      run_id: 'run-a-rejudge-aaa', judge_prompt_version: 'judge-prompt.1', generated_at_utc: '2026-09-17T00:00:00Z',
      arms: { none: { n: 2, score: { n: 2, counts: { exact: 2, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } } },
    }));
    const prev = loadPreviousRejudges(dir, { exclude: [path.join(dir, 'summary.rejudge-prompt3.json')] });
    expect(prev.map((p) => p.run_id)).toEqual(['run-a-rejudge-aaa', 'run-a-rejudge']); // oldest first
    expect(prev[0].judge_prompt_version).toBe('judge-prompt.1');
    expect(prev[1].file).toBe('summary.rejudge.json');
    expect(prev[1].arms.none.score.counts).toEqual({ exact: 0, partial: 1, wrong: 1 });
    expect(prev.some((p) => p.file === 'summary.rejudge-prompt3.json')).toBe(false);
    // excluding every prior -> nothing left (a first rejudge has no history)
    expect(loadPreviousRejudges(dir, {
      exclude: [path.join(dir, 'summary.rejudge.json'), path.join(dir, 'summary.rejudge-aaa.json')],
    })).toEqual([]);
  });

  it('receipt of a rejudge of a rejudge: BOTH prompt versions named, previous numbers under "previous judge", suffixed artifacts', () => {
    const summary = {
      run_id: 'run-a-rejudge-prompt3',
      rejudged_from: 'run-a',
      judge_prompt_version: 'judge-prompt.3',
      regime: {
        date_utc: '2026-09-08T00:00:00Z', git_sha: 'abc123', git_dirty: false, harness: 'test',
        dataset: { sha256: 'deadbeef' }, answerer: {}, judge: { model: 'fake-judge', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.3' },
        retrieval: {}, platform: {}, n: 3, selection_rule: 'test', notes: [],
        rejudge: { of_run_id: 'run-a', date_utc: '2026-09-18T07:00:00Z', answers_modified: false, suffix: 'prompt3' },
      },
      arms: {
        none: { n: 2, score: { n: 2, counts: { exact: 1, partial: 0, wrong: 1 }, unparsed: 0, p1_score: 0.5 } },
        mycelium: { n: 1, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
      },
      original: {
        run_id: 'run-a', summary_missing: true,
        arms: { none: { n: 2 }, mycelium: { n: 1 } }, // reconstruction — no original scores exist
      },
    };
    const md = renderReceipt({
      runId: 'run-a-rejudge-prompt3',
      summary,
      previousJudges: [
        { file: 'summary.rejudge.json', run_id: 'run-a-rejudge', judge_prompt_version: 'judge-prompt.2', generated_at_utc: '2026-09-18T06:26:01Z',
          arms: {
            none: { n: 2, score: { n: 2, counts: { exact: 0, partial: 1, wrong: 1 }, unparsed: 0, p1_score: 0.25 } },
            mycelium: { n: 1, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
          } },
      ],
      rejudge: { ofRunId: 'run-a', judgePromptVersion: 'judge-prompt.3', suffix: 'prompt3' },
      generatedAt: '2026-09-18T07:00:00Z',
    });
    expect(md).toContain('Re-judge of run `run-a` with judge prompt version `judge-prompt.3`, tagged `prompt3`');
    expect(md).toMatch(/Previous judge `run-a-rejudge` \(prompt version `judge-prompt\.2`/);
    expect(md).toContain('from `summary.rejudge.json`');
    expect(md).toContain('| none | 2 | 0 | 1 | 1 | 0.250 |'); // the v2 numbers, read from summary.rejudge.json — not retyped
    expect(md).toContain('wrote NO summary.json'); // the reconstruction stamp still renders
    expect(md).toContain('judged.rejudge-prompt3.jsonl');
    expect(md).toContain('summary.rejudge-prompt3.json');
    expect(md).not.toContain('judged.rejudge.jsonl'); // never points at the first pass's artifacts
    expect(md).toContain('"suffix": "prompt3"'); // regime block records the tag
  });
});

// --- task 223: the run's own summary is the write-phase stamp when the judge
// died after the write phase. The rejudge prefers it; the reconstruction from
// rows stays the fallback for runs that predate the stamp.

// A judge-death run dir WITH its write-phase summary.json (the shape task 223
// leaves on disk): five arms' rows files + summary carrying the write-phase
// evidence — cost stamps, ingestion stats, the timeline candidates ledger.
function writeJudgeDeathRunDir(root) {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const regime = {
    date_utc: '2026-09-18T02:00:00Z', git_sha: 'abc123', git_dirty: false, harness: 'test',
    dataset: { name: 'fixture', sha256: 'deadbeef' },
    answerer: { model: 'fake-answerer', url_host: 'fake' },
    judge: { model: 'old-judge', url_host: 'old:8780', judge_prompt_version: 'judge-prompt.2' },
    retrieval: { budget: 5, namespace: 'bench-p1-run-w' },
    platform: { url_host: 'fake:3002' },
    n: 2, selection_rule: 'test', notes: [],
  };
  const writeInfo = {
    mycelium: { docs: 2, rows: 2, skipped: false, write_ms: 500 },
    'mycelium-extract': { docs: 2, rows: 2, skipped: false, extract_ms: 3600, facts: 5, facts_counts: [2, 3], parse_failures: 0 },
    'mycelium-timeline': {
      docs: 2, rows: 2, skipped: false, extract_ms: 3600, reconcile_ms: 5080, facts: 5, facts_counts: [2, 3], parse_failures: 1,
      timeline: {
        candidates: 3, adds: 2, supersedes: 1, keeps: 1, auto_adds: 0, decision_calls: 2, decision_failures: 0, fastpath_adds: 1, fastpath_skips_unembedded: 0,
        per_question: [
          {
            question_id: 'q-ku-1',
            candidates_ledger: [
              { text: 'Mara is the head of security.', decision: 'ADD', source: 'fastpath_below_threshold', shown_ids: [], top_score: 0.31, source_id: 'f-1', session_index: 0, index: 0, ok: true },
              { text: 'Mara is now the head of engineering.', decision: 'SUPERSEDE', source: 'decision_call', shown_ids: ['f-1'], top_score: 0.72, source_id: 'f-2', session_index: 1, index: 0, ok: true },
            ],
          },
          {
            question_id: 'q-ku-2',
            candidates_ledger: [
              { text: 'The launch moved to June.', decision: 'KEEP', source: 'decision_call', shown_ids: ['f-3'], top_score: 0.66, source_id: 'f-4', session_index: 1, index: 0, ok: true },
            ],
          },
        ],
      },
    },
    mem0: { docs: 2, rows: 2, skipped: false, write_ms: 4000, parse_failures: 0, facts: 4, facts_counts: [2, 2] },
    'mem0-raw': { docs: 4, rows: 4, skipped: false, write_ms: 200 },
  };
  const arms = {};
  for (const [name, w] of Object.entries(writeInfo)) arms[name] = { n: name === 'mem0-raw' ? 2 : 2, write: w, elapsed_ms: 10 };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ run_id: 'run-w', n: 2, regime, arms, write_info: writeInfo, phase: 'write' }, null, 2));
  const row = (arm, o) => JSON.stringify({ regime, arm, ...o });
  // every arm answers both questions; the timeline arm's q-ku-1 answer is wrong
  for (const arm of ['mycelium', 'mycelium-extract', 'mem0', 'mem0-raw']) {
    fs.writeFileSync(path.join(dir, `${arm}.rows.jsonl`), [
      row(arm, { question_id: 'q-ku-1', question_type: 'knowledge-update', question: 'Who heads engineering?', gold: 'engineering', answer: `${arm} says engineering.` }),
      row(arm, { question_id: 'q-ku-2', question_type: 'knowledge-update', question: 'When is the launch?', gold: 'June', answer: `${arm} says June.` }),
    ].join('\n'));
  }
  fs.writeFileSync(path.join(dir, 'mycelium-timeline.rows.jsonl'), [
    row('mycelium-timeline', { question_id: 'q-ku-1', question_type: 'knowledge-update', question: 'Who heads engineering?', gold: 'engineering', answer: 'I do not have that in my memory.', meta: { read_hits: [{ source_id: 'f-9', rank: 0 }], retrieval_mode: 'hybrid' } }),
    row('mycelium-timeline', { question_id: 'q-ku-2', question_type: 'knowledge-update', question: 'When is the launch?', gold: 'June', answer: 'It moved to June.', meta: { read_hits: [{ source_id: 'f-4', rank: 0 }], retrieval_mode: 'hybrid' } }),
  ].join('\n'));
  return dir;
}

describe('rejudge prefers the run\'s own summary (task 223)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rejudge-223-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const judgeFn = async ({ gold, answer }) => ({ label: answer.includes(gold) ? 'exact' : 'wrong', raw: 'RAW', hadThink: false });

  it('a judge-death run: write_info carried, regime from the summary, no reconstruction stamp, no invented original scores', async () => {
    const dir = writeJudgeDeathRunDir(root);
    const result = await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-18T06:30:00Z',
    });
    // the run's OWN summary was read — no reconstruction
    expect(result.summary.rejudged_from).toBe('run-w');
    expect(result.summary.regime.answerer).toEqual({ model: 'fake-answerer', url_host: 'fake' });
    expect(result.summary.regime.rejudge.original_summary).toBeUndefined();
    expect(result.summary.original.summary_missing).toBeUndefined();
    // the write-phase evidence rides through — the receipt's cost line, the
    // ingestion section, and the miss autopsy's candidates ledger live here
    expect(result.summary.write_info['mycelium-timeline'].extract_ms).toBe(3600);
    expect(result.summary.write_info['mycelium-timeline'].reconcile_ms).toBe(5080);
    expect(result.summary.write_info['mycelium-timeline'].parse_failures).toBe(1);
    expect(result.summary.write_info['mycelium-timeline'].timeline.per_question[0].candidates_ledger).toHaveLength(2);
    // a write-phase original has NO scores: the skeleton must not pose as a
    // score table — the phase + note say what the original summary is instead
    expect(result.summary.original.arms).toBeUndefined();
    expect(result.summary.original.phase).toBe('write');
    expect(result.summary.original.note).toMatch(/WRITE-phase/);
    // and the labels still judged, all five arms
    expect(result.judged).toHaveLength(10);
    expect(result.summary.arms['mycelium-timeline'].score.counts).toEqual({ exact: 1, partial: 0, wrong: 1 });
  });

  it('the rejudge receipt renders the write-phase evidence — cost line, ingestion grid, JUDGED cost bound — and the autopsy reads the ledger', async () => {
    const dir = writeJudgeDeathRunDir(root);
    const result = await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-18T06:30:00Z',
    });
    // the autopsy, computed the way run.mjs's rejudge block does: the REJUDGE
    // labels + the saved rows + the ledger via the summary
    const rows = fs.readFileSync(path.join(dir, 'mycelium-timeline.rows.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const autopsy = computeAutopsy({ arm: DEFAULT_AUTOPSY_ARM, summary: result.summary, judged: result.judged, rows });
    const md = renderReceipt({
      runId: result.summary.run_id,
      summary: result.summary,
      judged: result.judged,
      autopsy,
      rejudge: { ofRunId: result.summary.rejudged_from, judgePromptVersion: JUDGE_PROMPT_VERSION },
      generatedAt: '2026-09-18T06:30:00Z',
    });
    // the "cost ×N of extract" line (receipt.mjs timelineCostLine) renders from the fixture's stamps
    expect(md).toContain('Write cost (mycelium-timeline): 4.34 s/session — cost ×0.90 of extract; bound ≤ 2×');
    // the ingestion section renders (all four grid arms carry judged scores)
    expect(md).toContain('## Ingestion controls');
    expect(md).toContain('| Mycelium | ');
    expect(md).toContain('Facts per session (mycelium-extract): 5 facts over 2 sessions');
    // the win condition's cost bound is JUDGED from the run's own stamps —
    // timeline (3600+5080)/2 vs extract 3600/2 = ×2.41 — FAIL (decided, not "NOT JUDGED").
    // The fixture's cells are n=2 (< minN 5 → no cell verdict), so the judged
    // cost FAIL is the verdict's sole reason: the bound decided, by the run.
    expect(md).toContain('Cost bound (timeline write cost ≤ 2× extract): mycelium-timeline 4.34 s/session');
    expect(md).toContain('×2.41 — FAIL');
    expect(md).not.toContain('NOT JUDGED');
    expect(md).toContain('VERDICT: MISS — cost ×2.41 > 2×');
    // no "wrote NO summary.json" note and no invented original score table
    expect(md).not.toContain('wrote NO summary.json');
    expect(md).not.toContain('Original run `run-w` scores');
    // the miss autopsy reads the candidates ledger — q-ku-1 classified, not
    // unclassified-no-ledger
    expect(md).toContain('1 wrong knowledge-update row(s); ledger classified 100%');
    expect(md).toContain('- q-ku-1: superseded-but-unranked');
    expect(md).not.toContain('unclassified-no-ledger | 1');
  });

  it('an old-layout dir (no summary.json at all) still reconstructs — and carries no write_info', async () => {
    // the b478bd4e fallback: rows only, summary.json absent
    const dir = path.join(root, '2026-09-17-p1-224225');
    fs.mkdirSync(dir);
    const regime = {
      date_utc: '2026-09-17T22:42:25Z', git_sha: 'd73978f0', git_dirty: false, harness: 'test',
      dataset: { name: 'fixture', sha256: 'deadbeef' },
      answerer: { model: 'qwen3.8:27b', url_host: '100.95.5.83:11434' },
      judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' },
      retrieval: { budget: 5, namespace: 'bench-p1-2026-09-17-p1-224225' },
      platform: { url_host: '192.168.50.106:3002' },
      n: 1, selection_rule: 'test', notes: [],
    };
    fs.writeFileSync(path.join(dir, 'mycelium-timeline.rows.jsonl'), JSON.stringify({ ...{ question_id: 'q1', question_type: 'knowledge-update', question: 'Which city?', gold: 'Lisbon', answer: 'Lisbon.' }, regime, arm: 'mycelium-timeline' }));
    const result = await rejudgeRun({
      dir, judgeFn,
      judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', url_host: '127.0.0.1:8780' },
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      generatedAtUtc: '2026-09-18T06:30:00Z',
    });
    expect(result.summary.original.summary_missing).toBe(true); // reconstruction, stamped as such
    expect(result.summary.regime.rejudge.original_summary).toMatch(/missing/);
    expect(result.summary.write_info).toBeUndefined(); // nothing to carry — nothing invented
  });
});
