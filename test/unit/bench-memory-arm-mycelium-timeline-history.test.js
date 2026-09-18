import { describe, it, expect } from 'vitest';
import {
  createArmMyceliumTimeline,
  TIMELINE_READ_POLICY,
  TIMELINE_READ_POLICY_HISTORY,
  resolveTimelineReadPolicy,
  TIMELINE_HISTORY_OVERFETCH,
  TIMELINE_HISTORY_MAX_PREDECESSORS,
  attachHistoryChains,
} from '../../bench/memory/arms/arm_mycelium_timeline.mjs';

// task 220 — the READ side hides the history the WRITE side kept. The n=50
// receipt (2026-09-17-p1-224225) showed context_superseded = 0 on ALL 15
// knowledge-update rows: the fact-layer search asks for ONLY budget rows, and
// a superseded fact loses that slot race to its own successor (near-identical
// text ranks together, the current twin wins). Four of the seven wrong KU
// rows are HISTORY questions whose gold answer is the superseded predecessor
// of a current fact the reader DID hit. The `fact-episode-interleave-history`
// policy overfetches the fact search and walks each current fact's
// metadata.supersedes chain, placing the bounded predecessor chain BESIDE it,
// rendered with its validity window, so "was" and "is" are both readable.
//
// THE FIXTURE: one subject superseded twice — Charge 2 → Charge 3 → Charge 5 —
// plus four unrelated current facts (no predecessors) and one episode. The
// fake search honours `limit` exactly like the server: under the MEASURED
// policy (limit 5) the two predecessors rank below the five current facts and
// never surface — that IS today's production shape, pinned here.

const FACT_PAGE = [
  { source_id: 'f-charge5', content_text: 'Owns a Fitbit Charge 5', score: 5, metadata: { layer: 'fact', valid_from: '2024/01/10', valid_to: null, supersedes: 'f-charge3', superseded_by: null, superseded_by_text: null } },
  { source_id: 'f-a', content_text: 'Lives in Lisbon', score: 4, metadata: { layer: 'fact', valid_from: '2023/01/01', valid_to: null, supersedes: null, superseded_by: null, superseded_by_text: null } },
  { source_id: 'f-b', content_text: 'Has a dog', score: 3, metadata: { layer: 'fact', valid_from: '2023/02/01', valid_to: null, supersedes: null, superseded_by: null, superseded_by_text: null } },
  { source_id: 'f-c', content_text: 'Drinks espresso', score: 2, metadata: { layer: 'fact', valid_from: '2023/03/01', valid_to: null, supersedes: null, superseded_by: null, superseded_by_text: null } },
  { source_id: 'f-d', content_text: 'Manages a team of five', score: 1, metadata: { layer: 'fact', valid_from: '2023/04/01', valid_to: null, supersedes: null, superseded_by: null, superseded_by_text: null } },
  { source_id: 'f-charge3', content_text: 'Owns a Fitbit Charge 3', score: 0.9, metadata: { layer: 'fact', valid_from: '2023/06/01', valid_to: '2024/01/10', supersedes: 'f-charge2', superseded_by: 'f-charge5', superseded_by_text: 'Owns a Fitbit Charge 5' } },
  { source_id: 'f-charge2', content_text: 'Owns a Fitbit Charge 2', score: 0.8, metadata: { layer: 'fact', valid_from: '2022/12/01', valid_to: '2023/06/01', supersedes: null, superseded_by: 'f-charge3', superseded_by_text: 'Owns a Fitbit Charge 3' } },
];

const EPISODE_PAGE = [
  { source_id: 'e-0', content_text: 'user: I bought a new tracker today', metadata: { layer: 'episode', session_date: '2024/01/10 (Wed) 09:00' }, score: 2.5 },
];

// A fake whose slice-by-limit mirrors the real server: a row beyond `limit`
// does not exist as far as the caller is concerned.
function historyPlatform() {
  const searches = [];
  return {
    searches,
    async search({ namespace, limit }) {
      searches.push({ namespace, limit });
      if (namespace === 'bench-p1-r1-timeline') return { results: FACT_PAGE.slice(0, limit), mode: 'hybrid' };
      return { results: EPISODE_PAGE, mode: 'hybrid' };
    },
    async indexBulk() {
      return [];
    },
  };
}

function armFor(platform, readPolicy, seen) {
  return createArmMyceliumTimeline({
    answerChat: async (args) => {
      seen.push(args);
      return { text: 'ok', hadThink: false };
    },
    extractionChat: async () => {
      throw new Error('not called');
    },
    reconcileChat: async () => {
      throw new Error('not called');
    },
    platform,
    namespace: 'bench-p1-r1',
    retrievalBudget: 5,
    runId: 'r1',
    ...(readPolicy ? { readPolicy } : {}),
  });
}

