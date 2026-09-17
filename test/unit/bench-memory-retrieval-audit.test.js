// task 207 — the shared retrieval-provenance seam + gold mapping + audit
// (bench/memory/retrieval_stamp.mjs, grid.mjs's --retrieval-audit section).
// Hermetic: inline fixtures only; the composeGrid integration test injects the
// corpus through loadSplitFn so the 277 MB dataset is never touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildGoldIndex,
  classifyRow,
  computeRetrievalAudit,
  decideDiagnostic,
  mapGoldSessions,
  median,
  recordHits,
  stampBudget,
} from '../../bench/memory/retrieval_stamp.mjs';
import {
  buildTranscriptGroups,
  composeGrid,
  loadAuditItems,
  poolDiagnostic,
  renderRetrievalAuditSection,
} from '../../bench/memory/grid.mjs';
import { createArmNone } from '../../bench/memory/arms/arm_none.mjs';
import { createArmMycelium } from '../../bench/memory/arms/arm_mycelium.mjs';
import { createArmMem0 } from '../../bench/memory/arms/arm_mem0.mjs';
import { sessionIndexFromTags } from '../../bench/memory/arms/arm_letta.mjs';
import { selectItems } from '../../bench/memory/split.mjs';

// ---- fixtures -----------------------------------------------------------------

const GOLD_ITEMS = [
  {
    question_id: 'q-adv',
    question_type: 'single-session-preference',
    answer: 'Aisle five',
    answer_session_ids: ['sess-b'],
    haystack_session_ids: ['sess-a', 'sess-b', 'sess-c'],
    haystack_sessions: [
      [{ role: 'user', content: 'hello there' }],
      [{ role: 'user', content: 'I keep my cereal in Aisle five.' }],
      [{ role: 'user', content: 'unrelated' }],
    ],
  },
  {
    question_id: 'q-multi',
    question_type: 'multi-session',
    answer: 'Lisbon',
    answer_session_ids: ['sess-a', 'sess-c'],
    haystack_session_ids: ['sess-a', 'sess-b', 'sess-c'],
    haystack_sessions: [
      [{ role: 'user', content: 'I moved to Lisbon in spring.' }],
      [{ role: 'user', content: 'My manager is Dana.' }],
      [{ role: 'user', content: 'Lisbon is where my sister lives.' }],
    ],
  },
];

// ---- the stamp: recordHits -------------------------------------------------------

describe('recordHits — the shared read-time seam (task 207)', () => {
  it('a cooperative arm: ordered entries, rank 0-based, capped at the budget, budget stamped', () => {
    const meta = {};
    const out = recordHits(
      meta,
      [
        { source_id: 'run-q1-s2', score: 0.9, session_index: 2 },
        { source_id: 'run-q1-s0', score: 0.4, session_index: 0 },
        { source_id: 'run-q1-s1', score: 0.1, session_index: 1 },
      ],
      5
    );
    expect(out.budget).toBe(5);
    expect(out.read_hits_available).toBe(true);
    expect(out.read_hits).toHaveLength(3);
    expect(out.read_hits.map((h) => h.rank)).toEqual([0, 1, 2]);
    expect(out.read_hits[0]).toEqual({ source_id: 'run-q1-s2', score: 0.9, session_index: 2, rank: 0 });
  });

  it('caps at the stamped budget — what the model never read is not stamped as read', () => {
    const meta = recordHits(
      {},
      Array.from({ length: 7 }, (_, i) => ({ source_id: `h${i}`, score: i, session_index: i })),
      5
    );
    expect(meta.read_hits).toHaveLength(5);
    expect(meta.read_hits.at(-1).source_id).toBe('h4');
  });

  it('arm extras survive (the timeline shape is the seam’s superset), scores normalize to null', () => {
    const meta = recordHits({}, [{ source_id: 'x', score: undefined, session_index: null, layer: 'fact', rendered_date: '2024-01-01' }], 5);
    expect(meta.read_hits[0].layer).toBe('fact');
    expect(meta.read_hits[0].rendered_date).toBe('2024-01-01');
    expect(meta.read_hits[0].score).toBeNull();
    expect(meta.read_hits[0].session_index).toBeNull();
  });

  it('a no-op arm: null → read_hits null + read_hits_available FALSE, never a fake empty array', () => {
    const meta = recordHits({}, null, 5);
    expect(meta.read_hits).toBeNull();
    expect(meta.read_hits_available).toBe(false);
    expect(meta.budget).toBe(5);
  });

  it('a true zero-hit search stamps [] (available), not null', () => {
    const meta = recordHits({}, [], 5);
    expect(meta.read_hits).toEqual([]);
    expect(meta.read_hits_available).toBe(true);
  });

  it('stampBudget alone stamps null for an unstamped budget rather than a guess', () => {
    expect(stampBudget({}, undefined).budget).toBeNull();
  });
});

