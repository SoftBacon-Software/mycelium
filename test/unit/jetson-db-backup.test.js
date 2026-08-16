import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// jetson01 has no sqlite3 CLI and the database is live with a WAL, so a file
// copy is not a backup. This goes through Python's sqlite3.Connection.backup().
//
// The rule that actually matters: the script must OPEN the result and
// integrity-check it. "A backup you did not open is not a backup" — the third
// test below corrupts a verified copy and proves the check can go red, because
// a check that cannot fail is not a check.

const SCRIPT = join(process.cwd(), 'scripts/lib/jetson-db-backup.py')
let dir

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jetson-backup-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('backs up a live database and reports row counts', () => {
  const src = join(dir, 'src.db')
  const db = new Database(src)
  db.exec('CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT)')
  db.exec("INSERT INTO agents (name) VALUES ('lucy'), ('echo'), ('ada')")
  db.close()

  const dest = join(dir, 'dest.db')
  const out = execFileSync('python3', [SCRIPT, src, dest], { encoding: 'utf8' })
  const summary = JSON.parse(out)

  expect(summary.integrity).toBe('ok')
  expect(summary.rows.agents).toBe(3)
  expect(summary.tables).toBe(1)
})

test('refuses a missing source rather than writing an empty "backup"', () => {
  const src = join(dir, 'missing.db')
  const dest = join(dir, 'dest2.db')
  expect(() => execFileSync('python3', [SCRIPT, src, dest], { encoding: 'utf8', stdio: 'pipe' }))
    .toThrow()
})

test('refuses a 0-byte source — the repo-root mycelium.db decoy', () => {
  // The real database is server/data/mycelium.db. A glob that picks the
  // repo-root decoy has "backed up" nothing before.
  const decoy = join(dir, 'decoy.db')
  writeFileSync(decoy, '')
  const dest = join(dir, 'dest-decoy.db')
  expect(() => execFileSync('python3', [SCRIPT, decoy, dest], { encoding: 'utf8', stdio: 'pipe' }))
    .toThrow()
})

test('a corrupted result fails integrity — the check can actually go red', () => {
  const src = join(dir, 'src3.db')
  const db = new Database(src)
  db.exec('CREATE TABLE t (x INTEGER)')
  db.exec('INSERT INTO t VALUES (1)')
  db.close()

  const dest = join(dir, 'dest3.db')
  execFileSync('python3', [SCRIPT, src, dest], { encoding: 'utf8' })

  // Corrupt the already-verified copy, then re-verify it.
  const buf = readFileSync(dest)
  buf.fill(0, 100, 900)
  writeFileSync(dest, buf)

  expect(() => execFileSync('python3', [SCRIPT, '--verify-only', dest], { encoding: 'utf8', stdio: 'pipe' }))
    .toThrow()
})
