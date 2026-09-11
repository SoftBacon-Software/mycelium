import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reanswerRun, namespacesForArm, REANSWERABLE_ARMS } from '../../bench/memory/reanswer.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';

// Hermetic reanswer: a fake saved-run dir on disk + a fake arm + a fake judge.
// No network, no dataset, no model. The platform is a fake ONLY for the
// rows-present check (the /memory/list contract: refuse when a kept namespace
// was purged).

const POLICY = 'fact-episode-interleave';
const SOURCE_TYPE = 'bench_longmemeval';

function writeRunDir(root, { arm = 'mycelium-timeline', n = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const regime = {
    date_utc: '2026-09-11T00:00:00Z', git_sha: 'abc123', git_dirty: false, harness: 'test',
    dataset: { name: 'fixture', sha256: 'deadbeef' },
    answerer: { model: 'fake-answerer', url_host: 'fake' },
    judge: { model: 'old-judge', url_host: 'old:8780' },
    retrieval: { budget: 5, namespace: 'bench-p1-run-a', source_type: SOURCE_TYPE },
    platform: { url_host: 'fake:3002' },
    mycelium_timeline: {
      ingestion: 'timeline',
      read_policy: 'current-facts-first',
      layers: {
        episodic: { namespace: 'bench-p1-run-a' },
        reconciled: { namespace: 'bench-p1-run-a-timeline' },
      },
    },
    n: 2, selection_rule: 'test', notes: [],
  };
  const arms = {
    [arm]: {
      n,
      write: { docs: 5, rows: 7, extract_ms: 1000, reconcile_ms: 2000 },
      elapsed_ms: 2,
      score: { n, counts: { exact: 1, partial: 0, wrong: n - 1 }, unparsed: 0, p1_score: 1 / n },
    },
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ run_id: 'run-a', n, regime, arms }, null, 2));
  const row = (qid, q, gold) => JSON.stringify({
    question_id: qid, question_type: 'knowledge-update', question: q, gold,
    answer: `OLD ANSWER for ${qid}`, elapsed_ms: 5, meta: { hits: 5 }, regime,
  });
  const questions = Array.from({ length: n }, (_, i) => [`q${i + 1}`, `Where do I live (v${i + 1})?`, 'Lisbon']);
  fs.writeFileSync(path.join(dir, `${arm}.rows.jsonl`), questions.map(([a, b, c]) => row(a, b, c)).join('\n'));
  return dir;
}

// fake platform: both timeline namespaces hold rows unless `kept` is false
function fakePlatform({ kept = true } = {}) {
  const lists = [];
  return {
    lists,
    async listByType(sourceType, { namespace, limit } = {}) {
      lists.push({ sourceType, namespace, limit });
      return { results: kept ? [{ source_id: 'r1' }] : [] };
    },
  };
}

function fakeArm() {
  const calls = [];
  return {
    calls,
    arm: {
      async answer(question) {
        calls.push(question);
        return { text: `NEW ANSWER: Lisbon (to: ${question})`, meta: { hits: 5, read_policy: POLICY, context_episodes: 2 } };
      },
    },
  };
}

