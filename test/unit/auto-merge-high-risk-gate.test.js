import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = path.resolve(__dirname, '..', '..', '.github', 'workflows')
const BOT_PATH = path.join(WORKFLOWS_DIR, 'auto-merge-low-risk.yml')

// ---------------------------------------------------------------------------
// Layer 1 — the .github classification gate (landed in c42678d).
//
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
//
// The bot itself has since been RETIRED (the workflow file deleted), so these
// tests pass vacuously when the file is absent — absence is the green state.
// They stay so a reintroduction of the file with the OLD classification
// (the pre-c42678d shape) still trips them.
// ---------------------------------------------------------------------------

// Slice out one of the two pattern arrays as raw text.
function block(wf, varName) {
  const m = wf.match(new RegExp(`const ${varName} = \\[([\\s\\S]*?)\\];`))
  expect(m, `${varName} array must exist in the workflow`).toBeTruthy()
  return m[1]
}

describe('auto-merge low-risk gate (classification — c42678d)', () => {
  test('.github is NOT in lowRiskPatterns', () => {
    if (!existsSync(BOT_PATH)) return // retired — the merge-safety layer covers reintroduction
    const wf = readFileSync(BOT_PATH, 'utf8')
    const low = block(wf, 'lowRiskPatterns')
    // A workflow-only PR (this very file, or test.yml) must be rejected from
    // auto-merge, so .github must NOT satisfy the low-risk clause.
    expect(low.includes('.github'), '.github must not be classified low-risk').toBe(false)
  })

  test('.github IS in highRiskPatterns', () => {
    if (!existsSync(BOT_PATH)) return // retired — the merge-safety layer covers reintroduction
    const wf = readFileSync(BOT_PATH, 'utf8')
    const high = block(wf, 'highRiskPatterns')
    // ...and MUST trip the high-risk guard (accepts /^\.github\// or the
    // narrower /^\.github\/workflows\//).
    expect(high, '.github must be classified high-risk').toContain('.github')
  })

  test('approval body has no malformed nested interpolation', () => {
    if (!existsSync(BOT_PATH)) return // retired — nothing approves anything
    const wf = readFileSync(BOT_PATH, 'utf8')
    // The auto-approve body once read `all ${${{ steps.check.outputs... }}}`
    // — Actions ${{ }} nested inside a JS ${ }. It happened to evaluate
    // (Actions substitutes the count first, leaving ${5}) but is fragile and
    // wrong-looking. The fixed body hoists the Actions expression out of the
    // template literal, so the broken `${${{` sequence must be gone.
    expect(wf).not.toContain('${${{')
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — the merge-safety gate (behaviour, not filenames).
//
// The classification fix in c42678d closed the supply-chain hole, but the bot
// itself kept: self-approving and squash-merging with no ACTOR gate, no wait
// for green CI, `Dockerfile`/`railway.json`/`public/` classed LOW-risk (and
// jetson deploys FROM git, so an auto-merged change ships on the next deploy),
// and dead classifier patterns for trees retired in June 2026. Those are
// properties of what the bot DOES, not of which file does it — so this layer
// scans every workflow under `.github/workflows/` at test time and fails on
// the behaviour wherever it reappears, under whatever filename.
//
// The spec any PR-merging workflow must meet (the fallback spec, if a bot is
// ever wanted again):
//   1. ACTOR GATE — an allowlist check on context.actor / user.login before
//      any approve or merge call.
//   2. GREEN CI — the merge waits for check conclusions
//      (listCheckRuns / check_run / check_suite / workflow_run / conclusion)
//      or uses GitHub native auto-merge (enablePullRequestAutoMerge), which
//      enforces required checks. Merging straight out of an `opened` trigger
//      races the Tests workflow.
//   3. NO SELF-APPROVAL — a workflow posting its own APPROVE review defeats
//      required reviews and trains merge-on-bot-signal.
//   4. DEPLOY-CRITICAL PATHS ARE NOT LOW-RISK — Dockerfile, railway.json and
//      public/ ship on the next deploy or are what strangers read.
//   5. NO DEAD PATTERNS — trees retired from the repo leave the classifier.
//
// A workflow that does not touch PR approvals/merges at all (test.yml) is out
// of scope entirely. The fixtures below prove the gate is content-sensitive
// in both directions: a hardened bot passes, the same file with one guard
// deleted fails.
// ---------------------------------------------------------------------------

const MERGE_SIGNAL = /pulls\.merge\s*\(|merge_method\s*:/
const APPROVE_SIGNAL = /pulls\.createReview[\s\S]*?['"]APPROVE['"]/
const ACTOR_GATE = /context\.actor|user\.login/
const GREEN_CI = /listCheckRuns|listForRef|check_run|check_suite|workflow_run|conclusion|enablePullRequestAutoMerge/
const DEPLOY_CRITICAL = [/Dockerfile/, /railway\.json/, /public\//]
const DEAD_PATTERNS = [/studio-react/, /public\/studio\//]

// Every low-risk classifier block in a workflow file, as raw text with
// backslashes stripped: the patterns live in the file as regex literals
// (`/^railway\.json$/`, `/^public\/.*\.html$/`), so matching the classifier's
// CONTENT has to be escape-agnostic or `railway\.json` hides `railway.json`.
function lowRiskBlocks(text) {
  const blocks = []
  const re = /lowRisk\w*\s*=\s*\[([\s\S]*?)\]/g
  let m
  while ((m = re.exec(text))) blocks.push(m[1].replace(/\\/g, ''))
  return blocks
}

// The invariants a workflow file violates, as human-readable findings. Empty
// array = compliant (or not a PR-merging workflow at all).
function mergeSafetyFindings(text) {
  const findings = []
  const touchesMerges = MERGE_SIGNAL.test(text) || APPROVE_SIGNAL.test(text)
  if (!touchesMerges) return findings

  if (!ACTOR_GATE.test(text)) {
    findings.push(
      'no actor gate: any same-repo PR (maintainer branch, any bot with push ' +
      'access) is approved/merged with zero human review — require an ' +
      'allowlist check on context.actor / user.login before any approve/merge'
    )
  }
  if (!GREEN_CI.test(text)) {
    findings.push(
      'no green-CI wait: the merge can land before the Tests workflow ' +
      'finishes (CONTRIBUTING promises every PR runs the suite) — wait on ' +
      'check conclusions or use GitHub native auto-merge over required checks'
    )
  }
  if (APPROVE_SIGNAL.test(text)) {
    findings.push(
      'self-approves the PR: a workflow posting its own APPROVE review ' +
      'defeats required reviews — drop the auto-approve step entirely and ' +
      'satisfy reviews via GitHub native auto-merge'
    )
  }

  const low = lowRiskBlocks(text).join('\n')
  if (low) {
    if (DEPLOY_CRITICAL.some(p => p.test(low))) {
      findings.push(
        'deploy-critical paths classed low-risk: Dockerfile / railway.json / ' +
        'public/ auto-merge unreviewed and ship on the next deploy (jetson ' +
        'deploys FROM git) — move them to highRiskPatterns'
      )
    }
    if (DEAD_PATTERNS.some(p => p.test(low))) {
      findings.push(
        'dead patterns still in the low-risk classifier: studio-react/ and ' +
        'public/studio/ were retired June 2026 — the classifier is unmaintained'
      )
    }
  }
  return findings
}

// Read every workflow file actually present in a directory — the real
// `.github/workflows/` tree by default, a fixture dir for the bites.
function scanWorkflows(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map(f => ({ name: f, text: readFileSync(path.join(dir, f), 'utf8') }))
}

describe('no workflow under .github/workflows/ self-merges pull requests', () => {
  // Read the REAL tree at test time — the gate is on behaviour, so wherever a
  // PR-merging workflow reappears (this one, a renamed one, a new one), these
  // fire. Each invariant is its own test so each residual trips on its own.
  const files = scanWorkflows(WORKFLOWS_DIR)
  const scanned = files.map(f => ({ name: f.name, findings: mergeSafetyFindings(f.text) }))
  // Report the finding that matched THIS marker, not the file's first finding.
  const tripped = marker =>
    scanned.flatMap(f =>
      f.findings.filter(m => m.startsWith(marker)).map(m => `${f.name}: ${m}`)
    )

  test('the gate reads the real workflow tree, not a hardcoded list', () => {
    expect(files.length, 'no workflow files found — is .github/workflows/ there?').toBeGreaterThan(0)
  })

  test('every PR-merging workflow has an actor allowlist gate', () => {
    expect(
      tripped('no actor gate'),
      'workflow(s) approve/merge PRs without any actor check'
    ).toEqual([])
  })

  test('every PR-merging workflow waits for green CI before merging', () => {
    expect(
      tripped('no green-CI wait'),
      'workflow(s) merge PRs without waiting on check conclusions'
    ).toEqual([])
  })

  test('no workflow posts its own APPROVE review', () => {
    expect(
      tripped('self-approves the PR'),
      'workflow(s) self-approve the PR they then merge'
    ).toEqual([])
  })

  test('no classifier marks deploy-critical paths low-risk', () => {
    expect(
      tripped('deploy-critical paths classed low-risk'),
      'workflow(s) auto-merge deploy-critical files unreviewed'
    ).toEqual([])
  })

  test('no classifier carries dead patterns for retired trees', () => {
    expect(
      tripped('dead patterns still in the low-risk classifier'),
      'workflow(s) still classify trees that no longer exist'
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — fixture bites: the gate is content-sensitive in BOTH directions.
//
// These run against hermetic per-test fixture dirs (never the real tree), so
// the behaviour gate is proven to read workflow CONTENT — not a filename ban,
// and not the presence/absence of one historical file. The hardened fixture
// is the fallback spec, in file form, for whenever agent-PR auto-merge is
// wanted again.
// ---------------------------------------------------------------------------

// The fallback spec as a workflow: actor allowlist, green-CI wait, no
// self-approval. Classifier blocks get appended separately by the fixtures
// that need one.
const HARDENED_BOT = `name: Auto-merge sanctioned-bot PRs

on:
  workflow_run:
    workflows: [Tests]
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  merge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const ALLOWED_ACTORS = ['greatness', 'm5max-release-bot'];
            if (!ALLOWED_ACTORS.includes(context.actor)) {
              core.info('actor not on the allowlist - no auto-merge');
              return;
            }
            const { data: checks } = await github.rest.checks.listForRef({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: context.payload.workflow_run.head_sha,
            });
            if (!checks.check_runs.every(c => c.conclusion === 'success')) {
              core.info('checks not green - no auto-merge');
              return;
            }
            await github.rest.pulls.merge({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: 1,
              merge_method: 'squash',
            });
`

// A low-risk classifier limited to genuinely low-risk paths, parked in a
// comment block (the scan reads classifier CONTENT wherever it appears).
const classifier = lines =>
  `// const lowRiskPatterns = [\n${lines.map(l => `//   ${l},`).join('\n')}\n// ];`
const CLEAN_CLASSES = classifier(['/^README\\.md$/', '/^docs\\//'])
const CLASSES_WITH_DOCKERFILE = classifier(['/^README\\.md$/', '/^docs\\//', '/^Dockerfile$/'])

// Today's-bot shape: self-approve + immediate squash, no actor gate, no CI
// wait, deploy-critical and dead patterns in the low-risk classifier.
const MASTER_BOT = `name: Auto-merge low-risk PRs

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write
  pull-requests: write

jobs:
  check-and-merge:
    runs-on: ubuntu-latest
    steps:
      - name: Check if PR is low-risk
        uses: actions/github-script@v7
        with:
          script: |
            const lowRiskPatterns = [
              /^studio-react\\//,
              /^public\\/studio\\//,
              /^public\\/.*\\.html$/,
              /^README\\.md$/,
              /^docs\\//,
              /^railway\\.json$/,
              /^Dockerfile$/,
            ];
      - name: Auto-approve low-risk PR
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.pulls.createReview({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number,
              event: 'APPROVE',
            });
      - name: Merge
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.pulls.merge({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number,
              merge_method: 'squash',
            });
`

// A DIFFERENT filename, same bad behaviour — proves the gate is not a ban on
// one file's name.
const GENERIC_SELF_MERGER = `name: Friendly squash

on:
  pull_request:
    types: [opened]

jobs:
  squash:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.pulls.merge({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number,
              merge_method: 'squash',
            });
`

const CI_ONLY_WORKFLOW = `name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`

let fixturesRoot

beforeAll(() => {
  fixturesRoot = path.join(__dirname, 'fixtures', 'auto-merge-gate')
  mkdirSync(fixturesRoot, { recursive: true })
})

afterAll(() => {
  rmSync(fixturesRoot, { recursive: true, force: true })
})

// Fresh fixture dir per call so scans never leak across tests.
function scanFixture(caseName, fileName, text) {
  const dir = path.join(fixturesRoot, caseName)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, fileName), text)
  return scanWorkflows(dir)
}

const allFindings = files => files.flatMap(f => mergeSafetyFindings(f.text))
const has = (findings, marker) => findings.some(m => m.startsWith(marker))

describe('merge-safety gate bites (hermetic fixtures)', () => {
  test('the hardened bot passes every invariant (positive control)', () => {
    const findings = allFindings(scanFixture('positive', 'hardened.yml', HARDENED_BOT + CLEAN_CLASSES))
    expect(findings, 'a compliant bot must pass the gate').toEqual([])
  })

  test('reintroducing the retired bot shape fails on every residual', () => {
    const findings = allFindings(scanFixture('reintroduced', 'bot.yml', MASTER_BOT))
    expect(has(findings, 'no actor gate'), 'actor-gate residual must trip').toBe(true)
    expect(has(findings, 'no green-CI wait'), 'CI-wait residual must trip').toBe(true)
    expect(has(findings, 'self-approves the PR'), 'self-approval residual must trip').toBe(true)
    expect(has(findings, 'deploy-critical paths'), 'deploy-critical residual must trip').toBe(true)
    expect(has(findings, 'dead patterns'), 'dead-pattern residual must trip').toBe(true)
  })

  test('deleting the actor check from the hardened bot fails (fallback bite)', () => {
    const withoutActor = HARDENED_BOT.replace(
      /const ALLOWED_ACTORS[\s\S]*?\}\n/,
      '// actor check deleted\n'
    )
    const findings = allFindings(scanFixture('no-actor', 'hardened.yml', withoutActor))
    expect(has(findings, 'no actor gate'), 'removing the actor check must trip the gate').toBe(true)
  })

  test('adding a deploy-critical path back to low-risk fails (fallback bite)', () => {
    const findings = allFindings(
      scanFixture('dockerfile-lowrisk', 'hardened.yml', HARDENED_BOT + CLASSES_WITH_DOCKERFILE)
    )
    expect(
      has(findings, 'deploy-critical paths'),
      'Dockerfile back in lowRisk must trip the gate'
    ).toBe(true)
  })

  test('a self-merging workflow under a different filename still fails', () => {
    const findings = allFindings(
      scanFixture('generic', 'totally-unrelated-name.yml', GENERIC_SELF_MERGER)
    )
    expect(has(findings, 'no actor gate')).toBe(true)
    expect(has(findings, 'no green-CI wait')).toBe(true)
  })

  test('a workflow that never touches PRs is out of scope (test.yml shape)', () => {
    const findings = allFindings(scanFixture('ci-only', 'ci.yml', CI_ONLY_WORKFLOW))
    expect(findings, 'a CI workflow that never merges PRs is not in scope').toEqual([])
  })
})
