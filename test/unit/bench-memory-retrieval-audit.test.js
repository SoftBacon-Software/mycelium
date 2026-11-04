// task 207 — the shared retrieval-provenance seam + gold mapping + audit
// (bench/memory/retrieval_stamp.mjs, grid.mjs's --retrieval-audit section).
// Hermetic: inline fixtures only; the composeGrid integration test injects the
// corpus through loadSplitFn so the 277 MB dataset is never touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  armRetrievalVsAnswers,
  buildGoldIndex,
  classifyRow,
  computeRetrievalAudit,
  decideDiagnostic,
  hitQuestionId,
  mapGoldSessions,
  median,
  recordHits,
  stampBudget,
} from '../../bench/memory/retrieval_stamp.mjs';
import {
  buildTranscriptGroups,
  composeGrid,
  loadArmRows,
  loadAuditItems,
  loadRun,
  poolDiagnostic,
  renderRetrievalAuditSection,
  writeCap,
} from '../../bench/memory/grid.mjs';
import { createArmNone } from '../../bench/memory/arms/arm_none.mjs';
import { createArmMycelium } from '../../bench/memory/arms/arm_mycelium.mjs';
import { createArmMem0 } from '../../bench/memory/arms/arm_mem0.mjs';
import { sessionIndexFromTags, questionIdFromTags } from '../../bench/memory/arms/arm_letta.mjs';
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
    expect(out.read_hits[0]).toEqual({ source_id: 'run-q1-s2', score: 0.9, session_index: 2, question_id: null, rank: 0 });
  });

  it('normalizes question_id to null when the arm cannot stamp it — the pooled-store honesty field (task 304)', () => {
    const meta = recordHits({}, [{ source_id: 'x', score: 1, session_index: 0, question_id: 'q-own' }], 5);
    expect(meta.read_hits[0].question_id).toBe('q-own');
    expect(recordHits({}, [{ source_id: 'x', score: 1, session_index: 0 }], 5).read_hits[0].question_id).toBeNull();
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

  it('arm_mycelium: search results → {source_id, score, session_index, question_id} ordered stamps', async () => {
    const platform = {
      search: async () => ({
        mode: 'hybrid',
        results: [
          { source_id: 'r-q-s2', content_text: 'gold text', score: 0.88, metadata: { question_id: 'q', session_index: 2 } },
          { source_id: 'r-q2-s0', content_text: 'other', score: 0.31, metadata: { question_id: 'q2', session_index: 0 } },
        ],
      }),
    };
    const arm = createArmMycelium({ answerChat: async () => ({ text: 'ans' }), platform, namespace: 'ns', retrievalBudget: 5, runId: 'r' });
    const { meta } = await arm.answer('q?');
    expect(meta.hits).toBe(2);
    expect(meta.budget).toBe(5);
    expect(meta.read_hits).toEqual([
      { source_id: 'r-q-s2', score: 0.88, session_index: 2, question_id: 'q', rank: 0 },
      { source_id: 'r-q2-s0', score: 0.31, session_index: 0, question_id: 'q2', rank: 1 },
    ]);
  });

  it('arm_mem0: the sidecar’s metadata.session_index + question_id ride the stamp; zep-style null scores stay null', async () => {
    const sidecar = {
      calls: { add: [] },
      async request(pathname) {
        if (pathname !== '/search') throw new Error(`no route ${pathname}`);
        return {
          ok: true,
          count: 1,
          results: [{ id: 'mem-9', memory: 'fact', score: 0.7, metadata: { question_id: 'q', session_index: 3 } }],
        };
      },
      async stop() {},
    };
    const arm = createArmMem0({ answerChat: async () => ({ text: 'ans' }), runId: 'r', retrievalBudget: 5, sidecar });
    const { meta } = await arm.answer('q?');
    expect(meta.read_hits).toEqual([{ source_id: 'mem-9', score: 0.7, session_index: 3, question_id: 'q', rank: 0 }]);
  });

  it('sessionIndexFromTags/questionIdFromTags parse letta’s insert-time tags; malformed/absent → null', () => {
    expect(sessionIndexFromTags(['u', 'bench:longmemeval', 'question_id:q1', 'session_index:12'])).toBe(12);
    expect(sessionIndexFromTags(['u'])).toBeNull();
    expect(sessionIndexFromTags('not-an-array')).toBeNull();
    expect(sessionIndexFromTags(['session_index:x'])).toBeNull();
    expect(questionIdFromTags(['u', 'bench:longmemeval', 'question_id:q1', 'session_index:12'])).toBe('q1');
    expect(questionIdFromTags(['u'])).toBeNull();
    expect(questionIdFromTags('not-an-array')).toBeNull();
    expect(questionIdFromTags(['question_id:'])).toBeNull();
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
    const c = classifyRow({ readHits: undefined, mapping, writeCap: null, questionId: 'q' });
    expect(c.stamp).toBe('unstamped');
    expect(c.gold_rank).toBeNull();
  });

  it('null + available false = no-retrieval; null otherwise = retrieval error', () => {
    expect(classifyRow({ readHits: null, readHitsAvailable: false, mapping, writeCap: null, questionId: 'q' }).stamp).toBe('null_no_retrieval');
    expect(classifyRow({ readHits: null, readHitsAvailable: true, mapping, writeCap: null, questionId: 'q' }).stamp).toBe('null_error');
  });

  it('gold rank = the BEST (1-based) rank among gold-session hits', () => {
    const c = classifyRow({
      readHits: [
        { source_id: 'a', rank: 0, session_index: 9, question_id: 'q' },
        { source_id: 'b', rank: 1, session_index: 2, question_id: 'q' },
        { source_id: 'c', rank: 2, session_index: 3, question_id: 'q' },
      ],
      mapping,
      writeCap: null,
      questionId: 'q',
    });
    expect(c.hit).toBe(true);
    expect(c.gold_rank).toBe(2); // rank 1 → 1-based 2
  });

  it('gold beyond the write cap is counted, never charged to retrieval', () => {
    const c = classifyRow({ readHits: [{ source_id: 'a', rank: 0, session_index: 0, question_id: 'q' }], mapping, writeCap: 2, questionId: 'q' });
    expect(c.gold_written).toBe(false);
    expect(c.gold_rank).toBeNull();
  });

  it('hits without session_index are no-provenance rows (excluded from ranks, counted)', () => {
    const c = classifyRow({ readHits: [{ source_id: 'zep-edge', rank: 0, session_index: null, question_id: 'q' }], mapping, writeCap: null, questionId: 'q' });
    expect(c.session_provenance).toBe(false);
    expect(c.gold_rank).toBeNull();
  });
});

