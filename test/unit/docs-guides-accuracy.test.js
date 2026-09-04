// =============== DOCS GUIDES ACCURACY TEST (brief 09) ===============
// Drift-catcher for the contributor-facing guides under docs/. A new agent or
// plugin author reads these to learn the platform, so a stale claim here sends
// them down a dead path. Mirrors the read-and-assert style of
// test/unit/docs-contributor-accuracy.test.js.
//
// Invariants, all derived from the actual source:
//  (1) docs/getting-started-agent.md must not tell a new agent that being idle
//      earns them a DIRECTIVE. Auto-dispatch IS real
//      (server/routes/mycelium.js `dispatchWorkToIdleAgents`) — it assigns
//      unassigned TASKS and PLAN STEPS to idle agents — but it does not create
//      directives, and directives are a deprecated work-queue source
//      (server/db.js buildWorkQueue: "Directives are DEPRECATED (2026-06-05)").
//      The guide once said "the system may send you a directive with a work
//      assignment"; that conflation must not come back.
//  (2) docs/plugin-guide.md must not point at a plugin directory that does not
//      exist. The set of real plugin dirs is read from the filesystem, and every
//      server/plugins/<name>/ path the guide names must resolve. (It used to
//      point at build-in-public/, which was folded into marketing/.)
//  (3) every mycelium_* tool named in docs/getting-started-agent.md must be a
//      tool this repo's MCP server actually registers. The registry is derived
//      from the registration call sites in mcp/src/tools.js (registerDual
//      rewrites a legacy studio_* prefix; server.tool names count directly), so
//      the gate tracks the code rather than a hand-kept list. The guide once
//      taught tool names the server did not have; and when the registry moves,
//      only this catches the guide rotting behind it. Plugin tools are
//      discovered at runtime and are deliberately out of scope: the guide
//      teaches core tools only.
//  (4) docs/getting-started-agent.md must not present directives as a live
//      work-queue source. buildWorkQueue does not serve directives at all
//      (`void directives`) — work is pull-claimed, and pending requests are the
//      top of the queue. Invariant (1) only banned the auto-dispatch
//      conflation; this one bans the queue-PRIORITY framing ("Directives —
//      Blocking. Handle these first, always." / "Directives first."), which
//      used to pass straight through (1) untouched.
//  (5) docs/getting-started-agent.md must be reachable. Both entry paths carry
//      the canonical link — README.md for an agent joining a network,
//      CONTRIBUTING.md for a contributor orienting here — because a guide no
//      entry doc links is a guide nobody finds.

import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

