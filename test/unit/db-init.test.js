import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// db.js captures DATA_DIR from process.env at module-eval time (top of file),
// so we MUST set DATA_DIR to a fresh temp dir BEFORE the dynamic import below.
// vitest runs with pool:'forks', so this file's module state is isolated from
// any other test file. initDB() writes to DATA_DIR — never the live DB.

let tmpDataDir
let db // the db.js module namespace
let dbPath

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-init-'))
  process.env.DATA_DIR = tmpDataDir
  dbPath = join(tmpDataDir, 'mycelium.db')
  // Dynamic import AFTER DATA_DIR is set so the module binds to the temp dir.
  db = await import('../../server/db.js')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('initDB() fresh bootstrap', () => {
  test('bootstraps a FRESH empty database without throwing', () => {
    // The temp dir is empty — no mycelium.db exists yet. This is the exact
    // regression for the fresh-init bug we just fixed: the upgrade bridges and
    // schema.sql must produce a working DB on a clean slate, not just on an
    // already-populated production DB.
    expect(existsSync(dbPath)).toBe(false)
    expect(() => db.initDB()).not.toThrow()
    expect(existsSync(dbPath)).toBe(true)
  })

  test("a fresh DB's task table has the columns the app needs", () => {
    // Pins schema completeness: schema.sql is the canonical source of truth, so
    // a fresh DB must already declare these columns (they historically arrived
    // via ALTER migrations that only run on OLD DBs). If any goes missing the
    // app's task routes break on fresh installs.
    const raw = new Database(dbPath, { readonly: true })
    try {
      const cols = raw
        .pragma('table_info(tasks)')
        .map((c) => c.name)
      expect(cols).toContain('blocked_by')
      expect(cols).toContain('needs_approval')
      expect(cols).toContain('branch')
    } finally {
      raw.close()
    }
  })
})
