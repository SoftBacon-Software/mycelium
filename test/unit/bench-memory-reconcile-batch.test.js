// arm_mycelium_timeline — the BATCH reconcile decision path (task 234, the §3
// cost leg). v1 pays ONE decision call per CANDIDATE (measured ×5.71 of the
// extract arm's stamped seconds_per_session — receipts/2026-09-18-p1-154254.md,
// reconcile_ms 23,788 vs 11,236 over the same 5 sessions); the batch lever
// collects the session's call-bound candidates and decides them in ONE call per
// batch (cap BENCH_RECONCILE_BATCH, default 8; a remainder pays another call).
// The per-candidate SEARCHES stay — the ledger needs top_score/shown per
// candidate and the fastpath guard needs the embedded stamp; only the DECISION
// calls batch. Opt-in MYCELIUM_TIMELINE_RECONCILE_BATCH=1 — the default path
// stays the measured arm (pinned again below: same fixture, per-candidate
// calls). Hermetic: fake platform, no live calls.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createArmMyceliumTimeline,
  parseDecision,
  parseDecisionBatch,
  buildReconcileBatchUserPrompt,
  resolveReconcileBatchMode,
  resolveReconcileBatchSize,
  RECONCILE_BATCH_ENV,
  RECONCILE_BATCH_SIZE_ENV,
  RECONCILE_BATCH_SIZE,
  RECONCILE_PROMPT_VERSION_V1,
  RECONCILE_BATCH_PROMPT_VERSION,
  RECONCILE_SYSTEM,
  RECONCILE_SYSTEM_BATCH,
  WRITE_DECISION_FIELDS,
  WRITE_DECISION_FIELDS_BATCH,
} from '../../bench/memory/arms/arm_mycelium_timeline.mjs';

const DATES = ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15'];
// session 0 extracts TWO facts (both auto-add: nothing pending yet, no calls);
// session 1 extracts THREE candidates whose searches hit both current facts —
// every one of them would pay a call in v1.
const SESSIONS = [
  [{ role: 'user', content: 'I just signed the lease for the Lisbon apartment.' }],
  [{ role: 'user', content: 'Update week: my manager is Dana, my lease starts June.' }],
];
const EXTRACT_REPLIES = [
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon", "User works from Porto"]}' },
  { text: '{"facts": ["My manager is Dana now", "Lease starts in June", "User bought a desk"]}' },
];

// Same in-memory platform stand-in as bench-memory-arm-mycelium-timeline.test.js
// (memory-rows mode), plus per-row `embedded` stamps for the task-213 guard.
function fakePlatform({ embedded } = {}) {
  const rows = new Map(); // ns|source_type|source_id -> row
  const calls = { bulk: [], searches: [] };
  return {
    calls,
    rows,
    async indexBulk(items) {
      calls.bulk.push(items);
      let written = 0;
      for (const it of items) {
        rows.set(`${it.namespace}|${it.source_type}|${it.source_id}`, { ...it, chunk_index: 0 });
        written += 1;
      }
      return [{ rows: written }];
    },
    async search({ query, namespace, sourceTypes, limit }) {
      calls.searches.push({ query, namespace, sourceTypes, limit });
      const out = [];
      for (const r of rows.values()) {
        if (r.namespace !== namespace) continue;
        if (sourceTypes?.length && !sourceTypes.includes(r.source_type)) continue;
        out.push({
          source_id: r.source_id,
          content_text: r.content_text,
          metadata: r.metadata,
          score: 1,
          ...(embedded === undefined ? {} : { embedded }),
        });
      }
      return { results: out.slice(0, limit), mode: 'hybrid' };
    },
  };
}

function fakeChat(script) {
  const calls = [];
  const chat = async (args) => {
    calls.push(args);
    if (script.length === 0) throw new Error('fake chat: script exhausted');
    const r = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof r === 'string' ? { text: r } : r;
  };
  return { calls, chat };
}

function makeArm({ platform, decision, ...rest } = {}) {
  return createArmMyceliumTimeline({
    answerChat: async () => ({ text: 'ok' }),
    extractionChat: fakeChat([...EXTRACT_REPLIES]).chat,
    reconcileChat: decision?.chat ?? fakeChat(['ADD']).chat,
    platform: platform ?? fakePlatform(),
    namespace: 'bench-p1-r1',
    retrievalBudget: 5,
    runId: 'r1',
    ...rest,
  });
}