// ---- the stamp through the real arms ----------------------------------------------

describe('the arms stamp read_hits at read time', () => {
  it('arm_none: no retrieval surface — null + available false + budget', async () => {
    const arm = createArmNone({ answerChat: async () => ({ text: 'I do not know.', hadThink: false }), retrievalBudget: 5 });
    const { meta } = await arm.answer('q?');
    expect(meta.read_hits).toBeNull();
    expect(meta.read_hits_available).toBe(false);
    expect(meta.budget).toBe(5);
  });

  it('arm_mycelium: search results → {source_id, score, session_index} ordered stamps', async () => {
    const platform = {
      search: async () => ({
        mode: 'hybrid',
        results: [
          { source_id: 'r-q-s2', content_text: 'gold text', score: 0.88, metadata: { session_index: 2 } },
          { source_id: 'r-q-s0', content_text: 'other', score: 0.31, metadata: { session_index: 0 } },
        ],
      }),
    };
    const arm = createArmMycelium({ answerChat: async () => ({ text: 'ans' }), platform, namespace: 'ns', retrievalBudget: 5, runId: 'r' });
    const { meta } = await arm.answer('q?');
    expect(meta.hits).toBe(2);
    expect(meta.budget).toBe(5);
    expect(meta.read_hits).toEqual([
      { source_id: 'r-q-s2', score: 0.88, session_index: 2, rank: 0 },
      { source_id: 'r-q-s0', score: 0.31, session_index: 0, rank: 1 },
    ]);
  });

  it('arm_mem0: the sidecar’s metadata.session_index rides the stamp; zep-style null scores stay null', async () => {
    const sidecar = {
      calls: { add: [] },
      async request(pathname) {
        if (pathname !== '/search') throw new Error(`no route ${pathname}`);
        return {
          ok: true,
          count: 1,
          results: [{ id: 'mem-9', memory: 'fact', score: 0.7, metadata: { session_index: 3 } }],
        };
      },
      async stop() {},
    };
    const arm = createArmMem0({ answerChat: async () => ({ text: 'ans' }), runId: 'r', retrievalBudget: 5, sidecar });
    const { meta } = await arm.answer('q?');
    expect(meta.read_hits).toEqual([{ source_id: 'mem-9', score: 0.7, session_index: 3, rank: 0 }]);
  });

  it('sessionIndexFromTags parses letta’s insert-time tags; malformed/absent → null', () => {
    expect(sessionIndexFromTags(['u', 'bench:longmemeval', 'question_id:q1', 'session_index:12'])).toBe(12);
    expect(sessionIndexFromTags(['u'])).toBeNull();
    expect(sessionIndexFromTags('not-an-array')).toBeNull();
    expect(sessionIndexFromTags(['session_index:x'])).toBeNull();
  });
});

// ---- gold mapping -----------------------------------------------------------------

