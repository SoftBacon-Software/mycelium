import { describe, it, expect } from 'vitest';
import { runBench, summarizeFromResults } from '../../bench/memory/core.mjs';
import { buildRegime, requireCompleteRegime, REGIME_FIELDS } from '../../bench/memory/regime.mjs';
import { renderReceipt } from '../../bench/memory/receipt.mjs';

function makeRegime(over = {}) {
  return buildRegime({
    dateUtc: '2026-09-08T00:00:00Z',
    git: { git_sha: 'abc123', git_dirty: false },
    harnessVersion: 'test',
    dataset: { name: 'fixture', file: 'fixture.json', sha256: 'deadbeef', licence: 'MIT', url: null, count: 3 },
    answerer: { model: 'fake-answerer', url_host: 'fake', temperature: 0, max_tokens: 256 },
    judge: { model: 'fake-judge', url_host: 'fake' },
    retrieval: { budget: 5, chunking: 'per-session', source_type: 'bench_longmemeval', namespace: 'bench-p1-test' },
    platform: { url_host: 'fake:3002', version: '0.1.0', embedding_provider: 'fake', embedding_model: 'fake', chunk_size: 4000 },
    n: 3,
    notes: [],
    ...over,
  });
}

const ITEMS = [
  { question_id: 'q-1', question_type: 'multi-session', question: 'Which city?', answer: 'Lisbon', haystack_sessions: [[[{ role: 'user', content: 'Lisbon' }]]] },
  { question_id: 'q-2', question_type: 'multi-session', question: 'Manager?', answer: 'Dana', haystack_sessions: [[[{ role: 'user', content: 'Dana' }]]] },
];

describe('runBench with a fake arm + fake judge (hermetic end-to-end)', () => {
  async function run({ judge = true, arms = ['none', 'fake'] } = {}) {
    const writes = [];
    const armRows = [];
    const judgedRows = [];
    const fakeFactory = (name) => (_ctx) => ({
      name,
      async write(sessionTurns, { questionId }) {
        writes.push({ name, questionId, sessions: sessionTurns.length });
        return { docs: sessionTurns.length, rows: sessionTurns.length };
      },
      async answer(_question) {
        return {
          text: name === 'none' ? 'I do not know.' : 'Lisbon.',
          meta: name === 'fake' ? { hits: 1, retrieval_mode: 'hybrid' } : {},
        };
      },
    });
    const result = await runBench({
      items: ITEMS,
      runId: 'test-run',
      regime: makeRegime(),
      armFactories: arms.map((name) => ({ name, factory: fakeFactory(name) })),
      armContext: {},
      judgeFn: judge
        ? ({ gold, answer }) => ({ label: answer.includes(gold) ? 'exact' : 'wrong', raw: 'RAW' })
        : undefined,
      afterWrite: async ({ arm, writeInfo }) => writes.push({ name: `afterWrite:${arm}`, writeInfo }),
      onRow: (r) => armRows.push(r),
      onJudged: (r) => judgedRows.push(r),
    });
    return { result, writes, armRows, judgedRows };
  }

  it('every row carries the full regime stamp', async () => {
    const { result, armRows } = await run();
    expect(armRows.length).toBe(4); // 2 items x 2 arms
    for (const row of armRows) {
      for (const f of REGIME_FIELDS) expect(row.regime).toHaveProperty(f);
      expect(row.regime.git_sha).toBe('abc123');
    }
    expect(result.summary.regime.dataset.sha256).toBe('deadbeef');
  });

  it('arms run write->afterWrite->answer in order, per arm', async () => {
    const { writes } = await run();
    // both fake arms push one write entry per item; afterWrite fires once per arm, after its writes
    expect(writes.filter((w) => w.name.startsWith('afterWrite')).map((w) => w.name)).toEqual([
      'afterWrite:none',
      'afterWrite:fake',
    ]);
    expect(writes.filter((w) => w.name === 'fake')).toEqual([
      { name: 'fake', questionId: 'q-1', sessions: 1 },
      { name: 'fake', questionId: 'q-2', sessions: 1 },
    ]);
    const fakeAfter = writes.find((w) => w.name === 'afterWrite:fake');
    expect(fakeAfter.writeInfo).toEqual({ docs: 2, rows: 2, skipped: false });
  });

  it('judges every row and tallies per arm', async () => {
    const { result, judgedRows } = await run();
    expect(judgedRows).toHaveLength(4);
    expect(result.summary.arms.fake.score.counts.exact).toBe(1); // fake answers 'Lisbon.': matches q-1 gold only
    expect(result.summary.arms.fake.score.counts.wrong).toBe(1); // q-2 gold Dana != Lisbon
    expect(result.summary.arms.none.score.counts.wrong).toBe(2);
    expect(result.summary.arms.fake.score.n).toBe(2);
  });

  it('records per-query retrieval mode distribution for the memory arm', async () => {
    const { result } = await run();
    expect(result.summary.arms.fake.retrieval_modes).toEqual({ hybrid: 2 });
    expect(result.summary.arms.none.retrieval_modes).toBeUndefined();
  });

  it('skips judging cleanly when no judgeFn is given', async () => {
    const { result } = await run({ judge: false });
    expect(result.judged).toBeNull();
    expect(result.summary.arms.fake.score.unparsed).toBe(2); // no labels -> counted wrong, flagged
  });

  it('refuses to run without a regime stamp', async () => {
    await expect(
      runBench({ items: ITEMS, armFactories: [{ name: 'fake', factory: () => ({ name: 'fake', answer: async () => 'x' }) }], armContext: {}, regime: null })
    ).rejects.toThrow(/regime/);
  });

  it('refuses an arm whose factory reports a different name', async () => {
    await expect(
      runBench({
        items: ITEMS,
        armFactories: [{ name: 'expected', factory: () => ({ name: 'other', answer: async () => 'x' }) }],
        armContext: {},
        regime: makeRegime(),
      })
    ).rejects.toThrow(/expected 'expected'/);
  });
});