// The two current facts both sessions' searches surface (auto-added in s0),
// in insertion order.
const F0 = 'r1-q1-tl-f0';
const F1 = 'r1-q1-tl-f1';

describe('parseDecisionBatch — the batch reply contract (task 234)', () => {
  const set = (...ids) => new Set(ids);

  it('parses N numbered lines in candidate order: ADD | SUPERSEDE <shown id> | KEEP', () => {
    const r = parseDecisionBatch('1. ADD\n2. SUPERSEDE f1\n3. KEEP', [set(), set('f1'), set('f1')]);
    expect(r.decisions).toEqual([
      { action: 'ADD', id: null, ok: true },
      { action: 'SUPERSEDE', id: 'f1', ok: true },
      { action: 'KEEP', id: null, ok: true },
    ]);
    expect(r.decision_failures).toBe(0);
    expect(r.supersede_conflicts).toBe(0);
  });

  it('a line naming an id not in THAT candidate\'s shown set → fail-open ADD, counted (the stamped v1 rule)', () => {
    const r = parseDecisionBatch('1. SUPERSEDE ghost', [set('f1')]);
    expect(r.decisions).toEqual([{ action: 'ADD', id: null, ok: false }]);
    expect(r.decision_failures).toBe(1);
  });

  it('an unparseable line and a MISSING line both fail open to ADD, counted — never a silent drop', () => {
    const r = parseDecisionBatch('1. ADD\nthe second one is a duplicate I think', [set(), set('f1'), set('f1')]);
    expect(r.decisions).toEqual([
      { action: 'ADD', id: null, ok: true },
      { action: 'ADD', id: null, ok: false },
      { action: 'ADD', id: null, ok: false }, // no line at all for candidate 3
    ]);
    expect(r.decision_failures).toBe(2);
  });

  it('two candidates SUPERSEDING the same id: the FIRST line wins, later ones fall back to ADD, counted supersede_conflicts', () => {
    const r = parseDecisionBatch('1. SUPERSEDE f1\n2. SUPERSEDE f1\n3. ADD', [set('f1'), set('f1'), set()]);
    expect(r.decisions).toEqual([
      { action: 'SUPERSEDE', id: 'f1', ok: true },
      { action: 'ADD', id: null, ok: false },
      { action: 'ADD', id: null, ok: true },
    ]);
    expect(r.supersede_conflicts).toBe(1);
    expect(r.decision_failures).toBe(0); // the conflict is not a parse failure
  });

  it('KEEP is only legal for a candidate whose shown set was non-empty (mirrors v1, where KEEP was unreachable with nothing shown)', () => {
    const r = parseDecisionBatch('1. KEEP', [set()]);
    expect(r.decisions).toEqual([{ action: 'ADD', id: null, ok: false }]);
    expect(r.decision_failures).toBe(1);
  });

  it('a SUPERSEDE id claimed by a candidate that failed open does NOT win the id — a later valid claim takes it', () => {
    // candidate 1's SUPERSEDE names an id NOT in its own shown set (fail-open);
    // candidate 2's SUPERSEDE names the same id and IS valid — no conflict, it wins
    const r = parseDecisionBatch('1. SUPERSEDE f2\n2. SUPERSEDE f1', [set('f1'), set('f1', 'f2')]);
    expect(r.decisions).toEqual([
      { action: 'ADD', id: null, ok: false },
      { action: 'SUPERSEDE', id: 'f1', ok: true },
    ]);
    expect(r.decision_failures).toBe(1);
    expect(r.supersede_conflicts).toBe(0);
  });

  it('strips <think> blocks and code fences like v1; tolerates `1)` / `1 -` numbering and trailing punctuation on ids', () => {
    const r = parseDecisionBatch(
      '<think>reasoning here</think>```\n1) ADD\n2 - SUPERSEDE f9.,\n```',
      [set(), set('f9')]
    );
    expect(r.decisions).toEqual([
      { action: 'ADD', id: null, ok: true },
      { action: 'SUPERSEDE', id: 'f9', ok: true },
    ]);
  });

  it('a duplicate line number: first wins; a number outside the batch names no candidate (its target still fail-opens, counted)', () => {
    const dup = parseDecisionBatch('1. ADD\n1. KEEP', [set()]);
    expect(dup.decisions).toEqual([{ action: 'ADD', id: null, ok: true }]);

    const outOfRange = parseDecisionBatch('9. ADD', [set('f1')]);
    expect(outOfRange.decisions).toEqual([{ action: 'ADD', id: null, ok: false }]);
    expect(outOfRange.decision_failures).toBe(1);
  });

  it('v1 parseDecision is untouched (the measured parser, pinned)', () => {
    expect(parseDecision('SUPERSEDE f1', set('f1'))).toEqual({ action: 'SUPERSEDE', id: 'f1', ok: true });
    expect(parseDecision('ADD', set())).toEqual({ action: 'ADD', id: null, ok: true });
    expect(parseDecision('SUPERSEDE ghost', set('f1')).ok).toBe(false);
  });
});

