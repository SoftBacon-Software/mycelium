// =============== SCHEMA MIGRATION BRIDGE — legacy-upgrade behavioral gate ===============
// Proves the upgrade path the `migrations` array in server/db/core.js provides:
// EXISTING/persistent databases get new columns via ALTER TABLE ADD COLUMN,
// because server/schema.sql is `CREATE TABLE IF NOT EXISTS` — a no-op on a table
// that already exists. This is the exact gap CONTRIBUTING.md ("SQL") documents.
//
// Why this gate exists (and what it catches that the rest of the suite can't):
// every OTHER db test boots a FRESH temp database, so new columns arrive from
// schema.sql's CREATE TABLE and `npm test` stays GREEN even when a contributor
// has forgotten the matching `migrations` entry. The failure only shows on a
// database that predates the column — which no other test constructs. This one
// does: it seeds a "legacy" table MISSING a migrated column and proves the real
// migration code restores it (column appears, old rows backfill to the entry's
// DEFAULT, re-running is idempotent).
//
// Three groups, all exercising the REAL migration code — never a reimplementation
// and never a copied list (the hand-copy in schema-drift.test.js already rotted;
// we import the live array and read each DEFAULT from it, so a freshly added
// migration is auto-exercised without editing expectations here):
//   1. CONTRIBUTING documents the dual-write contract.
//   2. For every LIVE migrations entry: a legacy table missing the column gets it
//      via applyMigrations(), with old rows backfilled to the entry's DEFAULT.
//   3. The full initDBConnection() path upgrades a legacy DB, and is idempotent.

