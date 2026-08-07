// Positive-path cold-start gate — the happy path README "Quick start → Manual"
// sells FIRST. `boot-env-validation.test.js` owns the NEGATIVE path (the server
// exits FATAL when ADMIN_KEY + JWT_SECRET are missing); this test owns the one a
// stranger actually runs: with both secrets set, `node server/index.js` boots and
// answers `GET /health` with 200. CI runs it on Node 20 + 22.
//
// Without this, a silent regression that breaks startup (a throw before
// `app.listen`, a migration that needs a flag, the better-sqlite3 native quirk
// the README itself warns about) goes red for the first time on a stranger's
// machine, never in CI — the happy path is the untested path.
//
// Hermetic by construction:
//   - random EPHEMERAL PORT (grabbed from the kernel, released for the server) so
//     it cannot collide with a developer's running :3002 or a sibling test file;
//   - a throwaway DATA_DIR under os.tmpdir() so the server gets a FRESH SQLite DB,
//     not the developer's server/data/mycelium.db;
//   - inline JWT_SECRET + ADMIN_KEY so no host secret leaks into the child;
//   - loopback only — no docker, no outbound network.
//
// Flake-resistant by construction: the /health poll has a bounded deadline, each
// fetch attempt has its own timeout, a boot crash fails fast (with the real
// FATAL reason, not a misleading timeout), and the child is torn down in a
// `finally` no matter how the test ends. A flaky green is worse than no test, so
// we also assert the child exited ON ITS OWN (code 0) after SIGTERM — a
// killed-by-signal result means shutdown hung and is itself a failure.

import { describe, test, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')

// How long to wait for the freshly spawned server to answer /health with 200.
// The server typically boots in well under a second (schema applies fast on a
// fresh DB); the headroom covers plugin init (`await initPlugins()`) and a slow
// CI runner. Bounded so a real hang fails the test instead of hanging CI.
const HEALTH_DEADLINE_MS = 15000
// Per-test timeout: comfortably above the health deadline + graceful shutdown.
const TEST_TIMEOUT_MS = 30000

// The README "Manual" cold-start exports two random secrets and runs
// `node server/index.js`. We do the same, but inline in the child env (the
// server never reads a .env file on its own). We inherit the host environment so
// `node`, the better-sqlite3 native binding, and any plugin worker subprocesses
// still resolve PATH/HOME/etc., then OVERRIDE the four hermetic-critical vars.
function coldStartEnv(port, dataDir) {
  return {
    ...process.env,
    JWT_SECRET: 'cold-start-jwt-secret-' + port,
    ADMIN_KEY: 'cold-start-admin-key-' + port,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
  }
}

// Grab an ephemeral port the kernel assigns, then release it for the server to
// bind. There is an inherent TOCTOU race (another process could grab it in the
// gap), but it is far more robust than hardcoding a port, and if the server
// loses the race its bind throws loudly rather than silently shadowing :3002.
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

// Poll GET /health until it answers 200 or the deadline lapses. ECONNREFUSED
// (server not listening yet) is the normal boot-in-progress signal and is
// retried; a 200 ends the poll. If the child dies mid-boot, fail FAST with the
// real exit reason + captured boot log — that is the exact regression this gate
// exists to catch, and a clear "FATAL …" beats a misleading "never answered".
async function waitForHealth(port, deadlineMs, child, getBootLog) {
  const url = `http://127.0.0.1:${port}/health`
  const start = Date.now()
  let lastErr
  while (Date.now() - start < deadlineMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `server exited before answering GET ${url} ` +
          `(code=${child.exitCode}, signal=${child.signalCode}). Boot log:\n${getBootLog()}`,
      )
    }
    // Bound each attempt so a hung connection can't consume the whole deadline.
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
    `server never answered GET ${url} with 200 within ${Math.round(deadlineMs / 1000)}s ` +
      `(last: ${lastErr && lastErr.message}). Boot log:\n${getBootLog()}`,
  )
}

describe('server cold-start (README "Manual" positive path)', () => {
  test(
    'a freshly spawned server boots and answers GET /health with 200',
    async () => {
      const port = await getEphemeralPort()
      const dataDir = mkdtempSync(join(tmpdir(), 'mycelium-cold-start-'))

      const child = spawn('node', [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: coldStartEnv(port, dataDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Capture all boot output (the FATAL handlers write to stdout) so a
      // failure surfaces the real reason instead of an opaque timeout.
      let bootLog = ''
      child.stdout.on('data', (c) => { bootLog += c.toString() })
      child.stderr.on('data', (c) => { bootLog += c.toString() })
      const getBootLog = () => bootLog

      // Resolves when the child terminates on its own (covers the boot-crash
      // case so we can assert exit semantics after SIGTERM).
      const exited = new Promise((resolve, reject) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
        child.on('error', reject) // spawn itself failed (e.g. ENOENT)
      })

      try {
        const health = await waitForHealth(port, HEALTH_DEADLINE_MS, child, getBootLog)

        // README: a stranger verifies with `curl /health` and expects an OK body.
        expect(health.status, 'health.status should be ok').toBe('ok')
        expect(health.db_ok, 'health.db_ok — schema applied to the temp DB').toBe(true)
        expect(health.version, 'health.version — package.json read on boot').toBeTruthy()
      } finally {
        // Always tear down — never leave a server bound to a port OR a temp DB
        // on disk after the test, whether the assertions passed, failed, or
        // vitest aborted on timeout. (Putting rmSync here, not after the exit
        // assertions, means a failing run — the exact case CI reruns — still
        // cleans up its throwaway data dir.)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
        }
        rmSync(dataDir, { recursive: true, force: true })
      }

      // After SIGTERM the graceful-shutdown handler runs stopAllWorkers, closes
      // the listening socket + DB, and calls process.exit(0). Assert it exited ON
      // ITS OWN: a non-null signal means shutdown hung and we had to kill it,
      // which is a flake signal we surface rather than hide.
      const { code, signal } = await exited
      expect(signal, `server killed by signal (did not shut down cleanly); boot log:\n${getBootLog()}`).toBeNull()
      expect(code, `server exited non-zero after SIGTERM; boot log:\n${getBootLog()}`).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )
})
