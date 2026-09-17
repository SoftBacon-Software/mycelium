// The byte-identity fixture generator (task 210).
//
// Drives runBench's REAL row path with a fixed fixture — scripted extraction
// and decision chats, a fake platform with a deterministic score rule, a
// stubbed clock, an injected constant regime — and serializes the rows exactly
// as a run's <arm>.rows.jsonl would carry them. The bytes it produces on the
// PRE-merge bench branch are committed as timeline-default-golden.rows.jsonl;
// the vitest gate (test/unit/bench-memory-timeline-golden-bytes.test.js)
// regenerates on the MERGED tree and byte-diffs. Default path (flag unset)
// only: this is the gate that keeps 206's "byte-identical default" true of the
// MERGE, not just of 206's own commit.
//
// Coverage of the fixture (per question): q1 auto-add, SUPERSEDE of a flushed
// row (the upsert push), fastpath ADD; q2 auto-add, decided KEEP, decided ADD,
// and a FAILED episode search at read time (retrieval_error stamp); q3 a
// superseded fact rendered INSIDE the read context (the supersede line in
// read_hits). Every byte-critical meta field of the default path is exercised.
//
// The same file runs against EITHER tree: imports are relative to this module,
// so each checkout exercises its own arm/core code. Run standalone:
//   node bench/memory/fixtures/gen-timeline-golden.mjs --out /tmp/rows.jsonl

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runBench } from '../core.mjs';
import { createArmMyceliumTimeline } from '../arms/arm_mycelium_timeline.mjs';

const NS = 'bench-golden-r1';

const ITEMS = [
  {
    question_id: 'q1',
    question_type: 'multi-session',
    question: 'When does the lease start?',
    answer: 'It starts in May.',
    haystack_dates: ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15', '2023/05/22 (Mon) 18:00'],
    haystack_sessions: [
      [{ role: 'user', content: 'I just signed the lease for the Lisbon apartment.' }],
      [{ role: 'user', content: 'Update about the apartment.' }],
      [{ role: 'user', content: 'Also: my manager is Dana now.' }],
    ],
  },
  {
    question_id: 'q2',
    question_type: 'multi-session',
    question: 'What did I say about sailing?',
    answer: 'You sail in Greece.',
    haystack_dates: ['2023/06/01 (Thu) 10:00', '2023/06/02 (Fri) 11:00'],
    haystack_sessions: [
      [{ role: 'user', content: 'I sail every summer in Greece.' }],
      [{ role: 'user', content: 'Sailing update, and I bought a dinghy.' }],
    ],
  },
  {
    question_id: 'q3',
    question_type: 'single-session-preference',
    question: 'Manual or automatic?',
    answer: 'You switched to automatic.',
    haystack_dates: ['2023/07/01 (Sat) 12:00'],
    haystack_sessions: [[{ role: 'user', content: 'I drive a manual car. Wait — I switched to an automatic.' }]],
  },
];

// Extraction replies, one per extraction call, in deterministic call order:
// q1 s0, q1 s1, q1 s2, q2 s0, q2 s1, q3 s0.
const EXTRACTION_REPLIES = [
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon"]}' },
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon — moving in June"]}' },
  { text: '{"facts": ["User manager is Dana"]}' },
  { text: '{"facts": ["User sails every summer in Greece"]}' },
  { text: '{"facts": ["User sails every summer in Greece", "User sails every summer in Greece and owns a Laser dinghy"]}' },
  { text: '{"facts": ["User drives a manual car", "User drives an automatic car now"]}' },
];

// Decision replies, one per decision call: q1 s1 SUPERSEDE (of the flushed f0),
// q2 s1 KEEP then ADD, q3 s0 SUPERSEDE.
const DECISION_REPLIES = ['SUPERSEDE r1-q1-tl-f0', 'KEEP', 'ADD', 'SUPERSEDE r1-q3-tl-f0'];
const ANSWER_REPLIES = [
  { text: 'The lease starts in May.', hadThink: false },
  { text: 'You sail in Greece in the summer.', hadThink: false },
  { text: 'You switched to an automatic.', hadThink: false },
];

