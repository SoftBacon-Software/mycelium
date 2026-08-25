// README ↔ route-manifest MEMBERSHIP gate.
//
// The README is the surface a stranger copies commands from. If it cites an
// HTTP endpoint by path that the mounted router doesn't actually carry, the
// stranger gets a 404 and the doc has lied. This gate catches that rot:
// every endpoint path the README names must exist in the router.
//
// It is the missing third leg of the docs/refactor integrity tripod:
//   - route-manifest decomposition gate (test/refactor/route-manifest.mjs
//     --check): "routes don't silently move during a refactor" — the mounted
//     router is byte-identical to its snapshot.
//   - docs-inventory-accuracy: "the endpoint/table/test COUNTS are right."
//   - THIS gate: "each endpoint the README NAMES actually exists."
// Count-correct + decomposition-intact does NOT imply doc-correct: a README
// can name a route that doesn't exist while the total count is still right.
// Count is not membership.
//
// Source of truth is the SAME snapshot the decomposition gate freezes —
// test/refactor/route-manifest.snapshot (one manifest, many consumers; we do
// NOT re-walk the router here, that is route-manifest.mjs's job). That
// snapshot is the mycelium sub-router (mounted at /api/mycelium). Root-app
// routes such as GET /health (server/index.js, mounted on the root app, not
// the sub-router) are intentionally outside the snapshot's scope, so README
// citations of those are outside this gate's universe too. Concretely: the
// README cites /health only as a host-qualified probe
// (http://localhost:3002/health) or in prose, never as a $URL/<path> runnable
// citation, so it is never asserted here.
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const readme = readFileSync(path.resolve(ROOT, 'README.md'), 'utf8')
const snapshot = readFileSync(
  path.resolve(ROOT, 'test', 'refactor', 'route-manifest.snapshot'),
  'utf8',
)
const readmeLines = readme.split('\n')

// --- manifest side ---------------------------------------------------------
// Snapshot lines look like:   METHOD /path  [mw1,mw2]
// (method, one space, path, two spaces, then an arity-ish middleware bracket
// — exactly the shape route-manifest.mjs emits). The path token has no
// spaces, so METHOD + path is everything up to the double-space; the bracket
// falls off the match.
function parseManifest(text) {
  const routes = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)/)
    if (!m) continue
    routes.push({ method: m[1], segments: m[2].split('/').filter(Boolean) })
  }
  return routes
}

// Membership by segment PATTERN, not by canonical string. A manifest `:param`
// matches any single README segment, so the README's concrete example
// `/boot/dev-agent` lines up with the mounted `/boot/:agentId`, and a
// param-style `/boot/:id` would line up the same way. Literal segments must
// match exactly. (No `*` wildcards exist in the current snapshot.)
function routeExists(manifest, method, pathStr) {
  const segs = pathStr.split('/').filter(Boolean)
  return manifest.some(
    (r) =>
      r.method === method &&
      r.segments.length === segs.length &&
      r.segments.every((seg, i) => seg.startsWith(':') || seg === segs[i]),
  )
}

// --- README side -----------------------------------------------------------
// Only fenced code blocks — those are what strangers copy verbatim. Prose
// mentions (e.g. the figurative `POST /boot/:id` one-liner in the intro) are
// descriptive, not runnable citations, and are out of scope. Tuned so the
// only thing it flags on the real README is a genuine defect (the bite:
// `POST /agents` on master, corrected to `POST /admin/agents` on the brief-28
// branch).
function fencedBlocks(text) {
  const blocks = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(text)) !== null) blocks.push(m[1])
  return blocks
}

const METHOD_RE = '(?:GET|POST|PUT|DELETE|PATCH)'

function extractEndpoints(block) {
  const found = []
  for (const line of block.split('\n')) {
    // (a) `curl [-X METHOD] ... $URL/path ...` — $URL is the README's
    //     documented API-base variable ("$URL = your API base"), so `$URL/X`
    //     is the runnable endpoint X under /api/mycelium. METHOD comes from
    //     `-X M`, defaulting to GET (curl's default). Host-qualified URLs
    //     (github.com/…, http://localhost…, https://instance…) are NOT
    //     $URL-prefixed and so are never picked up here.
    const urlTok = line.match(/\$URL(\/[^\s'"\\]*)/)
    if (urlTok) {
      const x = line.match(/-X\s+(GET|POST|PUT|DELETE|PATCH)\b/)
      found.push({
        method: x ? x[1] : 'GET',
        path: urlTok[1],
        token: '$URL' + urlTok[1],
      })
      continue
    }
    // (b) a bare `METHOD /path` token (a doc style that spells the method out
    //     instead of using curl). Currently the README uses the curl/$URL
    //     form, so this catches nothing today; it is here so a future doc that
    //     writes `POST /admin/agents` inline is still covered.
    const bare = line.match(new RegExp('(^|\\s)(' + METHOD_RE + ')(\\s+)(/\\S+)'))
    if (bare) {
      found.push({ method: bare[2], path: bare[4], token: bare[2] + bare[3] + bare[4] })
    }
  }
  return found
}

// Insurance: drop anything file/package-looking the anchors might snag. (The
// $URL and METHOD anchors already exclude github URLs, localhost, package
// names, and relative file paths — none start with $URL/ or `METHOD /`.)
function looksLikeRoute(p) {
  return !/\.(js|mjs|cjs|json|md|sql|ya?ml|ts|tsx|sh|env|toml)$/i.test(p)
}

const manifest = parseManifest(snapshot)
const citations = fencedBlocks(readme)
  .flatMap(extractEndpoints)
  .filter((c) => looksLikeRoute(c.path))

function lineOf(token) {
  const i = readmeLines.findIndex((l) => l.includes(token))
  return i === -1 ? '?' : i + 1
}

describe('README named endpoints exist in the route manifest', () => {
  test('manifest parsed — snapshot is non-empty and well-formed', () => {
    // Guards a silent format change: if parseManifest stopped matching, every
    // citation would look "missing" for the wrong reason.
    expect(manifest.length, 'route-manifest.snapshot parsed zero routes').toBeGreaterThan(0)
  })

  test('extractor is alive — README code blocks cite at least one endpoint', () => {
    expect(citations.length, 'found zero endpoint citations; extractor may be broken').toBeGreaterThan(0)
  })

  test('every README-cited endpoint is mounted in the router', () => {
    const missing = citations.filter((c) => !routeExists(manifest, c.method, c.path))
    if (missing.length) {
      throw new Error(
        'README names endpoints NOT in route-manifest.snapshot ' +
          '(a stranger copying them gets a 404):\n' +
          missing
            .map((c) => `  - ${c.method} ${c.path}  <- README L${lineOf(c.token)}: "${c.token}"`)
            .join('\n'),
      )
    }
    // Explicit assertion so the passing path registers as an assertion, not
    // just the absence of a throw.
    expect(missing).toEqual([])
  })
})
