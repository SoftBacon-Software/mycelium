// printer-drone boot smoke — the workspace entrypoint `npm run start:printer`
// (and `:mock`) ships. F-mycelium/14 (mcp) and /21 (sdk) + server-cold-start gate
// the other surfaces; printer-drone — the 3D-printer drone worker at
// `printer-drone/index.js`, `npm run start:printer:mock` — had NO boot coverage.
//
// printer-drone ships an explicit hardware-free `--mock` mode for boot/testing,
// so "it boots" is checkable without a printer. This pins:
//   (a) POSITIVE — `--mock` against a closed local API URL boots INTO its poll
//       loop (prints "Polling every …") without hanging or a FATAL exit, and
//       honors MYCELIUM_URL (the resolved URL it logs is the one we passed, not
//       a hardcoded literal). Mirrors server-cold-start.test.js's spawn+poll
//       discipline (closed loopback URL, bounded deadline, teardown in finally,
//       clean-exit assert).
//   (b) DEFAULT-URL pin — the sovereignty-default correction: with MYCELIUM_URL
//       UNSET, `--mock` resolves its API URL to localhost, NEVER the deprecated
//       hosted mycelium.fyi. Same class of footgun F-mycelium/37 fixed for
//       admin-claude and mcp-resolve-url.test.js fixed for the MCP; before the
//       fix a stranger's first documented `npm run start:printer:mock` quietly
//       pointed at the deprecated public instance.
//
// Hermetic: the API URL is a CLOSED loopback port (instant ECONNREFUSED), so
// every heartbeat / claimJob fails fast inside its own .catch() and the drone
// stays in its poll loop. printer-drone's fetch has no timeout of its own, so a
// CLOSED port (not a silently-hanging URL) is what makes this deterministic. The
// mock provider's connect() is instant (no hardware, no network).

import { describe, test, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const ENTRY = join(REPO_ROOT, 'printer-drone', 'index.js')

const TEST_TIMEOUT_MS = 30000
const BOOT_DEADLINE_MS = 15000

// Grab an OS-assigned ephemeral port, then release it → a CLOSED loopback port
// (instant ECONNREFUSED) for the stub Mycelium API URL.
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

// Resolve when the child's combined stdout+stderr matches `regex`, or reject if
// the child dies / the deadline lapses (surfacing the real boot log). The
// "Mycelium: <url>" line and the "Polling every …" marker both land on stdout.
function waitForOutput(child, regex, deadlineMs, getBootLog) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return reject(new Error(
          `printer-drone exited (code=${child.exitCode}, signal=${child.signalCode}) ` +
            `before stdout matched ${regex}. Boot log:\n${getBootLog()}`,
        ))
      }
      const m = getBootLog().match(regex)
      if (m) return resolve(m)
      if (Date.now() - start >= deadlineMs) {
        return reject(new Error(
          `printer-drone stdout never matched ${regex} within ${Math.round(deadlineMs / 1000)}s. ` +
            `Boot log:\n${getBootLog()}`,
        ))
      }
      setTimeout(tick, 100)
    }
    tick()
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

// Spawn `printer-drone/index.js --mock`. cwd is a throwaway temp dir because the
// mock config uses a relative workDir ('./work'); running there keeps the work/
// dir out of the repo tree.
function spawnMock(env) {
  const cwd = mkdtempSync(join(tmpdir(), 'myc-printer-smoke-'))
  const child = spawn('node', [ENTRY, '--mock'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bootLog = ''
  child.stdout.on('data', (c) => { bootLog += c.toString() })
  child.stderr.on('data', (c) => { bootLog += c.toString() })
  return { child, cwd, getBootLog: () => bootLog }
}

describe('printer-drone boot (--mock hardware-free mode)', () => {
  test(
    'boots into its poll loop against a non-.fyi URL (no hang, no FATAL), honors MYCELIUM_URL',
    async () => {
      const closedApiPort = await getEphemeralPort()
      const apiUrl = `http://127.0.0.1:${closedApiPort}/api/mycelium`
      const env = { ...process.env, MYCELIUM_URL: apiUrl }

      const { child, cwd, getBootLog } = spawnMock(env)
      const exited = new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
        child.on('error', (err) => resolve({ code: 'spawn-error', signal: null, err }))
      })

      try {
        // Booted into the poll loop: the "Polling every …" marker prints right
        // before the while(running) loop in main(). Reaching it means config
        // loaded, provider connected, and the startup heartbeat did NOT crash
        // the process (it's .catch()'d against the closed port).
        await waitForOutput(child, /Polling every/, BOOT_DEADLINE_MS, getBootLog)

        // The resolved API URL it logged is the one MYCELIUM_URL supplied — not
        // a hardcoded .fyi literal. (The full line is `Mycelium: <url>`.)
        const urlMatch = getBootLog().match(/^Mycelium: (\S+)/m)
        expect(urlMatch, 'boot log must print the resolved Mycelium URL').toBeTruthy()
        expect(urlMatch[1], 'printer-drone must honor MYCELIUM_URL').toBe(apiUrl)
        expect(urlMatch[1], 'resolved URL must not be the deprecated .fyi').not.toContain('mycelium.fyi')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await terminate(child)
        rmSync(cwd, { recursive: true, force: true })
      }

      // Graceful shutdown on SIGTERM → process.exit(0). A signal kill means the
      // drone hung on shutdown — surfaced, not hidden.
      const { code, signal } = await exited
      expect(signal, `printer-drone killed by signal (shutdown hung); boot log:\n${getBootLog()}`).toBeNull()
      expect(code, `printer-drone exited non-zero after SIGTERM; boot log:\n${getBootLog()}`).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'with MYCELIUM_URL unset, the --mock default is localhost, NOT the deprecated .fyi',
    async () => {
      // THE DEFAULT-URL PIN. Before the sovereignty-default fix this resolved to
      // https://mycelium.fyi/api/mycelium and a stranger's first hardware-free
      // mock run quietly pointed at the deprecated public instance. After the
      // fix it must be their own localhost.
      const env = { ...process.env }
      delete env.MYCELIUM_URL

      const { child, cwd, getBootLog } = spawnMock(env)
      const exited = new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
      })

      try {
        // The "Mycelium: <url>" line prints in main() BEFORE any network call,
        // so we can capture the resolved default without the drone reaching a
        // real instance. (localhost:3002 is the default; if nothing listens the
        // startup heartbeat just ECONNREFUSES into its .catch().)
        const urlMatch = await waitForOutput(child, /^Mycelium: (\S+)/m, BOOT_DEADLINE_MS, getBootLog)
        const resolved = urlMatch[1]
        expect(resolved, 'default must be localhost (sovereignty), never .fyi').toBe('http://localhost:3002/api/mycelium')
        expect(resolved, 'default must not contain the deprecated hosted host').not.toContain('mycelium.fyi')
      } finally {
        // Tear down promptly — we only needed the startup-log line.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await terminate(child)
        rmSync(cwd, { recursive: true, force: true })
      }

      const { signal } = await exited
      expect(signal, `printer-drone killed by signal; boot log:\n${getBootLog()}`).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )
})
