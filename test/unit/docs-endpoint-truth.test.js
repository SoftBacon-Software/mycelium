// Entry-doc ↔ live-app ROUTE-REACHABILITY gate.
//
// README.md and CONTRIBUTING.md are the docs a stranger reads first, and the
// commands they copy out of them are expected to just work. If an entry doc
// tells a reader to hit an HTTP path the mounted app does not register, the
// stranger's first request 404s and the doc has lied. This gate catches that:
// every HTTP path the entry docs cite must resolve to a real route — 200 for an
// open route, 401/403 for a gated one, but never 404.
//
// It is the route-reachability sibling of two existing gates:
//   - readme-named-endpoints-gate (brief 19/28): asserts README fenced `$URL/`
//     citations exist in the route-manifest.snapshot — the /api/mycelium
//     sub-router ONLY. Its own commit message carves root routes out: "root-app
//     routes (GET /health) are intentionally outside the gate's universe."
//   - docs-reachability (brief 32): asserts docs/*.md FILES are linked from the
//     entry docs — file-reachability, not route-reachability.
// This gate closes both gaps: it reads the entry docs (README AND CONTRIBUTING)
// AND it builds the REAL root app (so root routes like GET /health are in
// scope), then asserts every cited path resolves. The three compose — same
// "docs reach reality" family, non-overlapping surfaces.
//
// Source of truth is the live Express app built by test/refactor/app-routes.mjs
// (root + sub-router + plugin routes, full prefixes), NOT a frozen list and NOT
// the sub-router-only snapshot. So a renamed or deleted route reds here without
// anyone editing the gate, and a path newly cited in the docs is checked
// automatically. Doc-side extraction is by scanning text for URL-like tokens
// (curl host-qualified, `$URL/...` fenced, bare `METHOD /path`, and the
// verify-path-attached-to-an-API-base anti-pattern) — derivation, not hardcode.
//
// Auth note: most /api/mycelium routes are gated. This gate asserts the route is
// REGISTERED (present in the live stack), not that it succeeds unauthenticated.
// A registered-but-gated route is a pass — the route is real. A 404 (path not
// registered at all) is the only failure.
//
// Scope growth (runner-platform-truth, 2026-09-04): the scan set is no longer
// just the two entry docs. docs/*.md files that teach a PLATFORM API call — a
// host-qualified curl whose URL path runs under the documented /api/mycelium
// base — are derived and added automatically (no file is named here), and only
// their platform citations are checked: a docs/ curl aimed at another process
// (the runner package ships its own `localhost:8080 /health,/ready` health
// server) describes a route table this gate does not build. This is what
// catches docs/runner-setup-macos.md teaching `POST .../agents`, which the app
// never registered — only GET /agents is mounted; registration is
// POST /admin/agents — so the stranger's first command in that doc 404'd.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const ENTRY_DOCS = ['README.md', 'CONTRIBUTING.md']
const SUB_ROUTER_BASE = '/api/mycelium'

// docs/*.md files that teach a PLATFORM API call join the scan set. The set is
// DERIVED by scanning docs/ — never named — so a lying doc added tomorrow is
// caught with no edit here. A host-qualified curl to a NON-platform path (the
// runner's own health server, a vendored service) does not qualify: that is a
// different process, and the live app built below is not it.
const DOCS_DIR = join(ROOT, 'docs')
const PLATFORM_CURL_RE = /\bcurl\b[^\n]*?https?:\/\/[^\s/]+(\/api\/mycelium\/\S*)/
function citesPlatformApi(rel) {
  return PLATFORM_CURL_RE.test(readFileSync(join(ROOT, rel), 'utf8'))
}
const DOC_DOCS = (() => {
  try {
    return readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join('docs', f))
      .filter(citesPlatformApi)
  } catch {
    return [] // docs/ absent — the entry docs are still scanned
  }
})()
const SCANNED_DOCS = [...ENTRY_DOCS, ...DOC_DOCS]
const isEntryDoc = (doc) => ENTRY_DOCS.includes(doc)