describe('RECONCILE_SYSTEM_BATCH — v1 rules verbatim + the batch contract', () => {
  it('carries v1\'s three rules verbatim', () => {
    expect(RECONCILE_SYSTEM_BATCH).toContain('Prefer ADD when unsure: SUPERSEDE requires the same specific subject whose state changed, not merely extra detail.');
    expect(RECONCILE_SYSTEM_BATCH).toContain('KEEP is only for true duplicates; a changed detail is SUPERSEDE.');
    expect(RECONCILE_SYSTEM_BATCH).toContain('Never invent an id that was not shown to you.');
  });

  it('states the batch contract: numbered candidates, facts shown once, exactly N lines in order', () => {
    expect(RECONCILE_SYSTEM_BATCH).toMatch(/numbered/i);
    expect(RECONCILE_SYSTEM_BATCH).toMatch(/shown once/i);
    expect(RECONCILE_SYSTEM_BATCH).toMatch(/exactly N lines/i);
    expect(RECONCILE_SYSTEM_BATCH).toMatch(/in order/i);
  });

  it('the prompt versions are named for the regime stamp', () => {
    expect(RECONCILE_PROMPT_VERSION_V1).toBe('reconcile-prompt.1-per-candidate');
    expect(RECONCILE_BATCH_PROMPT_VERSION).toBe('reconcile-prompt.2-batch');
  });
});

describe('buildReconcileBatchUserPrompt — facts shown ONCE, candidates numbered', () => {
  it('unions the candidates\' shown sets (first-seen order), renders v1\'s line format, numbers the candidates', () => {
    const items = [
      {
        candidate: 'My manager is Dana now',
        shown: [
          { id: 'f1', text: 'Signed a lease in Lisbon', valid_from: '2023/05/20 (Sat) 02:21' },
          { id: 'f0', text: 'User works from Porto', valid_from: '2023/05/20 (Sat) 02:21', this_session: true },
        ],
      },
      {
        candidate: 'Lease starts in June',
        shown: [{ id: 'f1', text: 'Signed a lease in Lisbon', valid_from: '2023/05/20 (Sat) 02:21' }],
      },
    ];
    const p = buildReconcileBatchUserPrompt({ sessionDate: '2023/05/21 (Sun) 09:15', items });
    // the union, deduped — f1 appears ONCE though both candidates were shown it
    expect(p.match(/^f1 \|/gm)).toHaveLength(1);
    expect(p.match(/^f0 \|/gm)).toHaveLength(1);
    expect(p).toContain('f1 | 2023/05/20 (Sat) 02:21 | current | Signed a lease in Lisbon');
    expect(p).toContain('f0 | 2023/05/20 (Sat) 02:21 | current (this session) | User works from Porto');
    expect(p).toContain('Session date: 2023/05/21 (Sun) 09:15');
    expect(p).toContain('1. My manager is Dana now');
    expect(p).toContain('2. Lease starts in June');
    expect(p).toContain('exactly 2 lines');
  });
});