// ---- the audit ---------------------------------------------------------------------

describe('computeRetrievalAudit — hit@budget, median gold rank, MRR per type × arm', () => {
  const goldIndex = buildGoldIndex(GOLD_ITEMS);
  const rows = {
    mycelium: [
      { question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: [{ source_id: 'a', rank: 0, session_index: 1, question_id: 'q-adv' }] } },
      {
        question_id: 'q-multi',
        question_type: 'multi-session',
        meta: {
          read_hits: [
            { source_id: 'b', rank: 0, session_index: 4, question_id: 'q-multi' },
            { source_id: 'c', rank: 1, session_index: 2, question_id: 'q-multi' },
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
    { runId: 'r2', summary: {}, rowsByArm: { mycelium: [{ question_id: 'q-multi', question_type: 'multi-session', meta: { read_hits: [{ source_id: 'd', rank: 0, session_index: 9, question_id: 'q-multi' }] } }] } },
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
          mycelium: [{ question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: [{ source_id: 'a', rank: 0, session_index: 1, question_id: 'q-adv' }] } }],
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
        meta: { read_hits: [{ source_id: 'x', rank: i, session_index: 0, question_id: `m${i}` }] },
      });
    }
    rows.push({ question_id: 'q-adv', question_type: 'single-session-preference', question: 'w', gold: 'g', answer: 'a', meta: { read_hits: [{ source_id: 'x', rank: 0, session_index: 1, question_id: 'q-adv' }] } });
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

  function writeRun(name, runId, armName, readHits, factsLayer = null) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const summary = {
      run_id: runId,
      n: 1,
      regime: {
        ...REGIME,
        retrieval: { ...REGIME.retrieval, namespace: `ns-${runId}` },
        // task 225: the facts-layer stamp that gives a timeline run its grid identity
        ...(factsLayer ? { mycelium_timeline: { facts_layer: factsLayer } } : {}),
      },
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

  it('task 225: two same-named timeline runs on different facts layers audit as SEPARATE labeled cells, never pooled', async () => {
    const hit = [{ source_id: 's0', rank: 0, score: 0.9, session_index: 0, question_id: 'q-adv' }]; // gold session 0 at rank 0 → ranked
    const dirs = [
      writeRun('run-rows', 'run-rows', 'mycelium-timeline', hit, 'memory-rows'),
      writeRun('run-am', 'run-am', 'mycelium-timeline', hit, 'am_facts'),
    ];
    const out = await composeGrid({
      dirs,
      generatedAt: '2026-09-18T00:00:00Z',
      receiptsDir: path.join(root, 'receipts'),
      audit: true,
      loadSplitFn: async () => ({ items: AUDIT_ITEMS }),
    });
    const md = fs.readFileSync(out.file, 'utf8');
    // each layer's rows land in ITS OWN cell — rows=1 each, not one pooled rows=2 row
    expect(md).toMatch(/\| mycelium-timeline \[memory-rows\] \| single-session-preference \| 1 \| 1 \|/);
    expect(md).toMatch(/\| mycelium-timeline \[am_facts\] \| single-session-preference \| 1 \| 1 \|/);
    // the hand-label transcripts carry the labels too (judged joins stay on the raw arm)
    expect(md).toContain('| mycelium-timeline [memory-rows] | wrong |');
    expect(md).toContain('| mycelium-timeline [am_facts] | wrong |');
  });
});

// ---- task 264: R@5/R@10 beside judged accuracy -----------------------------------
//
// The MemPalace headline is LongMemEval R@5 — session-level retrieval recall.
// Our grid's headline is judge-scored QA accuracy. Two cells, never placed side
// by side, so the retrieve-vs-use gap stayed invisible. Task 264 makes every
// arm row's gold hit lands at k=5/k=10 computable and renders, PER ARM:
// R@5 · R@10 · judged accuracy (p1) · the gap (retrieved-but-answered-wrong %).

describe('task 264 — R@5/R@10 on a fixture with known gold ids', () => {
  const item = (qid) => ({
    question_id: qid,
    question_type: 'multi-session',
    answer: 'g',
    answer_session_ids: ['sess-a'],
    haystack_session_ids: ['sess-a', 'sess-b'],
    haystack_sessions: [[{ role: 'user', content: 'g' }], [{ role: 'user', content: 'x' }]],
  });
  const items = ['q1', 'q2'].map(item);
  const goldIndex = buildGoldIndex(items);
  // rows helpers — one gold-session hit at a chosen context rank (session 0 is gold).
  // row() stamps the row's question onto every hit that carries none — the
  // honest arm shape (every hit names its owning question); tests that need a
  // FOREIGN or unknown hit pass question_id explicitly.
  const hit = (sessionIndex, rank) => ({ source_id: `s${rank}`, score: 1, session_index: sessionIndex, rank });
  const row = (qid, readHits) => ({
    question_id: qid,
    question_type: 'multi-session',
    meta: {
      read_hits: readHits === null ? null : readHits.map((h) => (h.question_id === undefined ? { ...h, question_id: qid } : h)),
      read_hits_available: readHits !== null,
    },
  });

  it('a perfect retriever: R@5 = R@10 = 1.0', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', [hit(0, 0)]), row('q2', [hit(0, 0)])] } }],
      goldIndex,
      budget: 10,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 1, hits: 2, n: 2 });
    expect(roll.a.r_at[10]).toEqual({ rate: 1, hits: 2, n: 2 });
  });

  it('an empty retriever (read_hits [] — the search ran, zero rows came back) is a KNOWN miss: R@5 = 0.0, never n/a', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', []), row('q2', [])] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 0, hits: 0, n: 2 });
  });

  it('a partial retriever scores the exact ratio — and R@5/R@10 differ when the gold sits at rank 6', () => {
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'r',
        rowsByArm: {
          a: [
            // gold at context rank 5 (1-based) → inside @5
            row('q1', [hit(1, 0), hit(0, 4)]),
            // gold at context rank 6 (1-based) → misses @5, inside @10
            row('q2', [hit(1, 0), hit(1, 1), hit(1, 2), hit(1, 3), hit(1, 4), hit(0, 5)]),
          ],
        },
      }],
      goldIndex,
      budget: 10,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 0.5, hits: 1, n: 2 });
    expect(roll.a.r_at[10]).toEqual({ rate: 1, hits: 2, n: 2 });
  });

  it('k beyond the read budget is n/a (why), never 0 and never R@budget re-badged', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', [hit(0, 0)])] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 1, hits: 1, n: 1 });
    expect(roll.a.r_at[10]).toMatchObject({ na: expect.stringMatching(/read budget 5/) });
  });

  it('a no-retrieval arm (read_hits null) is n/a (why), never 0', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { none: [row('q1', null), row('q2', null)] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.none.r_at[5]).toMatchObject({ na: expect.stringMatching(/no-retrieval/) });
    // R@10 at budget 5: the budget note fires first — it is the more fundamental
    // why (no arm can see rank 10 there), and it is still n/a, never 0
    expect(roll.none.r_at[10]).toMatchObject({ na: expect.stringMatching(/read budget 5/) });
  });

  it('banked rows (counts only, no read_hits key) are n/a (why) — ranks are never invented', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { banked: [{ question_id: 'q1', question_type: 'multi-session', meta: { hits: 5 } }] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.banked.r_at[5]).toMatchObject({ na: expect.stringMatching(/banked/) });
  });

  it('the per-type cells still carry the task-207 hit@budget unchanged (R@k does not disturb it)', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', [hit(0, 0)]), row('q2', [hit(0, 0)])] } }],
      goldIndex,
      budget: 5,
    });
    expect(audit.cells.a['multi-session'].hit_at_budget).toBe(1);
    expect(audit.cells.a['multi-session'].ranked).toBe(2);
  });
});

