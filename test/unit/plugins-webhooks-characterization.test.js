import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// CHARACTERIZATION tests for the PLUGINS + WEBHOOKS slice of
// server/routes/mycelium.js — a safety net under the god-file BEFORE
// decomposition. These tests LOCK CURRENT behavior (statuses, bodies, quirks);
// they do not assert what the API *should* do. Where current behavior smells
// like a bug it is flagged in a comment but STILL asserted as-is — if a
// decomposition changes any of these, that's a behavior change and must be
// deliberate, not accidental.
//
// Harness: same as studio-login.test.js — real router, fresh temp DB, env set
// before the dynamic import, supertest. pool:'forks' isolates module state.
//
// IMPORTANT harness property: loadPlugins() is NEVER called here, so
// plugins.js module state (loadedPlugins / allMcpTools / workerProcesses) is
// empty. That makes this harness exercise the "record exists in DB but plugin
// not loaded" branches of every /plugins route — which is exactly the state
// after enable/install without a restart, so it's a real production state,
// not a test artifact. Plugin records are seeded through db.ensurePluginRecord
// (the same function loadPlugins uses).

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const MASK = '••••••••' // the secret-masking placeholder used by the config routes

let tmpDataDir
let app
let db            // server/db.js — fixture seeding via the real DB functions
let guardPluginRouter
let memberToken   // studio JWT with a NON-admin role
let agentKey      // real registered agent API key (dvk_…)

// Track rejections that escape Express — the class of failure that kills the
// daemon (index.js exits on unhandledRejection). Locked contract: nothing in
// this file may leak one.
const escapedRejections = []
function onRejection(reason) { escapedRejections.push(reason) }

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-plugins-webhooks-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const plugins = await import('../../server/plugins.js')
  guardPluginRouter = plugins.guardPluginRouter

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  process.on('unhandledRejection', onRejection)

  // Non-admin studio user → JWT (exercises checkAdmin's 403 'Admin role required' path)
  const reg = await request(app)
    .post('/api/mycelium/studio/users')
    .set('X-Admin-Key', ADMIN_KEY)
    .send({ username: 'plugmember', password: 'correct-horse-battery', display_name: 'Plug Member', role: 'member' })
  if (reg.status !== 200) throw new Error('test setup: member registration failed: ' + JSON.stringify(reg.body))
  const login = await request(app)
    .post('/api/mycelium/studio/login')
    .send({ username: 'plugmember', password: 'correct-horse-battery' })
  if (login.status !== 200) throw new Error('test setup: member login failed: ' + JSON.stringify(login.body))
  memberToken = login.body.token

  // Real agent + API key (exercises the agent-key-vs-admin auth matrix)
  const agentReg = await request(app)
    .post('/api/mycelium/admin/agents')
    .set('X-Admin-Key', ADMIN_KEY)
    .send({ id: 'plug-test-agent', name: 'Plug Test Agent', project_id: 'plug-test-project' })
  if (agentReg.status !== 200) throw new Error('test setup: agent registration failed: ' + JSON.stringify(agentReg.body))
  agentKey = agentReg.body.api_key
})

afterAll(() => {
  process.removeListener('unhandledRejection', onRejection)
  rmSync(tmpDataDir, { recursive: true, force: true })
})

const api = () => request(app)
const asAdmin = (r) => r.set('X-Admin-Key', ADMIN_KEY)

// ======================== AUTH MATRIX (checkAdmin) ========================
// All /plugins config/mutation routes and all /webhooks routes gate on
// checkAdmin. Characterized once against GET /plugins; the per-route tests
// below each pin at least their own unauthenticated status.