describe('mapGoldSessions / buildGoldIndex — the dataset’s answer-session mapping', () => {
  it('primary method: answer_session_ids join haystack_session_ids (the real LongMemEval-S carries them, 500/500)', () => {
    const m = mapGoldSessions(GOLD_ITEMS[0]);
    expect(m).toEqual({ mapped: true, method: 'answer_session_ids', indices: [1] });
    const multi = mapGoldSessions(GOLD_ITEMS[1]);
    expect(multi).toEqual({ mapped: true, method: 'answer_session_ids', indices: [0, 2] });
  });

  it('fallback method: answer-text match into haystack_sessions — UNIQUE matches only', () => {
    const withoutIds = {
      question_id: 'q',
      answer: 'Aisle five',
      haystack_sessions: [[{ role: 'user', content: 'I keep my cereal in Aisle five.' }], [{ role: 'user', content: 'nothing here' }]],
    };
    expect(mapGoldSessions(withoutIds)).toEqual({ mapped: true, method: 'answer_text_match', indices: [0] });
    // the SAME row, mapped both ways by the two methods, names its method
    expect(mapGoldSessions(GOLD_ITEMS[0]).indices).toEqual([1]);
  });

  it('ambiguous or absent answers stay unmapped, with the reason named', () => {
    const ambiguous = {
      question_id: 'q',
      answer: 'lisbon',
      haystack_sessions: [[{ role: 'user', content: 'Lisbon is hilly.' }], [{ role: 'user', content: 'I love LISBON.' }]],
    };
    expect(mapGoldSessions(ambiguous).mapped).toBe(false);
    expect(mapGoldSessions(ambiguous).reason).toMatch(/ambiguous/);
    expect(mapGoldSessions({ question_id: 'q', answer: 'zzz', haystack_sessions: [[{ role: 'user', content: 'a' }]] }).mapped).toBe(false);
  });

  it('an answer_session_id that fails to join is unmapped — a partial mapping would poison rank stats', () => {
    const m = mapGoldSessions({
      question_id: 'q',
      answer: 'a',
      answer_session_ids: ['sess-a', 'sess-missing'],
      haystack_session_ids: ['sess-a'],
      haystack_sessions: [[{ role: 'user', content: 'a' }]],
    });
    expect(m.mapped).toBe(false);
    expect(m.reason).toMatch(/did not all join/);
  });

  it('buildGoldIndex reports method counts + coverage', () => {
    const { coverage, byQuestion } = buildGoldIndex([...GOLD_ITEMS, { question_id: 'q-bad', answer: 'zzz', haystack_sessions: [[]] }]);
    expect(coverage.total).toBe(3);
    expect(coverage.mapped).toBe(2);
    expect(coverage.unmapped).toBe(1);
    expect(coverage.methods).toEqual({ answer_session_ids: 2, answer_text_match: 1 });
    expect(byQuestion.get('q-bad').mapped).toBe(false);
  });

  it('loadAuditItems resolves the split by regime.dataset.name (SPLITS registry, injected loader) and re-selects', async () => {
    const summary = { n: 2, regime: { dataset: { name: 'bench-memory hermetic fixture' } } };
    const corpus = GOLD_ITEMS.concat([{ question_id: 'q-extra', answer: 'x', haystack_sessions: [[]] }]);
    const items = await loadAuditItems(summary, { loadSplitFn: async () => ({ items: corpus }) });
    expect(items).toHaveLength(2);
    expect(items).toEqual(selectItems(corpus, 2)); // the same deterministic selection the runner used
  });

  it('loadAuditItems refuses a dataset name no split claims — the audit never guesses the corpus', async () => {
    await expect(
      loadAuditItems({ n: 1, regime: { dataset: { name: 'mystery corpus' } } }, { loadSplitFn: async () => ({ items: [] }) })
    ).rejects.toThrow(/no split matches/);
  });
});

// ---- per-row classification ---------------------------------------------------------

