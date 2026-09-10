import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFactsStore, readFactsFile, factsRegimeDiff, FACTS_FILE } from '../../bench/memory/facts_store.mjs';

const REGIME = { model: 'qwen3.8:27b', url_host: 'box:11434', max_tokens: 4096, thinking: 'off', prompt_sha256: 'abc' };
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-store-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('facts store — extraction paid once, reused only under the same regime', () => {
  it('save writes a header first, then one line per session; readFactsFile maps them', () => {
    const s = createFactsStore({ file: path.join(dir, FACTS_FILE), extraction: REGIME, now: () => new Date('2026-09-09T20:00:00Z') });
    s.save('q1', 0, { facts: ['a', 'b'], parse_failed: false, extract_ms: 100 }, { runId: 'run-a' });
    s.save('q1', 1, { facts: [], parse_failed: true, extract_ms: 50 }, { runId: 'run-a' });
    const { header, entries } = readFactsFile(s.file);
    expect(header).toMatchObject({ type: 'header', run_id: 'run-a', extraction: REGIME, written_at: '2026-09-09T20:00:00.000Z' });
    expect(entries.get('q1:0')).toMatchObject({ question_id: 'q1', session_index: 0, facts: ['a', 'b'] });
    expect(entries.get('q1:1')).toMatchObject({ parse_failed: true, facts: [] });
    expect(s.stats.saved).toBe(2);
    expect(fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('a later run reuses sessions from that dir and counts them; unknown sessions load null', () => {
    const first = createFactsStore({ file: path.join(dir, FACTS_FILE), extraction: REGIME });
    first.save('q1', 0, { facts: ['a'] }, { runId: 'run-a' });
    const second = createFactsStore({ file: path.join(dir, 'second', FACTS_FILE), extraction: REGIME, reuseFrom: dir });
    expect(second.reusing).toBe(true);
    expect(second.load('q1', 0)).toMatchObject({ facts: ['a'] });
    expect(second.load('q1', 7)).toBeNull();
    expect(second.stats).toMatchObject({ reused: 1, reuse_source_run_id: 'run-a' });
    expect(second.stats.reuse_file).toBe(path.join(dir, FACTS_FILE));
  });

  it('refuses to reuse under a different extraction regime, naming the keys', () => {
    const first = createFactsStore({ file: path.join(dir, FACTS_FILE), extraction: REGIME });
    first.save('q1', 0, { facts: ['a'] }, { runId: 'run-a' });
    expect(() => createFactsStore({ file: path.join(dir, 'x', FACTS_FILE), extraction: { ...REGIME, max_tokens: 1024 }, reuseFrom: dir }))
      .toThrow(/facts reuse refused: extraction regime differs.*max_tokens: 4096 \(file\) vs 1024 \(this run\)/);
    expect(factsRegimeDiff(REGIME, { ...REGIME, thinking: 'on' })).toEqual(['thinking: "on" (file) vs "off" (this run)']);
    expect(factsRegimeDiff(REGIME, REGIME)).toEqual([]);
  });

  it('refuses a missing or headerless facts file loudly', () => {
    expect(() => createFactsStore({ file: path.join(dir, 'y', FACTS_FILE), extraction: REGIME, reuseFrom: path.join(dir, 'nope') })).toThrow();
    fs.writeFileSync(path.join(dir, FACTS_FILE), JSON.stringify({ type: 'session', question_id: 'q', session_index: 0, facts: [] }) + '\n');
    expect(() => createFactsStore({ file: path.join(dir, 'z', FACTS_FILE), extraction: REGIME, reuseFrom: dir })).toThrow(/no header line/);
  });

  it('a store without reuse loads null and never counts', () => {
    const s = createFactsStore({ file: path.join(dir, FACTS_FILE), extraction: REGIME });
    expect(s.reusing).toBe(false);
    expect(s.load('q', 0)).toBeNull();
    expect(s.stats.reused).toBe(0);
  });
});
