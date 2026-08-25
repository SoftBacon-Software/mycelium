// Docs inventory accuracy gate — runs under `npx vitest run` (matches test/**/*.test.js).
//
// The orientation docs (README.md, CLAUDE.md, .claude/CLAUDE.md) state concrete numbers
// about the size of the codebase: how many tables, how many routes, how many test files,
// and that routes/db.js were decomposed out of former god-files. Those numbers rot the
// moment the code moves, and a stale doc sells a stranger a picture of a monolith that no
// longer exists. This gate computes the real numbers from source and asserts the docs
// agree; if a count drifts, the failure names the offending doc and the real value.
//
// The test-FILE count is computed the same way vitest collects it — a recursive scan of
// `test/**/*.test.js`, the `include` glob in vitest.config.js — so the number the gate
// enforces is always exactly what `npm test` runs, in CI and in a dirty dev tree alike.
// (A test *case* count can't be computed statically, so the gate instead forbids any hard
// "N tests" literal and points readers at `npm test`.)
//
// Pins the same way test/refactor/db-manifest.test.js pins 308 db.js exports and
// test/unit/schema-drift.test.js pins the schema: compute from source, compare to what
// the docs claim. Compute, don't hardcode.

import { describe, test } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- real values, computed from source -------------------------------------

// Tables: count lines in the base schema containing `CREATE TABLE` (same method as
// `grep -c 'CREATE TABLE' server/schema.sql`).
const TABLE_COUNT = read('server/schema.sql')
  .split('\n')
  .filter((line) => /CREATE TABLE/.test(line)).length;

// Routes: one per non-blank line of the committed route-manifest snapshot. The snapshot
// itself is kept current by the route-manifest gate (`node test/refactor/route-manifest.mjs
// --check`), so reading it here is reading the pinned truth.
const ROUTE_COUNT = read('test/refactor/route-manifest.snapshot')
  .split('\n')
  .filter((line) => line.trim().length > 0).length;

// Test files: a recursive scan of `test/` for `*.test.js` — the SAME set vitest collects
// via its `include` glob `test/**/*.test.js` (vitest.config.js). We count the filesystem,
// not `git ls-files`, because the contract is "the docs match what `npm test` runs" and
// vitest collects from disk, not from git-tracked-ness: an uncommitted file in someone's
// working tree moves both numbers — `npm test`'s and this gate's — in lockstep. That makes
// the gate equal to `npm test` everywhere, with no tracked-vs-filesystem seam to paper
// over (the prior `git ls-files` + self-`+1` patch assumed at most one untracked test file
// and undercounted the moment a second appeared).
const listTestFiles = () => {
  const acc = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.test.js')) acc.push(p);
    }
  };
  walk(join(ROOT, 'test'));
  return acc;
};
const TEST_FILE_COUNT = listTestFiles().length;

// README.md and CLAUDE.md ship with the repo. `.claude/CLAUDE.md` is a LOCAL,
// gitignored AI-orientation file (see `.gitignore`) — present on a developer's
// machine but absent from a clean checkout, so assert against it only when it
// exists. On CI it is simply not in the map and not checked.
const DOCS = {};
for (const rel of ['README.md', 'CLAUDE.md', '.claude/CLAUDE.md']) {
  const full = join(ROOT, rel);
  if (existsSync(full)) DOCS[rel] = readFileSync(full, 'utf8');
}

// Concise, one-line assertions (throw on violation) so a drift produces a clear
// "doc X says Y, real is Z" message instead of dumping a whole file into CI output.
const everyCountEquals = (text, re, expected, doc, unit) => {
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (n !== expected) {
      throw new Error(
        `${doc}: says "${m[0].trim()}" but the real ${unit} count is ${expected}. Update the doc.`,
      );
    }
  }
};
const mustContain = (text, re, doc, what) => {
  if (!re.test(text)) {
    throw new Error(`${doc}: does not state ${what}. The doc must be updated to match reality.`);
  }
};
const mustNotContain = (text, re, doc, why) => {
  const m = text.match(re);
  if (m) {
    throw new Error(`${doc}: still contains stale "${m[0].trim()}" — ${why}.`);
  }
};