describe('reanswerRun — re-answer a saved run against its kept namespaces (hermetic)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reanswer-')); });
  afterEach(() => { root && fs.rmSync(root, { recursive: true, force: true }); });

  function fakeJudge() {
    const calls = [];
    return {
      calls,
      judgeFn: async ({ question, gold, answer }) => {
        calls.push({ question, gold, answer });
        return { label: answer.includes(gold) ? 'exact' : 'wrong', raw: 'RAW', hadThink: false };
      },
    };
  }

  it('re-answers every saved question in order against the run\'s OWN namespace/run id, then judges the new answers', async () => {
    const dir = writeRunDir(root);
    const platform = fakePlatform({ kept: true });
    const { arm, calls } = fakeArm();
    const { judgeFn } = fakeJudge();
    const answers = [];
    const judged = [];
    const result = await reanswerRun({
      dir,
      arms: ['mycelium-timeline'],
      platform,
      sourceType: SOURCE_TYPE,
      makeArm: (ctx) => {
        // the run's regime is the source of the namespace/run id/budget
        expect(ctx).toMatchObject({ runId: 'run-a', namespace: 'bench-p1-run-a', budget: 5, platform });
        return arm;
      },
      judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      readPolicy: POLICY,
      generatedAtUtc: '2026-09-11T12:00:00Z',
      onAnswer: (armName, row) => answers.push([armName, row]),
      onJudged: (r) => judged.push(r),
      log: () => {},
    });

    expect(calls).toEqual(['Where do I live (v1)?', 'Where do I live (v2)?']); // questions from the SAVED rows, in order
    // the rows-present check ran against BOTH layers before anything was answered
    expect(platform.lists.map((l) => l.namespace)).toEqual(['bench-p1-run-a', 'bench-p1-run-a-timeline']);
    expect(answers.map(([a, r]) => [a, r.answer])).toEqual([
      ['mycelium-timeline', 'NEW ANSWER: Lisbon (to: Where do I live (v1)?)'],
      ['mycelium-timeline', 'NEW ANSWER: Lisbon (to: Where do I live (v2)?)'],
    ]);
    expect(answers[0][1]).toMatchObject({ question_id: 'q1', gold: 'Lisbon', question_type: 'knowledge-update' });
    expect(answers[0][1].meta.read_policy).toBe(POLICY); // the NEW policy rode on the answer's meta
    expect(judged.map((r) => `${r.arm}/${r.question_id}:${r.label}`)).toEqual([
      'mycelium-timeline/q1:exact', 'mycelium-timeline/q2:exact',
    ]);
    expect(result.judgedFilePath).toBe(path.join(dir, `judged.reanswer-${POLICY}.jsonl`));
    expect(result.rowsFilePaths['mycelium-timeline']).toBe(path.join(dir, `mycelium-timeline.rows.reanswer-${POLICY}.jsonl`));
    expect(fs.existsSync(result.judgedFilePath)).toBe(false); // run.mjs owns the writing
  });

  it('summary: reanswer run id, per-arm tallies with the ORIGINAL write block, reanswer regime marker', async () => {
    const dir = writeRunDir(root);
    const { arm } = fakeArm();
    const { judgeFn } = fakeJudge();
    const { summary } = await reanswerRun({
      dir, arms: ['mycelium-timeline'], platform: fakePlatform({ kept: true }), sourceType: SOURCE_TYPE,
      makeArm: () => arm, judgeFn,
      judge: { model: 'fake-judge', url_host: 'localhost:8780' },
      judgePromptVersion: 'judge-prompt.2',
      readPolicy: POLICY,
      generatedAtUtc: '2026-09-11T12:00:00Z',
    });
    expect(summary.run_id).toBe(`run-a-reanswer-${POLICY}`);
    expect(summary.reanswered_from).toBe('run-a');
    expect(summary.read_policy).toBe(POLICY);
    expect(summary.judge_prompt_version).toBe('judge-prompt.2');
    expect(summary.arms['mycelium-timeline'].n).toBe(2);
    expect(summary.arms['mycelium-timeline'].score.counts).toEqual({ exact: 2, partial: 0, wrong: 0 });
    // the write phase's own numbers ride along — reanswer does not re-write, so the
    // original write cost is still the write cost of these rows
    expect(summary.arms['mycelium-timeline'].write).toEqual({ docs: 5, rows: 7, extract_ms: 1000, reconcile_ms: 2000 });
    expect(summary.original.arms['mycelium-timeline'].score.counts.exact).toBe(1); // the run's pre-reanswer numbers
    expect(summary.regime.judge).toEqual({ model: 'fake-judge', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' });
    expect(summary.regime.reanswer).toMatchObject({
      of_run_id: 'run-a', answers_modified: true, read_policy: POLICY, write_side_untouched: true,
    });
  });

  it('never writes the originals: rows file and summary.json are byte-identical, and the module creates no files', async () => {
    const dir = writeRunDir(root);
    const before = ['summary.json', 'mycelium-timeline.rows.jsonl']
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
    const { arm } = fakeArm();
    const { judgeFn } = fakeJudge();
    await reanswerRun({
      dir, arms: ['mycelium-timeline'], platform: fakePlatform({ kept: true }), sourceType: SOURCE_TYPE,
      makeArm: () => arm, judgeFn,
      judge: { model: 'j', url_host: 'h' }, readPolicy: POLICY, generatedAtUtc: 'now',
    });
    for (const [f, content] of before) expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(content);
    expect(fs.readdirSync(dir).filter((f) => f.includes('reanswer'))).toEqual([]); // run.mjs owns the output files
  });

  it('refuses when a kept namespace was purged — names the namespace and the --keep contract, answers nothing', async () => {
    const dir = writeRunDir(root);
    const { arm, calls } = fakeArm();
    const { judgeFn } = fakeJudge();
    await expect(reanswerRun({
      dir, arms: ['mycelium-timeline'], platform: fakePlatform({ kept: false }), sourceType: SOURCE_TYPE,
      makeArm: () => arm, judgeFn,
      judge: { model: 'j', url_host: 'h' }, readPolicy: POLICY, generatedAtUtc: 'now',
    })).rejects.toThrow(/namespace bench-p1-run-a .*--keep/s);
    expect(calls).toEqual([]); // the check runs BEFORE any answer call
  });

  it('refuses when a reanswer output already exists — evidence is not silently overwritten', async () => {
    const dir = writeRunDir(root);
    fs.writeFileSync(path.join(dir, `judged.reanswer-${POLICY}.jsonl`), '');
    const { arm } = fakeArm();
    await expect(reanswerRun({
      dir, arms: ['mycelium-timeline'], platform: fakePlatform({ kept: true }), sourceType: SOURCE_TYPE,
      makeArm: () => arm, judgeFn: async () => ({ label: 'exact', raw: '', hadThink: false }),
      judge: { model: 'j', url_host: 'h' }, readPolicy: POLICY, generatedAtUtc: 'now',
    })).rejects.toThrow(/already exists/);
  });

  it('refuses a run whose saved rows are missing or disagree with the summary (the saved questions are the evidence)', async () => {
    const dir = writeRunDir(root);
    fs.unlinkSync(path.join(dir, 'mycelium-timeline.rows.jsonl'));
    const { arm } = fakeArm();
    await expect(reanswerRun({
      dir, arms: ['mycelium-timeline'], platform: fakePlatform({ kept: true }), sourceType: SOURCE_TYPE,
      makeArm: () => arm, judgeFn: async () => ({ label: 'exact', raw: '', hadThink: false }),
      judge: { model: 'j', url_host: 'h' }, readPolicy: POLICY, generatedAtUtc: 'now',
    })).rejects.toThrow(/missing .*mycelium-timeline\.rows\.jsonl/);

    const dir2 = writeRunDir(root, { n: 1 });
    fs.appendFileSync(path.join(dir2, 'mycelium-timeline.rows.jsonl'), '\n' + JSON.stringify({ question_id: 'qX', question: 'x', gold: 'y' }));
    await expect(reanswerRun({
      dir: dir2, arms: ['mycelium-timeline'], platform: fakePlatform({ kept: true }), sourceType: SOURCE_TYPE,
      makeArm: () => fakeArm().arm, judgeFn: async () => ({ label: 'exact', raw: '', hadThink: false }),
      judge: { model: 'j', url_host: 'h' }, readPolicy: POLICY, generatedAtUtc: 'now',
    })).rejects.toThrow(/2 rows but summary\.json says n=1/);
  });

  it('refuses arms it cannot re-answer (their sidecar stores died with the run) and arms the run never had', async () => {
    const dir = writeRunDir(root);
    const { arm } = fakeArm();
    for (const bad of ['zep', 'mem0', 'arm-that-never-was']) {
      await expect(reanswerRun({
        dir, arms: [bad], platform: fakePlatform({ kept: true }), sourceType: SOURCE_TYPE,
        makeArm: () => arm, judgeFn: async () => ({ label: 'exact', raw: '', hadThink: false }),
        judge: { model: 'j', url_host: 'h' }, readPolicy: POLICY, generatedAtUtc: 'now',
      })).rejects.toThrow(new RegExp(`reanswer:.*${bad}`));
    }
    expect(REANSWERABLE_ARMS).toEqual(['none', 'mycelium', 'mycelium-extract', 'mycelium-timeline']);
  });
});

