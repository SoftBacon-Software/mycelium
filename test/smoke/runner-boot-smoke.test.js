// Runner boot smoke — the workspace entrypoint `npm run start:runner` ships.
//
// F-mycelium/14 (mcp) and /21 (sdk) gate the other agent paths;
// server-cold-start.test.js gates the platform server. The runner — the
// autonomous agent runner at `runner/index.js`, `npm run start:runner` — had NO
// boot coverage: a regression in its startup guard (the ANTHROPIC_API_KEY
// fast-fail) or its health HTTP server (the Railway healthcheck target,
// `GET /` → orchestrator status) went red for the first time on a stranger's
// `node runner/index.js`, never in CI.
//
// This pins the two documented startup behaviors of runner/index.js:
//   (a) NEGATIVE — no Anthropic key anywhere (not in config, not in env, not
//       per-agent) → the runner fast-fails with process.exit(1) and a stderr
//       line naming ANTHROPIC_API_KEY. Mirrors boot-env-validation.test.js's
//       spawnSync guard (strip the env, assert exit≠0 + stderr match).
//   (b) POSITIVE — with a dummy key + a stub config (RUNNER_CONFIG env) whose
//       Mycelium API URL is a closed loopback port, the runner binds its health
//       server and `GET /` answers 200 with the orchestrator status. Mirrors
//       server-cold-start.test.js's spawn+poll discipline (ephemeral port,
//       loopback-only, bounded deadline, teardown in finally, clean-exit assert).
//
// Hermetic w.r.t. its assertions: the stub Mycelium API URL is a CLOSED loopback
// port (instant ECONNREFUSED), so every poll / heartbeat / SSE call the
// orchestrator makes fails fast inside its own try/catch and the process stays
// alive serving health. No LLM, no Claude subprocess is spawned (no work is ever
// claimed from a closed port). NOTE: the runner fires one best-effort outbound
// GitHub-status fetch on boot (github-status.js, fail-open, caught) — that is the
// runner's real startup behavior, not something this test introduces, and it does
// not affect whether the health port binds.