describe('classifyRow — the four stamp states + the rank', () => {
  const mapping = { mapped: true, method: 'answer_session_ids', indices: [2] };

  it('banked rows (no read_hits key) are unstamped, never ranked', () => {
    const c = classifyRow({ readHits: undefined, mapping, writeCap: null });
    expect(c.stamp).toBe('unstamped');
    expect(c.gold_rank).toBeNull();
  });

  it('null + available false = no-retrieval; null otherwise = retrieval error', () => {
    expect(classifyRow({ readHits: null, readHitsAvailable: false, mapping, writeCap: null }).stamp).toBe('null_no_retrieval');
    expect(classifyRow({ readHits: null, readHitsAvailable: true, mapping, writeCap: null }).stamp).toBe('null_error');
  });

  it('gold rank = the BEST (1-based) rank among gold-session hits', () => {
    const c = classifyRow({
      readHits: [
        { source_id: 'a', rank: 0, session_index: 9 },
        { source_id: 'b', rank: 1, session_index: 2 },
        { source_id: 'c', rank: 2, session_index: 3 },
      ],
      mapping,
      writeCap: null,
    });
    expect(c.hit).toBe(true);
    expect(c.gold_rank).toBe(2); // rank 1 → 1-based 2
  });

  it('gold beyond the write cap is counted, never charged to retrieval', () => {
    const c = classifyRow({ readHits: [{ source_id: 'a', rank: 0, session_index: 0 }], mapping, writeCap: 2 });
    expect(c.gold_written).toBe(false);
    expect(c.gold_rank).toBeNull();
  });

  it('hits without session_index are no-provenance rows (excluded from ranks, counted)', () => {
    const c = classifyRow({ readHits: [{ source_id: 'zep-edge', rank: 0, session_index: null }], mapping, writeCap: null });
    expect(c.session_provenance).toBe(false);
    expect(c.gold_rank).toBeNull();
  });
});

// ---- the audit ---------------------------------------------------------------------

