import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..', '..')

// The one-line installer is the front door of a public release. On 2026-08-22
// it was doubly broken: public/install.sh pulled a GHCR image no anonymous
// user can fetch (token request -> HTTP 403), while tools/install.sh — the
// file server/index.js actually serves at https://mycelium.fyi/install.sh —
// cloned a `stable` branch that does not exist on origin. Neither script was
// documented or tested, so both rotted invisibly. This gate reads tracked
// files only (no network) and pins the recorded reality in ALLOWED_REFS.
// When reality changes (pin to a tag, publish an image), re-verify the refs
// against origin and update ALLOWED_REFS in the same commit — that is the
// point of this gate.

const CANONICAL = 'tools/install.sh' // served at /install.sh by server/index.js

// runner/install.sh installs a different product from a different repo
// (SoftBacon-Software/mycelium-runner) — not a platform-installer twin.
const EXEMPT = new Set(['runner/install.sh'])

// Recorded reality, verified 2026-08-22 against origin:
//   git ls-remote origin refs/heads/master -> f8448af... (exists)
//   git ls-remote origin refs/heads/stable -> (no such ref)
//   docker manifest inspect ghcr.io/softbacon-software/mycelium:latest
//     -> "denied"; anonymous token request -> HTTP 403 (never published, or
//     private). IMAGE is deliberately absent from this map: no registry
//     artifact exists, so the installer must not reference one. Adding
//     IMAGE here requires Gilbert to have published it first.
const ALLOWED_REFS = {
  REPO: 'https://github.com/SoftBacon-Software/mycelium.git',
  BRANCH: 'master',
}

const tracked = execFileSync('git', ['ls-files'], { cwd: root })
  .toString()
  .split('\n')
  .filter(Boolean)
const installers = tracked
  .filter(
    (f) =>
      /^install[\w.-]*\.sh$/.test(path.basename(f)) &&
      f.split('/').length <= 2 &&
      !EXEMPT.has(f)
  )
  .sort()