describe('task 264 — judged accuracy + the retrieved-but-answered-wrong gap', () => {
  const items = ['q1', 'q2', 'q3'].map((qid) => ({
    question_id: qid,
    question_type: 'multi-session',
    answer: 'g',
    answer_session_ids: ['sess-a'],
    haystack_session_ids: ['sess-a'],
    haystack_sessions: [[{ role: 'user', content: 'g' }]],
  }));
  const goldIndex = buildGoldIndex(items);
  const hitRow = (qid) => ({ question_id: qid, meta: { read_hits: [{ source_id: 's', score: 1, session_index: 0, rank: 0, question_id: qid }], read_hits_available: true } });
  const judgedRows = [
    { question_id: 'q1', label: 'exact' },
    { question_id: 'q2', label: 'wrong' },
    { question_id: 'q3', label: 'partial' },
  ];

  it('judged accuracy is p1 over the arm’s joined labels; the gap is P(wrong | gold retrieved within budget)', () => {
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'r',
        rowsByArm: { a: [hitRow('q1'), hitRow('q2'), hitRow('q3')] },
        judgedByArm: { a: judgedRows },
      }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.judged_p1).toBeCloseTo((1 + 0 + 0.5) / 3); // exact + wrong + partial
    expect(roll.a.gap).toEqual({ rate: 1 / 3, wrong: 1, n: 3 }); // every row retrieved; one wrong
  });

  it('a retrieved-MISS judged wrong is retrieval-side, not the gap — the gap only counts gold-retrieved rows', () => {
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'r',
        rowsByArm: {
          a: [
            { question_id: 'q1', meta: { read_hits: [{ source_id: 'x', score: 1, session_index: 9, rank: 0, question_id: 'q1' }], read_hits_available: true } }, // miss
            { question_id: 'q2', meta: { read_hits: [{ source_id: 's', score: 1, session_index: 0, rank: 0, question_id: 'q2' }], read_hits_available: true } }, // hit, wrong
          ],
        },
        judgedByArm: { a: [{ question_id: 'q1', label: 'wrong' }, { question_id: 'q2', label: 'wrong' }] },
      }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    // denominator = the 1 RETRIEVED row (q2): the miss row (q1) is a retrieval
    // failure and stays out of the gap — R@k carries it instead
    expect(roll.a.gap).toEqual({ rate: 1, wrong: 1, n: 1 });
    expect(roll.a.r_at[5]).toEqual({ rate: 0.5, hits: 1, n: 2 });
  });

  it('no judged labels joined → accuracy n/a + gap n/a, each saying why', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [hitRow('q1')] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.judged_p1).toMatchObject({ na: expect.stringMatching(/no judged rows/) });
    expect(roll.a.gap).toMatchObject({ na: expect.stringMatching(/no retrieved-hit rows carry a judge label/) });
  });

  it('task 225: judged labels join on the RAW arm name and surface under the arm’s LABELED identity', () => {
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'r',
        rowsByArm: { 'mycelium-timeline': [hitRow('q1')] },
        judgedByArm: { 'mycelium-timeline': [{ question_id: 'q1', label: 'exact' }] },
        labelByArm: { 'mycelium-timeline': 'mycelium-timeline [am_facts]' },
      }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll['mycelium-timeline [am_facts]'].judged_p1).toBe(1);
  });
});

