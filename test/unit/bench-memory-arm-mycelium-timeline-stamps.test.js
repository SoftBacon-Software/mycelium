import { describe, it, expect } from 'vitest';
import {
  createArmMyceliumTimeline,
  buildReconcileUserPrompt,
  resolveReconcileFastpathThreshold,
  RECONCILE_FASTPATH_THRESHOLD,
  FASTPATH_THRESHOLD_ENV,
  WRITE_DECISION_FIELDS,
  buildReadHits,
  renderMergedHit,
  RECONCILE_SYSTEM,
} from '../../bench/memory/arms/arm_mycelium_timeline.mjs';
import { runBench } from '../../bench/memory/core.mjs';

// task 205 — the stamps (meta.read_hits, meta.write_decisions, the per-candidate
// ledger) and the pre-committed cost lever (the reconcile fastpath).
//
// The fake platform's FACT-page must carry the arm's OWN source_ids: the arm
// filters reconcile search hits through its pending map (facts written by this
// write call), so a foreign id is skipped before the score is ever read.

const DATES = ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15'];
const SESSIONS = [
  [{ role: 'user', content: 'I just signed the lease for the Lisbon apartment.' }],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];
const EXTRACT_LEASE = { text: '{"facts": ["Signed a lease for an apartment in Lisbon"]}' };
const EXTRACT_DANA = { text: '{"facts": ["User manager is Dana"]}' };

const factHit = (source_id, text, score, extraMeta = {}) => ({
  source_id,
  content_text: text,
  score,
  metadata: { layer: 'fact', question_id: 'q1', valid_from: '2023/05/20 (Sat) 02:21', valid_to: null, ...extraMeta },
});
const episodeHit = (source_id, text, score) => ({
  source_id,
  content_text: text,
  score,
  metadata: { layer: 'episode', question_id: 'q1', session_date: '2023/05/01 (Mon) 10:00' },
});

// The fact layer returns a scripted page; the episode layer a scripted list;
// either can be told to throw (the retrieval_error stamp path).
function scriptedPlatform({ factPage = [], episodes = [], failFactSearch = false, failEpisodeSearch = false } = {}) {
  const calls = { searches: [] };
  return {
    calls,
    async indexBulk() {
      return [{ rows: 1 }];
    },
    async search({ query, namespace, limit }) {
      calls.searches.push({ query, namespace, limit });
      if (namespace.endsWith('-timeline')) {
        if (failFactSearch) throw new Error('boom: facts store down');
        return { results: factPage, mode: 'hybrid' };
      }
      if (failEpisodeSearch) throw new Error('boom: episode store down');
      return { results: episodes, mode: 'hybrid' };
    },
  };
}

function makeArm({ platform, extractionReplies = [EXTRACT_LEASE, EXTRACT_DANA], decisionReplies = ['ADD'], threshold, ...rest } = {}) {
  const extractionCalls = [];
  const decisionCalls = [];
  const arm = createArmMyceliumTimeline({
    answerChat: async () => ({ text: 'ok' }),
    extractionChat: async (args) => {
      extractionCalls.push(args);
      return extractionReplies[Math.min(extractionCalls.length - 1, extractionReplies.length - 1)];
    },
    reconcileChat: async (args) => {
      decisionCalls.push(args);
      const r = decisionReplies[Math.min(decisionCalls.length - 1, decisionReplies.length - 1)];
      return typeof r === 'string' ? { text: r } : r;
    },
    platform,
    namespace: 'bench-p1-r1',
    retrievalBudget: 5,
    runId: 'r1',
    ...(threshold === undefined ? {} : { reconcileFastpathThreshold: threshold }),
    ...rest,
  });
  return { arm, extractionCalls, decisionCalls };
}

