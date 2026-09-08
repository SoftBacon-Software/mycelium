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

// Tables: count the schema's CREATE TABLE *statement* lines — anchored so the keyword
// must OPEN the line (leading whitespace tolerated). A bare /CREATE TABLE/ line count is
// inflated by every COMMENT that quotes the keyword, and schema.sql carries two such
// comments (the "now native CREATE TABLE columns above" note and the "CREATE TABLE IF
// NOT EXISTS keeps both paths idempotent" note) — that is exactly how the docs came to
// ship 56 and then 57 tables for a 55-table schema. Matching the `CREATE TABLE IF NOT
// EXISTS` prefix instead is no better: the second comment quotes that full prefix, and a
// future statement written without IF NOT EXISTS would be silently undercounted. Same
// method as `grep -icE '^\s*CREATE TABLE' server/schema.sql`, cross-checked against
// `sqlite3 :memory: < server/schema.sql` (55 non-sqlite_ tables when this was written).
// Accepted residual blind spot: a line inside a /* block comment */ beginning with
// CREATE TABLE would still count — schema.sql uses only `--` line comments and its
// statements are machine-written; SQL parsing is not worth the dependency.
const TABLE_COUNT = read('server/schema.sql')
  .split('\n')
  .filter((line) => /^\s*CREATE TABLE/i.test(line)).length;

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
for (const rel of ['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.claude/CLAUDE.md']) {
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
      [/56\s+tables/i, `the table count is ${TABLE_COUNT}, not 56 — that number already counted a schema.sql comment line`],
      // 57 is the number the bare-keyword derivation most recently blessed into the docs
      // (two comment lines quoting CREATE TABLE), so it is the one that would creep back
      // through this list's blind spot. Both stale numbers banned; see TABLE_COUNT above.
      [/57\s+tables/i, `the table count is ${TABLE_COUNT}, not 57 — the bare-keyword count included two schema.sql comment lines`],
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

// --- route-module map -------------------------------------------------------
//
// The checks above pin COUNTS, and a module can vanish from every doc without
// redding anything. This section derives the mounted route modules from
// server/routes/*.js at test time and requires each one to be acknowledged in
// README's "What's actually here" section — the section that promises
// "implemented and exercised by the running system, not a roadmap" — or to be a
// deliberately-labelled internal surface. Add a route module without
// acknowledging it anywhere and this goes red.
//
// Ack scope is that section ONLY (its Maturity subsection included), and a
// FEATURE ack must be the feature's NAME — the bold lead of a registry bullet —
// not a word in some bullet's body. Prose can't carry an acknowledgment: the
// verb in "runs in production daily" doesn't document runs.js, and an
// enumeration in another bullet ("tasks, plans, ... and events all carry a
// project_id") survives deleting the event bullet, which would leave the gate
// green while the event feature is undocumented. Mentions elsewhere in README —
// the schema-table enumeration under Architecture, the retired-studio note —
// don't count either.

const ROUTES_DIR = join(ROOT, 'server', 'routes');
const MOUNTED_MODULES = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

const featureSection = (() => {
  const text = read('README.md');
  const start = text.indexOf("## What's actually here");
  if (start === -1) {
    throw new Error('README.md: the "What\'s actually here" feature registry is missing');
  }
  const end = text.indexOf('\n## ', start + 1);
  return end === -1 ? text.slice(start) : text.slice(start, end);
})();

// The feature names: the bold lead of every registry bullet ("- **Agent network** — ...").
const FEATURE_LEADS = [
  ...featureSection.matchAll(/^\s*[-*]\s+\*\*(.+?)\*\*/gm),
].map((m) => m[1].replace(/\.\s*$/, ''));

// Derivation can't guess prose aliases, so name them here — one entry per module
// whose file name isn't the phrase a feature lead uses. Keep it short and
// justified: each entry is an acknowledgment the gate would otherwise force into
// the README.
const MODULE_ALIASES = {
  // One feature, two modules: the god-file decomposition split the agent-network
  // surface between agents.js (register/heartbeat/status) and mycelium.js (the
  // router itself — /boot/:agentId, /work/:agentId). The same lead credits both.
  agents: ['agent network'],
  mycelium: ['agent network'],
  // The lead says "Organizations"; the file says orgs.
  orgs: ['organizations', 'orgs'],
  // The lead says "Messaging & requests".
  messages: ['messaging', 'messages'],
  // The lead says "Event log & live stream".
  events: ['event log', 'events'],
  // The lead says "Approval gates".
  approvals: ['approval gates', 'approvals'],
  // The lead says "Plugin system" (singular).
  plugins: ['plugin', 'plugins'],
  // The lead says "GPU drone queue" (singular).
  drones: ['drone', 'drones'],
  // "runs" also matches the verb "runs in production daily"; require the feature
  // name so the run-history bullet can't be dropped while prose carries the ack.
  runs: ['run history'],
  // The registry documents this module as the "Bug tracker" (singular).
  bugs: ['bug tracker', 'bugs'],
};

// House-internal surfaces: mounted, but plumbing rather than product. Keep this
// list SHORT and justified — a lazy "internal" dump defeats the gate. Each entry
// must still be LABELLED in README (the "Internal surfaces" subsection), so the
// list is the machine-checkable mirror of that note, never a way to hide a module
// from the docs; the second test below enforces the pairing.
const INTERNAL_MODULES = [
  'files', // agent temp uploads, auto-delete after a day
  'team_settings', // operator settings sections + profile sync
  'file_server', // browse/search/download through a connected file drone
  'operators', // human operator records + availability
  'studio', // operator login / user administration (JWT)
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word-boundary match that also refuses to match inside a hyphenated compound
// ("studio-react", "admin-claude") — those name other things, not the module.
const matches = (text, alias) =>
  new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, 'i').test(text);
const mentionsLead = (alias) => FEATURE_LEADS.some((lead) => matches(lead, alias));
const mentionsSection = (alias) => matches(featureSection, alias);

const baseOf = (file) => file.replace(/\.js$/, '');
const aliasesFor = (file) => MODULE_ALIASES[baseOf(file)] ?? [baseOf(file).replace(/_/g, ' ')];
const isInternal = (file) => INTERNAL_MODULES.includes(baseOf(file));

describe('route module map', () => {
  test(`the feature registry has leads to match against`, () => {
    // Guard on the extractor itself: if the registry's bullet shape changes
    // (no bold leads parsed), every module below would silently lose its ack.
    if (FEATURE_LEADS.length < 10) {
      throw new Error(
        `README's "What's actually here" section yielded ${FEATURE_LEADS.length} bold bullet ` +
          'leads — the registry shape changed; fix FEATURE_LEADS extraction.',
      );
    }
  });

  test(`every mounted route module (${MOUNTED_MODULES.length}) is a documented feature or a labelled internal surface`, () => {
    const missing = MOUNTED_MODULES.filter(
      (file) => !aliasesFor(file).some(mentionsLead) && !isInternal(file),
    );
    if (missing.length > 0) {
      throw new Error(
        `README's "What's actually here" section does not acknowledge ${missing.length} mounted ` +
          'route module(s): ' +
          missing.map((f) => `${f} (looks for: ${aliasesFor(f).join(' / ')})`).join('; ') +
          '. Add a feature bullet or an internal-surface label — the section promises ' +
          '"implemented and exercised by the running system, not a roadmap."',
      );
    }
  });

  test('every internal surface stays labelled in README — the list may not hide a module from the docs', () => {
    const unlabelled = INTERNAL_MODULES.filter((base) => !aliasesFor(`${base}.js`).some(mentionsSection));
    if (unlabelled.length > 0) {
      throw new Error(
        `INTERNAL_MODULES names ${unlabelled.join(', ')}, but README's "What's actually here" ` +
          'section no longer labels them. Restore the "Internal surfaces" note or drop the ' +
          'entry — the list and the note must stay in sync.',
      );
    }
  });

  test('INTERNAL_MODULES names only modules that still exist under server/routes/', () => {
    const real = new Set(MOUNTED_MODULES.map((f) => f.replace(/\.js$/, '')));
    const stale = INTERNAL_MODULES.filter((base) => !real.has(base));
    if (stale.length > 0) {
      throw new Error(
        `INTERNAL_MODULES names module(s) with no matching server/routes file: ${stale.join(', ')} — stale list.`,
      );
    }
  });
});
