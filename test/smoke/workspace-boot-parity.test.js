// Workspace boot-smoke parity gate.
//
// package.json `workspaces` lists four shipped packages — mcp, runner,
// printer-drone, sdk — each with an `index.js` entrypoint and a `start:*`
// script. The convention this gate enforces (established by the existing boot
// smokes and documented here) is:
//
//   Every workspace `W` MUST ship a boot smoke at
//   `test/smoke/${W}-boot-smoke.test.js`
//   that contains real vitest test calls (describe/test).
//
// Why: a workspace entrypoint that no test ever boots regresses silently — a
// stranger's first `npm run start:<w>` is the untested path (see the mcp
// regression documented in mcp-boot-smoke.test.js: `npm run start:mcp` crashes
// on master and nothing caught it). This gate makes "a new workspace with no
// boot smoke" a RED the moment it's added to package.json, without a
// hand-maintained allowlist that would rot.
//
// This gate is deliberately structural (does the smoke FILE exist and does it
// contain tests?) — it does not re-run the smokes. Each smoke is responsible for
// asserting its own entrypoint's boot behavior; this just guarantees one exists
// per workspace, by a single derived convention.

import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const PKG_PATH = join(REPO_ROOT, 'package.json')
const SMOKE_DIR = join(REPO_ROOT, 'test', 'smoke')

// Read workspaces from the LIVE package.json (not a snapshot): a workspace added
// tomorrow with no smoke auto-fails here without editing any list in this file.
function readWorkspaces() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
  // package.json workspaces is an array of dir names in this repo.
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : []
}

describe('workspace boot-smoke parity', () => {
  // Snapshot the live workspace list once so a failure names every offending
  // workspace, not just the first.
  const workspaces = readWorkspaces()

  test('package.json declares the expected workspace set (guard against silent reshuffle)', () => {
    // If the workspace set itself changes, this assertion forces a human to look
    // — and to add/remove the matching boot smoke — rather than the parity gate
    // quietly passing over a different set.
    expect(workspaces.sort()).toEqual(['mcp', 'printer-drone', 'runner', 'sdk'].sort())
  })

  test.each(workspaces)(
    'workspace "%s" ships a boot smoke at test/smoke/<workspace>-boot-smoke.test.js',
    (workspace) => {
      const smokeFile = join(SMOKE_DIR, `${workspace}-boot-smoke.test.js`)
      expect(existsSync(smokeFile),
        `workspace "${workspace}" is in package.json workspaces but has NO boot smoke at ${smokeFile}. ` +
          `Add one (mirror runner-boot-smoke.test.js) so its entrypoint boot is covered.`).toBe(true)

      // The file must contain real test calls — an empty placeholder must not
      // satisfy the gate (a check that cannot fail is not a check).
      const contents = readFileSync(smokeFile, 'utf-8')
      expect(contents,
        `${smokeFile} exists but declares no tests — a boot smoke must actually assert boot behavior.`).toMatch(/\b(test|it)\s*\(/)
    },
  )
})