describe('the reconcile fastpath — the cost lever (pre-committed, task 205)', () => {
  it('a top score BELOW the threshold is an ADD with NO decision call — counted fastpath_adds', async () => {
    // session 0's candidate auto-adds (nothing pending yet); the scripted fact
    // page carries f0 (session 0's own row) so session 1's candidate sees it
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.2)] });
    const { arm, decisionCalls } = makeArm({ platform, threshold: 0.35 });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline).toMatchObject({ candidates: 2, adds: 2, auto_adds: 1, fastpath_adds: 1, decision_calls: 0, decision_failures: 0 });
    expect(decisionCalls).toHaveLength(0); // the decision chat was NEVER dialed
  });

  it('a top score ABOVE the threshold still spends the decision call — with the UNCHANGED prompt', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.9)] });
    const { arm, decisionCalls } = makeArm({ platform, threshold: 0.35, decisionReplies: ['ADD'] });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline).toMatchObject({ candidates: 2, decision_calls: 1, fastpath_adds: 0 });
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].system).toBe(RECONCILE_SYSTEM);
  });

  it('the boundary is inclusive: a score EQUAL to the threshold takes the decision call', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'lease fact', 0.35)] });
    const { arm, decisionCalls } = makeArm({ platform, threshold: 0.35 });
    await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(decisionCalls).toHaveLength(1);
  });

  it('the true top score is read from the server rank order, and the scan keeps counting past a full shown window', async () => {
    // session 0 writes four facts (each fastpathing against the weak page);
    // session 1's search surfaces ALL FOUR at weak scores — the shown window
    // caps at top-k=3 (f3 never rendered) but the score scan covers every
    // qualifying hit: top 0.1 < 0.35 → ADD, no call, and the ledger shows the
    // capped shown_ids beside the true top_score.
    const platform = scriptedPlatform({
      factPage: [
        factHit('r1-q1-tl-f0', 'lease fact', 0.1),
        factHit('r1-q1-tl-f1', 'second lease fact', 0.2),
        factHit('r1-q1-tl-f2', 'third lease fact', 0.3),
        factHit('r1-q1-tl-f3', 'fourth lease fact', 0.4),
      ],
    });
    const extractionReplies = [
      { text: '{"facts": ["F1", "F2", "F3", "F4"]}' },
      { text: '{"facts": ["Manager is Dana"]}' },
    ];
    const { arm, decisionCalls } = makeArm({ platform, extractionReplies, threshold: 0.35 });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline).toMatchObject({ candidates: 5, adds: 5, auto_adds: 1, fastpath_adds: 4, decision_calls: 0 });
    expect(decisionCalls).toHaveLength(0);
    const capped = w.timeline.candidates_ledger[4];
    expect(capped).toMatchObject({
      session_index: 1, source: 'fastpath_below_threshold', top_score: 0.1, decision: 'ADD', ok: true,
    });
    expect(capped.shown_ids).toEqual(['r1-q1-tl-f0', 'r1-q1-tl-f1', 'r1-q1-tl-f2']); // capped at top-k
  });

  it('an env override is honoured and validated; no env means the pre-committed 0.35', () => {
    expect(RECONCILE_FASTPATH_THRESHOLD).toBe(0.35);
    expect(resolveReconcileFastpathThreshold({ env: {} })).toEqual({ threshold: 0.35, source: 'default' });
    expect(resolveReconcileFastpathThreshold({ env: { [FASTPATH_THRESHOLD_ENV]: '0.9' } })).toEqual({ threshold: 0.9, source: 'env' });
    expect(() => resolveReconcileFastpathThreshold({ env: { [FASTPATH_THRESHOLD_ENV]: 'abc' } })).toThrow(/must be a number/);
    expect(() => resolveReconcileFastpathThreshold({ env: { [FASTPATH_THRESHOLD_ENV]: '1.5' } })).toThrow(/\[0, 1\]/);
    expect(() => resolveReconcileFastpathThreshold({ env: { [FASTPATH_THRESHOLD_ENV]: '-0.1' } })).toThrow(/\[0, 1\]/);
    expect(() => createArmMyceliumTimeline({
      answerChat: async () => ({}), extractionChat: async () => ({}), reconcileChat: async () => ({}),
      platform: scriptedPlatform(), namespace: 'ns', retrievalBudget: 5, runId: 'r', reconcileFastpathThreshold: 2,
    })).toThrow(/reconcileFastpathThreshold/);
  });
});