describe('namespacesForArm — the run\'s regime is the source of what to check', () => {
  const regime = {
    retrieval: { namespace: 'bench-p1-run-a' },
    mycelium_extract: { namespace: 'bench-p1-run-a-extract' },
    mycelium_timeline: { layers: { episodic: { namespace: 'bench-p1-run-a' }, reconciled: { namespace: 'bench-p1-run-a-timeline' } } },
  };
  it('maps each re-answerable arm to the namespaces its rows live in', () => {
    expect(namespacesForArm('none', regime)).toEqual([]);
    expect(namespacesForArm('mycelium', regime)).toEqual(['bench-p1-run-a']);
    expect(namespacesForArm('mycelium-extract', regime)).toEqual(['bench-p1-run-a', 'bench-p1-run-a-extract']);
    expect(namespacesForArm('mycelium-timeline', regime)).toEqual(['bench-p1-run-a', 'bench-p1-run-a-timeline']);
  });
  it('a regime without the arm\'s block still yields the base namespace (the episodic layer is always there)', () => {
    expect(namespacesForArm('mycelium-timeline', { retrieval: { namespace: 'ns' } })).toEqual(['ns']);
  });
});

describe('reanswer receipt rendering', () => {
  const summary = {
    run_id: `run-a-reanswer-${POLICY}`,
    reanswered_from: 'run-a',
    read_policy: POLICY,
    judge_prompt_version: 'judge-prompt.2',
    regime: {
      date_utc: '2026-09-11T00:00:00Z', git_sha: 'abc123', git_dirty: false, harness: 'test',
      dataset: { sha256: 'deadbeef' }, answerer: {}, judge: { model: 'fake-judge', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' },
      retrieval: {}, platform: {}, n: 2, selection_rule: 'test', notes: [],
      reanswer: { of_run_id: 'run-a', date_utc: '2026-09-11T12:00:00Z', answers_modified: true, read_policy: POLICY, write_side_untouched: true },
    },
    arms: {
      'mycelium-timeline': { n: 2, score: { n: 2, counts: { exact: 2, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } },
    },
    original: {
      run_id: 'run-a',
      judge: { model: 'old-judge', url_host: 'old:8780' },
      arms: {
        'mycelium-timeline': { n: 2, score: { n: 2, counts: { exact: 0, partial: 1, wrong: 1 }, unparsed: 0, p1_score: 0.25 } },
      },
    },
  };

  it('names the source run + read policy, renders BOTH score tables, and points at the reanswer artifacts', () => {
    const md = renderReceipt({
      runId: `run-a-reanswer-${POLICY}`,
      summary,
      reanswer: { ofRunId: 'run-a', readPolicy: POLICY },
      generatedAt: '2026-09-11T12:00:00Z',
    });
    expect(md).toContain(`Re-answer of run \`run-a\` under read policy \`${POLICY}\``);
    expect(md).toContain('The write side is the original run\'s own (no write-side calls) — the answers AND the judge');
    expect(md).toContain('| mycelium-timeline | 2 | 2 | 0 | 0 | 1.000 |'); // new table
    expect(md).toContain('Original run `run-a` scores (pre-reanswer');
    expect(md).toContain('| mycelium-timeline | 2 | 0 | 1 | 1 | 0.250 |'); // original table
    expect(md).toContain(`judged.reanswer-${POLICY}.jsonl`);
    expect(md).toContain(`summary.reanswer-${POLICY}.json`);
    expect(md).toContain('"read_policy": "fact-episode-interleave"'); // regime block records it
    expect(md).toContain('"of_run_id": "run-a"');
  });

  it('a plain (fresh-run) receipt has no reanswer block', () => {
    const md = renderReceipt({
      runId: 'run-a',
      summary: { run_id: 'run-a', regime: summary.regime, arms: summary.arms },
      generatedAt: '2026-09-11T12:00:00Z',
    });
    expect(md).not.toMatch(/Re-answer of run/);
    expect(md).not.toMatch(/pre-reanswer/);
  });
});