describe('auth matrix — checkAdmin on GET /plugins', () => {
  test('no credentials → 401 Authentication required', async () => {
    const res = await api().get('/api/mycelium/plugins')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
  })

  test('wrong admin key → 403 Invalid admin key', async () => {
    const res = await api().get('/api/mycelium/plugins').set('X-Admin-Key', 'wrong-key')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Invalid admin key' })
  })

  test('non-admin studio JWT → 403 Admin role required', async () => {
    const res = await api().get('/api/mycelium/plugins').set('Authorization', 'Bearer ' + memberToken)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Admin role required' })
  })

  test('valid AGENT key → 403 "Admin role required" (findings-§1 fix; agents still cannot list plugins)', async () => {
    const res = await api().get('/api/mycelium/plugins').set('X-Agent-Key', agentKey)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Admin role required' })
  })

  test('garbage Bearer token → 401 "Authentication required" (fixed: no more misleading "Invalid admin key")', async () => {
    // FIXED (findings §1 sibling): an Authorization header that fails JWT
    // verification is a failed AUTHENTICATION — 401 about the caller's
    // credentials, no longer a 403 blaming an admin key that was never sent.
    const res = await api().get('/api/mycelium/plugins').set('Authorization', 'Bearer not-a-jwt')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
  })

  test('valid admin key in X-Admin-Key → 200', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(res.status).toBe(200)
  })
})

// ======================== GET /plugins (list) ========================

describe('GET /plugins — list with enabled/disabled state', () => {
  test('fresh DB (no records) → empty array', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('returns full DB rows ordered by name, enabled honors manifest initial state', async () => {
    // Seed via the SAME function loadPlugins uses. manifest.enabled === true is
    // honored on first insert; any other value (including absent) → disabled.
    db.ensurePluginRecord({
      name: 'alpha-plugin', displayName: 'Alpha', description: 'first', version: '2.0.0',
      author: 'tests', enabled: true, routePrefix: '/alpha', mcpToolCount: 3,
    })
    db.ensurePluginRecord({ name: 'beta-plugin', displayName: 'Beta', description: 'second' })

    const res = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(res.status).toBe(200)
    expect(res.body.map((p) => p.name)).toEqual(['alpha-plugin', 'beta-plugin'])

    const [alpha, beta] = res.body
    expect(alpha).toMatchObject({
      name: 'alpha-plugin', display_name: 'Alpha', description: 'first',
      version: '2.0.0', author: 'tests', enabled: 1, route_prefix: '/alpha', mcp_tool_count: 3,
    })
    // No explicit enabled flag in manifest → disabled (0), despite the DB
    // column DEFAULT being 1 — ensurePluginRecord always binds it explicitly.
    expect(beta).toMatchObject({
      name: 'beta-plugin', display_name: 'Beta', description: 'second',
      version: '1.0.0', author: '', enabled: 0, route_prefix: '', mcp_tool_count: 0,
    })
    // Lock the exact row shape (raw SELECT * — schema drift shows up here)
    expect(Object.keys(alpha).sort()).toEqual([
      'author', 'description', 'display_name', 'enabled', 'installed_at',
      'mcp_tool_count', 'name', 'route_prefix', 'updated_at', 'version',
    ])
  })
})

// ======================== GET /plugins/:name ========================

describe('GET /plugins/:name — detail', () => {
  test('unknown plugin → 404 Plugin not found', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins/nope'))
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Plugin not found' })
  })

  test('record present but plugin NOT loaded → record + legacy/empty manifest enrichment', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins/alpha-plugin'))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'alpha-plugin', display_name: 'Alpha', enabled: 1 })
    // Not in getLoadedPlugins() → type falls back to 'legacy' and every
    // manifest-derived field is empty. This is also the live state right after
    // enable/install before the required restart.
    expect(res.body.type).toBe('legacy')
    expect(res.body.config_schema).toEqual([])
    expect(res.body.mcp_tools).toEqual([])
    expect(res.body.hooks).toEqual([])
    expect(res.body.gated_actions).toEqual([])
    expect(res.body.pages).toEqual([])
  })

  test('no auth → 401', async () => {
    const res = await api().get('/api/mycelium/plugins/alpha-plugin')
    expect(res.status).toBe(401)
  })
})

// ======================== plugin config ========================

