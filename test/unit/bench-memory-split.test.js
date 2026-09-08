import { describe, it, expect } from 'vitest';
import { loadSplit, selectItems, SPLITS } from '../../bench/memory/split.mjs';

describe('bench/memory split selection', () => {
  const items = [
    { question_id: 'q-003', question: 'c', answer: 'C', question_type: 'multi-session', haystack_sessions: [[]] },
    { question_id: 'q-001', question: 'a', answer: 'A', question_type: 'multi-session', haystack_sessions: [[]] },
    { question_id: 'q-002', question: 'b', answer: 'B', question_type: 'multi-session', haystack_sessions: [[]] },
  ];

  it('selects deterministically: sorted by question_id, first n', () => {
    expect(selectItems(items, 2).map((i) => i.question_id)).toEqual(['q-001', 'q-002']);
    expect(selectItems(items, 3).map((i) => i.question_id)).toEqual(['q-001', 'q-002', 'q-003']);
    // same input, same output — no shuffling, ever
    expect(selectItems(items, 2).map((i) => i.question_id)).toEqual(selectItems([...items].reverse(), 2).map((i) => i.question_id));
  });

  it('selecting more than available would take all (runner errors on short split)', () => {
    expect(selectItems(items, 99)).toHaveLength(3);
  });
});

describe('bench/memory split loading (sha gate)', () => {
  it('loads the committed hermetic fixture and verifies its sha256', async () => {
    const s = await loadSplit('fixture');
    expect(s.count).toBe(3);
    expect(s.sha256).toBe(SPLITS.fixture.expectedSha256);
    expect(s.items[0].haystack_sessions).toBeDefined();
  });

  it('refuses to load a split whose sha256 does not match the pinned value', async () => {
    const fakeSplits = {
      fixture: {
        ...SPLITS.fixture,
        expectedSha256: 'not-the-real-sha',
      },
    };
    await expect(loadSplit('fixture', { splits: fakeSplits })).rejects.toThrow(/MISMATCH/);
  });

  it('fails loud when the split file is missing, with the download instruction', async () => {
    const fakeSplits = {
      longmemeval: {
        ...SPLITS.longmemeval,
        dir: '/nonexistent-dir-for-test',
      },
    };
    await expect(loadSplit('longmemeval', { splits: fakeSplits })).rejects.toThrow(/curl -L/);
  });

  it('longmemeval split pins the published sha256 and MIT licence', () => {
    expect(SPLITS.longmemeval.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SPLITS.longmemeval.expectedSha256).toBe(
      'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442'
    );
    expect(SPLITS.longmemeval.licence).toBe('MIT');
    expect(SPLITS.longmemeval.url).toContain('huggingface.co/datasets/xiaowu0162/longmemeval-cleaned');
  });
});
