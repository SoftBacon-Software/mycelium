import { describe, it, expect } from 'vitest';
import { purgeRunRows, purgeNamespaces } from '../../bench/memory/cleanup.mjs';

// Fake platform whose /memory/list mirrors the server's hard cap: it never
// returns more than `cap` rows per call, newest first, and deleteIndex removes
// a source_id from the pool. This is the shape that let a single
// list-then-delete sweep silently strand everything past row 100.
function fakePlatform({ ids, cap = 3, failIds = [] }) {
  const pool = new Set(ids);
  const failed = [];
  const calls = { list: 0, deletes: 0 };
  return {
    calls,
    failed,
    async listByType(_sourceType, { namespace, limit } = {}) {
      calls.list++;
      if (!namespace) throw new Error('fake list requires a namespace');
      const remaining = ids.filter((id) => pool.has(id));
      return { results: remaining.slice(0, Math.min(limit ?? 20, cap)).map((source_id) => ({ source_id, namespace })) };
    },
    async deleteIndex(_sourceType, sourceId) {
      calls.deletes++;
      if (failIds.includes(sourceId)) { failed.push(sourceId); throw new Error(`DELETE -> 500: boom ${sourceId}`); }
      pool.delete(sourceId);
      return { ok: true };
    },
  };
}

const IDS = Array.from({ length: 250 }, (_, i) => `r-${String(i).padStart(3, '0')}`);

describe('purgeRunRows (paginating bench cleanup)', () => {
  it('drains a namespace larger than the list cap and reports the truth', async () => {
    const platform = fakePlatform({ ids: IDS, cap: 100 });
    const out = await purgeRunRows(platform, { sourceType: 'bench_longmemeval', namespace: 'bench-p1-test' });
    expect(out.deleted).toBe(250);
    expect(out.batches).toBe(3); // 100 + 100 + 50, then the empty list that ends the loop
    expect(out.rows_remaining_after).toBe(0);
    expect(out.failed_deletes).toEqual([]);
    expect(out.kept).toBe(false);
  });

  it('stops and reports rather than spinning when every delete in a batch fails', async () => {
    const platform = fakePlatform({ ids: IDS.slice(0, 5), cap: 100, failIds: IDS.slice(0, 5) });
    const out = await purgeRunRows(platform, { sourceType: 'bench_longmemeval', namespace: 'bench-p1-test' });
    expect(out.deleted).toBe(0);
    expect(out.rows_remaining_after).toBe(5);
    expect(out.failed_deletes).toHaveLength(5);
    expect(platform.calls.deletes).toBe(5); // one batch's worth, no spin
  });

  it('refuses to run without an explicit namespace', async () => {
    const platform = fakePlatform({ ids: IDS.slice(0, 2) });
    await expect(purgeRunRows(platform, { sourceType: 'bench_longmemeval' })).rejects.toThrow(/explicit namespace/);
    expect(platform.calls.list).toBe(0);
  });

  it('is a no-op drain (one empty list) when the namespace is already empty', async () => {
    const platform = fakePlatform({ ids: [], cap: 100 });
    const out = await purgeRunRows(platform, { sourceType: 'bench_longmemeval', namespace: 'bench-p1-test' });
    expect(out.deleted).toBe(0);
    expect(out.batches).toBe(0);
    expect(out.rows_remaining_after).toBe(0);
  });
});

describe('purgeNamespaces — every namespace a run indexed, one receipt shape', () => {
  const fakePurge = async (_platform, { namespace }) => ({
    namespace,
    deleted: namespace.endsWith('-extract') ? 5 : 2,
    batches: 1,
    failed_deletes: namespace.endsWith('-extract') ? ['x1'] : [],
    rows_remaining_after: 0,
  });

  it('one namespace returns that purge itself', async () => {
    const logs = [];
    const r = await purgeNamespaces({}, { sourceType: 'bench_x', namespaces: ['bench-p1-a'], log: (m) => logs.push(m), purge: fakePurge });
    expect(r).toMatchObject({ namespace: 'bench-p1-a', deleted: 2 });
    expect(logs).toEqual(['cleanup bench-p1-a: 2 deleted in 1 batches, 0 failed, 0 remaining']);
  });

  it('several namespaces aggregate with per_namespace detail', async () => {
    const r = await purgeNamespaces({}, { sourceType: 'bench_x', namespaces: ['bench-p1-a', 'bench-p1-a-extract'], purge: fakePurge });
    expect(r).toMatchObject({ namespaces: ['bench-p1-a', 'bench-p1-a-extract'], deleted: 7, batches: 2, failed_deletes: ['x1'], rows_remaining_after: 0, kept: false });
    expect(r.per_namespace).toHaveLength(2);
  });
});