describe('GET/PUT /plugins/:name/config', () => {
  test('GET config for unknown plugin → 404', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins/nope/config'))
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Plugin not found' })
  })

  test('PUT config for unknown plugin → 404 (validated before any write)', async () => {
    const res = await asAdmin(api().put('/api/mycelium/plugins/nope/config')).send({ k: 'v' })
    expect(res.status).toBe(404)
  })

  test('GET config with nothing set → empty object', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins/alpha-plugin/config'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
  })

  test('PUT stores values; ALL values come back as strings (String() coercion in setPluginConfig)', async () => {
    const put = await asAdmin(api().put('/api/mycelium/plugins/alpha-plugin/config'))
      .send({ max_items: 5, verbose: true, endpoint: 'http://example.com' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })

    const res = await asAdmin(api().get('/api/mycelium/plugins/alpha-plugin/config'))
    // Numbers and booleans are flattened to strings — round-tripping through
    // this API loses types. Locked as current behavior.
    expect(res.body).toEqual({ max_items: '5', verbose: 'true', endpoint: 'http://example.com' })
  })

  test('keys written while the plugin is NOT loaded are never marked secret (is_secret from loaded schema only)', async () => {
    // SMELL (locked): isSecret is derived from the LOADED manifest's
    // configSchema. With the plugin unloaded (schema []), a secret-typed key
    // written via this route is stored is_secret=0 — plaintext, and NOT masked
    // on later reads. Operators configuring a plugin before the enable+restart
    // dance get their secrets stored unmasked.
    await asAdmin(api().put('/api/mycelium/plugins/alpha-plugin/config')).send({ api_token: 'plaintext-tok' })
    const res = await asAdmin(api().get('/api/mycelium/plugins/alpha-plugin/config'))
    expect(res.body.api_token).toBe('plaintext-tok') // NOT masked
  })

  test('is_secret rows ARE masked in GET config', async () => {
    // Seed the way a loaded plugin's schema-aware write would store it.
    db.setPluginConfig('alpha-plugin', 'real_secret', 'tok-123', true)
    const res = await asAdmin(api().get('/api/mycelium/plugins/alpha-plugin/config'))
    expect(res.body.real_secret).toBe(MASK)
  })

  test('PUT with the mask placeholder skips the write (unchanged-secret passthrough)', async () => {
    const put = await asAdmin(api().put('/api/mycelium/plugins/alpha-plugin/config'))
      .send({ real_secret: MASK })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })
    // Underlying stored value untouched (verified through the real DB layer)
    expect(db.getPluginConfigValue('alpha-plugin', 'real_secret')).toBe('tok-123')
  })

  test('the literal mask string is UNSTORABLE as a config value (silently dropped)', async () => {
    // SMELL (locked): the placeholder check is value-based, so a NEW key whose
    // intended value happens to equal '••••••••' is silently never written —
    // the route still says ok:true.
    const put = await asAdmin(api().put('/api/mycelium/plugins/alpha-plugin/config'))
      .send({ brand_new_key: MASK })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })
    expect(db.getPluginConfigValue('alpha-plugin', 'brand_new_key')).toBe(null)
  })

  test('config routes require admin → 401 without credentials', async () => {
    expect((await api().get('/api/mycelium/plugins/alpha-plugin/config')).status).toBe(401)
    expect((await api().put('/api/mycelium/plugins/alpha-plugin/config').send({ k: 'v' })).status).toBe(401)
  })
})

// ======================== enable / disable / install / uninstall ========================

