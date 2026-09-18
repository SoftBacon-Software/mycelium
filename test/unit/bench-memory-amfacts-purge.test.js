import { describe, it, expect } from 'vitest';
import { purgeRunWithFacts } from '../../bench/memory/cleanup.mjs';
import { createPlatform } from '../../bench/memory/platform.mjs';

// task 216 — the am_facts ROWS half of the bench cleanup contract. The routes
// layer (MYCELIUM_TIMELINE_FACTS=am_facts) writes fact rows into the
// auto-memory TABLE under the <ns>-amfacts namespace; purgeRunRows/purgeNamespaces
// drain the semantic-INDEX half only (listByType + deleteIndex). purgeRunWithFacts
// purges the rows first through task 211's DELETE /auto-memory/facts?namespace=<ns>
// — and ONLY that namespace — then the index purge, then the two verify reads
// the cleanup receipt states (factsList → 0 rows, namespace-scoped search → 0 hits).
//
// Fake platform: the bench-cleanup fake (index pool, capped list, deleteIndex)
// PLUS an am_facts row table only factsPurgeByNamespace can drain, a factsList
// read, and a namespace-scoped search. Every call is recorded with a sequence
// number so the receipt's stated ORDER — rows first, then index, then verify —
// is itself the assertion. The fake's factsPurge touches ONLY the fact table
// (it does not model 211's unindex seam), so a zero search-hit verify requires
// BOTH halves to have actually run.

function fakePlatform({ indexIds = [], factRows = [], failFactsPurge = false, failIds = [], indexNs = 'bench-p1-x-amfacts' } = {}) {
  const indexRows = indexIds.map((source_id) => ({ source_id, namespace: indexNs, source_type: 'am_fact' }));
  const facts = factRows.map((f, i) => ({ id: i + 1, namespace: f.namespace ?? 'bench-p1-x-amfacts', text: f.text ?? `fact ${i + 1}` }));
  const calls = [];
  let seq = 0;
  const record = (what, detail = {}) => calls.push({ seq: ++seq, what, ...detail });
  return {
    calls,
    factsTable: facts,
    indexRows,
    async factsPurgeByNamespace(namespace) {
      record('factsPurgeByNamespace', { namespace });
      if (failFactsPurge) throw new Error('DELETE /auto-memory/facts -> 500: boom');
      if (!namespace) throw new Error('fake purge requires a namespace');
      const doomed = facts.filter((f) => f.namespace === namespace);
      for (const f of doomed) facts.splice(facts.indexOf(f), 1);
      return { deleted: doomed.length, namespaces: [namespace] };
    },
    async factsList({ namespace } = {}) {
      record('factsList', { namespace });
      if (!namespace) throw new Error('fake factsList requires a namespace');
      return facts.filter((f) => f.namespace === namespace); // server shape: a bare array
    },
    async search({ query, namespace, sourceTypes, limit } = {}) {
      record('search', { query, namespace, sourceTypes, limit });
      // any query hits every remaining index row in the namespace: a leftover
      // row cannot hide from the verify, a drained namespace answers 0
      const hits = indexRows.filter(
        (r) => r.namespace === namespace && (!sourceTypes?.length || sourceTypes.includes(r.source_type)),
      );
      return { results: hits.slice(0, limit ?? hits.length), mode: 'hybrid', count: hits.length, query };
    },
    async listByType(_sourceType, { namespace, limit } = {}) {
      record('listByType', { namespace });
      if (!namespace) throw new Error('fake list requires a namespace');
      const remaining = indexRows.filter((r) => r.namespace === namespace);
      return { results: remaining.slice(0, Math.min(limit ?? 20, 100)) };
    },
    async deleteIndex(_sourceType, sourceId) {
      record('deleteIndex', { sourceId });
      if (failIds.includes(sourceId)) throw new Error('DELETE -> 500: boom');
      const at = indexRows.findIndex((r) => r.source_id === sourceId);
      if (at !== -1) indexRows.splice(at, 1);
      return { ok: true };
    },
  };
}

