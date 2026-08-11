import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

// A stranger who clones this repo sees a flat list of top-level directories.
// Every one of them has to be discoverable: either README.md names it (so a
// reader of README alone can account for every directory), or the directory
// ships its own README.md that explains it. A new top-level directory with
// neither is a mystery to a cold reader — and this gate turns that into a
// red test instead of a silent addition.
//
// The directory set is DERIVED from the live filesystem on every run (never
// hardcoded) and the README text is read live, so dropping in an
// undocumented top-level directory — or deleting a README mention — turns
// the gate red by itself, with no list to keep in sync.

// Tooling directories that are not product surface and never belong in the
// README map. Dotfiles (.git, .github, .claude, ...) are excluded by the
// leading-dot filter below.
const SKIP_DIRS = new Set(['node_modules'])

function topLevelDirs() {
  return readdirSync(REPO_ROOT)
    .filter((name) => !name.startsWith('.')) // dotfiles are tooling/config
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => statSync(join(REPO_ROOT, name)).isDirectory())
    .sort()
}

const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
const dirs = topLevelDirs()

describe('every top-level directory is accounted for in README or its own README', () => {
  // Sanity floor: if the derivation ever regresses to an empty set, the
  // per-directory loop below generates zero cases and looks quietly green.
  // Fail loud instead.
  test('derived top-level directory set is non-empty', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  for (const dir of dirs) {
    test(`top-level directory "${dir}/" is documented`, () => {
      // A directory is "accounted for" if README.md points at it as a path
      // (the `dir/` form the Architecture tree and Packages table already
      // use), or it carries its own README.md explaining it. We match the
      // path form `dir/` rather than the bare name: common directory names
      // like `tools` and `scripts` appear in README as ordinary English
      // words ("MCP tools", "local models, scripts") without documenting
      // the directory, and a bare-substring match would pass those through
      // as false greens — the exact mystery this gate exists to catch.
      const mentionedInReadme = readme.includes(dir + '/')
      const hasOwnReadme = existsSync(join(REPO_ROOT, dir, 'README.md'))
      expect(mentionedInReadme || hasOwnReadme).toBe(true)
    })
  }
})
