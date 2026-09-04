import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  extractRefs,
  splitSections,
  deriveDeclaredNames,
  findExternalRepoUrls,
  isMonorepoUrl,
} from '../../tools/npm-identity.mjs'

// Package-name identity gate — the network-free half of tools/npm-identity.mjs.
//
// tools/npm-identity.mjs asks the live registry whether the names our entry
// docs teach resolve to US; it is a maintainer tool, not CI (registry flake
// has no place in the test gate). This file gates what CI CAN see:
//
//   1. Every bare package name README presents with an install/run
//      instruction is either a package this repo declares, or the section
//      teaching it explicitly marks it external (links a github repo that is
//      not the monorepo). This is the gate that catches the 2026-08 shape of
//      the rot: README teaching `mycelium-mcp` — a name npm resolves to a
//      SEPARATE repo's older client — with nothing marking it external.
//   2. The in-repo MCP server's package identity cannot collide: mcp/ declares
//      `mycelium-mcp-server`, and nothing in-repo claims the bare
//      `mycelium-mcp` npm name.
//   3. The MCP tool count README states is DERIVED from mcp/src/tools.js at
//      test time — a number in the entry docs that no gate derives is how the
//      "~79" drifted in the first place.
//
// Derivation is shared with the tool (imported above), never re-implemented
// here. Pattern follows test/unit/readme-names-shipped-packages.test.js:
// derive from source on every run, nothing hardcoded.

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
const mcpReadme = readFileSync(join(REPO_ROOT, 'mcp', 'README.md'), 'utf8')
const mcpPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'mcp', 'package.json'), 'utf8'))
const declared = deriveDeclaredNames()

function sectionOf(text, sectionStartLine) {
  return splitSections(text).find((s) => s.startLine === sectionStartLine)
}

// ---------------------------------------------------------------------------
// Parser self-tests. The identity assertions below are only as good as
// extractRefs; these pin the shapes that exist in the entry docs today so a
// parser regression cannot silently vacate the gate (the "check that cannot
// fail" failure mode — a green gate that reads nothing).
// ---------------------------------------------------------------------------

describe('extractRefs parses the shapes the entry docs use', () => {
  const FIXTURE = [
    '# Doc',
    '',
    '## Install',
    '',
    '```bash',
    'npm install mycelium-agent-sdk',
    'npx -y some-pkg@latest',
    'npm install -g global-pkg',
    'npm install',
    '```',
    '',
    'Run `npm install mycelium-mcp` to fetch the wrong thing.',
    '',
    '## Packages',
    '',
    '| Package | Path | Description |',
    '|---------|------|-------------|',
    '| `first-pkg` | `a/` | one |',
    '| `second-pkg` | `b/` | two |',
    '| `@scope/third` | `c/` | three |',
    '',
    '## Environment variables',
    '',
    '| Variable | Required | Description |',
    '|----------|----------|-------------|',
    '| `not-a-package` | yes | must not be extracted |',
  ].join('\n')

  const refs = extractRefs(FIXTURE, 'FIXTURE.md')
  const names = refs.map((r) => r.name)

  test('extracts an idiom inside a fenced block', () => {
    expect(names).toContain('mycelium-agent-sdk')
  })

  test('strips a version suffix and the -y flag from npx', () => {
    expect(names).toContain('some-pkg')
  })

  test('strips the -g flag from npm install -g', () => {
    expect(names).toContain('global-pkg')
  })

  test('bare `npm install` with no name extracts nothing', () => {
    // one ref per taught name; the bare install must not add an unnamed entry
    const installRefs = refs.filter((r) => r.kind === 'idiom')
    expect(installRefs.length).toBe(4) // 3 in the fence + 1 mid-prose
  })

  test('extracts an idiom written mid-prose in backticks', () => {
    const midProse = refs.find((r) => r.name === 'mycelium-mcp')
    expect(midProse, 'mid-prose `npm install x` must be seen').toBeTruthy()
    expect(midProse.kind).toBe('idiom')
  })

  test('every row of a Package table is extracted — not just the first', () => {
    expect(names).toContain('first-pkg')
    expect(names).toContain('second-pkg')
    expect(names).toContain('@scope/third')
  })

  test('a non-Package table (env vars, plugins, options) is never parsed', () => {
    expect(names).not.toContain('not-a-package')
    expect(names).not.toContain('Variable')
  })
})

