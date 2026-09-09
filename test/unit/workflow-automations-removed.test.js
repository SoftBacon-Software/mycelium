import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// workflow-automations REMOVAL GUARD (task 185).
//
// The plugin shipped dark ("enabled": false in its plugin.json from the day it
// landed), its router was never mounted (GET /automations/rules 404s live), no
// admin route can enable a plugin, its 4 MCP proxy tools were already dark at
// the agent surface, and its only in-repo references were its own files plus
// two doc rows — one of which claimed "mounted", which was false. Removed
// 2026-09-09 per the task-183 census (jarvis/runs/task-183-p-product/
// VERDICTS.md row A5; task-170 precedent: an unmounted router can never accrue
// a route-usage counter row, so the usage-window KEEP bar does not apply).
//
// This guard keeps it buried: the dir, its schema/seed, its MCP tool names and
// its doc rows must not come back. server/migrate-table-names.js intentionally
// KEEPS the dv_automation_* mappings (old-DB upgrade path, the task-170
// precedent), and "admin-automation" in the README names the admin-claude
// agent — so bare "automation" strings are NOT asserted here; only the
// plugin's own identifier name-space is.

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..')
const PLUGINS_DIR = join(ROOT, 'server', 'plugins')
const PLUGIN = 'workflow-automations'

// Strings only the removed plugin owned: its name, its four MCP proxy tool
// names, its table, its bus events.
const PLUGIN_NAMESPACE = [
  PLUGIN,
  'automation_templates',
  'mycelium_automation_list',
  'mycelium_automation_trigger',
  'mycelium_automation_log',
  'mycelium_automation_stats',
  'automation_rule_created',
  'automation_rule_deleted',
  'automation_triggered',
]

// Recursively list files under dir (names only, relative to dir).
const listFiles = (dir) => {
  const acc = []
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else acc.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return acc
}

describe('workflow-automations plugin stays removed (task 185)', () => {
  test(`no server/plugins/${PLUGIN}/ dir`, () => {
    expect(
      existsSync(join(PLUGINS_DIR, PLUGIN)),
      `the removed plugin dir came back at server/plugins/${PLUGIN}/`
    ).toBe(false)
  })

  test('no plugin ships an automation_templates seed (schema or lazy seed)', () => {
    const offenders = listFiles(PLUGINS_DIR).filter((p) => {
      try {
        return readFileSync(p, 'utf8').includes('automation_templates')
      } catch {
        return false
      }
    })
    expect(
      offenders,
      `automation_templates seed survives in: ${offenders.join(', ')}`
    ).toEqual([])
  })

  test('no plugin declares an automation MCP tool or the /automations prefix', () => {
    for (const dir of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const pluginJson = JSON.parse(
        readFileSync(join(PLUGINS_DIR, dir.name, 'plugin.json'), 'utf8')
      )
      expect(
        pluginJson.routePrefix,
        `plugin ${dir.name} re-registered the removed /automations prefix`
      ).not.toBe('/automations')

      const mcpToolsPath = join(PLUGINS_DIR, dir.name, 'mcp-tools.json')
      if (!existsSync(mcpToolsPath)) continue
      const tools = JSON.parse(readFileSync(mcpToolsPath, 'utf8'))
      const names = (Array.isArray(tools) ? tools : tools.tools ?? []).map(
        (t) => t.name
      )
      const auto = names.filter((n) => String(n).startsWith('mycelium_automation_'))
      expect(
        auto,
        `plugin ${dir.name} re-declared removed MCP tools: ${auto.join(', ')}`
      ).toEqual([])
    }
  })

  test('README and docs/surface-levels.md no longer list the plugin', () => {
    for (const rel of ['README.md', 'docs/surface-levels.md']) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      for (const name of PLUGIN_NAMESPACE) {
        expect(
          text.includes(name),
          `${rel} still names the removed plugin via "${name}"`
        ).toBe(false)
      }
    }
  })
})