describe('plugin enable/disable/install/uninstall', () => {
  test('enable/disable unknown plugin → 404', async () => {
    expect((await asAdmin(api().put('/api/mycelium/plugins/nope/enable'))).status).toBe(404)
    expect((await asAdmin(api().put('/api/mycelium/plugins/nope/disable'))).status).toBe(404)
  })

  test('PUT enable → { ok, name, enabled: 1 } and the list reflects it', async () => {
    const res = await asAdmin(api().put('/api/mycelium/plugins/beta-plugin/enable'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, name: 'beta-plugin', enabled: 1 })
    const list = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(list.body.find((p) => p.name === 'beta-plugin').enabled).toBe(1)
    // NOTE: enable does NOT load the plugin — getLoadedPlugins() is only
    // populated at boot. Routes/tools appear only after restart (by design;
    // the install route's message says so).
  })

  test('PUT disable → { ok, name, enabled: 0 }', async () => {
    const res = await asAdmin(api().put('/api/mycelium/plugins/beta-plugin/disable'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, name: 'beta-plugin', enabled: 0 })
    const list = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(list.body.find((p) => p.name === 'beta-plugin').enabled).toBe(0)
  })

  test('POST /plugins/install without name → 400', async () => {
    const res = await asAdmin(api().post('/api/mycelium/plugins/install')).send({})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Plugin name required' })
  })

  test('POST /plugins/install unknown name → 404 with a DIFFERENT message than sibling 404s', async () => {
    const res = await asAdmin(api().post('/api/mycelium/plugins/install')).send({ name: 'nope' })
    expect(res.status).toBe(404)
    // Inconsistency (locked): every other plugin route says 'Plugin not found'.
    expect(res.body).toEqual({ error: 'Plugin not found in server/plugins/' })
  })

  test('install a disabled plugin → enables it + restart-required message', async () => {
    const res = await asAdmin(api().post('/api/mycelium/plugins/install')).send({ name: 'beta-plugin' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true, name: 'beta-plugin',
      message: 'Plugin enabled. Server restart required to fully load.',
    })
    const list = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(list.body.find((p) => p.name === 'beta-plugin').enabled).toBe(1)
  })

  test('install an already-enabled plugin → different response shape (already-enabled short-circuit)', async () => {
    const res = await asAdmin(api().post('/api/mycelium/plugins/install')).send({ name: 'beta-plugin' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, message: 'Plugin already enabled', name: 'beta-plugin' })
  })

  test('uninstall unknown plugin → 404', async () => {
    const res = await asAdmin(api().delete('/api/mycelium/plugins/nope/uninstall'))
    expect(res.status).toBe(404)
  })

  test('uninstall → disables + clears ALL config + restart-required message; files stay on disk', async () => {
    // Give beta some config so the clearing is observable
    await asAdmin(api().put('/api/mycelium/plugins/beta-plugin/config')).send({ a: '1', b: '2' })
    const before = await asAdmin(api().get('/api/mycelium/plugins/beta-plugin/config'))
    expect(before.body).toEqual({ a: '1', b: '2' })

    const res = await asAdmin(api().delete('/api/mycelium/plugins/beta-plugin/uninstall'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true, name: 'beta-plugin',
      message: 'Plugin disabled and config cleared. Server restart required. Plugin files remain in server/plugins/ for reinstall.',
    })
    const list = await asAdmin(api().get('/api/mycelium/plugins'))
    expect(list.body.find((p) => p.name === 'beta-plugin').enabled).toBe(0)
    const after = await asAdmin(api().get('/api/mycelium/plugins/beta-plugin/config'))
    expect(after.body).toEqual({})
    // The record itself is NOT deleted — uninstall is disable+wipe, not remove.
    expect((await asAdmin(api().get('/api/mycelium/plugins/beta-plugin'))).status).toBe(200)
  })

  test('mutation routes require admin → 401 without credentials', async () => {
    expect((await api().put('/api/mycelium/plugins/beta-plugin/enable')).status).toBe(401)
    expect((await api().put('/api/mycelium/plugins/beta-plugin/disable')).status).toBe(401)
    expect((await api().post('/api/mycelium/plugins/install').send({ name: 'beta-plugin' })).status).toBe(401)
    expect((await api().delete('/api/mycelium/plugins/beta-plugin/uninstall')).status).toBe(401)
  })
})

// ======================== aggregate/loaded-plugin views ========================
// These read plugins.js module state, which is empty in this harness (no
// loadPlugins). Passing 200s here ALSO prove the literal paths (mcp-tools,
// workers, nav, all-widgets, registry) are matched BEFORE /plugins/:name —
// otherwise they'd 404 as unknown plugin names.