describe('task 264 — the receipt renders the per-arm retrieval-vs-answers table', () => {
  const item = {
    question_id: 'q-adv',
    question_type: 'single-session-preference',
    answer: 'Aisle five',
    answer_session_ids: ['sess-1'],
    haystack_session_ids: ['sess-1'],
    haystack_sessions: [[{ role: 'user', content: 'Aisle five' }]],
  };
  const goldIndex = buildGoldIndex([item]);

  const auditFor = (rowsByArm, judgedByArm) =>
    computeRetrievalAudit({
      runs: [{ runId: 'r1', rowsByArm, judgedByArm }],
      goldIndex,
      budget: 5,
    });

  it('renders R@5 · R@10 · judged accuracy · the gap per arm, with counts, and states the definitions', () => {
    const audit = auditFor(
      { mycelium: [{ question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: [{ source_id: 's', score: 1, session_index: 0, rank: 0, question_id: 'q-adv' }], read_hits_available: true } }] },
      { mycelium: [{ question_id: 'q-adv', label: 'wrong' }] }
    );
    const lines = renderRetrievalAuditSection({
      audit,
      goldCoverage: goldIndex.coverage,
      writeCapValue: null,
      diagnostic: poolDiagnostic(audit, 5),
      budget: 5,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/task 264/);
    expect(text).toMatch(/\| mycelium \| 1\.000 \(1\/1\) \| n\/a \(read budget 5[^)]*\) \| 0\.000 \(0\/1\) \| 100\.0% \(1\/1\) \|/);
    expect(text).toMatch(/R@5 = THIS question's gold session in the top 5 of the stamped read hits/);
    // task 304 (review-B reason 2): the pooled-store protocol is STATED, and the
    // published-per-question-R@k comparability claim is gone
    expect(text).toMatch(/pooled per-run store/);
    expect(text).toMatch(/NOT comparable to a published per-question R@k/);
    expect(text).not.toMatch(/96\.6%-style number can be placed beside an arm honestly/);
    expect(text).toMatch(/retrieved-but-answered-wrong/);
  });

  it('an arm whose rows are banked renders n/a (why) — and its judged accuracy still renders from judged.jsonl', () => {
    const audit = auditFor(
      { old: [{ question_id: 'q-adv', question_type: 'single-session-preference', meta: { hits: 5 } }] },
      { old: [{ question_id: 'q-adv', label: 'exact' }] }
    );
    const lines = renderRetrievalAuditSection({
      audit,
      goldCoverage: goldIndex.coverage,
      writeCapValue: null,
      diagnostic: poolDiagnostic(audit, 5),
      budget: 5,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/\| old \| n\/a \(.*banked.*\) \| n\/a \(.*\) \| 1\.000 \(1\/1\) \| n\/a \(.*\) \|/);
    expect(text).not.toMatch(/\| old \| 0\.000 \|/);
  });

  it('states the evidence granularity: session-level, turn-level absent in this dataset', () => {
    const audit = auditFor(
      { mycelium: [{ question_id: 'q-adv', question_type: 'single-session-preference', meta: { read_hits: [{ source_id: 's', score: 1, session_index: 0, rank: 0, question_id: 'q-adv' }], read_hits_available: true } }] },
      { mycelium: [{ question_id: 'q-adv', label: 'exact' }] }
    );
    const lines = renderRetrievalAuditSection({
      audit,
      goldCoverage: goldIndex.coverage,
      writeCapValue: null,
      diagnostic: poolDiagnostic(audit, 5),
      budget: 5,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/session-level/);
    expect(text).toMatch(/[Tt]urn-level .*absent/);
  });
});

describe('task 264 — composeGrid: judged labels flow from judged.jsonl into the table (banked-run shape)', () => {
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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-memory-264-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeRun(name, runId, armName, { stamped }) {
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
    const meta = stamped
      ? { hits: 1, read_hits: [{ source_id: 's0', score: 0.9, session_index: 0, rank: 0, question_id: 'q-adv' }], read_hits_available: true }
      : { hits: 3 }; // the banked shape: counts only, no read_hits key
    fs.writeFileSync(
      path.join(dir, `${armName}.rows.jsonl`),
      JSON.stringify({ question_id: 'q-adv', question_type: 'single-session-preference', question: 'Where is the cereal?', gold: 'Aisle five', answer: 'I do not know.', meta }) + '\n'
    );
    return dir;
  }

  it('a stamped run: the table carries real R@5/R@10/gap numbers; judged accuracy joins from judged.jsonl', async () => {
    const dirs = [writeRun('run-a', 'run-a', 'mycelium', { stamped: true })];
    dirs.push(writeRun('run-b', 'run-b', 'none', { stamped: false })); // none stamps read_hits null itself
    // overwrite run-b's rows with the true null stamp (writeRun's banked shape is for the other test)
    fs.writeFileSync(
      path.join(root, 'run-b', 'none.rows.jsonl'),
      JSON.stringify({ question_id: 'q-adv', question_type: 'single-session-preference', question: 'Where is the cereal?', gold: 'Aisle five', answer: 'I do not know.', meta: { hits: 0, read_hits: null, read_hits_available: false, budget: 5 } }) + '\n'
    );
    const out = await composeGrid({
      dirs,
      generatedAt: '2026-10-29T00:00:00Z',
      receiptsDir: path.join(root, 'receipts'),
      audit: true,
      loadSplitFn: async () => ({ items: AUDIT_ITEMS }),
    });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toMatch(/task 264/);
    expect(md).toMatch(/\| mycelium \| 1\.000 \(1\/1\) \| n\/a \(read budget 5[^)]*\) \| 0\.000 \(0\/1\) \| 100\.0% \(1\/1\) \|/);
    // the no-retrieval arm: retrieval columns n/a, judged accuracy still rendered
    expect(md).toMatch(/\| none \| n\/a \(.*no-retrieval.*\) \| n\/a \(.*\) \| 0\.000 \(0\/1\) \| n\/a \(.*\) \|/);
  });

  it('a banked run (ids not logged): R@k renders n/a (why), judged accuracy still renders', async () => {
    const dirs = [writeRun('run-a', 'run-a', 'old-arm', { stamped: false })];
    dirs.push(writeRun('run-b', 'run-b', 'none', { stamped: false }));
    const out = await composeGrid({
      dirs,
      generatedAt: '2026-10-29T00:00:00Z',
      receiptsDir: path.join(root, 'receipts'),
      audit: true,
      loadSplitFn: async () => ({ items: AUDIT_ITEMS }),
    });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toMatch(/\| old-arm \| n\/a \(.*banked.*\) \|/);
    expect(md).toMatch(/\| old-arm .* \| 0\.000 \(0\/1\) \|/);
    expect(md).toMatch(/no turn-level evidence ids/);
  });
});

// ---- task 304: R@k counts only THIS question's sessions ---------------------------
//
// Review B (2026-11-03) sent 264 BACK: every arm writes ALL n questions'
// haystacks into ONE per-run store, so a read routinely ranks OTHER questions'
// sessions — and a foreign session whose index collides with this question's
// gold index was counted as a gold hit by session NUMBER alone. On the banked
// 2026-09-19-p1-134358 run, 4 of the 34 R@5 "hits" were other questions'
// sessions (0.680 → 0.600). These are the hostile tests that pin the fix.

describe('task 304 — a hit requires the retrieved session to belong to THIS question', () => {
  const item = (qid) => ({
    question_id: qid,
    question_type: 'multi-session',
    answer: 'g',
    answer_session_ids: ['sess-a'],
    haystack_session_ids: ['sess-a', 'sess-b'],
    haystack_sessions: [[{ role: 'user', content: 'g' }], [{ role: 'user', content: 'x' }]],
  });
  const items = ['q1', 'q2'].map(item);
  const goldIndex = buildGoldIndex(items);
  const hit = (sessionIndex, rank, questionId) => ({
    source_id: `s${rank}`,
    score: 1,
    session_index: sessionIndex,
    rank,
    ...(questionId !== undefined ? { question_id: questionId } : {}),
  });
  const row = (qid, readHits) => ({
    question_id: qid,
    question_type: 'multi-session',
    meta: { read_hits: readHits, read_hits_available: readHits !== null },
  });

  it('q1 read ONLY q2\'s session 0 (not q1\'s gold) — R@5 must be 0', () => {
    // q1's gold is its OWN session 0; the single retrieved hit is q2's session 0 —
    // the numbers collide, the questions do not. Session number alone must not credit.
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', [hit(0, 0, 'q2')])] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 0, hits: 0, n: 1 });
  });

  it('the banked shape: a foreign hit parses from the runId-prefixed source_id and does not credit; the OWN hit does, at its own rank', () => {
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'run-9',
        rowsByArm: {
          a: [
            row('q1', [
              { source_id: 'run-9-q2-s0', score: 1, session_index: 0, rank: 0 }, // foreign, colliding index
              { source_id: 'run-9-q1-s0', score: 1, session_index: 0, rank: 1 }, // own gold
            ]),
          ],
        },
      }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 1, hits: 1, n: 1 });
    // the task-207 rank stats carry the fix too: gold_rank is the OWN hit's rank
    const cell = audit.cells.a['multi-session'];
    expect(cell.hit).toBe(1);
    expect(cell.median_gold_rank).toBe(2);
  });

  it('a hit with NO question identity (pooled store, unparsable source id) renders n/a (why) — never a credit, never a guess', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', [{ source_id: 'edge-uuid', score: 1, session_index: 0, rank: 0 }])] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toMatchObject({ na: expect.stringMatching(/question/) });
  });

  it('a source id from ANOTHER run (runId given, prefix mismatch) is unknown ownership — n/a, never a fabricated foreign miss (task 324)', () => {
    // the re-answer shape review B flagged: the pass stamps
    // run_id `<orig>-reanswer-<policy>` while its store's ids carry `<orig>-`;
    // the old bare parse fabricated `<orig>-<qid>`, foreign to every row and
    // therefore a KNOWN miss — a fabricated miss. It must be n/a.
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'run-9-reanswer-mixed',
        rowsByArm: { a: [row('q1', [{ source_id: 'run-9-q1-s0', score: 1, session_index: 0, rank: 0 }])] },
      }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toMatchObject({ na: expect.stringMatching(/question/) });
  });

  it('a row where ANY index-carrying hit lacks question identity is n/a — the gold could be that hit, so the outcome is unknown', () => {
    const audit = computeRetrievalAudit({
      runs: [{
        runId: 'r',
        rowsByArm: { a: [row('q1', [hit(0, 0, 'q1'), { source_id: 'edge-uuid', score: 1, session_index: 1, rank: 1 }])] },
      }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toMatchObject({ na: expect.stringMatching(/question/) });
  });

  it('foreign-only reads are KNOWN misses (rankable, 0.0) — not n/a and not silently dropped', () => {
    const audit = computeRetrievalAudit({
      runs: [{ runId: 'r', rowsByArm: { a: [row('q1', [hit(1, 0, 'q2'), hit(2, 1, 'q2')])] } }],
      goldIndex,
      budget: 5,
    });
    const roll = armRetrievalVsAnswers(audit, audit.budget);
    expect(roll.a.r_at[5]).toEqual({ rate: 0, hits: 0, n: 1 });
  });

  it('hitQuestionId: the explicit stamp wins; banked runId-prefixed and bare `<qid>-s<idx>` source ids parse; another run\'s id with runId given → null (task 324); unparseable → null', () => {
    expect(hitQuestionId({ question_id: 'q9', source_id: 'anything' })).toBe('q9');
    expect(hitQuestionId({ question_id: null, source_id: 'run-9-q2-s0' }, 'run-9')).toBe('q2');
    expect(hitQuestionId({ source_id: 'q2-s0' })).toBe('q2');
    expect(hitQuestionId({ source_id: '15745da0_abs-s37' })).toBe('15745da0_abs');
    // task 324 (review B finding 2): runId given, id from ANOTHER run — the old
    // parse fabricated `<otherRun>-<qid>`, a foreign id that could only miss
    expect(hitQuestionId({ question_id: null, source_id: 'run-8-q2-s0' }, 'run-9')).toBeNull();
    expect(hitQuestionId({ source_id: 'edge-uuid' })).toBeNull();
    expect(hitQuestionId({ source_id: 's0' })).toBeNull();
    expect(hitQuestionId({ source_id: 'mem-9' })).toBeNull();
    expect(hitQuestionId(null)).toBeNull();
    expect(hitQuestionId({})).toBeNull();
  });
});

// task 319 — the BANKED RUN re-stamps to 30/50 on the committed rows. The
// committed receipt (receipts/2026-09-19-p1-134358-retrieval-audit-task264.md)
// quotes R@5 0.600 (30/50) own-question; this test pins that number to the
// committed rows joined against a committed gold-map fixture
// (bench/memory/test-fixtures/banked-134358-gold-map.json — the LongMemEval-S
// gold fields for the run's 50 selected questions, extracted once via
// loadAuditItems so the 277 MB dataset is never touched here), so a future
// regression in the question-scoping cannot silently re-inflate the banked
// headline. Review B's four foreign-only rows must stay misses.
describe('task 319 — the banked 2026-09-19-p1-134358 run re-stamps to 30/50 own-question', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const RUN_DIR = path.join(REPO_ROOT, 'bench/memory/results/2026-09-19-p1-134358');
  const GOLD_MAP = path.join(REPO_ROOT, 'bench/memory/test-fixtures/banked-134358-gold-map.json');

  it('mycelium R@5 = 0.600 (30/50) and gap 50.0% (15/30) over the committed rows', () => {
    const run = loadRun(RUN_DIR);
    const budget = run.summary.regime?.retrieval?.budget;
    const goldFixture = JSON.parse(fs.readFileSync(GOLD_MAP, 'utf8'));
    expect(goldFixture.n).toBe(50);
    const goldIndex = buildGoldIndex(goldFixture.items);
    expect(goldIndex.coverage.mapped).toBe(50); // all answer_session_ids join their haystack ids
    const judgedByArm = {}; // keyed by RAW arm name — the same join the render tool runs
    for (const j of run.judged ?? []) if (j.arm) (judgedByArm[j.arm] ??= []).push(j);
    const audit = computeRetrievalAudit({
      runs: [
        {
          runId: run.runId,
          rowsByArm: { mycelium: loadArmRows(run.dir, 'mycelium') },
          judgedByArm,
          labelByArm: run.labelByArm,
        },
      ],
      goldIndex,
      budget,
      writeCap: writeCap(run.summary),
    });
    const roll = armRetrievalVsAnswers(audit, budget);
    expect(roll.mycelium.r_at[5]).toEqual({ rate: 0.6, hits: 30, n: 50 });
    expect(roll.mycelium.gap).toEqual({ rate: 0.5, wrong: 15, n: 30 });
    // R@10 stays n/a: the read budget (5) never stamps deeper ranks
    expect(roll.mycelium.r_at[10]).toHaveProperty('na');
  });

  it('review B\'s four foreign-only rows are misses with foreign hits — never re-credited', () => {
    const run = loadRun(RUN_DIR);
    const goldFixture = JSON.parse(fs.readFileSync(GOLD_MAP, 'utf8'));
    const goldIndex = buildGoldIndex(goldFixture.items);
    const rows = loadArmRows(run.dir, 'mycelium');
    const byQ = new Map(rows.map((r) => [r.question_id, r]));
    for (const qid of ['07741c44', '0862e8bf_abs', '0a34ad58', '1192316e']) {
      const r = byQ.get(qid);
      expect(r, `row ${qid} in the committed banked rows`).toBeTruthy();
      const c = classifyRow({
        readHits: r.meta.read_hits,
        readHitsAvailable: r.meta.read_hits_available,
        mapping: goldIndex.byQuestion.get(qid),
        writeCap: writeCap(run.summary),
        questionId: qid,
        runId: run.runId,
      });
      expect(c.hit).toBe(false);
      expect(c.foreign_hits).toBeGreaterThan(0);
    }
  });
});