const FACT_NS = 'bench-p1-x-amfacts';
const RUN_NAMESPACES = ['bench-p1-x', FACT_NS];
const SOURCE_TYPES = { 'bench-p1-x': 'bench_longmemeval', [FACT_NS]: 'am_fact' };
const VERIFY = { query: 'What is the managers name', sourceTypes: ['am_fact'], limit: 5 };
const INDEX_IDS = Array.from({ length: 7 }, (_, i) => `amfact-row-${i}`);

const routesModeArgs = (extra = {}) => ({
  sourceType: 'bench_longmemeval',
  namespaces: RUN_NAMESPACES,
  sourceTypesByNamespace: SOURCE_TYPES,
  factsNamespace: FACT_NS,
  verify: VERIFY,
  ...extra,
});

describe('purgeRunWithFacts — routes-mode cleanup (MYCELIUM_TIMELINE_FACTS=am_facts)', () => {
  it('purges the fact rows FIRST, then the index, then the verify reads', async () => {
    const platform = fakePlatform({
      indexIds: INDEX_IDS,
      factRows: [{}, {}, {}, {}, {}], // 5 rows: the 210 smoke scale (4 supersede-chain + current)
    });
    const out = await purgeRunWithFacts(platform, routesModeArgs());
    expect(out.facts_cleanup.facts_deleted).toBe(5);
    expect(out.facts_cleanup.facts_rows_remaining_after).toBe(0);
    expect(out.facts_cleanup.search_hits_after).toBe(0);
    expect(out.rows_remaining_after).toBe(0); // the index half drained too
    // the stated receipt order: rows purge < first index list < verify reads
    const kinds = platform.calls.map((c) => c.what);
    expect(kinds[0]).toBe('factsPurgeByNamespace');
    expect(kinds.indexOf('factsPurgeByNamespace')).toBeLessThan(kinds.indexOf('listByType'));
    expect(kinds.indexOf('listByType')).toBeLessThan(kinds.indexOf('factsList'));
    expect(kinds.indexOf('factsList')).toBeLessThan(kinds.lastIndexOf('search'));
  });

  it('fires factsPurgeByNamespace EXACTLY once, for the -amfacts namespace only', async () => {
    const platform = fakePlatform({ indexIds: INDEX_IDS, factRows: [{}, {}] });
    await purgeRunWithFacts(platform, routesModeArgs());
    const purges = platform.calls.filter((c) => c.what === 'factsPurgeByNamespace');
    expect(purges).toHaveLength(1);
    expect(purges[0].namespace).toBe(FACT_NS);
    expect(purges[0].namespace.endsWith('-amfacts')).toBe(true);
    // the episodic namespace rides the INDEX purge only — it never touches the
    // facts route (pinned by suffix: the base ns has no -amfacts suffix)
    expect(RUN_NAMESPACES).toContain('bench-p1-x');
    expect(purges.map((p) => p.namespace)).not.toContain('bench-p1-x');
  });

  it('post-purge both verify reads return zero on a platform with rows and index rows', async () => {
    const platform = fakePlatform({ indexIds: INDEX_IDS, factRows: [{}, {}, {}] });
    const out = await purgeRunWithFacts(platform, routesModeArgs());
    expect(platform.factsTable).toHaveLength(0);
    expect(platform.indexRows).toHaveLength(0);
    expect(out.facts_cleanup).toMatchObject({
      namespace: FACT_NS,
      facts_rows_remaining_after: 0,
      search_hits_after: 0,
    });
    // the search verify is the namespace-scoped am_fact probe (206's seam)
    const search = platform.calls.find((c) => c.what === 'search');
    expect(search.namespace).toBe(FACT_NS);
    expect(search.sourceTypes).toEqual(['am_fact']);
    expect(search.query).toBe(VERIFY.query);
  });

  it('refuses a facts namespace outside the run namespace list', async () => {
    const platform = fakePlatform({ indexIds: INDEX_IDS, factRows: [{}] });
    await expect(
      purgeRunWithFacts(platform, routesModeArgs({ factsNamespace: 'some-other-run-amfacts' })),
    ).rejects.toThrow(/outside the run/);
    expect(platform.calls.filter((c) => c.what === 'factsPurgeByNamespace')).toHaveLength(0);
  });

  it('requires the verify reads — a routes-mode cleanup without them is a receipt that cannot state "drained"', async () => {
    const platform = fakePlatform({ indexIds: INDEX_IDS, factRows: [{}] });
    await expect(purgeRunWithFacts(platform, routesModeArgs({ verify: null }))).rejects.toThrow(/verify/);
    await expect(purgeRunWithFacts(platform, routesModeArgs({ verify: { sourceTypes: ['am_fact'], limit: 5 } }))).rejects.toThrow(/verify/);
    expect(platform.calls).toHaveLength(0);
  });

  it('a FAILED rows purge still runs the index purge, then surfaces the error loudly', async () => {
    const platform = fakePlatform({ indexIds: INDEX_IDS, factRows: [{}], failFactsPurge: true });
    await expect(purgeRunWithFacts(platform, routesModeArgs())).rejects.toThrow(/boom/);
    // the index half ran anyway — a mid-write death must not strand the index rows
    expect(platform.calls.some((c) => c.what === 'deleteIndex')).toBe(true);
    expect(platform.indexRows).toHaveLength(0);
    // the fact row remains — the leak is reported, never hidden
    expect(platform.factsTable).toHaveLength(1);
  });
});