describe('computeRetrievalAudit — hit@budget, median gold rank, MRR per type × arm', () => {
  const goldIndex = buildGoldIndex(GOLD_ITEMS);
  const rows = {
    mycelium: [
      { question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: [{ source_id: 'a', rank: 0, session_index: 1 }] } },
      {
        question_id: 'q-multi',
        question_type: 'multi-session',
        meta: {
          read_hits: [
            { source_id: 'b', rank: 0, session_index: 4 },
            { source_id: 'c', rank: 1, session_index: 2 },
          ],
        },
      },
    ],
    none: [
      { question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: null, read_hits_available: false } },
      { question_id: 'q-multi', question_type: 'multi-session', meta: {} }, // banked-shape row
    ],
  };
  // a second run whose multi-session row is provenance-carrying but MISSES the
  // gold — the miss-in-the-rank-stats path (MRR charges 0, median skips it)
  const runs = [
    { runId: 'r1', summary: {}, rowsByArm: rows },
    { runId: 'r2', summary: {}, rowsByArm: { mycelium: [{ question_id: 'q-multi', question_type: 'multi-session', meta: { read_hits: [{ source_id: 'd', rank: 0, session_index: 9 }] } }] } },
  ];
  const audit = computeRetrievalAudit({ runs, goldIndex, budget: 5, writeCap: null });

  it('the preference cell: hit@1.0, median rank 1, MRR 1.0', () => {
    const cell = audit.cells.mycelium['single-session-preference'];
    expect(cell.ranked).toBe(1);
    expect(cell.hit).toBe(1);
    expect(cell.hit_at_budget).toBe(1);
    expect(cell.median_gold_rank).toBe(1);
    expect(cell.mrr).toBe(1);
  });

  it('the multi-session cell: gold at rank 2, one miss → hit 0.5, median 2, MRR 0.25', () => {
    const cell = audit.cells.mycelium['multi-session'];
    expect(cell.ranked).toBe(2);
    expect(cell.hit).toBe(1);
    expect(cell.hit_at_budget).toBe(0.5);
    expect(cell.median_gold_rank).toBe(2);
    expect(cell.mrr).toBe(0.25); // (1/2 + 0) / 2
  });

  it('the none arm: no-retrieval rows are counted, never ranked; banked rows counted as banked', () => {
    const pref = audit.cells.none['single-session-preference'];
    expect(pref.null_no_retrieval).toBe(1);
    expect(pref.ranked).toBe(0);
    const multi = audit.cells.none['multi-session'];
    expect(multi.unstamped_banked).toBe(1);
    expect(multi.ranked).toBe(0);
    expect(multi.mrr).toBeNull();
  });

  it('median is the middle of the rank list (even → mean of the middles)', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

// ---- the pre-committed rule ---------------------------------------------------------

describe('decideDiagnostic / poolDiagnostic — mechanical, no judgement', () => {
  const BUDGET = 5;

  it('branch A: median gold rank > budget → replay at budget 10, NON-COMPARABLE', () => {
    const d = decideDiagnostic({ ranked: 7, hit: 4, median_gold_rank: 9, unstamped_banked: 0, stamped: 7 }, BUDGET);
    expect(d.branch).toBe('budget-10-replay');
    expect(d.reason).toMatch(/OUTSIDE the read/);
  });

  it('branch B: gold already within top-budget → answer-side transcripts', () => {
    const d = decideDiagnostic({ ranked: 7, hit: 4, median_gold_rank: 2, unstamped_banked: 0, stamped: 7 }, BUDGET);
    expect(d.branch).toBe('answer-side-transcripts');
    expect(d.reason).toMatch(/answer-side/);
  });

  it('no ranked rows yet → the rule refuses to fire (insufficient stamps)', () => {
    const d = decideDiagnostic({ ranked: 0, hit: 0, median_gold_rank: null, unstamped_banked: 7, stamped: 0 }, BUDGET);
    expect(d.branch).toBe('insufficient-stamps');
    expect(d.reason).toMatch(/first stamped run/);
  });

  it('pooling: ANY arm’s replay branch fires the replay; else any answer-side verdict carries it', () => {
    const replay = { 'single-session-preference': { ranked: 3, median_gold_rank: 7 } };
    const answerSide = { 'single-session-preference': { ranked: 3, median_gold_rank: 2 } };
    const insufficient = { 'single-session-preference': { ranked: 0, median_gold_rank: null, stamped: 0, unstamped_banked: 3 } };
    expect(poolDiagnostic({ cells: { a: replay, b: answerSide } }, BUDGET).branch).toBe('budget-10-replay');
    expect(poolDiagnostic({ cells: { a: answerSide, b: insufficient } }, BUDGET).branch).toBe('answer-side-transcripts');
    expect(poolDiagnostic({ cells: { a: insufficient } }, BUDGET).branch).toBe('insufficient-stamps');
  });
});

// ---- the receipt section -------------------------------------------------------------

describe('renderRetrievalAuditSection — the receipt block', () => {
  // an unmapped item in the corpus so the coverage line has something to count
  const goldIndex = buildGoldIndex([...GOLD_ITEMS, { question_id: 'q-bad', answer: 'zzz', haystack_sessions: [[]] }]);
  const audit = computeRetrievalAudit({
    runs: [
      {
        runId: 'r1',
        summary: {},
        rowsByArm: {
          mycelium: [{ question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: [{ source_id: 'a', rank: 0, session_index: 1 }] } }],
        },
      },
    ],
    goldIndex,
    budget: 5,
    writeCap: null,
  });

  it('renders the gold-mapping method + coverage (required in the receipt)', () => {
    const lines = renderRetrievalAuditSection({
      audit,
      goldCoverage: goldIndex.coverage,
      writeCapValue: null,
      diagnostic: poolDiagnostic(audit, 5),
      budget: 5,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/answer_session_ids/);
    expect(text).toMatch(/2\/3 questions mapped/);
    expect(text).toMatch(/unmapped 1/);
    expect(text).toMatch(/never assigned ranks/);
  });

  it('branch A prints the budget-10 replay command + the NON-COMPARABLE stamp', () => {
    const budget = { ...audit };
    const lines = renderRetrievalAuditSection({
      audit: budget,
      goldCoverage: goldIndex.coverage,
      writeCapValue: null,
      diagnostic: { branch: 'budget-10-replay', perArm: [{ arm: 'mycelium', decision: decideDiagnostic({ ranked: 1, median_gold_rank: 9 }, 5) }] },
      budget: 5,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/budget-10-replay/);
    expect(text).toMatch(/--question-type single-session-preference --budget 10/);
    expect(text).toMatch(/NON-COMPARABLE/);
  });

  it('branch B renders the transcripts for hand labels', () => {
    const lines = renderRetrievalAuditSection({
      audit,
      goldCoverage: goldIndex.coverage,
      writeCapValue: null,
      diagnostic: { branch: 'answer-side-transcripts', perArm: [{ arm: 'mycelium', decision: decideDiagnostic({ ranked: 1, median_gold_rank: 1 }, 5) }] },
      budget: 5,
      transcripts: [
        {
          question_id: 'q-adv',
          question_type: 'single-session-preference',
          question: 'Where is the cereal?',
          gold: 'Aisle five',
          perArm: [{ arm: 'mycelium', label: 'exact', answer: 'Aisle five.', gold_rank: 1 }],
        },
      ],
    });
    const text = lines.join('\n');
    expect(text).toMatch(/Transcripts for hand labels/);
    expect(text).toMatch(/\*\*Gold:\*\* Aisle five/);
    expect(text).toMatch(/\| mycelium \| exact \| 1 \|/);
  });

  it('buildTranscriptGroups: all preference questions + the worst-12 multi-session rows', () => {
    const rows = [];
    for (let i = 0; i < 15; i++) {
      rows.push({
        question_id: `m${i}`,
        question_type: 'multi-session',
        question: `q${i}`,
        gold: 'g',
        answer: 'a',
        // gold session 0 retrieved at rank i → gold_rank i+1, every row ranked
        meta: { read_hits: [{ source_id: 'x', rank: i, session_index: 0 }] },
      });
    }
    rows.push({ question_id: 'q-adv', question_type: 'single-session-preference', question: 'w', gold: 'g', answer: 'a', meta: { read_hits: [{ source_id: 'x', rank: 0, session_index: 1 }] } });
    const items = GOLD_ITEMS.concat(
      Array.from({ length: 15 }, (_, i) => ({
        question_id: `m${i}`,
        question_type: 'multi-session',
        answer: 'g',
        answer_session_ids: ['sess-a'],
        haystack_session_ids: ['sess-a'],
        haystack_sessions: [[{ role: 'user', content: 'g' }]],
      }))
    );
    const groups = buildTranscriptGroups({
      runs: [{ runId: 'r1', judged: [], rowsByArm: { mycelium: rows } }],
      goldIndex: buildGoldIndex(items),
      writeCapValue: null,
    });
    // the one preference question + the 12 deepest multi-session ranks (worst first: m14 gold_rank 15 … m3 gold_rank 4)
    expect(groups.filter((g) => g.question_type === 'single-session-preference')).toHaveLength(1);
    const multi = groups.filter((g) => g.question_type === 'multi-session');
    expect(multi).toHaveLength(12);
    expect(multi[0].question_id).toBe('m14');
    expect(multi[11].question_id).toBe('m3');
  });
});

// ---- composeGrid integration (audit: true) --------------------------------------------

describe('composeGrid --retrieval-audit: the section lands in the grid receipt, the branch is decided', () => {
  let root;

  const AUDIT_ITEMS = [
    {
      question_id: 'q-adv',
      question_type: 'single-session-preference',
      answer: 'Aisle five',
      answer_session_ids: ['sess-1'],
      haystack_session_ids: ['sess-1'],
      haystack_sessions: [[{ role: 'user', content: 'Aisle five' }]],
    },
  ];

  // deep-enough regime for the comparability check; dataset name is a REAL
  // SPLITS name (loadAuditItems resolves the key against the registry first,
  // then loads the corpus through the injected loadSplitFn — no dataset file)
  const REGIME = {
    date_utc: '2026-09-17T00:00:00Z',
    git_sha: 'sha',
    git_dirty: false,
    harness: 'p1-skeleton.1',
    dataset: { name: 'bench-memory hermetic fixture', file: 'x.json', sha256: 'sha-x', licence: 'MIT', url: null, items_available: 1, citation: 'test' },
    answerer: { model: 'm', url_host: 'h', temperature: 0, max_tokens: 4096 },
    judge: { model: 'j', url_host: 'h', judge_prompt_version: 'p' },
    retrieval: { budget: 5, chunking: 'c', source_type: 'bench_longmemeval', namespace: 'ns', server_mode: 'hybrid (server-side)' },
    platform: { url_host: 'h', version: 'v' },
    n: 1,
    selection_rule: 'sort by question_id ascending, take first n (deterministic, stable across runs)',
    notes: [],
  };

  function writeRun(name, runId, armName, readHits) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const summary = {
      run_id: runId,
      n: 1,
      regime: { ...REGIME, retrieval: { ...REGIME.retrieval, namespace: `ns-${runId}` } },
      arms: { [armName]: { n: 1, score: { counts: { exact: 0, partial: 0, wrong: 1 }, p1_score: 0 } } },
      write_info: {},
      commands: [],
    };
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
    fs.writeFileSync(
      path.join(dir, 'judged.jsonl'),
      JSON.stringify({ question_id: 'q-adv', arm: armName, question_type: 'single-session-preference', gold: 'Aisle five', answer: 'I do not know.', label: 'wrong', judge_raw: 'WRONG', judge_had_think: false }) + '\n'
    );
    fs.writeFileSync(
      path.join(dir, `${armName}.rows.jsonl`),
      JSON.stringify({
        question_id: 'q-adv',
        question_type: 'single-session-preference',
        question: 'Where is the cereal?',
        gold: 'Aisle five',
        answer: 'I do not know.',
        // undefined = the banked row shape (counts only, no read_hits key at all);
        // null = a no-retrieval stamp; array = a cooperative stamp
        meta:
          readHits === undefined
            ? { hits: 3 }
            : { hits: readHits === null ? 0 : readHits.length, read_hits: readHits, read_hits_available: readHits !== null },
      }) + '\n'
    );
    return dir;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-memory-audit-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stamped rows decide branch B; the receipt carries the audit + the transcripts pointer', async () => {
    // gold session 0 retrieved at rank 0 — within budget → answer-side branch
    const dirs = [writeRun('run-a', 'run-a', 'mycelium', [{ source_id: 'run-a-q-adv-s0', rank: 0, score: 0.9, session_index: 0 }])];
    dirs.push(writeRun('run-b', 'run-b', 'none', null));
    const out = await composeGrid({
      dirs,
      generatedAt: '2026-09-17T00:00:00Z',
      receiptsDir: path.join(root, 'receipts'),
      audit: true,
      loadSplitFn: async () => ({ items: AUDIT_ITEMS }),
    });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(out.diagnosticBranch).toBe('answer-side-transcripts');
    expect(md).toMatch(/Retrieval audit — read-side provenance \(task 207\)/);
    expect(md).toMatch(/1\/1 questions mapped/);
    expect(md).toMatch(/`answer_session_ids` 1/);
    expect(md).toMatch(/Pooled branch: `answer-side-transcripts`/);
    expect(md).toMatch(/### Transcripts for hand labels/);
    expect(md).toMatch(/\*\*Gold:\*\* Aisle five/);
    // the no-retrieval arm is in the table, stamped null, never ranked
    expect(md).toMatch(/\| none \| single-session-preference \| 1 \| 0 \|/);
  });

  it('banked-shape rows (counts only) yield insufficient-stamps — no ranks invented', async () => {
    // meta without read_hits: exactly the banked 09-08/09-10 row shape
    const dirs = [writeRun('run-a', 'run-a', 'mycelium', undefined), writeRun('run-b', 'run-b', 'none', undefined)];
    const out = await composeGrid({
      dirs,
      generatedAt: '2026-09-17T00:00:00Z',
      receiptsDir: path.join(root, 'receipts'),
      audit: true,
      loadSplitFn: async () => ({ items: AUDIT_ITEMS }),
    });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(out.diagnosticBranch).toBe('insufficient-stamps');
    expect(md).toMatch(/Pooled branch: `insufficient-stamps`/);
    expect(md).toMatch(/0 ranked preference rows/);
    expect(md).toMatch(/never assigned ranks/);
  });
});