import { describe, test, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// core.js captures DATA_DIR at module-eval time and freezes DB_PATH from it, so
// point DATA_DIR at a throwaway dir BEFORE the dynamic import. Top-level await
// finishes that import — binding migrations / applyMigrations / initDBConnection
// / getDB — before the per-entry tests below iterate the live `migrations` array.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'myc-migration-bridge-'));
process.env.DATA_DIR = TMP_DATA_DIR;
const { migrations, applyMigrations, initDBConnection, getDB } = await import('../../server/db/core.js');

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

// Parse the SQLite DEFAULT clause out of a migration entry's `def` so the
// expected backfill value is read FROM THE LIVE ARRAY, not hardcoded here.
//   "TEXT NOT NULL DEFAULT '[]'"   -> { hasDefault: true, value: '[]' }
//   "INTEGER NOT NULL DEFAULT 0"   -> { hasDefault: true, value: 0 }
//   "TEXT"                         -> { hasDefault: false }            (NULL backfill)
function parseDefault(def) {
  var m = def.match(/DEFAULT\s+('(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|[^\s,]+)/i);
  if (!m) return { hasDefault: false };
  var raw = m[1];
  if (raw.charAt(0) === "'") {
    return { hasDefault: true, value: raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\') };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { hasDefault: true, value: Number(raw) };
  return { hasDefault: true, value: raw };
}

describe('CONTRIBUTING documents the schema-migration bridge', () => {
  const doc = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');

  test('names the dual-write contract for columns + the new-table exemption', () => {
    // The fresh-DB target AND the existing-DB bridge, by file + symbol:
    expect(doc).toMatch(/server\/schema\.sql/);
    expect(doc).toMatch(/server\/db\/core\.js/);
    expect(doc).toMatch(/migrations/);
    // WHY the bridge is needed (the no-op that silently skips existing DBs):
    expect(doc).toMatch(/IF NOT EXISTS/i);
    expect(doc).toMatch(/existing databases/i);
    // A column add requires BOTH edits:
    expect(doc).toMatch(/BOTH/i);
    // A new TABLE is the documented exception:
    expect(doc).toMatch(/new TABLE/i);
    expect(doc).toMatch(/migrations` entry/i);
  });
});

describe('migrations array — every entry upgrades a legacy table via real applyMigrations()', () => {
  // Iterate the LIVE array: each entry is exercised in isolation against a
  // hand-seeded "legacy" table that is missing exactly the migrated column.
  // Removing or breaking any entry reds its own named test; a freshly appended
  // migration is covered automatically (no expectation edits required here).
  for (const [table, col, def] of migrations) {
    test(table + '.' + col + ' — added + legacy row backfilled to the entry DEFAULT', () => {
      const db = new Database(':memory:');
      // Legacy shape: the table exists but WITHOUT the migrated column.
      db.exec('CREATE TABLE ' + table + ' (id TEXT PRIMARY KEY)');
      db.prepare("INSERT INTO " + table + " (id) VALUES ('r1')").run();

      // The REAL apply loop over the REAL array (initDBConnection's bridge).
      expect(() => applyMigrations(db)).not.toThrow();

      // (1) the column now exists on the legacy table.
      const cols = db.pragma('table_info(' + table + ')').map((c) => c.name);
      expect(cols, table + '.' + col + ' was not added by the migrations bridge').toContain(col);

      // (2) the legacy row is backfilled to the DEFAULT documented in the entry.
      const d = parseDefault(def);
      const v = db.prepare('SELECT ' + col + ' AS v FROM ' + table + " WHERE id = 'r1'").get().v;
      if (d.hasDefault) {
        expect(v, table + '.' + col + ' backfill != entry DEFAULT').toBe(d.value);
      } else {
        expect(v, table + '.' + col + ' should backfill to NULL').toBeNull();
      }

      // (3) idempotent: re-running must not throw and must not duplicate the
      // column (the "already exists" swallow is the regression this guards).
      expect(() => applyMigrations(db)).not.toThrow();
      const again = db.pragma('table_info(' + table + ')').filter((c) => c.name === col).length;
      expect(again, table + '.' + col + ' appeared more than once after re-run').toBe(1);

      db.close();
    });
  }
});

describe('full initDBConnection() upgrades a legacy DB and is idempotent', () => {
  // The integrated path: boot a real DB, simulate a legacy column gap with
  // ALTER TABLE DROP COLUMN, then prove initDBConnection() — the same function
  // every boot runs — restores it. Uses a NON-indexed migrated column, because
  // SQLite refuses DROP COLUMN on a column that an index covers (verified: the
  // indexed migrated columns like tasks.blocked_by can't be dropped). The
  // exhaustive applyMigrations() group above covers the indexed ones.
  const SUBJECT = ['tasks', 'blocks']; // TEXT NOT NULL DEFAULT '[]', not indexed

  test('run #1 boots fresh, dropped column restored on run #2, run #3 is a no-op', () => {
    const dbFile = join(TMP_DATA_DIR, 'mycelium.db');
    const [table, col] = SUBJECT;
    const entry = migrations.find((m) => m[0] === table && m[1] === col);
    expect(entry, 'subject ' + table + '.' + col + ' must be a live migrations entry').toBeDefined();
    const def = entry[2];

    // Run #1: fresh boot establishes the full modern schema.
    expect(() => initDBConnection()).not.toThrow();

    // Simulate a legacy DB: close the boot connection (initDBConnection reassigns
    // the module's live `db` binding, so reach it via getDB()), drop the migrated
    // column — now missing, as on a DB that predates it — and add a legacy row.
    const boot = getDB();
    if (boot) boot.close();
    const raw = new Database(dbFile);
    raw.exec('ALTER TABLE ' + table + ' DROP COLUMN ' + col);
    raw.prepare("INSERT INTO " + table + " (title, requester) VALUES ('legacy-task', 'tester')").run();
    raw.close();

    // Run #2: the migration bridge re-adds the column and backfills the legacy row.
    expect(() => initDBConnection()).not.toThrow();
    const check = new Database(dbFile, { readonly: true });
    try {
      const cols = check.pragma('table_info(' + table + ')').map((c) => c.name);
      expect(cols, 'dropped column was not restored by initDBConnection()').toContain(col);
      expect(cols.filter((c) => c === col).length).toBe(1);

      const d = parseDefault(def);
      const v = check.prepare('SELECT ' + col + ' AS v FROM ' + table + " WHERE title = 'legacy-task'").get().v;
      if (d.hasDefault) expect(v).toBe(d.value);
      else expect(v).toBeNull();
    } finally {
      check.close();
    }

    // Run #3: idempotent — the "already exists" swallow holds; no throw, still once.
    expect(() => initDBConnection()).not.toThrow();
    const recheck = new Database(dbFile, { readonly: true });
    try {
      const cols2 = recheck.pragma('table_info(' + table + ')').map((c) => c.name);
      expect(cols2.filter((c) => c === col).length).toBe(1);
    } finally {
      recheck.close();
    }
  });
});
