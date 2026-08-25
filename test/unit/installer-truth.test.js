import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