describe('installer truth', () => {
  test('exactly one platform installer (twins must be byte-identical)', () => {
    expect(installers, `tracked platform installers: ${installers.join(', ')}`).toContain(CANONICAL)
    if (installers.length > 1) {
      const canonicalBytes = readFileSync(path.join(root, CANONICAL))
      for (const f of installers) {
        if (f === CANONICAL) continue
        const identical = readFileSync(path.join(root, f)).equals(canonicalBytes)
        expect(
          identical,
          `${f} diverges from ${CANONICAL} — one canonical installer only: delete it or make it byte-identical (no twin drift)`
        ).toBe(true)
      }
    }
  })

  test('every artifact ref in the script matches the recorded allowlist', () => {
    const script = readFileSync(path.join(root, CANONICAL), 'utf8')
    const found = {}
    for (const m of script.matchAll(/^\s*(REPO|BRANCH|IMAGE|TAG|VERSION|REF|COMMIT)\s*=\s*"([^"]*)"/gm)) {
      found[m[1]] = m[2]
    }
    expect(
      found,
      'ref assignments must equal ALLOWED_REFS exactly — a new or changed REPO/BRANCH/IMAGE ref is only real if the recorded reality in this test is updated in the same commit'
    ).toEqual(ALLOWED_REFS)
  })

  test('preflight verifies the install ref before the first mutating command', () => {
    const script = readFileSync(path.join(root, CANONICAL), 'utf8')
    const lines = script.split('\n')
    const mutating =
      /^\s*(git\s+(clone|fetch|pull|checkout)|mkdir|touch|chmod|chown|cp\s|mv\s|ln\s|cat\s*>|npm\s+(ci|install|i)\b|pip3?\s+install|systemctl|docker\s+(run|pull|build|stop|rm|compose))/
    const firstMutating = lines.findIndex((l) => mutating.test(l))
    const preflightCall = lines.findIndex((l) => /^preflight\s*$/.test(l))
    expect(firstMutating, 'script must contain a mutating command for the order check to guard').toBeGreaterThan(-1)
    expect(preflightCall, "script must invoke the preflight at top level (a line that is exactly 'preflight')").toBeGreaterThan(-1)
    expect(
      preflightCall,
      `preflight (line ${preflightCall + 1}) must run before the first mutating command (line ${firstMutating + 1}: ${lines[firstMutating].trim()})`
    ).toBeLessThan(firstMutating)
    // The preflight must actually verify the artifact, not just exist.
    expect(script, 'preflight must verify the ref with git ls-remote --exit-code').toContain('git ls-remote --exit-code')
  })

  test('server /install.sh route serves the canonical installer', () => {
    const server = readFileSync(path.join(root, 'server', 'index.js'), 'utf8')
    const m = server.match(/installScript\s*=\s*path\.join\(__dirname,\s*([^)]+)\)/)
    expect(m, 'server/index.js must resolve an installScript path for the /install.sh route').toBeTruthy()
    const segments = m[1].match(/'([^']*)'/g)?.map((s) => s.slice(1, -1)) ?? []
    expect(
      segments,
      `the /install.sh route must serve ${CANONICAL} (the route is guarded by existsSync, so a wrong path silently 404s)`
    ).toEqual(['..', 'tools', 'install.sh'])
  })

  test('README install story matches the script', () => {
    const script = readFileSync(path.join(root, CANONICAL), 'utf8')
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8')

    // The URL the script advertises must be the URL the README teaches.
    const urls = [
      ...new Set(
        [...script.matchAll(/https:\/\/\S*install\.sh/g)].map((m) => m[0].replace(/[`'")|]+$/, ''))
      ),
    ]
    expect(urls.length, 'script must advertise its one-line URL in its header').toBeGreaterThan(0)
    for (const u of urls) {
      expect(readme, `README must advertise the same installer URL as the script: ${u}`).toContain(u)
    }

    // No registry-image story in the README while no image is published.
    if (ALLOWED_REFS.IMAGE === undefined) {
      const imageLines = readme.split('\n').filter((l) => l.includes('ghcr.io'))
      expect(
        imageLines,
        'README references a GHCR image but ALLOWED_REFS records none — publish first (Gilbert\\u2019s call), then record it'
      ).toEqual([])
    }

    // Any branch/tag token on the README\\u2019s installer lines must be the ref the script installs.
    const readmeInstallLines = readme.split('\n').filter((l) => /install\.sh/.test(l))
    for (const line of readmeInstallLines) {
      for (const ref of line.matchAll(/\b(master|stable|main|v\d+(?:\.\d+)+)\b/g)) {
        expect(
          ref[1],
          `README install line names ref '${ref[1]}' but the script installs '${ALLOWED_REFS.BRANCH}': ${line.trim()}`
        ).toBe(ALLOWED_REFS.BRANCH)
      }
    }
  })
})

// ─── Success-output truth (brief 158, 2026-09-05) ──────────────────────────
//
// The gates above pin what the installer INSTALLS. This describe pins what it
// PRINTS when the install succeeds — the last thing a stranger reads. On
// 2026-08-27 (re-derived 2026-09-05) that summary taught a dead dashboard
// first and a dead docs URL last: step 1 was `http://localhost:$PORT/studio/`
// — the /studio SPA was retired 2026-06 (7d13710) and a fresh boot 404s it —
// and the Docs line pointed at https://mycelium.fyi/docs, live 404 (the site
// root serves; the path does not). Nothing above reads the strings the script
// ECHOES, so both rotted. Three gates close the class:
//
//   1. Retired-surface ban — no line that PRODUCES OUTPUT may teach the
//      retired SPA path. Scoped twice, mirroring the retired-surface server
//      gate's naming-trap discipline: to output lines (echo/printf and the
//      info/ok/warn/fail helpers — not comments, so the header usage comment
//      and future prose can't false-red), and to the SPA path rather than the
//      word, because `/api/mycelium/studio/*` is the LIVE studio.js
//      JWT/user module (server/routes/studio.js) that outlived the SPA.
//   2. Route existence — every /api/mycelium/... path an output line cites
//      must be registered by the real app. Source of truth is
//      test/refactor/app-routes.mjs, the same live no-listen derivation
//      docs-endpoint-truth.test.js builds (full app: root + sub-router +
//      plugin routes, `:param`-aware) — chosen over route-manifest.snapshot
//      because it reds on rename/delete with no snapshot to refresh. The bare
//      API base (/api/mycelium) is the mount pointer, not a route — excluded,
//      or the API summary line false-reds.
//   3. External-URL allowlist — every non-localhost http(s) URL the script
//      prints must be recorded in ECHOED_EXTERNAL_URLS with the day it was
//      last verified live and the receipt that proved it. Hermetic in CI;
//      MYCELIUM_NET_CHECK=1 re-verifies live (the same switch the
//      install-one-liner gate specifies). An entry without a date is rejected
//      — a check that cannot fail is not a check.
//
// Out of scope, deliberately: `${REPO}` is interpolated on output lines but
// is not a literal (ALLOWED_REFS above already pins it by set-equality), and
// the header usage comment is not output (the one-liner gate's surface).

const OUTPUT_LINE = /^\s*(?:(?:echo|printf)\b|(?:info|ok|warn|fail)\s+["'])/
// The retired surface is the SPA's ROOT path. The lookbehind keeps the live
// /api/mycelium/studio route module legal — drop it and the gate false-reds
// the admin-creation curl the success block teaches.
const RETIRED_SPA_PATH = /(?<!\/api\/mycelium)\/studio\b/

function installerOutputLines(script) {
  return script
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => OUTPUT_LINE.test(line))
}

function echoedExternalUrls(script) {
  const found = new Set()
  for (const { line } of installerOutputLines(script)) {
    // `$` is excluded from the token class so a `${NC}` color-code bleeding
    // into an unterminated URL cannot be captured as part of it.
    for (const m of line.matchAll(/https?:\/\/[^\s"'\\$]+/g)) {
      const url = m[0].replace(/[.,;)\]}>]+$/, '')
      // Localhost URLs are the server's own surface — taught-URL truth for
      // those is gate 2's job (and the /health line). The allowlist class is
      // external only.
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url)) continue
      found.add(url)
    }
  }
  return [...found].sort()
}

// Optional method prefix (`POST /api/...` prose), else the line's `-X METHOD`,
// else GET. Continuation lines carry no URL of their own, so header/flag
// continuation output is naturally out of the extraction.
function echoedApiPaths(script) {
  const found = []
  for (const { line, n } of installerOutputLines(script)) {
    for (const m of line.matchAll(
      /(?:(GET|POST|PUT|DELETE|PATCH)\s+)?(\/api\/mycelium(?:\/[A-Za-z0-9_:-]+)*\/?)/g
    )) {
      const p = m[2].replace(/\/+$/, '')
      if (p === '/api/mycelium') continue // the mount pointer, not an endpoint
      const method = m[1] || line.match(/-X\s+(GET|POST|PUT|DELETE|PATCH)\b/)?.[1] || 'GET'
      found.push({ method, path: p, n, line: line.trim() })
    }
  }
  return found
}

function registersMethodPath(method, p) {
  const want = p.split('/').filter(Boolean)
  return printRoutes.some((entry) => {
    const sp = entry.indexOf(' ')
    if (entry.slice(0, sp) !== method) return false
    const reg = entry.slice(sp + 1).split('/').filter(Boolean)
    return (
      reg.length === want.length &&
      reg.every((seg, i) => seg.startsWith(':') || seg === want[i])
    )
  })
}

const PRINT_ADMIN_KEY = 'installer-truth-admin-key-0123456789abcdef0123456789abcdef'
const PRINT_JWT_SECRET = 'installer-truth-jwt-secret'

let printRoutes = []
let printDataDir

beforeAll(() => {
  printDataDir = mkdtempSync(path.join(tmpdir(), 'myc-installer-print-'))
  const outFile = path.join(printDataDir, 'routes.json')
  // process.execPath = the same node running vitest, so the helper's native
  // binding (better-sqlite3) matches whatever the suite is running under.
  // app-routes.mjs captures the app WITHOUT binding a port, so this composes
  // with docs-endpoint-truth.test.js building the same app concurrently.
  const r = spawnSync(process.execPath, [path.join('test', 'refactor', 'app-routes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      DATA_DIR: printDataDir,
      ADMIN_KEY: PRINT_ADMIN_KEY,
      JWT_SECRET: PRINT_JWT_SECRET,
      APP_ROUTES_OUT: outFile,
    },
  })
  if (r.status !== 0) {
    throw new Error(
      'app-routes.mjs did not exit 0 (status=' + r.status + ', signal=' + r.signal +
        '). The live app build failed — the route-existence gate refuses to run ' +
        'against an empty/stale route set. stderr tail:\n' +
        (r.stderr || '').split('\n').slice(-8).join('\n')
    )
  }
  printRoutes = JSON.parse(readFileSync(outFile, 'utf8'))
})

afterAll(() => {
  if (printDataDir) rmSync(printDataDir, { recursive: true, force: true })
})

// Recorded reality: every non-localhost http(s) URL the installer PRINTS, the
// day it was last verified live, and the receipt that proved it. Adding an
// entry without a date is rejected by the gate below. When a URL dies, fix the
// script and remove the entry in the same commit.
const ECHOED_EXTERNAL_URLS = {
  'https://git-scm.com': {
    verified: '2026-09-05',
    receipt: 'curl -sIL -> HTTP 200 (git download page)',
  },
  'https://nodejs.org': {
    verified: '2026-09-05',
    receipt: 'curl -sIL -> HTTP 200 (node download page)',
  },
  'https://github.com/SoftBacon-Software/mycelium/issues': {
    verified: '2026-09-05',
    receipt: 'curl -sIL -> HTTP 200 (preflight failure report target)',
  },
  'https://github.com/SoftBacon-Software/mycelium-mcp.git': {
    verified: '2026-09-05',
    receipt: 'git ls-remote --exit-code <url> HEAD -> 0 (MCP step clone target)',
  },
  // The Docs line was repointed here from https://mycelium.fyi/docs — a URL
  // the repo does not control, live 404 on 2026-08-27 AND 2026-09-05 — in
  // favour of the tracked docs/ tree on the repo it installs.
  'https://github.com/SoftBacon-Software/mycelium/tree/master/docs': {
    verified: '2026-09-05',
    receipt: 'curl -sIL -> HTTP 200; docs/ has 14 tracked files at master 69b05a6',
  },
}

describe('installer success output truth', () => {
  test('no echoed line teaches the retired /studio SPA', () => {
    const script = readFileSync(path.join(root, CANONICAL), 'utf8')
    const violations = installerOutputLines(script).filter(({ line }) =>
      RETIRED_SPA_PATH.test(line)
    )
    expect(
      violations.map((v) => `  L${v.n}: ${v.line.trim()}`),
      'the /studio SPA was retired 2026-06 and a fresh boot 404s it — the installer must not print it as a working surface'
    ).toEqual([])
  })

  test('the ban is scoped to the SPA path — the live /api/mycelium/studio module does not trip it', () => {
    expect(
      RETIRED_SPA_PATH.test('http://localhost:$PORT/studio/'),
      'the retired SPA root path must be caught'
    ).toBe(true)
    expect(
      RETIRED_SPA_PATH.test('curl -X POST http://localhost:$PORT/api/mycelium/studio/users'),
      'the studio.js JWT/user module outlived the SPA; its API paths are legal output'
    ).toBe(false)
  })

  test('no output line swallows a color reset behind an escaped backslash (verbatim copy-paste)', () => {
    const script = readFileSync(path.join(root, CANONICAL), 'utf8')
    // Found live 2026-09-05: the printed curl block rendered a LITERAL
    // `\033[0m` — inside double quotes `\\${NC}` collapses to `\` + `\033[0m`,
    // which echo -e reads as an escaped backslash, eating the reset and
    // orphaning the line-continuation `\` (no longer adjacent to the newline).
    // A stranger copy-pasting the block got `\033[0m` as a stray curl argument.
    // The defect signature is an escaped backslash immediately followed by an
    // expansion; a wanted literal `\` in copied output must come LAST.
    const violations = installerOutputLines(script).filter(({ line }) => /\\\$\{?\w/.test(line))
    expect(
      violations.map((v) => `  L${v.n}: ${v.line.trim()}`),
      'an output line ends in \\\\${VAR} — the reset is swallowed and the trailing backslash breaks copy-paste; put ${VAR} before the escaped backslash'
    ).toEqual([])
  })

  test('every echoed /api/mycelium path is registered by the live app (404 = fail)', () => {
    expect(
      printRoutes.length,
      'app-routes.mjs returned zero routes — build failed or stack shape changed'
    ).toBeGreaterThan(0)
    const echoed = echoedApiPaths(readFileSync(path.join(root, CANONICAL), 'utf8'))
    expect(
      echoed.length,
      'extractor found zero /api/mycelium citations in installer output — extractor may be broken'
    ).toBeGreaterThan(0)
    const missing = echoed.filter((c) => !registersMethodPath(c.method, c.path))
    expect(
      missing.map((c) => `  ${c.method} ${c.path}  <- L${c.n}: ${c.line}`),
      'the installer prints API paths the app does not register — a stranger copying them gets a 404'
    ).toEqual([])
  })

  test('every echoed external URL is on the dated allowlist (set equality)', () => {
    const echoed = echoedExternalUrls(readFileSync(path.join(root, CANONICAL), 'utf8'))
    expect(
      echoed,
      'an echoed URL is only real if recorded in ECHOED_EXTERNAL_URLS with a date + receipt in the same commit (mycelium.fyi/docs taught a 404 for months because nothing pinned it)'
    ).toEqual(Object.keys(ECHOED_EXTERNAL_URLS).sort())
  })

  test('every allowlist entry carries a last-verified date and a receipt', () => {
    const bad = Object.entries(ECHOED_EXTERNAL_URLS).filter(([, e]) => {
      if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.verified || '')) return true
      const t = Date.parse(e.verified + 'T00:00:00Z')
      // A future stamp is a lie (+24h absorbs timezone skew between writer and CI);
      // an empty receipt is an unverified claim, not a record.
      if (Number.isNaN(t) || t > Date.now() + 24 * 3600 * 1000) return true
      return !(e.receipt || '').trim()
    })
    expect(
      bad.map(([u]) => u),
      'allowlist entries need { verified: YYYY-MM-DD, receipt } — an entry without them is an unverified claim'
    ).toEqual([])
  })

  test.runIf(process.env.MYCELIUM_NET_CHECK === '1')(
    'MYCELIUM_NET_CHECK: every allowlisted URL resolves live today',
    () => {
      for (const [url, entry] of Object.entries(ECHOED_EXTERNAL_URLS)) {
        if (url.endsWith('.git')) {
          execFileSync('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
            stdio: 'pipe',
            timeout: 30000,
          }) // throws on a missing repo/ref
        } else {
          const code = parseInt(
            execFileSync(
              'curl',
              ['-sIL', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', url],
              { encoding: 'utf8', timeout: 30000 }
            ).trim(),
            10
          )
          expect(
            code,
            `${url} (allowlisted ${entry.verified}: ${entry.receipt}) now returns HTTP ${code} — fix the script line and the entry in the same commit`
          ).toBeLessThan(400)
        }
      }
    }
  )
})
