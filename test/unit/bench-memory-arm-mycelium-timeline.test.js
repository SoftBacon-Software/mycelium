import { describe, it, expect } from 'vitest';
import {
  createArmMyceliumTimeline,
  buildReconcileUserPrompt,
  parseDecision,
  myceliumTimelineNamespace,
  myceliumTimelineNamespaces,
  sessionDateFor,
  RECONCILE_SYSTEM,
} from '../../bench/memory/arms/arm_mycelium_timeline.mjs';
import { RAG_SYSTEM } from '../../bench/memory/arms/arm_mycelium.mjs';
import { runBench } from '../../bench/memory/core.mjs';
import { buildRegime } from '../../bench/memory/regime.mjs';

const DATES = ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15', '2023/05/22 (Mon) 18:00'];

const SESSIONS = [
  [
    { role: 'user', content: 'I just signed the lease for the Lisbon apartment.' },
    { role: 'assistant', content: 'Congrats — Lisbon awaits!' },
  ],
  [{ role: 'user', content: 'Update: my move to Lisbon got pulled forward to June.' }],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

// An in-memory stand-in for the platform index: upsert on
// (source_type, source_id, chunk 0) exactly like sm_embeddings, search scoped
// by namespace in insertion order. Just enough server to exercise the arm's
// filtering and supersede bookkeeping hermetically.
function fakePlatform() {
  const rows = new Map(); // ns|source_type|source_id -> row
  const calls = { bulk: [], searches: [] };
  return {
    calls,
    rows,
    async indexBulk(items) {
      calls.bulk.push(items);
      let written = 0;
      for (const it of items) {
        const key = `${it.namespace}|${it.source_type}|${it.source_id}`;
        const existed = rows.has(key);
        rows.set(key, { ...it, chunk_index: 0 });
        written += existed ? 1 : 1; // an upsert rewrites one row either way
      }
      return [{ rows: written }];
    },
    async search({ query, namespace, sourceTypes, limit }) {
      calls.searches.push({ query, namespace, sourceTypes, limit });
      const out = [];
      for (const r of rows.values()) {
        if (r.namespace !== namespace) continue;
        if (sourceTypes?.length && !sourceTypes.includes(r.source_type)) continue;
        out.push({ source_id: r.source_id, content_text: r.content_text, metadata: r.metadata, score: 1 });
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

// extraction replies: one fact list per session, in order
const EXTRACT_REPLIES = [
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon"]}' },
  { text: '{"facts": ["Moves to Lisbon in June"]}' },
  { text: '{"facts": ["User manager is Dana"]}' },
];

function makeArm({ platform, extraction, decision, ...rest } = {}) {
  return createArmMyceliumTimeline({
    answerChat: async () => ({ text: 'ok' }),
    extractionChat: extraction?.chat ?? fakeChat([...EXTRACT_REPLIES]).chat,
    reconcileChat: decision?.chat ?? fakeChat(['ADD']).chat,
    platform: platform ?? fakePlatform(),
    namespace: 'bench-p1-r1',
    retrievalBudget: 5,
    runId: 'r1',
    ...rest,
  });
}

describe('arm_mycelium_timeline — the §3 timeline arm', () => {
  it('write(): episodic row is arm_mycelium\'s verbatim row + the session date; reconciled facts land in the -timeline namespace', async () => {
    const platform = fakePlatform();
    const arm = makeArm({ platform });
    const w = await arm.write(SESSIONS.slice(0, 1), { questionId: 'q1', sessionDates: DATES });
    expect(w.docs).toBe(1);
    expect(w.facts_per_session).toEqual([1]);
    expect(w.parse_failures).toBe(0);

    const episode = platform.rows.get('bench-p1-r1|bench_longmemeval|r1-q1-s0');
    expect(episode.content_text).toBe('user: I just signed the lease for the Lisbon apartment.\nassistant: Congrats — Lisbon awaits!');
    expect(episode.namespace).toBe('bench-p1-r1'); // the BASE namespace — arm_mycelium's place
    expect(episode.metadata).toMatchObject({
      question_id: 'q1', session_index: 0, bench: 'longmemeval', run_id: 'r1',
      layer: 'episode', session_date: '2023/05/20 (Sat) 02:21',
    });

    const fact = [...platform.rows.values()].find((r) => r.metadata.layer === 'fact');
    expect(fact.namespace).toBe('bench-p1-r1-timeline');
    expect(fact.source_id).toBe('r1-q1-tl-f0');
    expect(fact.content_text).toBe('Signed a lease for an apartment in Lisbon');
    expect(fact.metadata).toMatchObject({
      question_id: 'q1', layer: 'fact', episode: 'r1-q1-s0',
      session_date: '2023/05/20 (Sat) 02:21',
      valid_from: '2023/05/20 (Sat) 02:21', valid_to: null,
      supersedes: null, superseded_by: null, superseded_by_text: null,
      ingestion: 'timeline', run_id: 'r1',
    });
    expect(w.rows).toBe(2); // episode + fact, from the bulk receipts
    expect(w.timeline).toMatchObject({ adds: 1, supersedes: 0, keeps: 0, auto_adds: 1, decision_calls: 0, decision_failures: 0 });
    expect(w.timeline.seconds_per_session).toHaveLength(1);
  });

  it('write(): the full supersede flow in ONE write() — old fact keeps its row with valid_to, new fact carries supersedes + episode', async () => {
    const platform = fakePlatform();
    // s1's candidate supersedes f0; s2's Dana fact then sees f1 (current) and is a plain ADD
    const decision = fakeChat(['SUPERSEDE r1-q1-tl-f0', 'ADD']);
    const arm = makeArm({ platform, decision });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });

    // adds: 2 = f0's auto-ADD + the s2 decided ADD (the ledger counts every
    // written new fact); the SUPERSEDE's new row counts under supersedes only
    expect(w.timeline).toMatchObject({ adds: 2, supersedes: 1, keeps: 0, auto_adds: 1, decision_calls: 2, decision_failures: 0 });

    // f0 was FLUSHED in session 0, so the supersede crossed a flush boundary:
    // the upsert must have rewritten the platform row, not a dead local copy
    const old = platform.rows.get('bench-p1-r1-timeline|bench_longmemeval|r1-q1-tl-f0');
    expect(old.metadata.valid_to).toBe('2023/05/21 (Sun) 09:15'); // superseding session's date
    expect(old.metadata.superseded_by).toBe('r1-q1-tl-f1');
    expect(old.metadata.superseded_by_text).toBe('Moves to Lisbon in June');
    expect(old.metadata.valid_from).toBe('2023/05/20 (Sat) 02:21'); // history intact, row NOT deleted

    const neu = platform.rows.get('bench-p1-r1-timeline|bench_longmemeval|r1-q1-tl-f1');
    expect(neu.metadata).toMatchObject({
      valid_from: '2023/05/21 (Sun) 09:15', valid_to: null,
      supersedes: 'r1-q1-tl-f0', superseded_by: null,
      episode: 'r1-q1-s1', session_date: '2023/05/21 (Sun) 09:15',
    });

    // the Dana fact is current (no current fact matched it)
    const dana = platform.rows.get('bench-p1-r1-timeline|bench_longmemeval|r1-q1-tl-f2');
    expect(dana.metadata.valid_to).toBeNull();

    // the decision prompt showed the old fact with its id and date
    expect(decision.calls[0].user).toContain('r1-q1-tl-f0 | 2023/05/20 (Sat) 02:21 | current | Signed a lease for an apartment in Lisbon');
    expect(decision.calls[0].system).toBe(RECONCILE_SYSTEM);
  });

  it('write(): an in-session SUPERSEDE of a not-yet-flushed fact rewrites the pending row — no double write', async () => {
    const platform = fakePlatform();
    const extraction = fakeChat([{ text: '{"facts": ["User plans to move in May", "User plans to move in June"]}' }]);
    const decision = fakeChat(['SUPERSEDE r1-q1-tl-f0']);
    const arm = makeArm({ platform, extraction, decision });
    const w = await arm.write([SESSIONS[0]], { questionId: 'q1', sessionDates: DATES });

    // adds: 1 = f0's auto-ADD (candidate 1, nothing existed yet); candidate 2's
    // SUPERSEDE counts under supersedes, not adds
    expect(w.timeline).toMatchObject({ adds: 1, supersedes: 1, auto_adds: 1, decision_calls: 1 });
    const f0 = platform.rows.get('bench-p1-r1-timeline|bench_longmemeval|r1-q1-tl-f0');
    expect(f0.metadata.valid_to).toBe('2023/05/20 (Sat) 02:21');
    expect(f0.metadata.superseded_by).toBe('r1-q1-tl-f1');
    const f1 = platform.rows.get('bench-p1-r1-timeline|bench_longmemeval|r1-q1-tl-f1');
    expect(f1.metadata.supersedes).toBe('r1-q1-tl-f0');
    // exactly one row per source_id on the platform (upsert, not duplicate)
    expect([...platform.rows.values()].filter((r) => r.source_id === 'r1-q1-tl-f0')).toHaveLength(1);
  });

  it('write(): KEEP writes nothing; in-session duplicates reconcile against facts decided earlier in the SAME session', async () => {
    const platform = fakePlatform();
    const extraction = fakeChat([
      { text: '{"facts": ["User has a dog named Rex", "User has a dog named Rex"]}' },
    ]);
    const decision = fakeChat(['KEEP']);
    const arm = makeArm({ platform, extraction, decision });
    const w = await arm.write([SESSIONS[0]], { questionId: 'q1', sessionDates: DATES });

    // candidate 1: nothing exists → auto-ADD. candidate 2: shown the in-session
    // fact (the flush hasn't landed) → decision call → KEEP → nothing written.
    expect(w.timeline).toMatchObject({ adds: 1, auto_adds: 1, keeps: 1, decision_calls: 1 });
    expect(decision.calls[0].user).toContain('current (this session)');
    const facts = [...platform.rows.values()].filter((r) => r.metadata.layer === 'fact');
    expect(facts).toHaveLength(1);
  });

  it('write(): a malformed decision reply fail-opens to ADD and is COUNTED, never silent', async () => {
    const platform = fakePlatform();
    const extraction = fakeChat([
      { text: '{"facts": ["a", "b"]}' },
    ]);
    const decision = fakeChat(['SUPERSEDE r1-q1-tl-fNOPE']); // invented id
    const arm = makeArm({ platform, extraction, decision });
    const w = await arm.write([SESSIONS[0]], { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline.decision_failures).toBe(1);
    expect(w.timeline.adds).toBe(2); // both candidates written as ADDs
    expect(w.timeline.supersedes).toBe(0);
  });

  it('write(): other questions\' facts are never reconciliation targets (per-user scope)', async () => {
    const platform = fakePlatform();
    // seed the facts namespace with another user's CURRENT fact
    platform.rows.set('bench-p1-r1-timeline|bench_longmemeval|r1-qX-tl-f0', {
      source_type: 'bench_longmemeval', source_id: 'r1-qX-tl-f0', namespace: 'bench-p1-r1-timeline',
      content_text: 'Signed a lease for an apartment in Lisbon', chunk_index: 0,
      metadata: { question_id: 'qX', layer: 'fact', valid_from: '2023/01/01', valid_to: null },
    });
    const decision = fakeChat([]);
    const arm = makeArm({ platform, decision });
    const w = await arm.write([SESSIONS[0]], { questionId: 'q1', sessionDates: DATES });
    expect(w.timeline.auto_adds).toBe(1);
    expect(w.timeline.decision_calls).toBe(0); // no decision call was spent on another user's fact
    expect(decision.calls).toHaveLength(0);
  });

  it('write(): an extraction parse failure drops the FACTS but the episodic row still lands (the verbatim record does not depend on the extractor)', async () => {
    const platform = fakePlatform();
    const extraction = fakeChat([{ text: '{"facts": ["truncated', finishReason: 'length' }]);
    const logs = [];
    const arm = makeArm({ platform, extraction, decision: fakeChat([]), log: (m) => logs.push(m) });
    const w = await arm.write([SESSIONS[0]], { questionId: 'q1', sessionDates: DATES });
    expect(w.parse_failures).toBe(1);
    expect(w.facts).toBe(0);
    expect(platform.rows.get('bench-p1-r1|bench_longmemeval|r1-q1-s0')).toBeTruthy();
    expect(logs.find((l) => /EXTRACT PARSE FAILURE/.test(l))).toMatch(/episode row kept/);
  });

  it('write(): with a facts store, extraction is REUSED without a model call but reconciliation still runs', async () => {
    const saved = [];
    const store = {
      stats: { reuse_source_run_id: 'run-prev' },
      load: (qid, idx) => (idx === 0 ? { facts: ['Cached fact one'], parse_failed: false } : null),
      save: (qid, idx, rec, meta) => saved.push({ qid, idx, rec, meta }),
    };
    const platform = fakePlatform();
    const extraction = fakeChat([{ text: '{"facts": ["Fresh fact"]}' }]);
    // session 1's fresh candidate sees session 0's cached fact → one decision call
    const arm = makeArm({ platform, extraction, decision: fakeChat(['ADD']), factsStore: store });
    const w = await arm.write(SESSIONS.slice(0, 2), { questionId: 'q1', sessionDates: DATES });
    expect(extraction.calls).toHaveLength(1); // session 0 reused, session 1 extracted
    expect(w.facts_reused).toBe(1);
    expect(w.facts).toBe(2);
    expect(saved).toHaveLength(1);
  });

  it('write(): flushes rows PER SESSION so the next session reconciles against what just landed', async () => {
    const platform = fakePlatform();
    const arm = makeArm({ platform });
    await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });
    expect(platform.calls.bulk).toHaveLength(3); // one flush per session
    // after session 0's flush, session 1's reconcile search must see f0
    const searchesAfterS0 = platform.calls.searches.filter((s) => s.query === 'Moves to Lisbon in June');
    expect(searchesAfterS0.length).toBe(1);
    // (the fake store serves what was indexed, which is the point of the flush)
  });

  it('write(): rejects non-array payloads and missing ids loudly (same contract as the other arms)', async () => {
    const arm = makeArm({});
    await expect(arm.write('nope', { questionId: 'q' })).rejects.toThrow(/haystack_sessions/);
    await expect(arm.write([SESSIONS[0]], {})).rejects.toThrow(/runId and questionId/);
  });

  it('missing session dates are legal: null stamped, rendered as unknown date, reconcile still works', async () => {
    const platform = fakePlatform();
    const arm = makeArm({ platform });
    const w = await arm.write([SESSIONS[0]], { questionId: 'q1', sessionDates: null });
    const fact = [...platform.rows.values()].find((r) => r.metadata.layer === 'fact');
    expect(fact.metadata.valid_from).toBeNull();
    expect(fact.metadata.session_date).toBeNull();
    expect(w.timeline.adds).toBe(1);
  });
});

describe('arm_mycelium_timeline — READ over both layers', () => {
  it('answer(): current facts first, then episodes, then superseded facts — capped at the budget, each hit dated, supersede lines rendered', async () => {
    const searches = [];
    const platform = {
      async search({ query, namespace, limit }) {
        searches.push({ namespace, limit });
        if (namespace === 'bench-p1-r1-timeline') {
          return {
            results: [
              { source_id: 'f-cur', content_text: 'User manager is Dana', metadata: { layer: 'fact', valid_from: '2023/05/22 (Mon) 18:00', valid_to: null }, score: 3 },
              { source_id: 'f-old', content_text: 'User lives in Porto', metadata: { layer: 'fact', valid_from: '2023/05/01', valid_to: '2023/05/10', superseded_by_text: 'User lives in Lisbon' }, score: 2 },
              { source_id: 'f-cur-2', content_text: 'User has a dog', metadata: { layer: 'fact', valid_from: '2023/05/02', valid_to: null }, score: 1.5 },
            ],
            mode: 'hybrid',
          };
        }
        return {
          results: [
            { source_id: 'e-0', content_text: 'user: I moved to Porto once', metadata: { layer: 'episode', session_date: '2023/05/01 (Mon) 10:00' }, score: 2.5 },
            { source_id: 'e-1', content_text: 'user: hello', metadata: { layer: 'episode', session_date: '2023/05/02 (Tue) 10:00' }, score: 1 },
          ],
          mode: 'hybrid',
        };
      },
      async indexBulk() { return []; },
    };
    const seen = [];
    const arm = createArmMyceliumTimeline({
      answerChat: async (args) => { seen.push(args); return { text: 'Lisbon.', hadThink: false }; },
      extractionChat: async () => { throw new Error('not called'); },
      reconcileChat: async () => { throw new Error('not called'); },
      platform,
      namespace: 'bench-p1-r1',
      retrievalBudget: 5,
      runId: 'r1',
    });
    const r = await arm.answer('Where do I live?');

    expect(searches).toEqual([
      { namespace: 'bench-p1-r1-timeline', limit: 5 },
      { namespace: 'bench-p1-r1', limit: 5 },
    ]);
    // current facts (rank order) → episodes (rank order) → superseded facts
    const hits = seen[0].user.replace(/^Memory context:\n/, '').split('\n\n---\n\n');
    expect(hits).toHaveLength(5);
    expect(hits[0]).toBe('[fact | 2023/05/22 (Mon) 18:00] User manager is Dana');
    expect(hits[1]).toContain('[fact | 2023/05/02] User has a dog');
    expect(hits[2]).toBe('[session | 2023/05/01 (Mon) 10:00] user: I moved to Porto once');
    expect(hits[4]).toContain('[fact | 2023/05/01] User lives in Porto');
    expect(hits[4]).toContain('superseded on 2023/05/10 by: User lives in Lisbon');

    // the RAG envelope is arm_mycelium's; only the per-hit rendering differs
    expect(seen[0].system).toBe(RAG_SYSTEM);
    expect(seen[0].user).toMatch(/^Memory context:\n/);
    expect(seen[0].user).toMatch(/\n\nQuestion: Where do I live\?$/);

    expect(r.text).toBe('Lisbon.');
    expect(r.meta).toMatchObject({
      hits: 5, facts_hits: 3, episode_hits: 2, current_facts: 2, superseded_facts: 1,
      retrieval_mode: 'hybrid', ingestion: 'timeline',
    });
  });

  it('answer(): the budget caps the merged pool (5 hits max even when both layers return full pages)', async () => {
    const page = (n, layer, extra = {}) =>
      Array.from({ length: n }, (_, i) => ({
        source_id: `${layer}-${i}`, content_text: `${layer} ${i}`,
        metadata: { layer, valid_from: 'd', valid_to: null, ...extra },
      }));
    const platform = {
      async search({ namespace }) {
        return namespace.endsWith('-timeline')
          ? { results: page(5, 'fact'), mode: 'hybrid' }
          : { results: page(5, 'episode', { session_date: 'd' }), mode: 'hybrid' };
      },
      async indexBulk() { return []; },
    };
    const seen = [];
    const arm = createArmMyceliumTimeline({
      answerChat: async (args) => { seen.push(args); return { text: 'x' }; },
      extractionChat: async () => ({}), reconcileChat: async () => ({}),
      platform, namespace: 'bench-p1-r1', retrievalBudget: 5, runId: 'r1',
    });
    const r = await arm.answer('q');
    expect(r.meta.hits).toBe(5); // 5 current facts fill the pool first
    expect(seen[0].user).not.toContain('[session');
  });
});

describe('arm_mycelium_timeline — contracts', () => {
  it('namespaces: the reconciled layer is the suffixed sibling; cleanup covers BOTH layers', () => {
    expect(myceliumTimelineNamespace('bench-p1-2026-09-10-p1-x')).toBe('bench-p1-2026-09-10-p1-x-timeline');
    expect(myceliumTimelineNamespaces('ns')).toEqual(['ns', 'ns-timeline']);
    const arm = makeArm({});
    expect(arm.namespaces).toEqual(['bench-p1-r1', 'bench-p1-r1-timeline']);
    expect(arm.namespace).toBe('bench-p1-r1-timeline');
    expect(arm.name).toBe('mycelium-timeline');
  });

  it('refuses to exist without the thinking-off chats — no silent fall-back to the answerer', () => {
    const base = { answerChat: async () => ({}), platform: fakePlatform(), namespace: 'ns', retrievalBudget: 5, runId: 'r' };
    expect(() => createArmMyceliumTimeline(base)).toThrow(/extractionChat.*thinking OFF/s);
    expect(() =>
      createArmMyceliumTimeline({ ...base, extractionChat: async () => ({}) })
    ).toThrow(/reconcileChat.*thinking OFF/s);
  });

  it('refuses an unstamped retrieval budget and a bad reconcile window at factory time', () => {
    const base = {
      answerChat: async () => ({}), extractionChat: async () => ({}), reconcileChat: async () => ({}),
      platform: fakePlatform(), namespace: 'ns', runId: 'r',
    };
    for (const bad of [undefined, 0, -1, 2.5]) {
      expect(() => createArmMyceliumTimeline({ ...base, retrievalBudget: bad })).toThrow(/retrievalBudget must be a positive int/);
    }
    expect(() => createArmMyceliumTimeline({ ...base, retrievalBudget: 5, reconcileTopK: 0 })).toThrow(/reconcileTopK/);
    expect(() => createArmMyceliumTimeline({ ...base, retrievalBudget: 5, reconcileTopK: 5, reconcileOverfetch: 3 })).toThrow(/reconcileOverfetch/);
  });

  it('sessionDateFor: verbatim dataset string, null when missing', () => {
    expect(sessionDateFor(DATES, 1)).toBe('2023/05/21 (Sun) 09:15');
    expect(sessionDateFor(null, 0)).toBeNull();
    expect(sessionDateFor(['', 0], 0)).toBeNull();
    expect(sessionDateFor(['', 0], 1)).toBeNull(); // non-string entries are not dates
  });
});

describe('the reconcile prompt + decision parser', () => {
  it('buildReconcileUserPrompt: date, candidate, existing facts one per line; none → (none)', () => {
    const p = buildReconcileUserPrompt({
      candidate: 'User is moving to Lisbon in June',
      sessionDate: '2023/05/21 (Sun) 09:15',
      existing: [
        { id: 'f0', text: 'Signed a lease in Lisbon', valid_from: '2023/05/20 (Sat) 02:21' },
        { id: 'f2', text: 'In-session fact', valid_from: '2023/05/21 (Sun) 09:15', this_session: true },
      ],
    });
    expect(p).toBe(
      'Session date: 2023/05/21 (Sun) 09:15\n\n' +
      'Candidate fact:\nUser is moving to Lisbon in June\n\n' +
      'Existing facts (id | valid_from | status | text):\n' +
      'f0 | 2023/05/20 (Sat) 02:21 | current | Signed a lease in Lisbon\n' +
      'f2 | 2023/05/21 (Sun) 09:15 | current (this session) | In-session fact'
    );
    expect(buildReconcileUserPrompt({ candidate: 'c', sessionDate: null, existing: [] })).toContain('Existing facts: (none)');
    expect(() => buildReconcileUserPrompt({ candidate: '', existing: [] })).toThrow(/non-empty candidate/);
  });

  it('parseDecision: ADD / KEEP / SUPERSEDE, tolerant of think blocks, fences, casings and punctuation; loud on junk', () => {
    expect(parseDecision('ADD', new Set())).toEqual({ action: 'ADD', id: null, ok: true });
    expect(parseDecision('add — it is new', new Set())).toEqual({ action: 'ADD', id: null, ok: true });
    expect(parseDecision('KEEP', new Set())).toEqual({ action: 'KEEP', id: null, ok: true });
    expect(parseDecision('<think>hmm</think>\nKEEP', new Set())).toEqual({ action: 'KEEP', id: null, ok: true });
    expect(parseDecision('```\nKEEP\n```', new Set())).toEqual({ action: 'KEEP', id: null, ok: true });
    expect(parseDecision('SUPERSEDE f0', new Set(['f0']))).toEqual({ action: 'SUPERSEDE', id: 'f0', ok: true });
    expect(parseDecision('supersede: f0.', new Set(['f0']))).toEqual({ action: 'SUPERSEDE', id: 'f0', ok: true });
    // the one hard rule: an invented id is never applied
    expect(parseDecision('SUPERSEDE ghost', new Set(['f0']))).toEqual({ action: 'ADD', id: null, ok: false });
    for (const junk of ['', 'I would add this fact because...', '{"decision": "ADD"}', 'MAYBE f0']) {
      expect(parseDecision(junk, new Set(['f0'])).ok).toBe(false);
    }
  });

  it('the pre-committed reconcile prompt names all three actions and the invented-id rule', () => {
    expect(RECONCILE_SYSTEM).toContain('ADD');
    expect(RECONCILE_SYSTEM).toContain('SUPERSEDE <id>');
    expect(RECONCILE_SYSTEM).toContain('KEEP');
    expect(RECONCILE_SYSTEM).toContain('Never invent an id');
    expect(RECONCILE_SYSTEM).toContain('one line');
  });
});

describe('core.mjs carries session dates and merges the timeline ledger', () => {
  const ITEM = {
    question_id: 'q1', question_type: 'single_session_user', question: 'Q?', answer: 'A',
    haystack_sessions: [SESSIONS[0], SESSIONS[1], SESSIONS[2]],
    haystack_dates: DATES,
  };

  it('write() receives the dataset dates sliced with maxSessions; the timeline ledger sums across questions', async () => {
    const seenWrites = [];
    const rows = [];
    await runBench({
      items: [ITEM],
      armFactories: [
        {
          name: 'mycelium-timeline',
          factory: () => ({
            name: 'mycelium-timeline',
            async write(sessions, { questionId, sessionDates }) {
              seenWrites.push({ n: sessions.length, dates: sessionDates, questionId });
              return {
                docs: sessions.length, rows: sessions.length,
                facts: sessions.length, facts_per_session: sessions.map(() => 1),
                extract_ms: 10, reconcile_ms: 20, parse_failures: 0,
                timeline: {
                  question_id: questionId, adds: 1, supersedes: 2, keeps: 3, auto_adds: 4,
                  decision_calls: 5, decision_failures: 0, seconds_per_session: [1.5],
                },
              };
            },
            async answer() { return { text: 'x', meta: {} }; },
          }),
        },
      ],
      armContext: {},
      regime: { ok: true },
      runId: 'r',
      maxSessions: 2,
      onRow: (row) => rows.push(row),
    });
    expect(seenWrites[0]).toEqual({ n: 2, dates: DATES.slice(0, 2), questionId: 'q1' });
  });

  it('the timeline ledger: scalars summed, per-question blocks kept whole', async () => {
    const armFactory = () => ({
      name: 'mycelium-timeline',
      async write() {
        return {
          docs: 1, rows: 2, facts: 1, facts_per_session: [1], extract_ms: 5, reconcile_ms: 6, parse_failures: 0,
          timeline: { question_id: 'q', adds: 1, supersedes: 0, keeps: 2, auto_adds: 1, decision_calls: 1, decision_failures: 0, seconds_per_session: [2.0] },
        };
      },
      async answer() { return { text: 'x', meta: {} }; },
    });
    const ITEM2 = { ...ITEM, question_id: 'q2' };
    let captured = null;
    await runBench({
      items: [ITEM, ITEM2],
      armFactories: [{ name: 'mycelium-timeline', factory: armFactory }],
      armContext: {},
      regime: { ok: true },
      runId: 'r',
      afterWrite: async (info) => { captured = info; },
    });
    expect(captured.arm).toBe('mycelium-timeline');
    expect(captured.writeInfo.timeline).toMatchObject({
      adds: 2, supersedes: 0, keeps: 4, auto_adds: 2, decision_calls: 2, decision_failures: 0,
    });
    expect(captured.writeInfo.timeline.per_question).toHaveLength(2);
    expect(captured.writeInfo.reconcile_ms).toBe(12);
    expect(captured.writeInfo.extract_ms).toBe(10);
  });
});

describe('the regime stamps the timeline block', () => {
  const base = {
    dateUtc: 'd',
    git: { git_sha: 's', git_dirty: false },
    harnessVersion: 'h',
    dataset: { name: 'n', file: 'f', sha256: 'x', licence: 'l', url: 'u', count: 1 },
    answerer: { model: 'm' },
    judge: { model: 'j' },
    retrieval: { budget: 5 },
    platform: {},
    n: 1,
    notes: [],
  };

  it('mycelium_timeline: namespaces, verbatim reconcile prompt, policy, layers, am_facts rationale', () => {
    const r = buildRegime({
      ...base,
      mycelium_timeline: {
        ingestion: 'timeline',
        reconcile_prompt: RECONCILE_SYSTEM,
        reconcile_policy: { top_k: 3, auto_add_on_no_match: true },
        layers: { episodic: { namespace: 'ns' }, reconciled: { namespace: 'ns-timeline' } },
        retrieval_budget: 5,
      },
    });
    expect(r.mycelium_timeline).toMatchObject({
      ingestion: 'timeline',
      reconcile_prompt: RECONCILE_SYSTEM, // verbatim — the prompt IS the regime
      reconcile_policy: { top_k: 3, auto_add_on_no_match: true },
    });
    expect(r.mycelium_timeline.layers).toEqual({ episodic: { namespace: 'ns' }, reconciled: { namespace: 'ns-timeline' } });
    expect(buildRegime(base).mycelium_timeline).toBeUndefined();
  });
});