describe('regime stamp completeness', () => {
  it('buildRegime emits every required field', () => {
    const regime = makeRegime();
    expect(() => requireCompleteRegime(regime)).not.toThrow();
    for (const f of REGIME_FIELDS) expect(regime[f]).toBeDefined();
  });

  it('requireCompleteRegime throws when a field is missing', () => {
    const regime = makeRegime();
    delete regime.judge;
    expect(() => requireCompleteRegime(regime)).toThrow(/missing judge/);
  });
});

describe('summarizeFromResults — receipt rebuildable from the run output alone', () => {
  it('rebuilds identical tallies from rows + judged', async () => {
    const r = await run(); // r IS the runBench result here: {summary, rows, judged}
    const rebuilt = summarizeFromResults({
      runId: 'test-run',
      regime: r.summary.regime,
      rows: r.rows,
      judged: r.judged,
    });
    expect(rebuilt.arms.fake.score).toEqual(r.summary.arms.fake.score);
    expect(rebuilt.arms.none.score).toEqual(r.summary.arms.none.score);
    expect(rebuilt.n).toBe(2);
  });
  // helper re-declared for this block
  async function run() {
    return run2();
  }
  async function run2() {
    const fakeFactory = (name) => () => ({
      name,
      async write() {},
      async answer(_question) {
        return { text: name === 'fake' ? 'Lisbon.' : 'I do not know.', meta: name === 'fake' ? { retrieval_mode: 'hybrid' } : {} };
      },
    });
    return runBench({
      items: ITEMS,
      runId: 'test-run',
      regime: makeRegime(),
      armFactories: ['none', 'fake'].map((name) => ({ name, factory: fakeFactory(name) })),
      armContext: {},
      judgeFn: ({ gold, answer }) => ({ label: answer.includes(gold) ? 'exact' : 'wrong', raw: 'RAW' }),
    });
  }
});

describe('receipt rendering — numbers only from the run output', () => {
  it('renders arm rows from the summary and marks a receipt provisional without judge agreement', () => {
    const summary = {
      run_id: 'r1',
      regime: makeRegime(),
      arms: {
        none: { n: 2, score: { n: 2, counts: { exact: 0, partial: 1, wrong: 1 }, unparsed: 0, p1_score: 0.25 } },
        mycelium: { n: 2, score: { n: 2, counts: { exact: 2, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 }, retrieval_modes: { hybrid: 2 } },
      },
    };
    const md = renderReceipt({ runId: 'r1', summary, generatedAt: '2026-09-08T00:00:00Z' });
    expect(md).toContain('| none | 2 | 0 | 1 | 1 | 0.250 |');
    expect(md).toContain('| mycelium | 2 | 2 | 0 | 0 | 1.000 |');
    expect(md).toContain('NOT RECORDED'); // provisional without hand labels
    expect(md).toContain('"sha256": "deadbeef"'); // regime block present
    expect(md).toMatch(/"budget": 5/);
  });

  it('includes the judge-agreement number and disagreements when provided', () => {
    const summary = {
      run_id: 'r1',
      regime: makeRegime(),
      arms: { none: { n: 1, score: { n: 1, counts: { exact: 1, partial: 0, wrong: 0 }, unparsed: 0, p1_score: 1 } } },
    };
    const md = renderReceipt({
      runId: 'r1',
      summary,
      agreement: { n: 20, agree: 18, rate: 0.9, disagree: [{ question_id: 'q', arm: 'none', hand: 'exact', judge: 'partial' }] },
      handlabels: { hand_scorer: 'tester', path: 'hl.json', n: 20 },
      generatedAt: 'now',
    });
    expect(md).toContain('18/20 = 90.0%');
    expect(md).toContain('hand=exact judge=partial');
    expect(md).not.toContain('NOT RECORDED');
  });
});
