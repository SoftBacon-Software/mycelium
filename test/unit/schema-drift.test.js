// =============== SCHEMA DRIFT TEST ===============
// FAIL LOUDLY if server/schema.sql and the db migrations list ever disagree.
// This catches the exact fresh-init gap that was bug #10.
//
// THE INPUT IS IMPORTED, NEVER COPIED. `migrations` comes straight from
// server/db/core.js — the same array initDBConnection() applies on boot — so a
// migration added there is visible here with no human re-copying it. The old
// version of this file held a hand-copied "simplified version" of the array
// (commented as "Lines 38-99 in db.js"; db.js was decomposed into server/db/
// long ago) and it rotted: it was missing projects.repo_path and
// plan_steps.attempt_count while the suite stayed GREEN, because a stale input
// only narrows what the check can see. A check that cannot fail is not a
// check. core.js's module scope is side-effect-free (no DB is opened until
// initDBConnection() runs), which test/unit/schema-migration-bridge.test.js
// already relies on.
//
// JURISDICTION: the [table, column] pairs the migrations bridge adds. Inline
// CREATE TABLE statements outside schema.sql are OUT of scope here — plugin
// DBs are separate by design, and password_resets is already in schema.sql,
// which makes studio.js's inline CREATE redundant-but-harmless.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrations } from '../../server/db/core.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// The team-column upgrade bridge is NOT a data array in core.js — it is three
// inline guarded ALTERs inside initDBConnection() (projects.team_id,
// operators.primary_team_id, agents.primary_team_id), and this gate leaves
// initDBConnection untouched. So this is the LAST hand-maintained input in
// this file, kept deliberately small and labelled: if it rots, it rots as a
// three-entry canary with this comment pointing at it — not as a 52-entry
// lookalike of the real thing.
var teamColumns = [
  ["projects", "team_id"],
  ["operators", "primary_team_id"],
  ["agents", "primary_team_id"]
];

// Helper to get columns from a table using PRAGMA table_info
function getTableColumns(db, tableName) {
  const columns = db.pragma(`table_info(${tableName})`);
  return columns.map(col => ({ name: col.name, type: col.type }));
}

// The drift check itself, shared by BOTH cases below: for every [table, column]
// a migration would ADD, a fresh schema.sql-built DB must already have that
// column. The canary case runs this same function — it proves THE check fails,
// not a copy of it.
function assertMigrationColumnsExist(db, pairs) {
  for (const [table, column] of pairs) {
    const columns = getTableColumns(db, table);
    const columnExists = columns.some(col => col.name === column);

    if (!columnExists) {
      const tableColumns = columns.map(c => c.name).join(', ');
      throw new Error(`Migration would add column '${column}' to table '${table}' but it doesn't exist in schema.sql. Schema columns: [${tableColumns}]`);
    }
  }
}

function freshSchemaDb() {
  // Create a fresh in-memory DB and apply server/schema.sql to it
  const db = new Database(':memory:');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  return db;
}

describe('Schema Drift Test', () => {
  it('should ensure schema.sql and the core.js migrations agree', () => {
    const db = freshSchemaDb();

    // Combine the REAL migrations (imported from source) with the team-column
    // canary into one list of [table, column] pairs
    const allMigrations = [
      ...migrations.map(([table, column, _def]) => [table, column]),
      ...teamColumns.map(([table, column]) => [table, column])
    ];

    // For each (table, column) that the bridge would ADD, verify it exists in
    // the schema.sql-created table
    assertMigrationColumnsExist(db, allMigrations);

    // Cleanup
    db.close();
  });

  // CANARY, not coverage: the INPUT being real is proven by the import above.
  // This case proves the CHECK can still fail — that the loop inside
  // assertMigrationColumnsExist() throws on a column schema.sql lacks — using
  // a fake entry, because a green suite would otherwise be equally consistent
  // with a check that had gone blind.
  it('should FAIL LOUDLY if the drift check is fed a column schema.sql lacks', () => {
    const db = freshSchemaDb();

    // A fake migration whose column is NOT in schema.sql
    const fakeMigration = ["tasks", "fake_column_not_in_schema"];

    expect(() => {
      assertMigrationColumnsExist(db, [fakeMigration]);
    }).toThrow(/fake_column_not_in_schema/);

    // Cleanup
    db.close();
  });
});