// --- live route set (built once) --------------------------------------------
const ADMIN_KEY = 'docs-truth-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'docs-truth-jwt-secret'

let tmpDataDir
let routes = []

beforeAll(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-docs-truth-'))
  const outFile = join(tmpDataDir, 'routes.json')
  // process.execPath = the same node running vitest, so the helper's native
  // binding (better-sqlite3) matches whatever the test suite is running under.
  const r = spawnSync(process.execPath, [join('test', 'refactor', 'app-routes.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      DATA_DIR: tmpDataDir,
      ADMIN_KEY,
      JWT_SECRET,
      APP_ROUTES_OUT: outFile,
    },
  })
  if (r.status !== 0) {
    throw new Error(
      'app-routes.mjs did not exit 0 (status=' +
        r.status +
        ', signal=' +
        r.signal +
        '). The live app build failed — the gate refuses to run against an ' +
        'empty/stale route set. stderr tail:\n' +
        (r.stderr || '').split('\n').slice(-8).join('\n'),
    )
  }
  routes = JSON.parse(readFileSync(outFile, 'utf8'))
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// --- membership: does (method, path) resolve? ------------------------------
// Segments match by PATTERN: a registered `:param` segment matches any single
// doc segment (so doc `/boot/dev-agent` lines up with registered
// `/boot/:agentId`), literals match exactly. Method must match too — a doc
// `POST /agents` is wrong if only `GET /agents` is mounted.
function segments(p) {
  return p.split('/').filter(Boolean)
}
function oneMatches(method, path) {
  const want = segments(path)
  return routes.some((line) => {
    const sp = line.indexOf(' ')
    return line.slice(0, sp) === method && sameShape(segments(line.slice(sp + 1)), want)
  })
}
function sameShape(reg, want) {
  if (reg.length !== want.length) return false
  return reg.every((seg, i) => seg.startsWith(':') || seg === want[i])
}

// A bare prose mention (e.g. `POST /boot/:id`) does not say whether it lives at
// root or under /api/mycelium, so it resolves if EITHER does. A scoped, curl,
// or $URL citation pins the base exactly and gets no fan-out.
function resolves(c) {
  if (c.exact) return oneMatches(c.method, c.path)
  return oneMatches(c.method, c.path) || oneMatches(c.method, SUB_ROUTER_BASE + c.path)
}

// --- doc-side extraction -----------------------------------------------------
// Each citation: { method, path, exact, doc, line, token }. `exact` true means
// path is the literal server path (curl/$URL/scoped); false means bare prose
// that may be root- or sub-router-relative (fan-out).
const METHOD = 'GET|POST|PUT|DELETE|PATCH'
const METHOD_RE = new RegExp('\\b(' + METHOD + ')\\b')

// Paths are captured greedily off the raw text then trimmed of trailing prose
// punctuation (closing backtick/paren/quote, comma, period). Entry docs wrap
// URLs in `backticks`, so a naive `/health` capture bleeds into ``/health`,``;
// route paths never end in these chars, so trimming only ever removes noise.
function cleanPath(p) {
  return p.replace(/[)`"'.,;]+$/, '').replace(/\/{2,}/g, '/')
}
function methodFrom(s) {
  const m = s.match(/-X\s+(GET|POST|PUT|DELETE|PATCH)\b/)
  return m ? m[1] : 'GET'
}

function extract(doc, name) {
  const citations = []
  const lines = readFileSync(join(ROOT, doc), 'utf8').split('\n')
  lines.forEach((line, idx) => {
    const ln = idx + 1

    // (a) scoped: a verify-path in parentheses on a line that also asserts the
    //     /api/mycelium API base — "API at …/api/mycelium (`GET /health` to
    //     verify)". Read naturally the path is under /api/mycelium, which is the
    //     exact wrong-base trap that birthed the /health bug. Pin it there.
    //     An optional opening quote/backtick sits between "(" and the method
    //     because these paths are inline-coded: "(`GET /health`".
    if (/\b\/api\/mycelium\b/.test(line)) {
      const m = line.match(/\(\s*[`'"]?(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/)
      if (m) {
        citations.push({
          method: m[1],
          path: cleanPath(SUB_ROUTER_BASE + m[2]),
          exact: true,
          doc: name,
          line: ln,
          token: m[0],
        })
        return // this line's path token is accounted for; don't also bare-match it
      }
    }

    // (b) host-qualified curl — the URL path is the literal server path. Anchor
    //     to the URL that follows `curl` (lazy), not the first URL on the line:
    //     a line can name the API base in prose AND curl the verify route, e.g.
    //     "API at …/api/mycelium. Verify with `curl …/health`" — only /health is
    //     an instruction to hit the server.
    const curl = line.match(/\bcurl\b[\s\S]*?(https?:\/\/[^\s/]+)(\/\S*)/)
    if (curl) {
      citations.push({
        method: methodFrom(line),
        path: cleanPath(curl[2]),
        exact: true,
        doc: name,
        line: ln,
        token: curl[0],
      })
      return
    }

    // (c) $URL/<path> — $URL is the documented /api/mycelium API base.
    const dollar = line.match(/\$URL(\/\S*)/)
    if (dollar) {
      citations.push({
        method: methodFrom(line),
        path: cleanPath(SUB_ROUTER_BASE + dollar[1]),
        exact: true,
        doc: name,
        line: ln,
        token: '$URL' + dollar[1],
      })
      return
    }

    // (d) bare `METHOD /path` prose — base ambiguous, fan out.
    const bare = line.match(new RegExp('\\b(' + METHOD + ')\\s+(\\/[A-Za-z0-9:_-]+(?:\\/[A-Za-z0-9:_-]+)*)'))
    if (bare) {
      citations.push({
        method: bare[1],
        path: cleanPath(bare[2]),
        exact: false,
        doc: name,
        line: ln,
        token: bare[1] + ' ' + bare[2],
      })
    }
  })
  return citations
}

