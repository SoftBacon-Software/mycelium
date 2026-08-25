import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wfPath = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'auto-merge-low-risk.yml')
const wf = readFileSync(wfPath, 'utf8')

// The auto-merge bot squash-merges any PR whose changed files are ALL in
// lowRiskPatterns and NONE in highRiskPatterns (is_low_risk = allLowRisk &&
// !hasHighRisk). On a PUBLIC repo a GitHub Actions workflow runs with the
// repo's GITHUB_TOKEN and any secrets the workflow declares, so a PR that
// changes a file under .github/ is a supply-chain surface: it can exfiltrate
// secrets or silently weaken CI and must therefore require a human review,
// never auto-merge. These guards pin .github into the HIGH-risk block and
// OUT of the low-risk block — the same review bar the routes/schema/db files
// already get. Text assertions are stable here because the patterns are
// canonical regex-literal lines in the embedded script (same style as the
// docs-token gates).
//
// The low-risk and high-risk checks are separate tests so each fires on its
// own — a reverted classification shows BOTH halves red, not just the first.

// Slice out one of the two pattern arrays as raw text.
function block(varName) {
  const m = wf.match(new RegExp(`const ${varName} = \\[([\\s\\S]*?)\\];`))
  expect(m, `${varName} array must exist in the workflow`).toBeTruthy()
  return m[1]
}

describe('auto-merge low-risk gate', () => {
  test('.github is NOT in lowRiskPatterns', () => {
    const low = block('lowRiskPatterns')
    // A workflow-only PR (this very file, or test.yml) must be rejected from
    // auto-merge, so .github must NOT satisfy the low-risk clause.
    expect(low.includes('.github'), '.github must not be classified low-risk').toBe(false)
  })

  test('.github IS in highRiskPatterns', () => {
    const high = block('highRiskPatterns')
    // ...and MUST trip the high-risk guard (accepts /^\.github\// or the
    // narrower /^\.github\/workflows\//).
    expect(high, '.github must be classified high-risk').toContain('.github')
  })

  test('approval body has no malformed nested interpolation', () => {
    // The auto-approve body once read `all ${${{ steps.check.outputs... }}}`
    // — Actions ${{ }} nested inside a JS ${ }. It happened to evaluate
    // (Actions substitutes the count first, leaving ${5}) but is fragile and
    // wrong-looking. The fixed body hoists the Actions expression out of the
    // template literal, so the broken `${${{` sequence must be gone.
    expect(wf).not.toContain('${${{')
  })
})
