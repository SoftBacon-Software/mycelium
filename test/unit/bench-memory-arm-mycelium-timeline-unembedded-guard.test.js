import { describe, it, expect } from 'vitest';
import {
  createArmMyceliumTimeline,
  WRITE_DECISION_FIELDS,
} from '../../bench/memory/arms/arm_mycelium_timeline.mjs';
import { runBench } from '../../bench/memory/core.mjs';

// task 213 — the reconcile fastpath's unembedded-top-hit guard (the bench half).
//
// The fastpath (task 205) skips the decision LLM call when the best CURRENT
// same-question hit scores below the threshold. But rows just written are
// embedded ASYNCHRONOUSLY — a reconcile search seconds later may rank the
// newest facts keyword-only — and a keyword-only score inside a hybrid result
// is not evidence that nothing is worth deciding: a SUPERSEDE worth a call can
// score below 0.35 and be auto-ADDed. THE GUARD: when the best current hit is
// explicitly `embedded: false` (the platform's own per-row stamp, task 213's
// server half), the fastpath is withheld and the decision call is PAID —
// counted fastpath_skips_unembedded, ledger source 'fastpath_skipped_unembedded'.
//
// Compatibility contract (the golden-bytes gate depends on it): a hit WITHOUT
// the embedded stamp (undefined/null — a legacy platform or the fixed golden
// fixture, which predates the field) keeps TODAY's fastpath behaviour exactly;
// the guard bites only on the platform's explicit `false`.

const DATES = ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15'];
const SESSIONS = [
  [{ role: 'user', content: 'I just signed the lease for the Lisbon apartment.' }],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];
const EXTRACT_LEASE = { text: '{"facts": ["Signed a lease for an apartment in Lisbon"]}' };
const EXTRACT_DANA = { text: '{"facts": ["User manager is Dana"]}' };

// Same shape as the task-205 stamps harness, plus the one field task 213 adds
// to the server's search rows: `embedded`, TOP-LEVEL on the hit (not metadata).
const factHit = (source_id, text, score, embedded, questionId = 'q1') => ({
  source_id,
  content_text: text,
  score,
  metadata: { layer: 'fact', question_id: questionId, valid_from: '2023/05/20 (Sat) 02:21', valid_to: null },
  ...(embedded === undefined ? {} : { embedded }),
});

function scriptedPlatform({ factPage = [] } = {}) {
  const calls = { searches: [] };
  return {
    calls,
    async indexBulk() {
      return [{ rows: 1 }];
    },
    async search({ query, namespace, limit }) {
      calls.searches.push({ query, namespace, limit });
      if (namespace.endsWith('-timeline')) return { results: factPage, mode: 'hybrid' };
      return { results: [], mode: 'hybrid' };
    },
  };
}

function makeArm({ platform, extractionReplies = [EXTRACT_LEASE, EXTRACT_DANA], decisionReplies = ['ADD'], threshold = 0.35 } = {}) {
  const decisionCalls = [];
  const arm = createArmMyceliumTimeline({
    answerChat: async () => ({ text: 'ok' }),
    extractionChat: async () => extractionReplies[Math.min(0, extractionReplies.length - 1)],
    reconcileChat: async (args) => {
      decisionCalls.push(args);
      const r = decisionReplies[Math.min(decisionCalls.length - 1, decisionReplies.length - 1)];
      return typeof r === 'string' ? { text: r } : r;
    },
    platform,
    namespace: 'bench-p1-r1',
    retrievalBudget: 5,
    runId: 'r1',
    reconcileFastpathThreshold: threshold,
  });
  return { arm, decisionCalls };
}

// Session 0's candidate auto-adds (nothing pending yet); the scripted fact page
// carries f0 so session 1's candidate faces exactly ONE current hit.
async function writeTwoSessions(arm) {
  return arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
}

