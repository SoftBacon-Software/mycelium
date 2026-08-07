import { describe, test, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MyceliumAgent } from '../../sdk/src/index.js'

// SDK onboarding-path boot smoke.
//
// The README gives the Agent SDK the most onboarding copy of the three agent
// paths ("Agent SDK (any Node runtime)" — `npx mycelium-agent-sdk init`, a full
// MyceliumAgent sample with boot + onWork + completeTask). F-mycelium/13 gates
// the server cold-start and /14 gates the MCP server; this completes the trio
// by gating the SDK — the third documented path. A regression that breaks
// MyceliumAgent.boot() (a renamed /boot route, a changed auth header, a broken
// workspace export) now turns CI red instead of red on a stranger's first
// `npx mycelium-agent-sdk init`.
//
// Hermetic: spawns the REAL server (node server/index.js) with inline secrets,
// an OS-assigned port, and a /tmp DATA_DIR; drives the documented boot flow
// through the LOCAL sdk workspace code (never the npm package). No network, no
// LLM, no npm fetch. Mirrors the spawn+poll discipline of boot-env-validation
// + safety-404-and-readonly-health (random port, temp dir, inline key) without
// duplicating what they cover.

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const ADMIN_KEY = 'smoke-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'smoke-jwt-secret-0123456789abcdef0123456789abcdef'

// Grab an OS-assigned ephemeral port, then release it so the server can bind.
function randomPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

// SIGTERM a child and resolve once it is gone (SIGKILL backstop after 5s).
function terminate(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    child.once('exit', finish)
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish()
    }, 5000).unref()
  })
}

// Poll /health until the server reports a healthy DB, bounded by timeoutMs.
async function waitForHealth(port, childStdio, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) {
        const body = await res.json()
        if (body && body.db_ok) return body
      }
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(
    `server did not become healthy on port ${port} within ${timeoutMs}ms ` +
    `(last error: ${lastErr ? lastErr.message : 'n/a'})\n--- child stdio ---\n${childStdio}`,
  )
}

async function json(res) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

describe('SDK onboarding boot (MyceliumAgent.boot against a live server)', () => {
  test('register → boot → heartbeat round-trip resolves and lists the agent', async () => {
    const port = await randomPort()
    const dataDir = mkdtempSync(join(tmpdir(), 'myc-sdk-smoke-'))
    const base = `http://127.0.0.1:${port}/api/mycelium`
    const agentId = 'sdk-smoke-bot'

    const env = {
      ...process.env,
      JWT_SECRET,
      ADMIN_KEY,
      PORT: String(port),
      DATA_DIR: dataDir,
    }

    const child = spawn('node', ['server/index.js'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdio = ''
    child.stdout.on('data', (d) => { stdio += d })
    child.stderr.on('data', (d) => { stdio += d })

    let agent
    try {
      // 1. Real server is up + healthy.
      const health = await waitForHealth(port, () => stdio)
      expect(health.db_ok, 'server DB must be ready').toBe(true)

      // 2. Register a test agent over the admin API. The real route is
      //    POST /admin/agents (NOT /agents) — verified against
      //    server/routes/admin.js. The plaintext api_key comes back once.
      const regRes = await fetch(`${base}/admin/agents`, {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agentId, name: 'SDK Smoke Bot', project_id: 'smoke-proj' }),
      })
      expect(regRes.status, 'admin registration must succeed').toBe(200)
      const reg = await json(regRes)
      expect(reg.api_key, 'registration must return a dvk_ api_key').toMatch(/^dvk_/)

      // 3. Boot through the LOCAL SDK workspace code (this is the surface a
      //    stranger's `new MyceliumAgent({...}).boot()` exercises).
      agent = new MyceliumAgent({
        agentId,
        apiKey: reg.api_key,
        apiUrl: base,
        runtime: 'sdk',
      })
      const bootData = await agent.boot()

      // 4. boot() resolved and returned the agent's context (role contract +
      //    work queue) — not a silent empty pass.
      expect(bootData, 'boot() must resolve to a context object').toBeTruthy()
      expect(typeof bootData, 'boot() must resolve to an object').toBe('object')
      expect(bootData.role_contract, 'boot must return the role contract').toBeTruthy()
      expect(bootData.role_contract.agent_id, 'role contract must name the agent').toBe(agentId)

      // The heartbeat half of boot() landed server-side: the SDK's runtime
      // metadata was persisted by the POST /agents/heartbeat boot issues.
      const selfRes = await fetch(`${base}/agents/${agentId}`, {
        headers: { 'X-Admin-Key': ADMIN_KEY },
      })
      expect(selfRes.status).toBe(200)
      const self = await json(selfRes)
      expect(self.runtime, 'heartbeat must have persisted the SDK runtime').toBe('sdk')

      // 5. Follow-up GET /agents (admin) lists the registered agent.
      const listRes = await fetch(`${base}/agents`, {
        headers: { 'X-Admin-Key': ADMIN_KEY },
      })
      expect(listRes.status).toBe(200)
      const listed = await json(listRes)
      const ids = (Array.isArray(listed) ? listed : listed.agents || []).map((a) => a.id)
      expect(ids, 'registered agent must appear in GET /agents').toContain(agentId)

      // Graceful agent shutdown (final offline heartbeat) while the server is
      // still up — stop() must settle without throwing.
      await agent.stop()
      agent = null
    } finally {
      // SIGTERM the server child and assert a clean exit. The server's SIGTERM
      // handler runs gracefulShutdown → server.close → process.exit(0).
      if (agent) { try { await agent.stop() } catch { /* server may be down */ } }
      const exitCode = await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode)
        child.once('exit', resolve)
        terminate(child)
      })
      // Server SIGTERM handler → gracefulShutdown → process.exit(0).
      expect(exitCode,
        `server child should exit cleanly on SIGTERM, got ${exitCode}\n--- child stdio ---\n${stdio}`).toBe(0)
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30000)

  test('boot against an unreachable server fails fast (connection refused), not hang', async () => {
    // Negative control: proves the assertions above are real. Pointing the SDK
    // at a closed port must reject promptly — a gate that silently passes when
    // the server is gone is no gate.
    const port = await randomPort() // grabbed then released — nothing listens here
    const agent = new MyceliumAgent({
      agentId: 'sdk-smoke-negative',
      apiKey: 'dvk_deadbeef'.padEnd(52, '0'),
      apiUrl: `http://127.0.0.1:${port}/api/mycelium`,
    })
    const bootPromise = agent.boot()
    // Hard ceiling: if boot ever hangs instead of rejecting, fail the test fast.
    const hangGuard = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('boot() hung instead of rejecting on a dead server')), 5000).unref(),
    )
    await expect(Promise.race([bootPromise, hangGuard])).rejects.toThrow()
  }, 15000)
})
