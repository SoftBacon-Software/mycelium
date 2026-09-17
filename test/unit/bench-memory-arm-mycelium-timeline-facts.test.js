// arm_mycelium_timeline — the MYCELIUM_TIMELINE_FACTS=am_facts flag path
// (task 206). When the flag is set, the reconciled layer reads/writes the
// /auto-memory/facts routes in a per-run namespace (`<ns>-amfacts`) instead of
// memory rows in the suffixed `-timeline` namespace — same metadata contract,
// ids become the route-minted am_facts ids. Default (unset) is pinned by the
// sibling suite bench-memory-arm-mycelium-timeline.test.js and must stay
// byte-identical. Hermetic: a fake platform standing in for the server routes,
// no live calls.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createArmMyceliumTimeline,
  myceliumTimelineNamespace,
  myceliumTimelineFactsNamespace,
  resolveTimelineFactsLayer,
  TIMELINE_FACTS_LAYERS,
  FACT_INDEX_SOURCE_TYPE,
  RECONCILE_SYSTEM,
} from '../../bench/memory/arms/arm_mycelium_timeline.mjs';

const DATES = ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15', '2023/05/22 (Mon) 18:00'];
const SESSIONS = [
  [
    { role: 'user', content: 'I just signed the lease for the Lisbon apartment.' },
    { role: 'assistant', content: 'Congrats — Lisbon awaits!' },
  ],
  [{ role: 'user', content: 'Update: my move to Lisbon got pulled forward to June.' }],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];
const EXTRACT_REPLIES = [
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon"]}' },
  { text: '{"facts": ["Moves to Lisbon in June"]}' },
  { text: '{"facts": ["User manager is Dana"]}' },
];