describe('purgeRunWithFacts — memory-rows mode (the default path)', () => {
  it('fires the facts route ZERO times and returns the purgeNamespaces shape byte-identically', async () => {
    const platform = fakePlatform({ indexIds: INDEX_IDS, factRows: [{}, {}], indexNs: 'bench-p1-x' });
    const out = await purgeRunWithFacts(platform, {
      sourceType: 'bench_longmemeval',
      namespaces: ['bench-p1-x'],
      sourceTypesByNamespace: { 'bench-p1-x': 'bench_longmemeval' },
      factsNamespace: null,
    });
    expect(platform.calls.some((c) => c.what === 'factsPurgeByNamespace')).toBe(false);
    expect(platform.calls.some((c) => c.what === 'factsList')).toBe(false);
    expect(platform.calls.some((c) => c.what === 'search')).toBe(false);
    expect(out.facts_cleanup).toBeUndefined();
    // the pre-216 shape, field for field
    expect(out).toEqual({
      namespace: 'bench-p1-x',
      source_type: 'bench_longmemeval',
      batches: 1,
      deleted: 7,
      failed_deletes: [],
      rows_remaining_after: 0,
      kept: false,
    });
  });
});

describe('createPlatform.factsPurgeByNamespace — the client seam', () => {
  const okFetch = (calls) => async (url, init) => {
    calls.push({ url, init });
    const text = JSON.stringify({ deleted: 5, namespaces: ['bench-p1-x-amfacts'] });
    return { status: 200, text: async () => text };
  };

  it('DELETEs /auto-memory/facts?namespace=<ns> and returns {deleted, namespaces}', async () => {
    const calls = [];
    const platform = createPlatform({ baseUrl: 'http://plat.test', fetchImpl: okFetch(calls) });
    const out = await platform.factsPurgeByNamespace('bench-p1-x-amfacts');
    expect(out).toEqual({ deleted: 5, namespaces: ['bench-p1-x-amfacts'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe('http://plat.test/api/mycelium/auto-memory/facts?namespace=bench-p1-x-amfacts');
  });

  it('encodes the namespace into the query string', async () => {
    const calls = [];
    const platform = createPlatform({ baseUrl: 'http://plat.test', fetchImpl: okFetch(calls) });
    await platform.factsPurgeByNamespace('run id with spaces-amfacts');
    expect(calls[0].url).toBe('http://plat.test/api/mycelium/auto-memory/facts?namespace=run%20id%20with%20spaces-amfacts');
  });

  it('refuses locally on an empty or missing namespace (purgeRunRows refusal convention, mirrored)', async () => {
    const calls = [];
    const platform = createPlatform({ baseUrl: 'http://plat.test', fetchImpl: okFetch(calls) });
    await expect(platform.factsPurgeByNamespace('')).rejects.toThrow(/explicit namespace/);
    await expect(platform.factsPurgeByNamespace('   ')).rejects.toThrow(/explicit namespace/);
    await expect(platform.factsPurgeByNamespace(undefined)).rejects.toThrow(/explicit namespace/);
    expect(calls).toHaveLength(0); // nothing reached the wire
  });
});
