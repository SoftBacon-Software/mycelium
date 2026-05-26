import { describe, test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

describe('schema.sql', () => {
  test('main server/schema.sql applies cleanly to an empty SQLite DB', () => {
    const schemaPath = join(REPO_ROOT, 'server', 'schema.sql')
    const schemaSql = readFileSync(schemaPath, 'utf8')
    const db = new Database(':memory:')
    try {
      db.exec(schemaSql)
    } finally {
      db.close()
    }
  })

  test('schema creates expected core tables', () => {
    const schemaPath = join(REPO_ROOT, 'server', 'schema.sql')
    const schemaSql = readFileSync(schemaPath, 'utf8')
    const db = new Database(':memory:')
    try {
      db.exec(schemaSql)
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all()
        .map((r) => r.name)

      // After the dv→mycelium rename, these tables should be unprefixed.
      // If a dv_-prefixed table reappears, the rename pass regressed.
      expect(tables).toContain('agents')
      expect(tables).toContain('tasks')
      expect(tables).toContain('plans')
      expect(tables).toContain('messages')
      expect(tables).toContain('drone_jobs')

      // Confirm no legacy dv_-prefixed table sneaks back in.
      const stale = tables.filter((t) => t.startsWith('dv_'))
      expect(stale).toEqual([])
    } finally {
      db.close()
    }
  })
})
