// Static-site Cache-Control policy gate — audit blocker #6 (site-01
// LAUNCH-READINESS). The site at / is the built Next.js export in public/,
// served by `express.static(publicPath, { setHeaders })`. Without this gate a
// regression back to express.static defaults (`public, max-age=0` on
// everything) ships silently: every visit re-downloads every hashed chunk,
// and the launch-readiness audit blocks on exactly that.
//
// The three classes asserted here (the matrix in public/serve.json):
//   1. /_next/static/**  — content-hashed by the Next build → immutable for a
//      year (a changed file is a changed URL, so caching it "forever" is safe);
//   2. HTML — revalidates every time (`no-cache` + ETag) so a deploy goes live
//      on the next load, never serves a stale page from disk cache;
//   3. other statics (portraits, badges, favicon) — stable but UNhashed names
//      → short TTL (`public, max-age=600`) so re-deploys aren't served stale.
//
// Hermetic by construction, same discipline as server-cold-start.test.js (which
// owns the boot-semantics contract this file builds on): random ephemeral port,
// throwaway DATA_DIR under os.tmpdir(), inline secrets, loopback only, bounded
// /health poll, teardown in `finally`, and a post-exit assertion that the port
// really is released.
//
// The asset paths are DISCOVERED from the tracked public/ export rather than
// hardcoded — every site build rehashes /_next/static and can add/move images,
// and a test that names one build's hash dies on the next export. Discovery
// failure is a loud, specific error: the tracked export IS the fixture, and a
// public/ that can't provide a chunk, a page, and an image is itself a defect.

import { describe, test, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'index.js')
const PUBLIC_DIR = join(REPO_ROOT, 'public')

const HEALTH_DEADLINE_MS = 15000
const TEST_TIMEOUT_MS = 30000

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.ico'])

// ---- fixture discovery over the tracked public/ export ----

// First file under public/<dirRel> matching `pred`, as { absPath, urlPath }.
// Sorted for determinism (readdir order is filesystem order, not stable).
function findPublicFile(dirRel, pred, label) {
  const base = join(PUBLIC_DIR, dirRel)
  let entries
  try {
    entries = readdirSync(base, { recursive: true })
  } catch (e) {
    throw new Error(`tracked public/ export is missing ${dirRel}/ (${e.message}) — the static site export is this test's fixture`, { cause: e })
  }
  const rel = entries
    .map((e) => e.split(sep).join('/'))
    .filter((e) => { try { return statSync(join(base, e)).isFile() } catch { return false } })
    .filter(pred)
    .sort()[0]
  if (!rel) throw new Error(`no ${label} found under public/${dirRel}/ — the tracked static export is the fixture; a public/ without one is itself a defect`)
  return { absPath: join(base, rel), urlPath: `/${dirRel}/${rel}` }
}

function discoverFixtures() {
  const chunk = findPublicFile('_next/static', (e) => extname(e) === '.js', 'a content-hashed .js chunk')
  const image = findPublicFile('.', (e) => !e.startsWith('_next/') && IMAGE_EXTS.has(extname(e).toLowerCase()), 'an image (portrait/badge/favicon)')
  // A directory page served BY express.static (e.g. /agents/ from
  // agents/index.html) — not the / route, which sendFile owns (see below).
  const page = findPublicFile('.', (e) => e.endsWith('/index.html') && e !== 'index.html', 'a non-root index.html page')
  return { chunk, image, page }
}

// ---- spawn helpers (mirror server-cold-start.test.js) ----

function coldStartEnv(port, dataDir) {
  return {
    ...process.env,
    JWT_SECRET: 'cache-headers-jwt-secret-' + port,
    ADMIN_KEY: 'cache-headers-admin-key-' + port,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
  }
}

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

async function waitForHealth(port, deadlineMs, child, getBootLog) {
  const url = `http://127.0.0.1:${port}/health`
  const start = Date.now()
  let lastErr
  while (Date.now() - start < deadlineMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited before answering GET ${url} (code=${child.exitCode}, signal=${child.signalCode}). Boot log:\n${getBootLog()}`)
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    } finally {
      clearTimeout(timer)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`server never answered GET ${url} with 200 within ${Math.round(deadlineMs / 1000)}s (last: ${lastErr && lastErr.message}). Boot log:\n${getBootLog()}`)
}

describe('static-site Cache-Control policy (audit blocker #6)', () => {
  test(
    'a freshly spawned server serves the three cache classes (immutable hashed assets, no-cache HTML, short-TTL other statics)',
    async () => {
      const { chunk, image, page } = discoverFixtures()

      const port = await getEphemeralPort()
      const dataDir = mkdtempSync(join(tmpdir(), 'mycelium-cache-headers-'))

      const child = spawn('node', [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: coldStartEnv(port, dataDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let bootLog = ''
      child.stdout.on('data', (c) => { bootLog += c.toString() })
      child.stderr.on('data', (c) => { bootLog += c.toString() })
      const getBootLog = () => bootLog

      const exited = new Promise((resolve, reject) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
        child.on('error', reject)
      })

      try {
        await waitForHealth(port, HEALTH_DEADLINE_MS, child, getBootLog)

        const headersFor = async (urlPath) => {
          const res = await fetch(`http://127.0.0.1:${port}${urlPath}`)
          expect(res.status, `GET ${urlPath} should serve 200`).toBe(200)
          const cc = res.headers.get('cache-control')
          expect(cc, `GET ${urlPath} should carry a Cache-Control header`).toBeTruthy()
          return cc
        }

        // Class 1 — content-hashed build output: immutable for a year.
        expect(
          await headersFor(chunk.urlPath),
          `hashed chunk ${chunk.urlPath} must be immutable (fix once, cache forever — the URL changes when the content does)`,
        ).toBe('public, max-age=31536000, immutable')

        // Class 2 — HTML revalidates, on BOTH html paths: the / entry page and
        // a directory page served by express.static itself.
        expect(await headersFor('/'), 'the / entry page must revalidate so a deploy lands on the next load').toBe('no-cache')
        expect(await headersFor(page.urlPath), `page ${page.urlPath} must revalidate so a deploy lands on the next load`).toBe('no-cache')

        // Class 3 — stable-named statics: short TTL, not stale-forever, not
        // re-downloaded every visit.
        expect(
          await headersFor(image.urlPath),
          `unhashed static ${image.urlPath} must carry the short TTL (600s)`,
        ).toBe('public, max-age=600')
      } finally {
        // Kill what we spawned — the listening socket, the throwaway DB, all
        // of it — whether the assertions passed, failed, or timed out.
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
        }
        rmSync(dataDir, { recursive: true, force: true })
      }

      // Port freed: the child must have exited ON ITS OWN after SIGTERM (a
      // signal-kill means shutdown hung), and the socket must be gone — a
      // follow-up connect to the port has to be REFUSED, not answered.
      const { code, signal } = await exited
      expect(signal, `server killed by signal (did not shut down cleanly); boot log:\n${getBootLog()}`).toBeNull()
      expect(code, `server exited non-zero after SIGTERM; boot log:\n${getBootLog()}`).toBe(0)
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
    },
    TEST_TIMEOUT_MS,
  )
})