describe('the batch levers — opt-in env, batch size cap', () => {
  const saved = {};
  const saveEnv = () => {
    saved[RECONCILE_BATCH_ENV] = process.env[RECONCILE_BATCH_ENV];
    saved[RECONCILE_BATCH_SIZE_ENV] = process.env[RECONCILE_BATCH_SIZE_ENV];
  };
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('default: batch OFF, source default; =1/true turns it on; =0/false is an explicit off; junk is loud', () => {
    delete process.env[RECONCILE_BATCH_ENV];
    expect(resolveReconcileBatchMode()).toEqual({ batch: false, source: 'default' });
    process.env[RECONCILE_BATCH_ENV] = '1';
    expect(resolveReconcileBatchMode()).toEqual({ batch: true, source: 'env' });
    process.env[RECONCILE_BATCH_ENV] = 'true';
    expect(resolveReconcileBatchMode().batch).toBe(true);
    process.env[RECONCILE_BATCH_ENV] = '0';
    expect(resolveReconcileBatchMode()).toEqual({ batch: false, source: 'env' });
    process.env[RECONCILE_BATCH_ENV] = 'yes';
    expect(() => resolveReconcileBatchMode()).toThrow(RECONCILE_BATCH_ENV);
  });

  it('batch size: default 8; a positive-int env override wins; junk/zero/fractional throws', () => {
    expect(RECONCILE_BATCH_SIZE).toBe(8);
    delete process.env[RECONCILE_BATCH_SIZE_ENV];
    expect(resolveReconcileBatchSize()).toEqual({ size: 8, source: 'default' });
    process.env[RECONCILE_BATCH_SIZE_ENV] = '3';
    expect(resolveReconcileBatchSize()).toEqual({ size: 3, source: 'env' });
    for (const junk of ['0', '-1', '2.5', 'eight']) {
      process.env[RECONCILE_BATCH_SIZE_ENV] = junk;
      expect(() => resolveReconcileBatchSize()).toThrow(RECONCILE_BATCH_SIZE_ENV);
    }
  });
});

