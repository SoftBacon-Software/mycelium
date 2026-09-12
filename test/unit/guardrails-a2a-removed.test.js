import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Task 186 §5, second half — the removal cut, task-185 shape (7f11bf7):
// `guardrails` and `a2a-gateway` shipped "enabled": false from the day they
// landed, their routers never mounted, and their 7 MCP tools were dark
// (4 + 3). The audit names them remove candidates; Gilbert's D-decision set
// (the "remove" verb of THE FOCUS) covers them.
//
// KEPT on purpose (asserted below so a future tidy doesn't sweep them):
//   - checkGuardrails (routes/mycelium.js) — CORE middleware with 10+ live
//     fan-in sites; it reads req.app._guardrailsCheck, the seam the plugin
//     WOULD have installed, and fails open + warns when absent. Its coverage
//     test (guardrails-route-coverage.test.js) stubs that field and never
//     imports the plugin.
//   - migrate-table-names.js dv_guardrail_* rows — old-DB upgrade path
//     (task-170 precedent).
//   - lib/ssrf-guard.js — webhooks.js and marketing still import it.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

var dataDir
var db

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'myc-cut-data-'))
  process.env.DATA_DIR = dataDir
  process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(function () {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('guardrails + a2a-gateway removal (task 186 §5, the 185 shape)', () => {
  test('both plugin directories are gone', () => {
    expect(existsSync(join(REPO_ROOT, 'server', 'plugins', 'guardrails'))).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'server', 'plugins', 'a2a-gateway'))).toBe(false)
  })

  test('their plugin test.js files are gone with them (test:plugins glob)', () => {
    expect(existsSync(join(REPO_ROOT, 'server', 'plugins', 'guardrails', 'test.js'))).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'server', 'plugins', 'a2a-gateway', 'test.js'))).toBe(false)
  })

  test('the root-app A2A rewrites are gone with the plugin (dead since day one)', () => {
    // index.js proxied /.well-known/agent.json and POST /a2a into the a2a
    // mount — a target that 404'd in practice while the plugin shipped
    // disabled. The shims go with the plugin.
    var index = readFileSync(join(REPO_ROOT, 'server', 'index.js'), 'utf8')
    expect(index).not.toContain('/api/mycelium/a2a/agent-card')
    expect(index).not.toContain('/api/mycelium/a2a/rpc')
    expect(existsSync(join(REPO_ROOT, 'test', 'unit', 'a2a-rpc-auth.test.js'))).toBe(false)
  })

  test('the loader mounts neither; their 7 MCP tools are not in the tool list', async () => {
    var plugins = await import('../../server/plugins.js')
    var coreStub = { gatedActions: [], onEvent: function () {} }
    var routerStub = { use: function () {}, post: function () {} }
    await plugins.loadPlugins(coreStub, routerStub)

    var names = plugins.getLoadedPlugins().map(function (m) { return m.name })
    expect(names).not.toContain('guardrails')
    expect(names).not.toContain('a2a-gateway')

    var toolNames = plugins.getPluginMcpTools().map(function (t) { return t.name })
    for (var dark of ['mycelium_guardrails_rules', 'mycelium_guardrails_check', 'mycelium_guardrails_violations', 'mycelium_guardrails_stats',
      'mycelium_a2a_discover', 'mycelium_a2a_send', 'mycelium_a2a_list']) {
      expect(toolNames, dark).not.toContain(dark)
    }
  })

  test('README: 5 built-in plugins; no guardrails / a2a-gateway table rows', () => {
    var readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
    expect(readme).toMatch(/5 built-in plugins/)
    expect(readme).toMatch(/5 plugins \+ _template/)
    expect(readme).not.toMatch(/^\| `guardrails` \|/m)
    expect(readme).not.toMatch(/^\| `a2a-gateway` \|/m)
    var contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
    expect(contributing).toMatch(/5 plugins/)
  })

  test('KEPT: checkGuardrails core middleware, ssrf-guard, migrate-table-names rows', () => {
    expect(existsSync(join(REPO_ROOT, 'server', 'lib', 'ssrf-guard.js'))).toBe(true)
    var myceliumRoutes = readFileSync(join(REPO_ROOT, 'server', 'routes', 'mycelium.js'), 'utf8')
    expect(myceliumRoutes).toContain('function checkGuardrails(')
    var migrate = readFileSync(join(REPO_ROOT, 'server', 'migrate-table-names.js'), 'utf8')
    expect(migrate).toContain('dv_guardrail_rules')
  })
})
