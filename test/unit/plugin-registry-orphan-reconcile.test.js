import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Task 186 §5 (AUDIT-lab-clockwork-2026-09-12): the plugins registry carried
// rows whose plugin DIRECTORY no longer exists (billing, residency, …) — 12 on
// the live box. ensurePluginRecord only syncs rows for dirs that exist, so
// removed plugins left permanent ghost rows, one of them (residency) still
// reading `enabled` with no code behind it.
//
// The loader now reconciles at boot: a row with no directory is MARKED
// orphaned (rows are never deleted; the enabled flag is operator state and is
// never touched), and a directory that comes back clears the flag. GET
// /plugins surfaces the flag because it returns the record verbatim.

var dataDir
var pluginsDir
var db

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'myc-orphans-data-'))
  pluginsDir = mkdtempSync(join(tmpdir(), 'myc-orphans-plugins-'))
  process.env.DATA_DIR = dataDir
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
  // plugins.js reads this ONCE at module load — set before the dynamic import.
  process.env.MYCELIUM_PLUGINS_DIR = pluginsDir

  db = await import('../../server/db.js')
  db.initDB()

  // The live-box shape: ghost rows with no directory, one of them enabled.
  var ins = db.getDB().prepare("INSERT INTO plugins (name, display_name, enabled) VALUES (?, ?, ?)")
  ins.run('billing', 'Billing', 1)
  ins.run('residency', 'Residency', 1)
  ins.run('workflow-automations', 'Workflow Automations', 0)

  // One real plugin dir on disk (the control that must never be orphaned).
  var real = join(pluginsDir, 'reconcile-control')
  mkdirSync(real)
  writeFileSync(join(real, 'plugin.json'), JSON.stringify({
    name: 'reconcile-control', version: '0.0.1', enabled: true,
  }))
  writeFileSync(join(pluginsDir, 'package.json'), '{"type":"module"}')
})

afterAll(function () {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(pluginsDir, { recursive: true, force: true })
})

async function boot() {
  var plugins = await import('../../server/plugins.js')
  var coreStub = { gatedActions: [], onEvent: function () {} }
  var routerStub = { use: function () {}, post: function () {} }
  await plugins.loadPlugins(coreStub, routerStub)
  return plugins
}

function row(name) {
  return db.getDB().prepare('SELECT * FROM plugins WHERE name = ?').get(name)
}

describe('plugin registry orphan reconcile (task 186 §5)', () => {
  test('boot marks rows with no directory orphaned and leaves real dirs alone', async () => {
    await boot()
    for (var ghost of ['billing', 'residency', 'workflow-automations']) {
      var r = row(ghost)
      expect(r, ghost).toBeTruthy()
      expect(r.orphaned, ghost).toBe(1)
      expect(r.orphaned_at, ghost + ' stamped').toBeTruthy()
    }
    expect(row('reconcile-control').orphaned).toBe(0)
  })

  test('marking never mutates the operator enabled flag (residency stays 1)', async () => {
    expect(row('residency').enabled).toBe(1)
    expect(row('workflow-automations').enabled).toBe(0)
  })

  test('a directory that comes back clears the flag on the next boot', async () => {
    var restored = join(pluginsDir, 'billing')
    mkdirSync(restored)
    writeFileSync(join(restored, 'plugin.json'), JSON.stringify({
      name: 'billing', version: '0.0.1', enabled: false,
    }))
    await boot()
    expect(row('billing').orphaned).toBe(0)
  })

  test('GET /plugins shape: the flag rides the record (route returns it verbatim)', async () => {
    var records = db.listPluginRecords()
    var residency = records.find(function (r) { return r.name === 'residency' })
    expect(residency.orphaned).toBe(1)
    expect(residency.orphaned_at).toBeTruthy()
  })
})