// The fake platform: rows in a Map keyed ns|source_type|source_id, flushed via
// indexBulk with a SHALLOW copy (metadata shared — an in-place supersede flip
// is visible server-side, mirroring the upsert push). Search returns live rows
// in insertion order; score is a deterministic substring-match rule
// (0.9 match / 0.2 no-match) so the fastpath threshold (0.35) is crossed and
// skipped exactly where the fixture intends. `overrides` pins specific
// (namespace, query) answers — used to dry up q3's episode layer so a
// SUPERSEDED fact enters the read context — and `failQueries` makes a search
// throw (q2's episode layer: the retrieval_error stamp).
function fakePlatform({ overrides = {}, failQueries = [] } = {}) {
  const rows = new Map();
  const order = [];
  const put = (r) => {
    const key = `${r.namespace}|${r.source_type}|${r.source_id}`;
    if (!rows.has(key)) order.push(key);
    rows.set(key, r);
  };
  return {
    rows,
    async indexBulk(items) {
      let written = 0;
      for (const it of items) {
        put({ ...it, chunk_index: 0 });
        written += 1;
      }
      return [{ rows: written }];
    },
    async search({ query, namespace, sourceTypes, limit }) {
      if (failQueries.some((f) => f.namespace === namespace && query.includes(f.includes))) {
        throw new Error(`fixture search failure for ${namespace}: ${query}`);
      }
      const ovKey = `${namespace}|${query}`;
      if (overrides[ovKey]) return overrides[ovKey](); // the override IS the full search response
      const out = [];
      for (const key of order) {
        const r = rows.get(key);
        if (r.namespace !== namespace) continue;
        if (sourceTypes?.length && !sourceTypes.includes(r.source_type)) continue;
        const match = r.content_text.includes(query) || query.includes(r.content_text);
        out.push({ source_id: r.source_id, content_text: r.content_text, metadata: r.metadata, score: match ? 0.9 : 0.2 });
      }
      return { results: out.slice(0, limit), mode: 'hybrid' };
    },
  };
}

function scriptedChat(replies) {
  let i = 0;
  return async () => {
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return typeof r === 'string' ? { text: r } : r;
  };
}

// The rows' regime is an INJECTED constant: it is the declared input of a run,
// not a measured output — the gate exists to catch merge corruption of the
// ARM/CORE path, and the regime block itself is pinned by its own tests
// (regime.facts_layer among them).
const REGIME = Object.freeze({
  date_utc: '2026-09-17T00:00:00.000Z',
  git_sha: 'golden-fixture-not-a-run',
  git_dirty: false,
  harness: 'bench/memory golden fixture (task 210)',
  dataset: { name: 'longmemeval', file: 'fixture', sha256: 'fixture', licence: 'fixture', url: 'fixture', count: 3, selected: 3 },
  answerer: { model: 'fixture-answerer', url_host: 'fixture', temperature: 0, max_tokens: 64 },
  judge: { model: 'none', url_host: 'none' },
  retrieval: { budget: 5, chunking: 'fixture', source_type: 'bench_longmemeval', namespace: NS, server_mode: 'fixture' },
  platform: { url_host: 'fixture', version: 'fixture', embedding_provider: 'fixture', embedding_model: 'fixture', chunk_size: 512 },
  n: 3,
  selection_rule: 'fixture-fixed',
  notes: [],
});

export async function buildGoldenRowsJsonl() {
  const extractionChat = scriptedChat(EXTRACTION_REPLIES);
  const reconcileChat = scriptedChat(DECISION_REPLIES);
  const answerChat = scriptedChat(ANSWER_REPLIES);
  let q3FactRows = null;
  const platform = fakePlatform({
    // q3: dry episode layer + a fact layer pinned to q3's own two rows, so the
    // SUPERSEDED fact renders inside the budget and its line lands in read_hits
    overrides: {
      [`${NS}|Manual or automatic?`]: () => ({ results: q3FactRows ?? [], mode: 'hybrid' }),
      [`${NS}-timeline|Manual or automatic?`]: () => ({ results: q3FactRows ?? [], mode: 'hybrid' }),
    },
    failQueries: [{ namespace: NS, includes: 'sailing' }],
  });

  // Deterministic clock: every Date.now-derived field (elapsed_ms, extract_ms,
  // reconcile_ms, seconds_per_session) is a constant.
  const realNow = Date.now;
  const realEnv = process.env.MYCELIUM_TIMELINE_FACTS;
  delete process.env.MYCELIUM_TIMELINE_FACTS;
  Date.now = () => 1700000000000;
  try {
    // keep a live handle on q3's two fact rows for the read override (the
    // superseded row's metadata is flipped in place before this read)
    const origIndexBulk = platform.indexBulk.bind(platform);
    platform.indexBulk = async (items) => {
      const r = await origIndexBulk(items);
      q3FactRows = [...platform.rows.values()].filter(
        (row) => row.namespace === `${NS}-timeline` && row.metadata?.question_id === 'q3'
      );
      return r;
    };

    const { rows } = await runBench({
      items: ITEMS,
      armFactories: [{ name: 'mycelium-timeline', factory: (ctx) => createArmMyceliumTimeline(ctx) }],
      armContext: {
        answerChat,
        extractionChat,
        reconcileChat,
        platform,
        namespace: NS,
        retrievalBudget: 5,
        runId: 'r1',
      },
      regime: REGIME,
      runId: 'r1',
    });
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.MYCELIUM_TIMELINE_FACTS;
    else process.env.MYCELIUM_TIMELINE_FACTS = realEnv;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argIdx = process.argv.indexOf('--out');
  const out = argIdx !== -1 ? path.resolve(process.argv[argIdx + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'timeline-default-golden.rows.jsonl');
  fs.writeFileSync(out, await buildGoldenRowsJsonl());
  console.error(`wrote ${out}`);
}