const contextRows = (seen) =>
  seen[0].user.replace(/^Memory context:\n/, '').split('\n\nQuestion: ')[0].split('\n\n---\n\n');

describe('fact-episode-interleave-history — the task-220 read policy', () => {
  it('names both policies; the history name is new and the measured name is untouched', () => {
    expect(TIMELINE_READ_POLICY).toBe('fact-episode-interleave');
    expect(TIMELINE_READ_POLICY_HISTORY).toBe('fact-episode-interleave-history');
  });

  it('places the bounded predecessor chain BESIDE its current fact, oldest last, each with its validity window', async () => {
    const seen = [];
    const platform = historyPlatform();
    const arm = armFor(platform, TIMELINE_READ_POLICY_HISTORY, seen);
    const r = await arm.answer('How long have I been using my Fitbit Charge 3?');

    // the fact search OVERFETCHES so the predecessors are reachable; the
    // episode search stays at the budget
    expect(platform.searches).toEqual([
      { namespace: 'bench-p1-r1-timeline', limit: TIMELINE_HISTORY_OVERFETCH },
      { namespace: 'bench-p1-r1', limit: 5 },
    ]);

    // Charge 5's chain rides directly beside it; Charge 3 (newest predecessor)
    // first, Charge 2 (oldest) LAST; the unrelated facts grow nothing
    expect(contextRows(seen)).toEqual([
      '[fact | 2024/01/10] Owns a Fitbit Charge 5',
      '[fact | 2023/06/01 → superseded 2024/01/10] Owns a Fitbit Charge 3',
      '[fact | 2022/12/01 → superseded 2023/06/01] Owns a Fitbit Charge 2',
      '[session | 2024/01/10 (Wed) 09:00] user: I bought a new tracker today',
      '[fact | 2023/01/01] Lives in Lisbon',
      '[fact | 2023/02/01] Has a dog',
      '[fact | 2023/03/01] Drinks espresso',
    ]);

    expect(r.meta).toMatchObject({
      hits: 7,
      facts_hits: 7,
      episode_hits: 1,
      current_facts: 5,
      superseded_facts: 2,
      context_facts: 4,
      context_episodes: 1,
      context_superseded: 2,
      budget: 5,
      read_policy: TIMELINE_READ_POLICY_HISTORY,
      history_overfetch: TIMELINE_HISTORY_OVERFETCH,
      history_chain_misses: 0,
      retrieval_mode: 'hybrid',
      ingestion: 'timeline',
    });

    // the provenance stamp reflects what the model ACTUALLY read, in order,
    // with the chain depth on exactly the chain rows
    expect(r.meta.read_hits.map((h) => [h.source_id, h.rank])).toEqual([
      ['f-charge5', 0],
      ['f-charge3', 1],
      ['f-charge2', 2],
      ['e-0', 3],
      ['f-a', 4],
      ['f-b', 5],
      ['f-c', 6],
    ]);
    expect(r.meta.read_hits[0].chain_depth).toBeUndefined();
    expect(r.meta.read_hits[1].chain_depth).toBe(0);
    expect(r.meta.read_hits[2].chain_depth).toBe(1);
    expect(r.meta.read_hits[6].chain_depth).toBeUndefined();
  });

  it('the per-question meta counts match the rendered context', async () => {
    const seen = [];
    const arm = armFor(historyPlatform(), TIMELINE_READ_POLICY_HISTORY, seen);
    const r = await arm.answer('q');
    const rows = contextRows(seen);
    expect(r.meta.hits).toBe(rows.length);
    expect(r.meta.context_superseded).toBe(rows.filter((l) => l.startsWith('[fact |') && l.includes('→ superseded')).length);
    expect(r.meta.context_facts).toBe(rows.filter((l) => l.startsWith('[fact |') && !l.includes('→ superseded')).length);
    expect(r.meta.context_episodes).toBe(rows.filter((l) => l.startsWith('[session |')).length);
  });

  it('the DEFAULT is the MEASURED policy: no flag reproduces the measured meta shape byte-for-byte on this fixture', async () => {
    const seenDefault = [];
    const seenExplicit = [];
    const armDefault = armFor(historyPlatform(), null, seenDefault);
    const armExplicit = armFor(historyPlatform(), TIMELINE_READ_POLICY, seenExplicit);
    const rd = await armDefault.answer('q');
    const re = await armExplicit.answer('q');

    // identical bytes, and both stamp the measured policy
    expect(JSON.stringify(rd.meta)).toBe(JSON.stringify(re.meta));
    expect(rd.meta.read_policy).toBe(TIMELINE_READ_POLICY);
    expect(contextRows(seenDefault)).toEqual(contextRows(seenExplicit));

    // the measured shape on THIS fixture: the predecessors never surface
    // (limit 5 cuts the page before them) — context_superseded 0, and NO
    // history keys anywhere
    expect(seenDefault[0].user).toContain('[fact | 2024/01/10] Owns a Fitbit Charge 5');
    expect(seenDefault[0].user).not.toContain('superseded');
    expect(Object.keys(rd.meta).sort()).toEqual(
      [
        'budget',
        'context_episodes',
        'context_facts',
        'context_superseded',
        'current_facts',
        'degraded_reason',
        'episode_hits',
        'facts_hits',
        'had_think',
        'hits',
        'ingestion',
        'read_hits',
        'read_hits_available',
        'read_policy',
        'retrieval_error',
        'retrieval_mode',
        'superseded_facts',
        'write_decisions',
      ].sort()
    );
    expect(rd.meta).toMatchObject({ hits: 5, context_facts: 4, context_episodes: 1, context_superseded: 0 });
  });
});

