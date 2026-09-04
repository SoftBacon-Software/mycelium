import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..', '..')

// The supported Node version used to be stated nowhere a stranger looks.
// CI's matrix (.github/workflows/test.yml) was the only tested set, while the
// README, CONTRIBUTING and tools/install.sh each implied a different one (or
// none): the installer enforced `-lt 18` and told people to "Install Node 18+"
// even though nothing tests Node 18, and the Manual quick start said nothing
// at all — a stranger on 18 hit a better-sqlite3 prebuild gap deep in
// `npm install` with no documented floor to check against. This gate pins all
// of those statements to ONE number — the engines floor — so they cannot
// drift apart again. Hermetic: tracked files only, no network.
//
// When the supported floor changes, change ALL of it in one commit:
// package.json `engines`, the README Manual + installer prose, CONTRIBUTING's
// quick start, and tools/install.sh (message AND the `-lt` enforcement).
// This gate fails until they agree.

const read = (f) => readFileSync(path.join(root, f), 'utf8')

// Strict parse: only the range form this repo uses. An exotic range must fail
// loudly here, not pass vacuously.
function enginesFloor(range) {
  const m = /^>= *(\d+)(?:\.\d+){0,2}$/.exec(String(range).trim())
  expect(
    m,
    `package.json engines.node "${range}" is not a ">=<major>" range — extend the parser in this gate rather than shipping a range nobody can check`
  ).toBeTruthy()
  return Number(m[1])
}

function matrixMajors() {
  const wf = read('.github/workflows/test.yml')
  const m = /^ *node: *\[(.*)\] *$/m.exec(wf)
  expect(
    m,
    'no `node: [...]` matrix found in .github/workflows/test.yml — the workflow shape changed; update this gate in the same commit'
  ).toBeTruthy()
  const majors = [...m[1].matchAll(/\d+/g)].map((d) => Number(d[0]))
  expect(majors.length, 'CI matrix parsed to zero Node versions').toBeGreaterThan(0)
  return majors
}

function floorFromPackage() {
  const pkg = JSON.parse(read('package.json'))
  expect(
    pkg.engines && pkg.engines.node,
    'package.json has no engines.node — the supported Node is stated nowhere machine-readable'
  ).toBeTruthy()
  return enginesFloor(pkg.engines.node)
}

// Requirement-shaped statements only: "Node 20+", "Node.js 20+",
// "Node 20 or later". A bare mention ("CI runs them on Node 20 and 22") is
// the tested SET, not the floor, and must not be flagged.
const REQUIREMENT = /node(?:\.js)? +(\d+)(?:\.\d+)*(?: *\+| +or +later)/gi

const requirementMajors = (text) =>
  [...text.matchAll(REQUIREMENT)].map((m) => Number(m[1]))

// Body of a section: from the END of its heading line to the next heading of
// the same level or shallower (searching from the heading itself would match
// position 0 and return an empty slice). Literal regexes at the call sites.
const throughNextHeading = (text, from) => {
  const lineEnd = text.indexOf('\n', from)
  const rest = text.slice(lineEnd === -1 ? text.length : lineEnd + 1)
  const next = rest.search(/^#{2,3} +\S/m)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('node version truth', () => {
  test('engines floor equals the oldest major CI tests', () => {
    const floor = floorFromPackage()
    const majors = matrixMajors()
    expect(
      floor,
      `engines floor is ${floor} but the oldest CI-tested major is ${Math.min(...majors)} — a floor below the matrix claims support nothing tests; a floor above it makes CI test unsupported versions`
    ).toBe(Math.min(...majors))
  })

  test('every major CI tests satisfies the engines range', () => {
    const floor = floorFromPackage()
    for (const major of matrixMajors()) {
      expect(
        major >= floor,
        `CI tests Node ${major}, which is below the engines floor ${floor} — CI would grade a version the package refuses`
      ).toBe(true)
    }
  })

  test('entry docs and installer all state the engines floor', () => {
    const floor = floorFromPackage()
    const surfaces = [
      ['README.md', read('README.md')],
      ['CONTRIBUTING.md', read('CONTRIBUTING.md')],
      ['tools/install.sh', read('tools/install.sh')],
    ]
    for (const [file, text] of surfaces) {
      const stated = requirementMajors(text)
      expect(stated.length, `${file} states no Node requirement at all`).toBeGreaterThan(0)
      const wrong = [...new Set(stated.filter((v) => v !== floor))]
      expect(
        wrong,
        `${file} states Node ${wrong.join(', ')} as a requirement but the engines floor is ${floor}`
      ).toEqual([])
    }
  })

  test('both quick starts state the floor, and the installer enforces it', () => {
    const floor = floorFromPackage()
    const readme = read('README.md')
    const contributing = read('CONTRIBUTING.md')

    const manualAt = readme.search(/^### +Manual *$/m)
    expect(manualAt, 'README has no "### Manual" quick start').toBeGreaterThanOrEqual(0)
    expect(
      requirementMajors(throughNextHeading(readme, manualAt)).length,
      'README Manual quick start states no Node requirement — a stranger on the wrong Node learns it from a compile error instead'
    ).toBeGreaterThan(0)

    const quickAt = contributing.search(/^## +Quick start *$/m)
    expect(quickAt, 'CONTRIBUTING has no "## Quick start" section').toBeGreaterThanOrEqual(0)
    expect(
      requirementMajors(throughNextHeading(contributing, quickAt)).length,
      'CONTRIBUTING Quick start states no Node prerequisite'
    ).toBeGreaterThan(0)

    const installer = read('tools/install.sh')
    const enforced = [...installer.matchAll(/-lt +(\d+)/g)].map((m) => Number(m[1]))
    expect(enforced.length, 'tools/install.sh enforces no minimum Node version (-lt)').toBeGreaterThan(0)
    for (const major of enforced) {
      expect(
        major,
        `tools/install.sh enforces Node >= ${major} but the engines floor is ${floor} — the installer would ship a version nothing tests`
      ).toBe(floor)
    }
  })

  test('README points contributors at CONTRIBUTING.md', () => {
    expect(
      /CONTRIBUTING\.md/.test(read('README.md')),
      'README never mentions CONTRIBUTING.md — the contributor guide is unreachable from the front door'
    ).toBe(true)
  })
})