describe('docs inventory accuracy', () => {
  test(`schema.sql defines ${TABLE_COUNT} tables — every "N tables" in the docs agrees`, () => {
    for (const [doc, text] of Object.entries(DOCS)) {
      everyCountEquals(text, /(\d+)\s+tables\b/gi, TABLE_COUNT, doc, 'table');
    }
  });

  test('the docs that state a table count state the real one', () => {
    // Root CLAUDE.md intentionally states no table count; README and .claude/CLAUDE.md do.
    // .claude/CLAUDE.md is local-only (gitignored), so only check it when present.
    mustContain(DOCS['README.md'], new RegExp(`${TABLE_COUNT}\\s+tables`), 'README.md', `"${TABLE_COUNT} tables"`);
    if (DOCS['.claude/CLAUDE.md']) {
      mustContain(
        DOCS['.claude/CLAUDE.md'],
        new RegExp(`${TABLE_COUNT}\\s+tables`),
        '.claude/CLAUDE.md',
        `"${TABLE_COUNT} tables"`,
      );
    }
  });

  test(`route manifest has ${ROUTE_COUNT} routes — every "N routes"/"N endpoints" agrees`, () => {
    for (const [doc, text] of Object.entries(DOCS)) {
      everyCountEquals(
        text,
        /(\d+)\s*[-–—]?\s*(?:routes?|endpoints?)\b/gi,
        ROUTE_COUNT,
        doc,
        'route',
      );
    }
  });

  test('every doc states the route count', () => {
    const re = new RegExp(`${ROUTE_COUNT}[-\\s]*(?:routes?|endpoints?)`, 'i');
    for (const [doc, text] of Object.entries(DOCS)) {
      mustContain(text, re, doc, `the ${ROUTE_COUNT}-route count`);
    }
  });

  test(`there are ${TEST_FILE_COUNT} test files — every doc states that count and no other`, () => {
    // vitest collects exactly these files (test/**/*.test.js), so every "N files" in the
    // docs must equal what `npm test` runs — no stale "20 files" / "47 files" may survive
    // alongside the real number.
    for (const [doc, text] of Object.entries(DOCS)) {
      everyCountEquals(text, /(\d+)\s+files\b/gi, TEST_FILE_COUNT, doc, 'test-file');
      mustContain(
        text,
        new RegExp(`${TEST_FILE_COUNT}\\s+files`),
        doc,
        `"${TEST_FILE_COUNT} files" (the test-file count)`,
      );
    }
  });

  test('no doc ships a hard "N tests" count — it rots; cite `npm test` instead', () => {
    // A test *case* count can't be computed from source, so pinning a literal only
    // guarantees it's wrong by the next commit. Forbid any "<number> tests" literal in the
    // covered docs and let `npm test` be the source of truth (the FILE count above IS
    // pinned; the case count is not).
    for (const [doc, text] of Object.entries(DOCS)) {
      mustNotContain(
        text,
        /\b\d+\s+tests?\b/gi,
        doc,
        'a hard test count rots — point readers at `npm test` instead',
      );
    }
  });

  test('no stale inventory literals survive in any doc', () => {
    // Each is a value the docs used to claim that the source contradicts. If one returns,
    // the doc is lying again. Sourced from the 2026-08-06 reconciliation.
    const stale = [
      [/291/, `the endpoint count is ${ROUTE_COUNT}, not 291`],
      [/57\s+tables/i, `the table count is ${TABLE_COUNT}, not 57`],
      [/150\+/, '"150+" tests was retired'],
      [/40\s+files/, `the test-file count is ${TEST_FILE_COUNT}, not 40`],
      [/no linter/i, 'ESLint is configured (eslint.config.js) and runs in CI'],
    ];
    for (const [doc, text] of Object.entries(DOCS)) {
      for (const [re, why] of stale) {
        mustNotContain(text, re, doc, why);
      }
    }
  });

  test('the decomposition is reflected — no doc still calls db.js a ~4400-line monolith', () => {
    // The old god-files are gone: routes/ is 33 per-domain modules, db.js is ~950 lines.
    for (const [doc, text] of Object.entries(DOCS)) {
      mustNotContain(text, /~?\s*4400\s+lines?/i, doc, 'db.js is ~950 lines now, decomposed');
    }
  });
});