describe('write() under MYCELIUM_TIMELINE_RECONCILE_BATCH=1 — the calls batch, the searches do not', () => {
  // Fixture arithmetic (the in-session window at work): s0's TWO candidates are
  // 1 auto-add + 1 call-bound (the second sees the first through sessionFacts);
  // s1's THREE candidates all see both flushed facts → s0's queue batches into
  // ONE call, s1's into ONE call — ONE call per session's queue.
  it('3 call-bound candidates / 2 current facts → EXACTLY ONE reconcileChat call for the session, 3 decision-batch ledger entries', async () => {
    const platform = fakePlatform();
    const decision = fakeChat(['1. ADD', '1. SUPERSEDE r1-q1-tl-f0\n2. ADD\n3. KEEP']);
    const arm = makeArm({ platform, decision, reconcileBatch: true });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });

    // one call PER SESSION'S QUEUE (2 total), both the BATCH prompt
    expect(decision.calls).toHaveLength(2);
    expect(decision.calls[0].system).toBe(RECONCILE_SYSTEM_BATCH);
    expect(decision.calls[1].system).toBe(RECONCILE_SYSTEM_BATCH);
    // the s1 call: THREE candidates in ONE call; the 2 current facts shown ONCE
    const user = decision.calls[1].user;
    expect(user).toContain('Existing facts (id | valid_from | status | text):');
    expect(user.match(/^r1-q1-tl-f0 \|/gm)).toHaveLength(1);
    expect(user.match(/^r1-q1-tl-f1 \|/gm)).toHaveLength(1);
    expect(user).toContain('1. My manager is Dana now');
    expect(user).toContain('2. Lease starts in June');
    expect(user).toContain('3. User bought a desk');
    expect(user).toContain('exactly 3 lines');

    // counts: decision_calls counts CALLS; decisions_batched counts candidates
    expect(w.timeline).toMatchObject({
      candidates: 5,
      auto_adds: 1, // s0's first candidate only — the second saw it through the session window
      decision_calls: 2, // s0's queue (1 candidate) + s1's queue (3 candidates)
      decisions_batched: 4,
      decision_failures: 0,
      supersede_conflicts: 0,
      supersedes: 1,
      adds: 3, // f0 auto + f1 (s0's batch ADD) + the batch's ADD
      keeps: 1,
    });

    // the ledger: every candidate recorded; the queued ones stamp source decision-batch
    const ledger = w.timeline.candidates_ledger;
    expect(ledger).toHaveLength(5);
    expect(ledger[0]).toMatchObject({ source: 'auto_add_on_no_match', decision: 'ADD' });
    expect(ledger.slice(1).map((e) => e.source)).toEqual(['decision-batch', 'decision-batch', 'decision-batch', 'decision-batch']);
    expect(ledger.slice(2).map((e) => e.decision)).toEqual(['SUPERSEDE', 'ADD', 'KEEP']);
    expect(ledger[2].shown_ids).toEqual([F0, F1]);
    expect(ledger[2].source_id).toBeTruthy(); // the SUPERSEDE wrote a fact
    expect(ledger[4].source_id).toBeNull(); // the KEEP wrote nothing

    // the SUPERSEDE's write semantics are v1's: old row flipped in place, new row carries supersedes
    const old = platform.rows.get(`bench-p1-r1-timeline|bench_longmemeval|${F0}`);
    expect(old.metadata.valid_to).toBe('2023/05/21 (Sun) 09:15');
    const neu = [...platform.rows.values()].find((r) => r.metadata.supersedes === F0);
    expect(neu).toBeTruthy();
    expect(neu.content_text).toBe('My manager is Dana now');
  });

  it('a queue larger than the cap pays another call for the remainder (cap 2: s0 pays 1 call for 1, s1 pays 2 calls for 3)', async () => {
    const decision = fakeChat(['1. ADD', '1. ADD\n2. ADD', '1. ADD']);
    const arm = makeArm({ platform: fakePlatform(), decision, reconcileBatch: true, reconcileBatchSize: 2 });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(decision.calls).toHaveLength(3);
    expect(decision.calls[1].user).toContain('1. My manager is Dana now');
    expect(decision.calls[1].user).toContain('2. Lease starts in June');
    expect(decision.calls[2].user).toContain('1. User bought a desk');
    expect(w.timeline.decision_calls).toBe(3);
    expect(w.timeline.decisions_batched).toBe(4);
  });

  it('a fail-open inside the batch still WRITES (ADD) and counts decision_failures — never a silent drop', async () => {
    const decision = fakeChat(['1. ADD', '1. SUPERSEDE not-a-shown-id\n2. ADD\n3. KEEP']);
    const arm = makeArm({ platform: fakePlatform(), decision, reconcileBatch: true });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline.decision_failures).toBe(1);
    expect(w.timeline.supersedes).toBe(0);
    expect(w.timeline.adds).toBe(4); // f0 auto + f1 + the fail-open ADD + candidate 2
    const ledger = w.timeline.candidates_ledger;
    expect(ledger[2]).toMatchObject({ decision: 'ADD', ok: false, source: 'decision-batch' });
  });

  it('the fastpath and the task-213 guard still apply PER CANDIDATE, before the queue: below-threshold ADDs pay nothing; unembedded top hits still pay (through the batch)', async () => {
    // top hits BELOW the threshold: every call-bound candidate fastpaths — ZERO calls
    const below = makeArm({
      platform: { ...fakePlatform(), search: async (args) => ({ results: args.namespace.endsWith('-timeline') ? [{ source_id: F0, content_text: 'x', metadata: { question_id: 'q1', valid_to: null, valid_from: 'd' }, score: 0.1 }] : { results: [], mode: 'hybrid' } }) },
      reconcileBatch: true,
      reconcileFastpathThreshold: 0.35,
    });
    const wb = await below.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(wb.timeline.decision_calls).toBe(0);
    expect(wb.timeline.fastpath_adds).toBe(4); // s0's second candidate + s1's three
    expect(wb.timeline.decisions_batched).toBe(0);

    // top hit explicitly UNEMBEDDED: the guard withholds the fastpath — the
    // candidates pay, through the batch (counted, source decision-batch)
    const platform = fakePlatform({ embedded: false });
    const decision = fakeChat(['1. ADD', '1. ADD\n2. ADD\n3. ADD']);
    const guard = makeArm({ platform, decision, reconcileBatch: true });
    const wg = await guard.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(wg.timeline.decision_calls).toBe(2);
    // only the SERVER-hit candidates count the skip (s0's in-window candidate
    // has no server hit yet — topScore null, topEmbedded null — same as v1)
    expect(wg.timeline.fastpath_skips_unembedded).toBe(3);
    expect(wg.timeline.decisions_batched).toBe(4);
    expect(wg.timeline.candidates_ledger.slice(1).every((e) => e.source === 'decision-batch')).toBe(true);
  });

  it('the DEFAULT path is unchanged on the same fixture: one call PER CANDIDATE, the v1 prompt, batch counters at zero', async () => {
    const decision = fakeChat(['ADD']);
    const arm = makeArm({ platform: fakePlatform(), decision }); // no flag
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(decision.calls).toHaveLength(4); // s0's second candidate + s1's three
    for (const c of decision.calls) expect(c.system).toBe(RECONCILE_SYSTEM);
    expect(w.timeline).toMatchObject({ decision_calls: 4, decisions_batched: 0, supersede_conflicts: 0, decision_failures: 0 });
  });

  it('the answer-row stamp: the default path keeps the v1 SEVEN fields; the batch path stamps NINE (calls vs candidates + conflicts)', async () => {
    expect(WRITE_DECISION_FIELDS_BATCH).toEqual([...WRITE_DECISION_FIELDS, 'decisions_batched', 'supersede_conflicts']);

    const plain = makeArm({ platform: fakePlatform() });
    await plain.write(SESSIONS.slice(0, 1), { questionId: 'q1', sessionDates: DATES });
    const a1 = await plain.answer('q', { question_id: 'q1' });
    expect(Object.keys(a1.meta.write_decisions)).toEqual(WRITE_DECISION_FIELDS);

    const batch = makeArm({ platform: fakePlatform(), decision: fakeChat(['1. ADD']), reconcileBatch: true });
    await batch.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    const a2 = await batch.answer('q', { question_id: 'q1' });
    expect(Object.keys(a2.meta.write_decisions)).toEqual(WRITE_DECISION_FIELDS_BATCH);
    expect(a2.meta.write_decisions).toMatchObject({ decision_calls: 2, decisions_batched: 4, supersede_conflicts: 0 });
  });
});