describe('attachHistoryChains — the predecessor walk (pure)', () => {
  const fact = (id, supersedes, validTo = 't1') => ({
    source_id: id,
    _layer: 'fact',
    metadata: { layer: 'fact', valid_from: 'd', valid_to: validTo, supersedes },
  });

  it('walks at most TIMELINE_HISTORY_MAX_PREDECESSORS, newest first, oldest last', () => {
    expect(TIMELINE_HISTORY_MAX_PREDECESSORS).toBe(2);
    const c1 = fact('c1', null);
    const c2 = fact('c2', 'c1');
    const c3 = fact('c3', 'c2');
    const c5 = fact('c5', 'c3', null);
    const out = attachHistoryChains({ merged: [c5], factHits: [c5, c3, c2, c1], maxPredecessors: 2 });
    expect(out.rows.map((h) => h.source_id)).toEqual(['c5', 'c3', 'c2']); // c1 is beyond the bound
    expect(out.misses).toBe(0);
    expect(out.rows[1]._chain).toBe(true);
    expect(out.rows[1]._chain_depth).toBe(0);
    expect(out.rows[2]._chain_depth).toBe(1);
  });

  it('a supersedes id the window does not contain is a COUNTED miss, never a silent truncation', () => {
    const c5 = fact('c5', 'f-charge3', null);
    const out = attachHistoryChains({ merged: [c5], factHits: [c5], maxPredecessors: 2 });
    expect(out.rows).toEqual([c5]);
    expect(out.misses).toBe(1);
  });

  it('a predecessor shared by two current facts renders once; a no-predecessor fact adds nothing', () => {
    const shared = fact('shared', null);
    const a = fact('a', 'shared', null);
    const b = fact('b', 'shared', null);
    const lone = fact('lone', null, null);
    const out = attachHistoryChains({ merged: [a, b, lone], factHits: [a, b, lone, shared], maxPredecessors: 2 });
    expect(out.rows.map((h) => h.source_id)).toEqual(['a', 'shared', 'b', 'lone']);
    expect(out.misses).toBe(0);
  });

  it('a link whose target has no valid_to is refused (it would blur "was" from "is"), counted as a miss', () => {
    const cur = fact('cur', 'pred', null);
    const pred = fact('pred', null, null); // malformed: claims to be a predecessor but is "current"
    const out = attachHistoryChains({ merged: [cur], factHits: [cur, pred], maxPredecessors: 2 });
    expect(out.rows).toEqual([cur]);
    expect(out.misses).toBe(1);
  });
});

describe('resolveTimelineReadPolicy', () => {
  it('defaults to the measured policy; accepts both names; throws loudly on junk', () => {
    expect(resolveTimelineReadPolicy(undefined)).toBe(TIMELINE_READ_POLICY);
    expect(resolveTimelineReadPolicy('fact-episode-interleave')).toBe(TIMELINE_READ_POLICY);
    expect(resolveTimelineReadPolicy(TIMELINE_READ_POLICY_HISTORY)).toBe(TIMELINE_READ_POLICY_HISTORY);
    expect(() => resolveTimelineReadPolicy('history')).toThrow(/read-policy|readPolicy|unknown/i);
    expect(() => resolveTimelineReadPolicy('fact-episode-interleave-historical')).toThrow(/unknown/i);
  });

  it('the arm factory refuses an unknown policy at construction time', () => {
    expect(
      () =>
        createArmMyceliumTimeline({
          answerChat: async () => ({}),
          extractionChat: async () => ({}),
          reconcileChat: async () => ({}),
          platform: historyPlatform(),
          namespace: 'bench-p1-r1',
          retrievalBudget: 5,
          runId: 'r1',
          readPolicy: ' newest-first',
        })
    ).toThrow(/readPolicy|read policy|unknown/i);
  });
});