import { describe, test, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const RUNNER_ENTRY = join(REPO_ROOT, 'runner', 'index.js')

// Per-test timeout: comfortably above the health deadline + graceful shutdown.
const TEST_TIMEOUT_MS = 30000
// How long to wait for the freshly spawned runner to answer GET / with 200.
const HEALTH_DEADLINE_MS = 15000

// Grab an OS-assigned ephemeral port, then release it. Two distinct uses:
//   - the HEALTH port the runner will bind (we then poll it);
//   - a CLOSED port used as the stub Mycelium API URL (instant ECONNREFUSED).
function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// Build the stub runner config as the RUNNER_CONFIG env var (config.js priority
// 1 — no config.json file on disk needed). Valid enough to pass loadConfig's
// validators (apiUrl + adminKey + ≥1 agent) but deliberately key-free so the
// index.js key-guard is what decides pass/fail.
function stubRunnerConfig({ apiUrl, agentCwd }) {
  return JSON.stringify({
    mycelium: { apiUrl, adminKey: 'smoke-admin-key' },
    agents: [{ id: 'runner-smoke-bot', cwd: agentCwd }],
    // NOTE: no anthropicApiKey anywhere — the key-guard branch under test.
  })
}

// Poll GET / on the runner's health server until it answers 200 or the deadline
// lapses. ECONNREFUSED (not listening yet) is the normal boot-in-progress signal
// and is retried; a child death fails FAST with the real boot log.
async function waitForHealthRoot(port, deadlineMs, child, getBootLog) {
  const url = `http://127.0.0.1:${port}/`
  const start = Date.now()
  let lastErr
  while (Date.now() - start < deadlineMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `runner exited before answering GET ${url} (code=${child.exitCode}, ` +
          `signal=${child.signalCode}). Boot log:\n${getBootLog()}`,
      )
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (res.ok) return await res.json()
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e // ECONNREFUSED while booting — retry on the next tick
    } finally {
      clearTimeout(timer)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(
    `runner never answered GET ${url} with 200 within ${Math.round(deadlineMs / 1000)}s ` +
      `(last: ${lastErr && lastErr.message}). Boot log:\n${getBootLog()}`,
  )
}

describe('runner boot (runner/index.js startup guard + health server)', () => {
  test(
    'NEGATIVE: with no Anthropic key anywhere, fast-fails non-zero naming ANTHROPIC_API_KEY',
    () => {
      // Inherit the host env so node + the native bindings resolve, then STRIP
      // ANTHROPIC_API_KEY so the child hits the key-guard regardless of the test
      // runner's env. Stub config has no global key and no per-agent key.
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      env.RUNNER_CONFIG = stubRunnerConfig({ apiUrl: 'http://127.0.0.1:1/api/mycelium', agentCwd: tmpdir() })

      const result = spawnSync('node', [RUNNER_ENTRY], {
        cwd: REPO_ROOT,
        env,
        timeout: 15000,
        encoding: 'utf8',
      })

      // The process must terminate on its own (not be killed by the timeout).
      expect(result.status, 'runner should fast-fail, not time out').not.toBeNull()
      // Non-zero exit.
      expect(result.status).not.toBe(0)
      // The documented guard message must appear on stderr (logger.error → console.error).
      expect(result.stderr, 'stderr should name ANTHROPIC_API_KEY').toMatch(/ANTHROPIC_API_KEY/)
    },
  )

  test(
    'POSITIVE: with a dummy key + stub config, binds the health port and GET / → 200',
    async () => {
      const healthPort = await getEphemeralPort()
      const closedApiPort = await getEphemeralPort() // grabbed then released → closed
      const agentCwd = mkdtempSync(join(tmpdir(), 'myc-runner-smoke-'))

      const env = {
        ...process.env,
        ANTHROPIC_API_KEY: 'dummy-anthropic-key', // satisfies the key-guard, no real call made
        RUNNER_CONFIG: stubRunnerConfig({
          apiUrl: `http://127.0.0.1:${closedApiPort}/api/mycelium`,
          agentCwd,
        }),
        PORT: String(healthPort), // runner reads PORT || HEALTH_PORT || 8080
      }

      const child = spawn('node', [RUNNER_ENTRY], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let bootLog = ''
      child.stdout.on('data', (c) => { bootLog += c.toString() })
      child.stderr.on('data', (c) => { bootLog += c.toString() })
      const getBootLog = () => bootLog

      const exited = new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
        child.on('error', (err) => resolve({ code: 'spawn-error', signal: null, err }))
      })

      try {
        const status = await waitForHealthRoot(healthPort, HEALTH_DEADLINE_MS, child, getBootLog)

        // Health server is live and serving orchestrator status. The stub agent
        // was registered (getStatus walks the in-memory agents Map — pure, no
        // network — so this holds even though the Mycelium API URL is closed).
        expect(status.running, 'orchestrator reports running=true after start()').toBe(true)
        expect(status.agents, 'health status lists the stub agent').toHaveProperty('runner-smoke-bot')
      } finally {
        // Always tear down — never leave a runner bound to a port or a temp dir
        // on disk, whether assertions passed, failed, or vitest aborted on timeout.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        rmSync(agentCwd, { recursive: true, force: true })
      }

      // After SIGTERM the runner's graceful shutdown (orchestrator.stop →
      // process.exit(0)) runs. Assert it exited ON ITS OWN: a non-null signal
      // means shutdown hung and we had to kill it — a flake signal we surface.
      const { code, signal } = await exited
      expect(signal, `runner killed by signal (shutdown hung); boot log:\n${getBootLog()}`).toBeNull()
      expect(code, `runner exited non-zero after SIGTERM; boot log:\n${getBootLog()}`).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )
})