// THE RECEIPT DEFECT (task 234, found in receipts/2026-09-18-p1-154254.md): ONE
// receipt quoted TWO cost ratios — line 39 "cost ×1.45 of extract" (the
// timelineCostLine renderer: LLM-time numerator over a hard-coded 2026-09-10
// extract stamp) and line 77 "×5.71" (the win-condition bound: both sides from
// the run's OWN stamped seconds_per_session). A quotable artifact cannot quote
// two costs. The win-condition renderer is the one that keeps (its denominator
// is the extract ARM's stamped seconds_per_session, same-run); timelineCostLine
// is the one that dies.
describe('receipt — ONE cost ratio, one renderer (the ×1.45/×5.71 defect)', () => {
  it('a run carrying both stamps renders the win-condition bound and NO second cost line', async () => {
    const { renderReceipt } = await import('../../bench/memory/receipt.mjs');
    const writeInfo = {
      'mycelium-timeline': {
        docs: 2,
        extract_ms: 1_000,
        reconcile_ms: 13_000,
        timeline: {
          candidates: 5, adds: 3, supersedes: 1, keeps: 1, auto_adds: 2,
          decision_calls: 1, decision_failures: 0, fastpath_adds: 0, fastpath_skips_unembedded: 0,
          per_question: [{ question_id: 'q1', seconds_per_session: [7.0, 7.1] }],
        },
      },
      'mycelium-extract': {
        docs: 2,
        extract_ms: 7_000,
        extract: { per_question: [{ question_id: 'q1', seconds_per_session: [1.2, 1.3] }] },
      },
    };
    const armScore = (exact, wrong) => ({ n: exact + wrong, score: { counts: { exact, partial: 0, wrong }, p1_score: exact / (exact + wrong) } });
    const summary = {
      run_id: 'r-test',
      regime: {},
      arms: { 'mycelium-timeline': armScore(1, 1), 'mycelium-extract': armScore(2, 0) },
    };
    const judged = [
      { arm: 'mycelium-timeline', question_id: 'q1', label: 'wrong', question_type: 'knowledge-update' },
      { arm: 'mycelium-timeline', question_id: 'q2', label: 'exact', question_type: 'knowledge-update' },
      { arm: 'mycelium-extract', question_id: 'q1', label: 'exact', question_type: 'knowledge-update' },
      { arm: 'mycelium-extract', question_id: 'q2', label: 'exact', question_type: 'knowledge-update' },
    ];
    const md = renderReceipt({ runId: 'r-test', summary, judged, writeInfo, generatedAt: '2026-09-18T12:00:00Z' });

    // the KEPT renderer: the win-condition bound, judged from the run's own stamps
    expect(md).toContain('Cost bound (timeline write cost ≤ 2× extract):');
    // the DELETED renderer: gone
    expect(md).not.toContain('Write cost (mycelium-timeline):');
    expect(md).not.toContain('of extract; bound ≤ 2×');
    // and ONE ratio is quoted everywhere the receipt says "cost ×N.NN" — two
    // renderers with two denominators would quote two numbers
    const ratios = [...md.matchAll(/cost ×(\d+\.\d+)/g)].map((m) => m[1]);
    expect(ratios.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ratios).size).toBe(1);
  });
});
