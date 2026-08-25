import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

// A "shipped" package is anything the repo DECLARES as an npm workspace or
// BAKES into its Docker image. A stranger who runs `docker compose up` or
// `npm install` lands these in their tree, so README.md has to name each
// one — otherwise the README cannot account for a package the repo ships.
// The set below is DERIVED from source on every run (package.json +
// Dockerfile), never hardcoded, so adding a workspace without documenting
// it turns this gate red.

function readWorkspaceNames(pkg) {
  const ws = pkg.workspaces
  if (!ws) return []
  // Accept both shapes: ["a","b"] and { packages: ["a","b"] }.
  // Object.values(...).flat() handles arrays, the {packages} object, and
  // even nested-glob arrays uniformly.
  return Object.values(ws).flat().filter(Boolean)
}

function readDockerfileCopyDirs(dockerfile) {
  const dirs = new Set()
  for (const line of dockerfile.split('\n')) {
    const m = line.match(/^\s*COPY\s+(.+)$/i)
    if (!m) continue
    // Every token across source and destination; dest usually mirrors src
    // (e.g. `COPY server/ server/`), so considering both is robust against
    // `COPY <files> <dir>/` shapes where only the dest names the dir.
    const tokens = m[1].trim().split(/\s+/)
    for (const tok of tokens) {
      if (tok.startsWith('--')) continue // COPY flags: --from, --chown, ...
      if (!tok.includes('/')) continue // bare filename, e.g. package*.json -> no dir
      const seg = tok.replace(/^\.\//, '').split('/')[0]
      if (!seg || seg === '.') continue // ignore "." and "./" (root / context)
      dirs.add(seg)
    }
  }
  return [...dirs]
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8')
const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')

const shipped = [...new Set([
  ...readWorkspaceNames(pkg),
  ...readDockerfileCopyDirs(dockerfile),
])].sort()

describe('README names every shipped/workspace package', () => {
  // Sanity floor: if derivation ever regresses and yields nothing, the
  // per-name loop below would generate zero cases and look quietly green.
  // This fails loud instead.
  test('derived shipped set is non-empty', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  // Each derivation source must contribute — guards a parser regression that
  // silently empties one half (and would otherwise just assert fewer names).
  test('both sources contribute (workspaces + Dockerfile COPY dirs)', () => {
    expect(readWorkspaceNames(pkg).length).toBeGreaterThan(0)
    expect(readDockerfileCopyDirs(dockerfile).length).toBeGreaterThan(0)
  })

  for (const name of shipped) {
    test(`README mentions shipped package "${name}"`, () => {
      expect(readme).toContain(name)
    })
  }
})