describe('aggregate plugin views (nothing loaded)', () => {
  test('GET /plugins/mcp-tools (admin) → []', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins/mcp-tools'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('GET /plugins/mcp-tools accepts a valid AGENT key (checkAgentOrAdmin, wider than the rest)', async () => {
    const res = await api().get('/api/mycelium/plugins/mcp-tools').set('X-Agent-Key', agentKey)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test('GET /plugins/mcp-tools with no credentials → 401 with the AGENT-flavored message', async () => {
    // QUIRK (locked): checkAgentOrAdmin's terminal fallback is checkAgent, so
    // an unauthenticated caller is told about X-Agent-Key even though admin
    // auth would also have worked.
    const res = await api().get('/api/mycelium/plugins/mcp-tools')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Missing X-Agent-Key header' })
  })

  test('GET /plugins/mcp-tools with an invalid agent key → 403 Invalid agent key', async () => {
    const res = await api().get('/api/mycelium/plugins/mcp-tools').set('X-Agent-Key', 'dvk_bogus')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Invalid agent key' })
  })

  test('GET /plugins/workers (admin) → {} when no worker plugins run; 401 unauthenticated', async () => {
    const res = await asAdmin(api().get('/api/mycelium/plugins/workers'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
    expect((await api().get('/api/mycelium/plugins/workers')).status).toBe(401)
  })

  test('GET /plugins/all-widgets → [] and GET /plugins/nav → []', async () => {
    const widgets = await asAdmin(api().get('/api/mycelium/plugins/all-widgets'))
    expect(widgets.status).toBe(200)
    expect(widgets.body).toEqual([])
    const nav = await asAdmin(api().get('/api/mycelium/plugins/nav'))
    expect(nav.status).toBe(200)
    expect(nav.body).toEqual([])
  })

  test('GET /plugins/:name/widgets — 404 unknown; record-but-not-loaded → { widgets: [] } WITHOUT route_prefix', async () => {
    expect((await asAdmin(api().get('/api/mycelium/plugins/nope/widgets'))).status).toBe(404)
    const res = await asAdmin(api().get('/api/mycelium/plugins/alpha-plugin/widgets'))
    expect(res.status).toBe(200)
    // ASYMMETRY (locked): the loaded branch returns { widgets, route_prefix };
    // the not-loaded branch omits route_prefix entirely. Consumers reading
    // .route_prefix get undefined in this state.
    expect(res.body).toEqual({ widgets: [] })
  })

  test('GET /plugins/registry — auth is checked BEFORE any network fetch (401 unauthenticated)', async () => {
    // Only the unauthenticated path is pinned: the authed path performs a real
    // fetch to the commit-pinned GitHub registry (covered by
    // registry-commit-pin.test.js for the pin itself) and caches module-globally
    // — not exercisable hermetically from here.
    const res = await api().get('/api/mycelium/plugins/registry')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Authentication required' })
  })
})

// ======================== WEBHOOKS ========================

describe('POST /webhooks — create subscription', () => {
  test('admin only: 401 with no credentials, 403 with a valid AGENT key (findings-§1 fix)', async () => {
    expect((await api().post('/api/mycelium/webhooks').send({ agent_id: 'a', url: 'http://x' })).status).toBe(401)
    // DESIGN SMELL (still locked): an agent cannot register a webhook even for
    // ITSELF — webhook management is admin-key/admin-JWT only. The agent's key
    // now at least reads as authentication (→ 403 'Admin role required').
    const res = await api().post('/api/mycelium/webhooks')
      .set('X-Agent-Key', agentKey)
      .send({ agent_id: 'plug-test-agent', url: 'http://example.com/hook' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Admin role required' })
  })

  test('missing agent_id or url → 400 with a single shared message', async () => {
    const noUrl = await asAdmin(api().post('/api/mycelium/webhooks')).send({ agent_id: 'a' })
    const noAgent = await asAdmin(api().post('/api/mycelium/webhooks')).send({ url: 'http://x' })
    const empty = await asAdmin(api().post('/api/mycelium/webhooks')).send({})
    for (const res of [noUrl, noAgent, empty]) {
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'agent_id and url are required' })
    }
  })

  test('minimal create → { ok, id }; row gets DEFAULT events JSON, empty secret, active=1', async () => {
    const res = await asAdmin(api().post('/api/mycelium/webhooks'))
      .send({ agent_id: 'plug-test-agent', url: 'http://example.com/hook1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.id).toBe('number')

    const list = await asAdmin(api().get('/api/mycelium/webhooks'))
    const row = list.body.find((w) => w.id === res.body.id)
    expect(row).toMatchObject({
      agent_id: 'plug-test-agent',
      url: 'http://example.com/hook1',
      // events is a JSON *string*, not an array, on the wire
      events: '["task_created","request_created","message_sent"]',
      secret: '',
      active: 1,
    })
    expect(typeof row.created_at).toBe('string')
    // Lock the exact row shape (raw SELECT * from webhooks)
    expect(Object.keys(row).sort()).toEqual(['active', 'agent_id', 'created_at', 'events', 'id', 'secret', 'url'])
  })

  test('events array is JSON-stringified; secret is MASKED in the list (findings §12 fix)', async () => {
    const res = await asAdmin(api().post('/api/mycelium/webhooks'))
      .send({ agent_id: 'plug-test-agent', url: 'http://example.com/hook2', events: ['task_done', '*'], secret: 'hook-secret-1' })
    expect(res.status).toBe(200)
    const list = await asAdmin(api().get('/api/mycelium/webhooks'))
    const row = list.body.find((w) => w.id === res.body.id)
    expect(row.events).toBe('["task_done","*"]')
    // Was (S12 locks-bug): the signing secret round-tripped in cleartext to any
    // admin listing webhooks — never masked like plugin-config secrets. Now
    // (S12 proves-fix): it is masked with the SAME placeholder plugin-config
    // secrets use.
    expect(row.secret).toBe(MASK)
  })

  test('FIXED (findings §12): non-array events is rejected with 400 — no silently-dead subscription', async () => {
    // Was (S12 locks-bug): createWebhook only stringifies arrays; any other
    // value was stored as-is, and dispatchWebhook JSON.parses events at
    // delivery time then SKIPS on parse failure — a subscription silently dead
    // from birth, acknowledged with a 200 at creation. Now (S12 proves-fix):
    // the route validates events is a proper array up front and rejects.
    const res = await asAdmin(api().post('/api/mycelium/webhooks'))
      .send({ agent_id: 'plug-test-agent', url: 'http://example.com/hook3', events: 'totally not json' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'events must be an array' })
    // The dead subscription was never created.
    const list = await asAdmin(api().get('/api/mycelium/webhooks'))
    expect(list.body.find((w) => w.url === 'http://example.com/hook3')).toBeUndefined()
  })

  test('no validation of url or agent_id existence at creation time', async () => {
    // SMELL (locked): 'not even a url' is accepted (the SSRF guard —
    // assertPublicHost — runs only at DISPATCH time), and the agent_id has no
    // FK — a webhook for a nonexistent agent is created silently.
    const res = await asAdmin(api().post('/api/mycelium/webhooks'))
      .send({ agent_id: 'ghost-agent-never-registered', url: 'not even a url' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

describe('GET /webhooks — list + filter', () => {
  test('admin only → 401 unauthenticated', async () => {
    expect((await api().get('/api/mycelium/webhooks')).status).toBe(401)
  })

  test('?agent_id= filters to that agent; unfiltered list returns every active webhook', async () => {
    const all = await asAdmin(api().get('/api/mycelium/webhooks'))
    expect(all.status).toBe(200)
    // hook3 (non-array events) is now rejected at creation (findings §12), so
    // one fewer fixture survives here than before: hook1, hook2, and the ghost.
    expect(all.body.length).toBeGreaterThanOrEqual(3)
    const ghosts = await asAdmin(api().get('/api/mycelium/webhooks').query({ agent_id: 'ghost-agent-never-registered' }))
    expect(ghosts.body).toHaveLength(1)
    expect(ghosts.body[0].agent_id).toBe('ghost-agent-never-registered')
  })
})

describe('DELETE /webhooks/:id', () => {
  test('admin only → 401 unauthenticated', async () => {
    expect((await api().delete('/api/mycelium/webhooks/1')).status).toBe(401)
  })

  test('deletes the row → { ok: true } and it leaves the list', async () => {
    const created = await asAdmin(api().post('/api/mycelium/webhooks'))
      .send({ agent_id: 'plug-test-agent', url: 'http://example.com/to-delete' })
    const id = created.body.id
    const del = await asAdmin(api().delete('/api/mycelium/webhooks/' + id))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    const list = await asAdmin(api().get('/api/mycelium/webhooks'))
    expect(list.body.find((w) => w.id === id)).toBeUndefined()
  })

  test('nonexistent id → still { ok: true } (no 404, blind DELETE)', async () => {
    // SMELL (locked): delete is not existence-checked; callers cannot tell a
    // successful delete from a no-op.
    const res = await asAdmin(api().delete('/api/mycelium/webhooks/999999'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test('non-numeric id → parseIntParam→null → no-op { ok: true }; other rows survive', async () => {
    const before = (await asAdmin(api().get('/api/mycelium/webhooks'))).body.length
    const res = await asAdmin(api().delete('/api/mycelium/webhooks/abc'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const after = (await asAdmin(api().get('/api/mycelium/webhooks'))).body.length
    expect(after).toBe(before)
  })
})

describe('GET /webhooks/deliveries', () => {
  test('admin only → 401 unauthenticated', async () => {
    expect((await api().get('/api/mycelium/webhooks/deliveries')).status).toBe(401)
  })

  test('fresh DB → []; every filter combination still → [] (filters reach the SQL without error)', async () => {
    const plain = await asAdmin(api().get('/api/mycelium/webhooks/deliveries'))
    expect(plain.status).toBe(200)
    expect(plain.body).toEqual([])
    const filtered = await asAdmin(api().get('/api/mycelium/webhooks/deliveries')
      .query({ event: 'task_created', webhook_id: '1', error_only: 'true', limit: '5', offset: '0' }))
    expect(filtered.status).toBe(200)
    expect(filtered.body).toEqual([])
  })

  test("route order: 'deliveries' is NOT swallowed by DELETE /webhooks/:id or any :id route", async () => {
    // GET /webhooks/deliveries is declared after DELETE /webhooks/:id but they
    // differ by method, and there is no GET /webhooks/:id at all — 'deliveries'
    // resolves to the literal route. Pinned so a decomposition that introduces
    // GET /webhooks/:id above it will trip this.
    const res = await asAdmin(api().get('/api/mycelium/webhooks/deliveries'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})

// ======================== guardPluginRouter (locked contract) ========================
// The full matrix lives in plugin-router-async-guard.test.js; this compact
// re-assertion keeps the contract visible from THIS slice's net: an unguarded
// async plugin route rejection must become a 500 through the app error
// handler — never an unhandledRejection (which index.js turns into process
// exit, i.e. one bad plugin route killing the daemon).

describe('guardPluginRouter — async rejection → 500, daemon survives', () => {
  function appWithGuardedPlugin(pluginRouter) {
    const a = express()
    a.use(express.json())
    a.use('/api/mycelium/charplugin', guardPluginRouter(pluginRouter, 'charplugin'))
    a.use(function (err, req, res, _next) {
      if (res.headersSent) return
      res.status(500).json({ error: 'Internal server error', _from: 'app_error_handler' })
    })
    return a
  }

  test('rejected async handler → 500 via error handler; no rejection escapes the process', async () => {
    const r = express.Router()
    r.post('/explode', async function () { throw new Error('plugin route rejected') })
    const res = await request(appWithGuardedPlugin(r)).post('/api/mycelium/charplugin/explode').send({})
    expect(res.status).toBe(500)
    expect(res.body._from).toBe('app_error_handler')
  })

  test('healthy handlers pass through the guard untouched', async () => {
    const r = express.Router()
    r.get('/fine', async function (req, res) { res.json({ ok: true }) })
    const res = await request(appWithGuardedPlugin(r)).get('/api/mycelium/charplugin/fine')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  // KEEP LAST in the file: verifies no test above leaked an unhandled
  // rejection out of Express (the daemon-killer class).
  test('zero escaped unhandledRejections across the entire file', () => {
    expect(escapedRejections).toHaveLength(0)
  })
})
