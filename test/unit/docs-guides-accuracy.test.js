// =============== DOCS GUIDES ACCURACY TEST (brief 09) ===============
// Drift-catcher for the contributor-facing guides under docs/. A new agent or
// plugin author reads these to learn the platform, so a stale claim here sends
// them down a dead path. Mirrors the read-and-assert style of
// test/unit/docs-contributor-accuracy.test.js.
//
// Two invariants, both derived from the actual source:
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
