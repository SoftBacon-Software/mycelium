// task 213 — the ledger-identity driver (pre-committed number 1, second half).
//
// Runs the REAL timeline arm through the REAL runBench row path on a FIXED
// hermetic fixture — scripted extraction/decision/answer chats, a fake platform
// whose every fact hit carries the healthy-embedder stamp (embedded: true), a
// stubbed clock — and dumps the per-candidate decision ledger as JSON.
//
// Run against BOTH trees with the SAME fixture:
//   node fastpath-guard-ledger-driver.mjs <tree-root> <out.json>
// The pre-committed claim: the guard tree's ledger is decision-for-decision
// IDENTICAL to the pre-guard tree's (baseline d73978f0) — with a healthy
// embedder the guard changes no decision, only adds the count (== 0 here).

const root = process.argv[2];
const out = process.argv[3];
if (!root || !out) {
  console.error('usage: node fastpath-guard-ledger-driver.mjs <tree-root> <out.json>');
  process.exit(2);
}

const { runBench } = await import(`${root}/bench/memory/core.mjs`);
const { createArmMyceliumTimeline } = await import(`${root}/bench/memory/arms/arm_mycelium_timeline.mjs`);

const DATES = ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:15', '2023/05/22 (Mon) 18:00'];
const SESSIONS = [
  [{ role: 'user', content: 'I just signed the lease for the Lisbon apartment.' }],
  [{ role: 'user', content: 'Update about the apartment: moving in June.' }],
  [{ role: 'user', content: 'Also: my manager is Dana now.' }],
];

// The fake platform mirrors the golden fixture's rule — live rows in insertion
// order, score 0.9 on a substring match / 0.2 otherwise — and stamps EVERY hit
// embedded:true (the healthy-embedder shape: each row's own vector exists).
function fakePlatform() {
  const rows = new Map();
  const order = [];
  return {
    async indexBulk(items) {
      let written = 0;
      for (const it of items) {
        const key = `${it.namespace}|${it.source_type}|${it.source_id}`;
        if (!rows.has(key)) order.push(key);
        rows.set(key, { ...it, chunk_index: 0 });
        written += 1;
      }
      return [{ rows: written }];
    },
    async search({ query, namespace, sourceTypes, limit }) {
      const out = [];
      for (const key of order) {
        const r = rows.get(key);
        if (r.namespace !== namespace) continue;
        if (sourceTypes?.length && !sourceTypes.includes(r.source_type)) continue;
        const match = r.content_text.includes(query) || query.includes(r.content_text);
        out.push({
          source_id: r.source_id,
          content_text: r.content_text,
          metadata: r.metadata,
          score: match ? 0.9 : 0.2,
          embedded: true, // the healthy-embedder stamp on EVERY hit
        });
      }
      return { results: out.slice(0, limit), mode: 'hybrid' };
    },
  };
}

const EXTRACTION_REPLIES = [
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon"]}' },
  { text: '{"facts": ["Signed a lease for an apartment in Lisbon — moving in June"]}' },
  { text: '{"facts": ["User manager is Dana"]}' },
];
const DECISION_REPLIES = ['SUPERSEDE r1-q1-tl-f0', 'ADD'];
const extractionChat = (() => {
  let i = 0;
  return async () => EXTRACTION_REPLIES[i++];
})();
const reconcileChat = (() => {
  let i = 0;
  return async () => ({ text: DECISION_REPLIES[i++] });
})();

const realNow = Date.now;
Date.now = () => 1700000000000;
try {
  const { summary } = await runBench({
    items: [
      {
        question_id: 'q1',
        question_type: 'multi-session',
        question: 'When does the lease start?',
        answer: 'It starts in May.',
        haystack_dates: DATES,
        haystack_sessions: SESSIONS,
      },
    ],
    armFactories: [{ name: 'mycelium-timeline', factory: (ctx) => createArmMyceliumTimeline(ctx) }],
    armContext: {
      answerChat: async () => ({ text: 'ok' }),
      extractionChat,
      reconcileChat,
      platform: fakePlatform(),
      namespace: 'bench-p1-ident',
      retrievalBudget: 5,
      runId: 'r1',
    },
    regime: Object.freeze({ date_utc: '2026-09-17T00:00:00.000Z', git_sha: 'ledger-identity-fixture', notes: [] }),
    runId: 'r1',
  });
  const tl = summary.arms['mycelium-timeline'].write.timeline;
  const fs = await import('node:fs');
  fs.writeFileSync(out, JSON.stringify({
    ledger: tl.per_question.flatMap((q) => q.candidates_ledger),
    counts: Object.fromEntries(Object.entries(tl).filter(([k, v]) => typeof v === 'number')),
  }, null, 2) + '\n');
  console.error(`wrote ${out}: ${tl.per_question.flatMap((q) => q.candidates_ledger).length} ledger entries, fastpath_skips_unembedded=${tl.fastpath_skips_unembedded ?? 'ABSENT'}`);
} finally {
  Date.now = realNow;
}