describe('task 213 — the fastpath withholds on an explicitly unembedded top hit', () => {
  it('BELOW threshold + embedded:false: the fastpath is WITHHELD — the decision call is paid, counted fastpath_skips_unembedded', async () => {
    // Pre-guard this was fastpath_adds:1, decision_calls:0 — an auto-ADD decided
    // on a keyword-only score. The guard pays the call instead.
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.2, false)] });
    const { arm, decisionCalls } = makeArm({ platform, decisionReplies: ['ADD'] });
    const w = await writeTwoSessions(arm);
    expect(w.timeline).toMatchObject({
      candidates: 2,
      auto_adds: 1,
      fastpath_adds: 0,
      fastpath_skips_unembedded: 1,
      decision_calls: 1,
    });
    expect(decisionCalls).toHaveLength(1); // the call the fastpath would have skipped
    const entry = w.timeline.candidates_ledger[1];
    expect(entry).toMatchObject({
      session_index: 1,
      source: 'fastpath_skipped_unembedded',
      decision: 'ADD',
      ok: true,
      top_score: 0.2,
    });
  });

  it('ABOVE threshold + embedded:false: pays the decision call like any other candidate, and the ledger records that the score was unembedded', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.9, false)] });
    const { arm, decisionCalls } = makeArm({ platform, decisionReplies: ['ADD'] });
    const w = await writeTwoSessions(arm);
    expect(w.timeline).toMatchObject({
      candidates: 2,
      decision_calls: 1,
      fastpath_adds: 0,
      fastpath_skips_unembedded: 1,
    });
    expect(decisionCalls).toHaveLength(1);
    expect(w.timeline.candidates_ledger[1]).toMatchObject({
      source: 'fastpath_skipped_unembedded',
      top_score: 0.9,
    });
  });

  it('an embedded:true top hit below the threshold keeps the fastpath EXACTLY as today (skip count 0)', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.2, true)] });
    const { arm, decisionCalls } = makeArm({ platform });
    const w = await writeTwoSessions(arm);
    expect(w.timeline).toMatchObject({
      candidates: 2,
      auto_adds: 1,
      fastpath_adds: 1,
      fastpath_skips_unembedded: 0,
      decision_calls: 0,
    });
    expect(decisionCalls).toHaveLength(0);
    expect(w.timeline.candidates_ledger[1].source).toBe('fastpath_below_threshold');
  });

  it('an embedded:true top hit above the threshold is a plain decision (source "decision", skip count 0)', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.9, true)] });
    const { arm } = makeArm({ platform });
    const w = await writeTwoSessions(arm);
    expect(w.timeline).toMatchObject({ decision_calls: 1, fastpath_adds: 0, fastpath_skips_unembedded: 0 });
    expect(w.timeline.candidates_ledger[1].source).toBe('decision');
  });

  it('COMPATIBILITY: a hit with NO embedded stamp (the golden-fixture / legacy-platform shape) keeps today\'s fastpath', async () => {
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.2)] }); // no embedded field
    const { arm, decisionCalls } = makeArm({ platform });
    const w = await writeTwoSessions(arm);
    expect(w.timeline).toMatchObject({
      candidates: 2,
      auto_adds: 1,
      fastpath_adds: 1, // the pre-guard behaviour, byte-for-byte
      fastpath_skips_unembedded: 0,
      decision_calls: 0,
    });
    expect(decisionCalls).toHaveLength(0);
    expect(w.timeline.candidates_ledger[1].source).toBe('fastpath_below_threshold');
  });

  it('the row-meta stamp is UNTOUCHED: WRITE_DECISION_FIELDS stays the 7 task-205 fields — no guard key rides meta', async () => {
    expect(WRITE_DECISION_FIELDS).toEqual([
      'candidates', 'adds', 'supersedes', 'keeps', 'decision_calls', 'decision_failures', 'fastpath_adds',
    ]);
    const platform = scriptedPlatform({ factPage: [factHit('r1-q1-tl-f0', 'Signed a lease in Lisbon', 0.2, false)] });
    const { arm } = makeArm({ platform });
    const w = await writeTwoSessions(arm);
    // the snapshot the arm stamps for answer() is keyed off WRITE_DECISION_FIELDS —
    // the guard count rides w.timeline / summary.json only
    expect(Object.keys(w.timeline)).toContain('fastpath_skips_unembedded');
    expect(WRITE_DECISION_FIELDS.every((f) => typeof w.timeline[f] === 'number')).toBe(true);
  });
});

describe('task 213 — the guard count rides summary.json write_info (hermetic forced-degraded run)', () => {
  // The pre-committed hermetic number: a forced-degraded run (every top hit
  // stamped unembedded) skips >= 1 and EVERY skip paid a decision call. Runs
  // the REAL arm through the REAL runBench row path with a scripted platform —
  // no live platform, no model.
  it('a forced-degraded hermetic run: skips >= 1, every skip paid its decision call, summary.write_info carries the sum', async () => {
    let seq = 0;
    const platform = {
      async indexBulk() {
        return [{ rows: 1 }];
      },
      async search() {
        seq += 1;
        // session 0's candidate faces an empty layer (auto-add); session 1's
        // candidate surfaces the flushed f0 row, explicitly UNEMBEDDED, above
        // the threshold — the skip must pay a decision call
        return {
          results: seq >= 2 ? [factHit('r1-qk-tl-f0', 'Signed a lease in Lisbon', 0.8, false, 'qk')] : [],
          mode: 'hybrid',
        };
      },
    };
    const scripted = (replies) => {
      let i = 0;
      return async () => ({ text: replies[Math.min(i++, replies.length - 1)] });
    };
    const items = [
      {
        question_id: 'qk',
        question_type: 'multi-session',
        question: 'When does the lease start?',
        answer: 'May',
        haystack_dates: DATES,
        haystack_sessions: SESSIONS,
      },
    ];
    const { summary } = await runBench({
      items,
      armFactories: [{ name: 'mycelium-timeline', factory: (ctx) => createArmMyceliumTimeline(ctx) }],
      armContext: {
        answerChat: async () => ({ text: 'ok' }),
        extractionChat: scripted(['{"facts": ["Signed a lease for an apartment in Lisbon"]}', '{"facts": ["User manager is Dana"]}', '{"facts": ["Third fact"]}']),
        reconcileChat: scripted(['ADD', 'ADD']),
        platform,
        namespace: 'bench-p1-guard',
        retrievalBudget: 5,
        runId: 'r1',
      },
      regime: Object.freeze({ date_utc: '2026-09-17T00:00:00.000Z', notes: [] }),
      runId: 'r1',
    });
    const tl = summary.arms['mycelium-timeline'].write.timeline;
    expect(tl.fastpath_skips_unembedded).toBeGreaterThanOrEqual(1);
    // EVERY skip paid a decision call: the ledger's guard entries are a subset
    // of the decision-call entries, 1:1
    const guardEntries = tl.per_question.flatMap((q) => q.candidates_ledger).filter((e) => e.source === 'fastpath_skipped_unembedded');
    expect(guardEntries.length).toBe(tl.fastpath_skips_unembedded);
    expect(tl.decision_calls).toBeGreaterThanOrEqual(guardEntries.length);
    expect(tl.fastpath_adds).toBe(0); // nothing fastpathed through an unembedded score
  });
});