describe('the stamps — meta.read_hits and meta.write_decisions (task 205)', () => {
  it('read_hits mirror the rendered context: ordered, rank 0 first, the supersede line carried', async () => {
    const platform = scriptedPlatform({
      factPage: [
        factHit('f-cur', 'User manager is Dana', 3, { valid_from: '2023/05/22 (Mon) 18:00' }),
        factHit('f-old', 'User lives in Porto', 2, { valid_from: '2023/05/01', valid_to: '2023/05/10', superseded_by_text: 'User lives in Lisbon' }),
      ],
      episodes: [episodeHit('e-0', 'user: I moved to Porto once', 2.5)],
    });
    const seen = [];
    const arm = createArmMyceliumTimeline({
      answerChat: async (args) => {
        seen.push(args);
        return { text: 'Lisbon.' };
      },
      extractionChat: async () => ({}),
      reconcileChat: async () => ({}),
      platform,
      namespace: 'bench-p1-r1',
      retrievalBudget: 5,
      runId: 'r1',
    });
    const r = await arm.answer('Where do I live?', { question_id: 'q1' });
    // interleave: f-cur, e-0 … then both live layers dry → the superseded tail
    expect(r.meta.read_hits).toEqual([
      { layer: 'fact', source_id: 'f-cur', rank: 0, score: 3, rendered_date: '2023/05/22 (Mon) 18:00', rendered_supersede_line: null },
      { layer: 'episode', source_id: 'e-0', rank: 1, score: 2.5, rendered_date: '2023/05/01 (Mon) 10:00', rendered_supersede_line: null },
      { layer: 'fact', source_id: 'f-old', rank: 2, score: 2, rendered_date: '2023/05/01', rendered_supersede_line: 'superseded on 2023/05/10 by: User lives in Lisbon' },
    ]);
    expect(seen[0].user).toContain('superseded on 2023/05/10 by: User lives in Lisbon');
    expect(seen[0].user).toContain('---'); // rows are separated in the context the model saw
  });

  it('read_hits are capped at the budget — exactly budget entries even with more hits', async () => {
    const platform = scriptedPlatform({
      factPage: [factHit('f-cur', 'a current fact', 3)],
      episodes: [episodeHit('e-0', 'user: one', 2.5), episodeHit('e-1', 'user: two', 1), episodeHit('e-2', 'user: three', 0.5), episodeHit('e-3', 'user: four', 0.1)],
    });
    const { arm } = makeArm({ platform });
    const r = await arm.answer('q', { question_id: 'q1' });
    expect(r.meta.read_hits).toHaveLength(5);
    expect(r.meta.read_hits.map((h) => h.source_id)).toEqual(['f-cur', 'e-0', 'e-1', 'e-2', 'e-3']);
    expect(r.meta.read_hits.map((h) => h.rank)).toEqual([0, 1, 2, 3, 4]);
  });

  it('write_decisions carry the question\'s own seven counts; a question this process never wrote stamps null', async () => {
    const platform = scriptedPlatform();
    const { arm } = makeArm({ platform });
    await arm.write(SESSIONS.slice(0, 1), { questionId: 'q1', sessionDates: DATES });
    const wrote = await arm.answer('q', { question_id: 'q1' });
    expect(wrote.meta.write_decisions).toEqual({
      candidates: 1, adds: 1, supersedes: 0, keeps: 0, decision_calls: 0, decision_failures: 0, fastpath_adds: 0,
    });
    const stranger = await arm.answer('q', { question_id: 'q-never-written' });
    expect(stranger.meta.write_decisions).toBeNull();
    const noItem = await arm.answer('q');
    expect(noItem.meta.write_decisions).toBeNull();
  });

  it('a failed layer search stamps read_hits null + retrieval_error — never a fake empty — and the healthy layer still answers', async () => {
    const platform = scriptedPlatform({ episodes: [episodeHit('e-0', 'user: I moved to Porto once', 2.5)], failFactSearch: true });
    const seen = [];
    const arm = createArmMyceliumTimeline({
      answerChat: async (args) => {
        seen.push(args);
        return { text: 'Porto.' };
      },
      extractionChat: async () => ({}),
      reconcileChat: async () => ({}),
      platform,
      namespace: 'bench-p1-r1',
      retrievalBudget: 5,
      runId: 'r1',
    });
    const r = await arm.answer('Where do I live?', { question_id: 'q1' });
    expect(r.meta.read_hits).toBeNull();
    expect(r.meta.retrieval_error).toMatch(/fact search failed: boom/);
    expect(r.meta.facts_hits).toBeNull();
    expect(r.meta.episode_hits).toBe(1);
    expect(seen[0].user).toContain('[session | 2023/05/01 (Mon) 10:00] user: I moved to Porto once');
  });

  it('both layers failing still answer — (no memory found), per-layer hits null, the error stamped', async () => {
    const platform = scriptedPlatform({ failFactSearch: true, failEpisodeSearch: true });
    const seen = [];
    const arm = createArmMyceliumTimeline({
      answerChat: async (args) => {
        seen.push(args);
        return { text: 'idk' };
      },
      extractionChat: async () => ({}),
      reconcileChat: async () => ({}),
      platform,
      namespace: 'bench-p1-r1',
      retrievalBudget: 5,
      runId: 'r1',
    });
    const r = await arm.answer('q', { question_id: 'q1' });
    expect(r.meta.read_hits).toBeNull();
    expect(r.meta.retrieval_error).toMatch(/fact search failed.*episode search failed/s);
    expect(r.meta.facts_hits).toBeNull();
    expect(r.meta.episode_hits).toBeNull();
    expect(seen[0].user).toContain('(no memory found)');
  });

  it('a truly empty search stamps an EMPTY array (not null)', async () => {
    const platform = scriptedPlatform({ factPage: [], episodes: [] });
    const { arm } = makeArm({ platform });
    const r = await arm.answer('q', { question_id: 'q1' });
    expect(r.meta.read_hits).toEqual([]);
    expect(r.meta.retrieval_error).toBeNull();
  });

  it('the per-candidate ledger rides the write result with ids, evidence, and decision source', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.2)] });
    const { arm } = makeArm({ platform, threshold: 0.35 });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline.candidates_ledger).toHaveLength(2);
    expect(w.timeline.candidates_ledger[0]).toMatchObject({
      index: 0, session_index: 0, text: 'Signed a lease for an apartment in Lisbon',
      decision: 'ADD', ok: true, source: 'auto_add_on_no_match', shown_ids: [], top_score: null,
      source_id: 'r1-q1-tl-f0',
    });
    expect(w.timeline.candidates_ledger[1]).toMatchObject({
      index: 0, session_index: 1, decision: 'ADD', ok: true,
      source: 'fastpath_below_threshold', shown_ids: ['r1-q1-tl-f0'], top_score: 0.2,
      source_id: 'r1-q1-tl-f1',
    });
  });

  it('adds + supersedes + keeps === candidates whatever the decision path (the write-decisions invariant)', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'lease one', 0.9)] });
    const decisionReplies = ['KEEP', 'SUPERSEDE r1-q1-tl-f0', 'ADD', 'garbage !!'];
    const extractionReplies = [
      { text: '{"facts": ["Lease one", "Lease two"]}' }, // session 0: auto-add, then KEEP
      { text: '{"facts": ["Manager is Dana", "Team is big", "Extra fact"]}' }, // SUPERSEDE, ADD, fail-open ADD
    ];
    const { arm } = makeArm({ platform, extractionReplies, decisionReplies, threshold: 0.35 });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    const t = w.timeline;
    expect(t.candidates).toBe(5);
    expect(t.adds + t.supersedes + t.keeps).toBe(t.candidates);
    expect(t).toMatchObject({ adds: 3, supersedes: 1, keeps: 1, auto_adds: 1, decision_calls: 4, decision_failures: 1, fastpath_adds: 0 });
    expect(WRITE_DECISION_FIELDS).toEqual(['candidates', 'adds', 'supersedes', 'keeps', 'decision_calls', 'decision_failures', 'fastpath_adds']);
  });
});