// The set of plugin directories that actually exist on disk (minus the scaffold).
function pluginDirNames() {
  const dir = join(REPO_ROOT, 'server', 'plugins')
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

// The core MCP tool registry, read out of the registration call sites in
// mcp/src/tools.js. registerDual(server, 'studio_x', ...) registers the same
// tool under both studio_x and mycelium_x (the prefix is rewritten at
// mcp/src/tools.js registerDual), and a direct server.tool('mycelium_x', ...)
// registration is possible too, so both shapes feed the set. This is the
// guide's vocabulary: every tool the guide names must be in here. Runtime
// plugin tools are invisible to a static read and are intentionally excluded.
function coreMcpToolNames() {
  const src = read('mcp/src/tools.js')
  const names = [...src.matchAll(/registerDual\(server,\s*'([a-z0-9_]+)'/g)].map(
    (m) => m[1].replace(/^studio_/, 'mycelium_'),
  )
  for (const m of src.matchAll(/server\.tool\(\s*'(mycelium_[a-z0-9_]+)'/g)) {
    names.push(m[1])
  }
  return new Set(names)
}

describe('docs/ guides accuracy', () => {
  // --- (1) getting-started-agent.md: the auto-dispatch model ---
  test('getting-started-agent.md does not claim auto-dispatch sends a directive', () => {
    const text = read('docs/getting-started-agent.md')
    // The platform assigns tasks/plan-steps to idle agents; it does not send a
    // directive. Directives are deprecated as a work-queue source.
    expect(
      text,
      'guide must not say the system / auto-dispatch sends a directive',
    ).not.toMatch(/(auto-dispatch|system may)[^.]*\bsend you a directive\b/i)
    expect(text).not.toMatch(/directives?[^.]*\bfrom auto-dispatch\b/i)
  })

  test('getting-started-agent.md still describes auto-dispatch (it is a real feature)', () => {
    // Guard against over-correction: auto-dispatch IS real, so the guide should
    // still mention it — accurately, as a task/plan-step assignment.
    const text = read('docs/getting-started-agent.md')
    expect(text).toMatch(/auto-dispatch/i)
  })

  // --- (3) getting-started-agent.md: the tool vocabulary is real ---
  test('every mycelium_* tool named in getting-started-agent.md is a registered core tool', () => {
    const text = read('docs/getting-started-agent.md')
    const registry = coreMcpToolNames()

    expect(
      registry.size,
      'registry derivation found too few tools — the registration ' +
        'pattern in mcp/src/tools.js moved and this gate is now blind',
    ).toBeGreaterThan(50)

    const named = [...text.matchAll(/mycelium_[a-z0-9_]+/g)].map((m) => m[0])
    expect(named.length, 'guide must name at least one tool').toBeGreaterThan(0)

    const ghosts = [...new Set(named)].filter((t) => !registry.has(t))
    expect(
      ghosts,
      'getting-started-agent.md teaches tool(s) this server does not ' +
        'register — an agent following the guide error-calls on its first ' +
        'session: ' +
        ghosts.join(', '),
    ).toEqual([])
  })

  // --- (4) getting-started-agent.md: directives are not a work source ---
  test('getting-started-agent.md does not rank directives in the live work queue', () => {
    const text = read('docs/getting-started-agent.md')
    // buildWorkQueue never serves directives (`void directives`): work is
    // pull-claimed, and pending requests sit at the top. None of these framings
    // may return. Note the first two landed regexes above only catch the
    // auto-dispatch conflation — this is the broader queue-priority ban.
    expect(
      text,
      'guide must not rank directives first in the work queue',
    ).not.toMatch(/\bdirectives?\s+first\b/i)
    expect(
      text,
      'guide must not tell a new agent to handle directives first/immediately',
    ).not.toMatch(/\bhandle (these|it|them|directives?) (first|immediately)\b/i)
    expect(
      text,
      'guide must not open a numbered priority list with a Directives entry',
    ).not.toMatch(/^\s*\d+\.\s*\*\*Directives?\*\*\s*[—-]/m)
    // Positive pin: the guide must still SAY the live model, so the topic
    // cannot be "fixed" by silently dropping it.
    expect(
      text,
      'guide must state that directives are deprecated as a work source',
    ).toMatch(/\bdirectives?\b[^.\n]{0,80}\bdeprecated\b/i)
  })

  // --- (5) getting-started-agent.md: reachability from the entry docs ---
  test('getting-started-agent.md is linked from README.md and CONTRIBUTING.md', () => {
    // Both canonical entry paths must reference the guide. An onboarding guide
    // nothing links is a guide nobody finds — which is exactly the state this
    // file was found in.
    expect(
      read('README.md'),
      'README.md must link docs/getting-started-agent.md',
    ).toMatch(/getting-started-agent\.md/)
    expect(
      read('CONTRIBUTING.md'),
      'CONTRIBUTING.md must link docs/getting-started-agent.md',
    ).toMatch(/getting-started-agent\.md/)
  })

  // --- (2) plugin-guide.md: every referenced plugin dir must exist ---
  test('every server/plugins/<name>/ path in plugin-guide.md exists on disk', () => {
    const text = read('docs/plugin-guide.md')
    const real = new Set(pluginDirNames())
    expect(real.size, 'plugin dir list must be non-empty').toBeGreaterThan(0)

    const referenced = [...text.matchAll(/server\/plugins\/([A-Za-z0-9_-]+)\//g)]
      .map((m) => m[1])
    expect(
      referenced.length,
      'guide must reference at least one plugin dir',
    ).toBeGreaterThan(0)

    const missing = referenced.filter(
      (name) => !real.has(name) && name !== '_template',
    )
    expect(
      missing,
      'plugin-guide.md references non-existent plugin dir(s): ' + missing.join(', '),
    ).toEqual([])
  })

  test('plugin-guide.md no longer points at the folded build-in-public/ plugin', () => {
    // build-in-public was folded into marketing/. A dead pointer here sends a
    // plugin author to a directory that does not exist.
    const text = read('docs/plugin-guide.md')
    expect(text).not.toMatch(/server\/plugins\/build-in-public\//)
  })
})
