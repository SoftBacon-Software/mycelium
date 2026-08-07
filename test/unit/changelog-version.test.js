import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md')

// The version this gate enforces is read from package.json, NOT hardcoded.
// Bumping package.json without a matching CHANGELOG heading fails this test.
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const version = pkg.version // e.g. "0.1.0"

// Matches "## [0.1.0]", "## v0.1.0", or "## 0.1.0" at the start of a line.
// Anchored to "## " so it matches headings, not the link-reference footer.
const versionHeading = new RegExp(
  `^##\\s+\\[?v?${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?\\b`,
  'm',
)

function readChangelog() {
  if (!existsSync(CHANGELOG)) return null
  return readFileSync(CHANGELOG, 'utf8')
}

describe('CHANGELOG tracks package.json version', () => {
  test('CHANGELOG.md exists at repo root', () => {
    expect(existsSync(CHANGELOG)).toBe(true)
  })

  test(`CHANGELOG has a heading for the current version (${version})`, () => {
    const text = readChangelog()
    expect(text, 'CHANGELOG.md must exist').not.toBeNull()
    expect(
      text,
      `expected a "## [${version}]" (or "## v${version}") heading in CHANGELOG.md`,
    ).toMatch(versionHeading)
  })

  test('CHANGELOG has an [Unreleased] section', () => {
    const text = readChangelog()
    expect(text, 'CHANGELOG.md must exist').not.toBeNull()
    expect(text).toMatch(/^##\s+\[Unreleased\]/im)
  })
})
