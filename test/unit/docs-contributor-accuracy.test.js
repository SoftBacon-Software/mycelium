// =============== DOCS CONTRIBUTOR ACCURACY TEST ===============
// Drift-catcher: CONTRIBUTING.md and test/README.md must tell a first-time
// contributor the truth about the linter and the test layout.
//
// HISTORY: these docs once claimed a Biome config (`biome.json`) that did not
// exist, said "lint is not run in CI" while CI does run eslint, and pointed
// contributors at `test/integration/` and `test/helpers/` directories that do
// not exist. If any of those statements come back, this test goes red. Mirrors
// the read-and-assert style of test/smoke/license-and-version.test.js.

import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

describe('contributor docs accuracy', () => {
  // --- the real state of the world: the linter ---
  test('the linter is ESLint (eslint.config.js); Biome is not configured', () => {
    expect(existsSync(join(REPO_ROOT, 'eslint.config.js'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'biome.json'))).toBe(false)
  })

  // --- the real state of the world: the test layout ---
  test('test layout is smoke/ + unit/ + refactor/ (no integration/ or helpers/)', () => {
    for (const dir of ['smoke', 'unit', 'refactor']) {
      expect(existsSync(join(REPO_ROOT, 'test', dir))).toBe(true)
    }
    for (const dir of ['integration', 'helpers']) {
      expect(existsSync(join(REPO_ROOT, 'test', dir))).toBe(false)
    }
  })

  // --- CI actually runs eslint ---
  test('CI runs an eslint lint step (npm run lint)', () => {
    const wf = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'test.yml'),
      'utf8',
    )
    expect(wf).toMatch(/Lint \(eslint\)/)
    expect(wf).toMatch(/npm run lint/)
  })

  // --- CONTRIBUTING.md must not re-state the old lies ---
  test('CONTRIBUTING.md does not claim Biome or say lint is off in CI', () => {
    const text = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
    expect(text).not.toMatch(/biome\.json/i)
    expect(text).not.toMatch(/not run in CI/)
  })

  // --- test/README.md must not point at nonexistent dirs ---
  test('test/README.md does not reference integration/ or helpers/', () => {
    const text = readFileSync(join(REPO_ROOT, 'test', 'README.md'), 'utf8')
    expect(text).not.toMatch(/integration\//)
    expect(text).not.toMatch(/helpers\//)
  })
})