describe('the stamps ride the harness (core.mjs passes the item to answer)', () => {
  it('runBench hands the full item to answer() so meta.write_decisions can key off question_id', async () => {
    const seenItems = [];
    await runBench({
      items: [{ question_id: 'q1', question_type: 'knowledge-update', question: 'Q?', answer: 'A', haystack_sessions: [], haystack_dates: [] }],
      armFactories: [
        {
          name: 'mycelium-timeline',
          factory: () => ({
            name: 'mycelium-timeline',
            async write() {
              return { docs: 0, rows: 0, timeline: { question_id: 'q1', candidates: 2, adds: 1, supersedes: 1, keeps: 0, auto_adds: 0, decision_calls: 1, decision_failures: 0, fastpath_adds: 1, seconds_per_session: [], candidates_ledger: [] } };
            },
            async answer(question, item) {
              seenItems.push(item);
              return { text: 'x', meta: {} };
            },
          }),
        },
      ],
      armContext: {},
      regime: { ok: true },
      runId: 'r',
    });
    expect(seenItems[0]?.question_id).toBe('q1');
  });

  it('core.mjs sums candidates + fastpath_adds into the timeline ledger and keeps per_question whole', async () => {
    let captured = null;
    await runBench({
      items: [
        { question_id: 'q1', question_type: 't', question: 'Q?', answer: 'A', haystack_sessions: [], haystack_dates: [] },
        { question_id: 'q2', question_type: 't', question: 'Q?', answer: 'A', haystack_sessions: [], haystack_dates: [] },
      ],
      armFactories: [
        {
          name: 'mycelium-timeline',
          factory: () => ({
            name: 'mycelium-timeline',
            async write(_, { questionId }) {
              return { docs: 1, rows: 1, timeline: { question_id: questionId, candidates: 3, adds: 2, supersedes: 0, keeps: 1, auto_adds: 0, decision_calls: 1, decision_failures: 0, fastpath_adds: 1, seconds_per_session: [], candidates_ledger: [{ index: 0, session_index: 0 }] } };
            },
            async answer() {
              return { text: 'x', meta: {} };
            },
          }),
        },
      ],
      armContext: {},
      regime: { ok: true },
      runId: 'r',
      afterWrite: async (info) => {
        captured = info;
      },
    });
    expect(captured.arm).toBe('mycelium-timeline');
    expect(captured.writeInfo.timeline).toMatchObject({ candidates: 6, adds: 4, keeps: 2, decision_calls: 2, fastpath_adds: 2 });
    expect(captured.writeInfo.timeline.per_question).toHaveLength(2);
    expect(captured.writeInfo.timeline.per_question[0].question_id).toBe('q1');
  });
});

