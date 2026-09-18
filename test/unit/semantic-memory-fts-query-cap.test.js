// 2026-09-18: three event-loop wedges in one night traced (gdb on the live
// Jetson process) to Statement.all inside fts5Bm25Function — a multi-kilobyte
// brief sent as the search query became a ~1,000-term OR that every row matched.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import createMemoryDB, { buildFtsQuery, FTS_MAX_TERMS } from '../../server/plugins/semantic-memory/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function terms(q) { return q ? q.split(' OR ') : []; }

describe('buildFtsQuery — the keyword leg is bounded', () => {
  it('a 6 KB brief-shaped query yields at most FTS_MAX_TERMS distinct lowercase terms', () => {
    const brief = ('THE DIRECTIVE (Gilbert 2026-09-10): "each agent does better today because they remember the lessons '
      + 'and history of yesterday." Program: BRIEF-lab-alive-memory-program.md §3 — the timeline arm, measured on the grid. '
      + 'Deliver (mycelium, ONE commit, worktree off master OUTSIDE the checkout at /Users/grb/Projects/_wt/mycelium-220); '
      + 'red tests first; NO pushes; NO deploys. gate_cmd pytest ruff eslint vitest ').repeat(20);
    expect(brief.length).toBeGreaterThan(6000);
    const q = buildFtsQuery(brief);
    const t = terms(q);
    expect(t.length).toBeLessThanOrEqual(FTS_MAX_TERMS);
    expect(t.length).toBeGreaterThan(10);
    expect(new Set(t).size).toBe(t.length); // distinct
    for (const x of t) {
      expect(x).toMatch(/^"[^"]+"$/); // each term quoted, no FTS specials inside
      expect(x).toBe(x.toLowerCase());
      expect(x.length).toBeGreaterThanOrEqual(5); // "abc" at minimum
    }
    expect(q).not.toMatch(/"the"|"and"|"for"/); // stopwords dropped
  });

  it('strips FTS5 specials, drops short tokens and duplicates, keeps order', () => {
    expect(buildFtsQuery('Fitbit (Charge) "3"* charge FITBIT ok 9 months')).toBe('"fitbit" OR "charge" OR "months"');
  });

  it('an empty or all-stopword query has no keyword leg — searchKeyword returns [] without touching FTS', () => {
    expect(buildFtsQuery('')).toBe('');
    expect(buildFtsQuery('the and for a an')).toBe('');
    const db = new Database(':memory:');
    db.exec(readFileSync(join(HERE, '../../server/plugins/semantic-memory/schema.sql'), 'utf8'));
    const mem = createMemoryDB(db, { config: { embedding_provider: 'none' } });
    mem.index('memory', 'a', 'Owns a Fitbit Charge 5 since June', { namespace: 'test' });
    expect(mem.searchKeyword('the and', { limit: 5 })).toEqual([]);
    expect(mem.searchKeyword('fitbit charge', { limit: 5 }).length).toBe(1);
  });
});
