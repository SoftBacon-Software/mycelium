import { describe, test, expect } from 'vitest'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// Plugin test COVERAGE GATE.
//
// CI's "Run plugin tests" step does `node --test server/plugins/*/test.js` — a
// glob over files that MATCH. A plugin without a test.js is simply absent from
// the glob: never loaded, never exercised, never fails. That made the step a
// real gate for the 3 plugins that had suites and invisible for the 12 that
// didn't — a broken plugin shipped green (add a syntax error to a plugin with
// no test.js and CI stayed green). See feedback_a_check_that_cannot_fail_is_not_a_check.
//
// This gate closes the blind spot: every plugin dir (bar the _template
// scaffold) MUST ship a non-empty test.js that references its own name. A new
// plugin added with no test now turns this RED, not silent. It globs the LIVE
// server/plugins/ dir, so it tracks reality — no frozen list to maintain.

const here = dirname(fileURLToPath(import.meta.url))
const PLUGINS_DIR = join(here, '..', '..', 'server', 'plugins')

// _template is the scaffold, not a plugin — excluded from coverage.
const EXCLUDE = new Set(['_template'])

const pluginDirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !EXCLUDE.has(d.name))
  .map((d) => d.name)
  .sort()

describe('plugin test coverage gate', () => {
  // Liveness check: proves the gate scans the real dir, not a stale snapshot.
  // If this fails, PLUGINS_DIR resolved wrong and the whole gate is moot.
  test('scans the live plugins dir (finds the known covered plugins)', () => {
    expect(pluginDirs, `expected to scan ${PLUGINS_DIR}`).toContain('appointments')
    expect(pluginDirs).toContain('workflows')
    expect(pluginDirs).toContain('semantic-memory')
    expect(pluginDirs.length, 'plugin count drifted — update this floor if intentional').toBeGreaterThanOrEqual(15)
  })

  test.each(pluginDirs)(
    'plugin "%s" ships a non-empty test.js that names itself',
    (name) => {
      const testFile = join(PLUGINS_DIR, name, 'test.js')
      expect(existsSync(testFile), `no test.js for plugin ${name} (looked at ${testFile})`).toBe(true)

      const src = readFileSync(testFile, 'utf8')
      expect(src.trim().length, `${testFile} is empty`).toBeGreaterThan(0)

      // Cheap "this test is actually about this plugin" guard — the file must
      // reference its own plugin name (case-insensitive, so an existing suite
      // using e.g. createAppointmentsDB satisfies the "appointments" dir), so a
      // copy-pasted placeholder that asserts nothing about THIS plugin can't.
      expect(
        src.toLowerCase(),
        `${testFile} does not reference its own plugin name "${name}"`
      ).toContain(name.toLowerCase())
    }
  )
})