let citations
beforeAll(() => {
  citations = SCANNED_DOCS.flatMap((d) => extract(d, d)).filter(
    // Non-entry docs are checked for their PLATFORM citations only (see the
    // DOCS_DIR note): bare `METHOD /path` prose and /api/mycelium-scoped or
    // $URL citations stay in universe; a host-qualified curl aimed elsewhere
    // (the runner's localhost:8080 health server) is another process's surface.
    (c) => isEntryDoc(c.doc) || !c.exact || c.path.startsWith(SUB_ROUTER_BASE + '/')
  )
})

describe('entry docs cite only routes the live app registers', () => {
  test('live route set is non-empty (app build succeeded)', () => {
    expect(routes.length, 'app-routes.mjs returned zero routes — build failed or stack shape changed').toBeGreaterThan(0)
  })

  test('extractor is alive — scanned docs cite at least one HTTP path', () => {
    expect(citations.length, 'found zero citations; extractor may be broken').toBeGreaterThan(0)
  })

  test('docs/ scan set is derived and non-empty (a platform-curl doc exists to police)', () => {
    expect(DOC_DOCS.length, 'no docs/*.md teaches a platform API curl — either docs/ moved or the derivation broke').toBeGreaterThan(0)
  })

  test('every cited path resolves (404 = fail)', () => {
    const missing = citations.filter((c) => !resolves(c))
    if (missing.length) {
      throw new Error(
        'Docs cite HTTP paths the app does NOT register ' +
          '(a stranger copying them gets a 404):\n' +
          missing
            .map((c) => `  - ${c.method} ${c.path}  <- ${c.doc}:L${c.line} "${c.token}"`)
            .join('\n'),
      )
    }
    expect(missing).toEqual([])
  })
})