describe('buildReadHits / renderMergedHit — the pure stamp builders', () => {
  it('renderMergedHit: the rendered line, its date, and the supersede line come from ONE structure', () => {
    const fact = { _layer: 'fact', source_id: 'f1', content_text: 'User lives in Lisbon', metadata: { valid_from: '2023/05/01', valid_to: null } };
    const sup = { _layer: 'fact', source_id: 'f2', content_text: 'User lives in Porto', metadata: { valid_from: '2023/04/01', valid_to: '2023/05/01', superseded_by_text: 'User lives in Lisbon' } };
    const supNoText = { _layer: 'fact', source_id: 'f3', content_text: 'x', metadata: { valid_to: 'd', superseded_by_text: null } };
    const ep = { _layer: 'episode', source_id: 'e1', content_text: 'user: hi', metadata: { session_date: '2023/05/02' } };
    expect(renderMergedHit(fact)).toEqual({ line: '[fact | 2023/05/01] User lives in Lisbon', date: '2023/05/01', supersede_line: null });
    expect(renderMergedHit(sup).line).toBe('[fact | 2023/04/01] User lives in Porto\nsuperseded on 2023/05/01 by: User lives in Lisbon');
    expect(renderMergedHit(sup).supersede_line).toBe('superseded on 2023/05/01 by: User lives in Lisbon');
    expect(renderMergedHit(supNoText).supersede_line).toBe('superseded on d by: (new fact not recorded)');
    expect(renderMergedHit(ep)).toEqual({ line: '[session | 2023/05/02] user: hi', date: '2023/05/02', supersede_line: null });
  });

  it('buildReadHits: rank is context order (0-based); a missing server score stamps null', () => {
    const hits = buildReadHits([
      { _layer: 'fact', source_id: 'a', content_text: 'x', score: 7.25, metadata: { valid_from: 'd1', valid_to: null } },
      { _layer: 'episode', source_id: 'b', content_text: 'y', metadata: { session_date: 'd2' } },
    ]);
    expect(hits).toEqual([
      { layer: 'fact', source_id: 'a', rank: 0, score: 7.25, rendered_date: 'd1', rendered_supersede_line: null },
      { layer: 'episode', source_id: 'b', rank: 1, score: null, rendered_date: 'd2', rendered_supersede_line: null },
    ]);
  });

  it('buildReconcileUserPrompt still rejects an empty candidate (the stamp work changed nothing about the prompt contract)', () => {
    expect(() => buildReconcileUserPrompt({ candidate: '', sessionDate: null, existing: [] })).toThrow(/non-empty candidate/);
  });
});