describe('isMonorepoUrl anchors the monorepo against its siblings', () => {
  test('the monorepo passes', () => {
    expect(isMonorepoUrl('git+https://github.com/SoftBacon-Software/mycelium.git')).toBe(true)
    expect(isMonorepoUrl('https://github.com/SoftBacon-Software/mycelium')).toBe(true)
  })

  test('sibling repos do NOT — the collision this gate exists for was a sibling', () => {
    expect(isMonorepoUrl('git+https://github.com/SoftBacon-Software/mycelium-mcp.git')).toBe(false)
    expect(isMonorepoUrl('git+https://github.com/SoftBacon-Software/mycelium-app.git')).toBe(false)
    expect(isMonorepoUrl('git+https://github.com/SoftBacon-Software/mycelium-lab.git')).toBe(false)
    expect(isMonorepoUrl(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate 1 — README identity, network-free: declared-here or marked-external.
// ---------------------------------------------------------------------------

describe('README package names are declared here or explicitly external', () => {
  const refs = extractRefs(readme, 'README.md')

  test('the gate still has something to read (idiom + table refs present)', () => {
    // If a docs rewrite empties either surface, this fails loud instead of
    // green-vacating the assertions below.
    expect(refs.some((r) => r.kind === 'idiom'), 'README teaches at least one install/run idiom').toBe(true)
    expect(refs.some((r) => r.kind === 'table'), 'README still has a Packages table').toBe(true)
  })

  for (const ref of refs) {
    test(`${ref.name} (${ref.kind} at README line ${ref.line})`, () => {
      const okDeclared = declared.has(ref.name)
      const section = sectionOf(readme, ref.sectionStartLine)
      const markedExternal = section ? findExternalRepoUrls(section.text).length > 0 : false
      expect(
        okDeclared || markedExternal,
        okDeclared
          ? 'declared by this repo'
          : `"${ref.name}" is not a package of this repo and the "${section ? section.heading : '?'}" section does not mark it external — a stranger installing it gets someone else's code (see tools/npm-identity.mjs for the live-registry half)`
      ).toBe(true)
    })
  }

  test('Packages table rows agree with the dirs they name', () => {
    for (const ref of refs.filter((r) => r.kind === 'table')) {
      if (ref.path && !ref.path.includes('/') && declared.has(ref.name)) {
        expect(declared.get(ref.name), `row binds "${ref.name}" to ${ref.path}/`).toBe(ref.path)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — the in-repo MCP server cannot collide with the npm name.
// ---------------------------------------------------------------------------

describe('the in-repo MCP server package identity cannot collide', () => {
  test('mcp/ declares mycelium-mcp-server, not the npm-colliding bare name', () => {
    expect(mcpPkg.name).toBe('mycelium-mcp-server')
    // The bare name is a SEPARATE repo's published client. Nothing of ours may
    // claim it — reverting the rename turns this red before docs can follow.
    expect(mcpPkg.name, 'the bare npm name belongs to SoftBacon-Software/mycelium-mcp').not.toBe('mycelium-mcp')
  })

  test('no workspace dir declares the colliding bare name', () => {
    expect(declared.has('mycelium-mcp')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate 3 — the MCP tool count is derived, not remembered.
// ---------------------------------------------------------------------------

const TOOLS_JS = readFileSync(join(REPO_ROOT, 'mcp', 'src', 'tools.js'), 'utf8')

// Core tools = registerDual call sites (each registers exactly one mycelium_*
// tool; the studio_* aliases were removed — see the comment at the top of
// tools.js). Plugin tools are runtime-discovered via registerPluginTools and
// deliberately NOT counted: the number depends on the instance.
function deriveCoreToolCount() {
  const calls = TOOLS_JS.match(/\bregisterDual\(server\b/g) || []
  return calls.length
}

// Numbers stated in prose about the MCP tool surface, e.g.
// "79 core `mycelium_*` tools" or "# MCP server (79 core tools + plugin tools)".
function toolCountClaims(text) {
  const claims = []
  const re = /(\d+)\s+(?:core\s+)?(?:`mycelium_\*`\s+)?tools/gi
  let m
  while ((m = re.exec(text)) !== null) claims.push(Number(m[1]))
  return claims
}

describe('the documented MCP tool count is derived from tools.js', () => {
  const count = deriveCoreToolCount()

  test('derivation is alive (registerDual call sites exist)', () => {
    expect(count, 'registerDual(server call sites in mcp/src/tools.js').toBeGreaterThan(0)
  })

  for (const [doc, text] of [['README.md', readme], ['mcp/README.md', mcpReadme]]) {
    const claims = toolCountClaims(text)

    test(`${doc} states the MCP tool count (deleting the claim fails loud)`, () => {
      expect(claims.length, `tool-count claim found in ${doc}`).toBeGreaterThan(0)
    })

    test(`${doc} tool count equals the derived core tool count (${count})`, () => {
      for (const claimed of claims) {
        expect(
          claimed,
          `${doc} claims ${claimed} tools; mcp/src/tools.js registers ${count} core tools — re-derive, then update the docs (or this gate) with the new number`
        ).toBe(count)
      }
    })
  }
})