// Simulates the server contract the routes expose: POST /facts stores a row AND
// an 'am_fact' index row whose metadata mirrors the bi-temporal columns (column
// mirrors win); supersede closes the interval, keeps the old row indexed, and
// renders the supersede line into both content_text and metadata — exactly what
// server/plugins/auto-memory/routes.js does.
function fakePlatformFacts() {
  const rows = new Map(); // ns|source_type|source_id -> index row
  let nextId = 0;
  const calls = { creates: [], supersedes: [], bulk: [], searches: [] };
  const put = (r) => rows.set(`${r.namespace}|${r.source_type}|${r.source_id}`, r);
  return {
    calls,
    rows,
    async indexBulk(items) {
      calls.bulk.push(items);
      let written = 0;
      for (const it of items) {
        put({ ...it, chunk_index: 0 });
        written += 1;
      }
      return [{ rows: written }];
    },
    async factsCreate(body) {
      calls.creates.push(body);
      const id = ++nextId;
      const meta = {
        ...body.metadata,
        namespace: body.namespace,
        valid_from: body.valid_from ?? body.metadata?.valid_from ?? null,
        valid_to: null,
        superseded_by: null,
      };
      put({
        source_type: FACT_INDEX_SOURCE_TYPE,
        source_id: String(id),
        content_text: body.fact_text,
        namespace: body.namespace,
        chunk_index: 0,
        metadata: meta,
      });
      return { ok: true, id, fact: { id, namespace: body.namespace, valid_from: meta.valid_from, valid_to: null, superseded_by: null }, memory_index: { indexed: true } };
    },
    async factsSupersede(id, newId, namespace) {
      calls.supersedes.push({ id, newId, namespace });
      const key = `${namespace}|${FACT_INDEX_SOURCE_TYPE}|${String(id)}`;
      const old = rows.get(key);
      if (!old) throw new Error(`fake factsSupersede: no fact ${id} in ${namespace}`);
      const neu = rows.get(`${namespace}|${FACT_INDEX_SOURCE_TYPE}|${String(newId)}`);
      if (!neu) throw new Error(`fake factsSupersede: no fact ${newId} in ${namespace}`);
      old.metadata.valid_to = '2026-09-17 12:00'; // the server's wall-clock close, as routes.js does
      old.metadata.superseded_by = Number(newId); // the column mirror is the INTEGER row id, as routes.js writes it
      old.metadata.superseded_by_text = neu.content_text;
      old.content_text = `${old.metadata.question_id ? '' : ''}${old.content_text}\n\n[superseded on ${old.metadata.valid_to} by: ${neu.content_text}]`;
      return { ok: true, fact: { id, superseded_by: newId, valid_to: old.metadata.valid_to }, replacement: { id: newId } };
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
    const r = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof r === 'string' ? { text: r } : r;
  };
  return { calls, chat };
}

function makeArm({ platform, extraction, decision, ...rest } = {}) {
  return createArmMyceliumTimeline({
    answerChat: async () => ({ text: 'ok' }),
    extractionChat: extraction?.chat ?? fakeChat(EXTRACT_REPLIES.map((r) => r)).chat,
    reconcileChat: decision?.chat ?? fakeChat(['ADD']).chat,
    platform: platform ?? fakePlatformFacts(),
    namespace: 'bench-p1-r1',
    retrievalBudget: 5,
    runId: 'r1',
    factsLayer: TIMELINE_FACTS_LAYERS.ROUTES,
    ...rest,
  });
}

describe('resolveTimelineFactsLayer — the env flag contract', () => {
  const ENV = 'MYCELIUM_TIMELINE_FACTS';
  let saved;
  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

  it('unset env = memory rows (today\'s shape); explicit override wins; bad value is loud', () => {
    expect(resolveTimelineFactsLayer(undefined)).toBe(TIMELINE_FACTS_LAYERS.MEMORY_ROWS);
    process.env[ENV] = 'am_facts';
    expect(resolveTimelineFactsLayer(undefined)).toBe(TIMELINE_FACTS_LAYERS.ROUTES);
    expect(resolveTimelineFactsLayer(TIMELINE_FACTS_LAYERS.MEMORY_ROWS)).toBe(TIMELINE_FACTS_LAYERS.MEMORY_ROWS);
    expect(() => resolveTimelineFactsLayer('sqlite')).toThrow(/unknown factsLayer/);
  });

  it('the factory refuses am_facts mode without a facts-capable platform client — no silent fallback', () => {
    expect(() => createArmMyceliumTimeline({
      answerChat: async () => ({ text: 'ok' }),
      extractionChat: async () => ({ text: '{}' }),
      reconcileChat: async () => ({ text: 'ADD' }),
      platform: { search: async () => ({ results: [] }), indexBulk: async () => [] },
      namespace: 'bench-p1-r1', retrievalBudget: 5, runId: 'r1',
      factsLayer: TIMELINE_FACTS_LAYERS.ROUTES,
    })).toThrow(/factsCreate\/factsSupersede/);
  });
});

describe('arm_mycelium_timeline in factsLayer am_facts mode — the routes are the first am_facts caller', () => {
  it('write(): facts go through factsCreate in the -amfacts namespace with the same metadata contract; episodes stay indexBulk in the base namespace', async () => {
    const platform = fakePlatformFacts();
    const arm = makeArm({ platform });
    expect(arm.factsLayer).toBe(TIMELINE_FACTS_LAYERS.ROUTES);
    expect(arm.namespace).toBe(myceliumTimelineFactsNamespace('bench-p1-r1'));
    expect(arm.namespaces).toEqual(['bench-p1-r1', 'bench-p1-r1-amfacts']);

    const w = await arm.write(SESSIONS.slice(0, 1), { questionId: 'q1', sessionDates: DATES });
    expect(w.facts_layer).toBe(TIMELINE_FACTS_LAYERS.ROUTES);
    expect(w.timeline).toMatchObject({ adds: 1, auto_adds: 1 });

    // exactly ONE factsCreate, carrying the full metadata contract
    expect(platform.calls.creates).toHaveLength(1);
    const create = platform.calls.creates[0];
    expect(create.namespace).toBe('bench-p1-r1-amfacts');
    expect(create.fact_text).toBe('Signed a lease for an apartment in Lisbon');
    expect(create.valid_from).toBe('2023/05/20 (Sat) 02:21');
    expect(create.metadata).toMatchObject({
      question_id: 'q1', layer: 'fact', episode: 'r1-q1-s0',
      session_date: '2023/05/20 (Sat) 02:21',
      valid_from: '2023/05/20 (Sat) 02:21', valid_to: null,
      supersedes: null, superseded_by: null, superseded_by_text: null,
      ingestion: 'timeline', run_id: 'r1',
    });

    // episodic rows: still the bulk path, base namespace, arm_mycelium's verbatim row
    expect(platform.calls.bulk).toHaveLength(1);
    expect(platform.calls.bulk[0]).toHaveLength(1); // the episode ONLY — no fact rows in the flush
    const episode = platform.rows.get('bench-p1-r1|bench_longmemeval|r1-q1-s0');
    expect(episode.metadata.layer).toBe('episode');

    // the fact's index row is source_type am_fact keyed by the ROUTE id
    const factRow = [...platform.rows.values()].find((r) => r.source_type === FACT_INDEX_SOURCE_TYPE);
    expect(factRow.source_id).toBe('1');
    expect(factRow.namespace).toBe('bench-p1-r1-amfacts');
    // memory-rows-mode rows would carry sourceType bench_longmemeval — none in the facts namespace
    expect([...platform.rows.values()].filter((r) => r.namespace === 'bench-p1-r1-amfacts' && r.source_type === 'bench_longmemeval')).toHaveLength(0);
  });

  it('write(): SUPERSEDE goes through factsSupersede with route ids; the old fact keeps its indexed row with valid_to + the supersede line', async () => {
    const platform = fakePlatformFacts();
    const decision = fakeChat(['SUPERSEDE 1', 'ADD']);
    const arm = makeArm({ platform, decision });
    const w = await arm.write(SESSIONS, { questionId: 'q1', sessionDates: DATES });

    expect(w.timeline).toMatchObject({ adds: 2, supersedes: 1, auto_adds: 1, decision_calls: 2 });
    // the ledger speaks STRING ids end to end (route ids are no exception —
    // they go into the reconcile prompt and the URL path the same way every
    // memory-row source_id always has)
    expect(platform.calls.supersedes).toEqual([{ id: '1', newId: '2', namespace: 'bench-p1-r1-amfacts' }]);

    // the decision prompt showed the route-minted id with its dataset date
    expect(decision.calls[0].user).toContain('1 | 2023/05/20 (Sat) 02:21 | current | Signed a lease for an apartment in Lisbon');
    expect(decision.calls[0].system).toBe(RECONCILE_SYSTEM);

    // old fact: still indexed, closed interval, the line renderable from the hit
    const old = platform.rows.get('bench-p1-r1-amfacts|am_fact|1');
    expect(old.metadata.valid_to).toBeTruthy();
    expect(old.metadata.superseded_by).toBe(2);
    expect(old.metadata.superseded_by_text).toBe('Moves to Lisbon in June');
    expect(old.content_text).toContain('superseded on');

    // new fact carries supersedes -> the route id of the old one
    const neu = platform.rows.get('bench-p1-r1-amfacts|am_fact|2');
    expect(neu.metadata.supersedes).toBe('1');
    expect(neu.metadata.valid_from).toBe('2023/05/21 (Sun) 09:15');
  });

  it('answer(): the facts search targets the am_fact index type in the -amfacts namespace; the supersede line renders from the hit', async () => {
    const platform = fakePlatformFacts();
    const decision = fakeChat(['SUPERSEDE 1']);
    const arm = makeArm({ platform, decision });
    await arm.write(SESSIONS.slice(0, 2), { questionId: 'q1', sessionDates: DATES });

    const r = await arm.answer('When does the lease start?');
    const factSearch = platform.calls.searches.find((s) => s.namespace === 'bench-p1-r1-amfacts');
    expect(factSearch.sourceTypes).toEqual([FACT_INDEX_SOURCE_TYPE]);
    const episodeSearch = platform.calls.searches.find((s) => s.namespace === 'bench-p1-r1');
    expect(episodeSearch.sourceTypes).toEqual(['bench_longmemeval']);
    expect(r.meta.facts_layer).toBe(TIMELINE_FACTS_LAYERS.ROUTES);
    expect(r.meta.read_policy).toBe('fact-episode-interleave');
  });

  it('default (unset env) keeps the memory-row shape byte-identical: no facts calls, -timeline namespace, memory-rows stamp', async () => {
    const ENV = 'MYCELIUM_TIMELINE_FACTS';
    const saved = process.env[ENV];
    delete process.env[ENV];
    try {
      const platform = fakePlatformFacts();
      const arm = makeArm({ platform, factsLayer: undefined });
      expect(arm.factsLayer).toBe(TIMELINE_FACTS_LAYERS.MEMORY_ROWS);
      expect(arm.namespace).toBe(myceliumTimelineNamespace('bench-p1-r1'));
      const w = await arm.write(SESSIONS.slice(0, 1), { questionId: 'q1', sessionDates: DATES });
      expect(w.facts_layer).toBe(TIMELINE_FACTS_LAYERS.MEMORY_ROWS);
      expect(platform.calls.creates).toHaveLength(0);
      expect(platform.calls.supersedes).toHaveLength(0);
      expect(platform.calls.bulk).toHaveLength(1);
      expect(platform.calls.bulk[0].map((i) => i.layer ?? i.metadata.layer)).toEqual(['episode', 'fact']); // both layers in one flush, as before
      const fact = [...platform.rows.values()].find((r) => r.metadata.layer === 'fact');
      expect(fact.namespace).toBe('bench-p1-r1-timeline');
      expect(fact.source_id).toBe('r1-q1-tl-f0');
    } finally {
      if (saved !== undefined) process.env[ENV] = saved;
    }
  });
});
