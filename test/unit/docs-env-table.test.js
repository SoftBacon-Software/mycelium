import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const SERVER_DIR = path.join(ROOT, 'server')

// ─────────────────────────────────────────────────────────────────────────────
// Env-docs parity gate.
//
// INVARIANT: every env var the SERVER reads must be discoverable from the docs
// a stranger reads before deploying — the README "## Environment" table and
// .env.example. A knob that exists only in source is a support ticket waiting
// to happen (someone enabling email, the GitHub proxy, host-allowlisting, …
// can't find the var without grepping). This test makes that impossible to ship.
//
// TRUTH IS DERIVED, NOT HARDCODED. The set of server-read keys is computed by
// scanning server/**/*.js for the read forms:
//     process.env.KEY        (dot)
//     process.env['KEY']     (bracket)
//     const { KEY } = process.env   (destructure)
// Keys follow the codebase's SCREAMING_SNAKE convention, so only [A-Z] keys are
// collected (this also matches the `process.env.<KEY>` idiom the task greps for).
//
// KNOWN BLIND SPOT: an env read indirected through a helper — e.g. a function
// called as fn(process.env) that then does env.KEY internally — is NOT seen by a
// static scan. If such a var is added, either read it directly at the call site
// or extend the derived set here. Do NOT weaken the assertions below to go green.
//
// ALLOW-LIST: keys that are genuinely internal/dev-only (not a deploy knob a
// stranger sets) are exempted from the docs requirement. Each entry MUST carry a
// justification and MUST still be read by the server (the "no dead allow-list
// entries" test below deletes stale ones automatically).
// ─────────────────────────────────────────────────────────────────────────────

const INTERNAL_ALLOW_LIST = {
  // Dev/test escape hatch only. When '1', webhook delivery may target
  // loopback/private hosts that the SSRF guard (assertPublicHost) would
  // otherwise block. Not a production knob; surfaced as internal in README so
  // it isn't mistaken for a normal option. Read at server/db/webhooks.js.
  MYCELIUM_WEBHOOK_ALLOW_LOOPBACK: true,
  // Test seam only: overrides the plugins directory so the crash-isolation
  // integration gate can boot the server against a fixture plugins dir. Not a
  // deploy knob a stranger sets. Read at server/plugins.js.
  MYCELIUM_PLUGINS_DIR: true,
}

// Recursively collect server JS/MJS source files. node_modules and the data/
// tree (SQLite + backups) are skipped — they aren't source and contain binaries.
function walkSource(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'data' || name === 'backups') continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      walkSource(p, out)
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      out.push(p)
    }
  }
  return out
}

// Pull every SCREAMING_SNAKE env key read in a source string, across the three
// read idioms. Returns a Set.
function readEnvKeys(src) {
  const keys = new Set()
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1])
  for (const m of src.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) keys.add(m[1])
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const piece of m[1].split(',')) {
      const k = piece.trim().match(/^([A-Z][A-Z0-9_]*)/)
      if (k) keys.add(k[1])
    }
  }
  return keys
}

// Derive the full set of env keys the server reads.
const serverKeys = new Set()
for (const file of walkSource(SERVER_DIR)) {
  for (const k of readEnvKeys(readFileSync(file, 'utf8'))) serverKeys.add(k)
}

// Keys that MUST be documented (server-read, not internal).
const documentedKeys = [...serverKeys].filter((k) => !INTERNAL_ALLOW_LIST[k])

const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')

// Slice out only the "## Environment" section (up to the next "## " heading) so a
// stray mention elsewhere in the README can't satisfy parity — removing the row
// from the table must red the gate.
function extractEnvSection(md) {
  const lines = md.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '## Environment') {
      start = i + 1
      break
    }
  }
  if (start === -1) return ''
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const envSection = extractEnvSection(readme)
const envExample = readFileSync(path.join(ROOT, '.env.example'), 'utf8')

// Word-boundary membership so ADMIN_KEY isn't satisfied by MYCELIUM_ADMIN_KEY,
// nor ANTHROPIC_API_KEY by ANTHROPIC_API_KEYS.
const has = (haystack, key) => new RegExp(`\\b${key}\\b`).test(haystack)

const missingFromReadme = documentedKeys.filter((k) => !has(envSection, k))
const missingFromEnvExample = documentedKeys.filter((k) => !has(envExample, k))
const deadAllowListEntries = Object.keys(INTERNAL_ALLOW_LIST).filter(
  (k) => !serverKeys.has(k)
)

describe('env-docs parity (server reads ⊆ docs)', () => {
  test('README has a ## Environment section', () => {
    expect(envSection, 'README must contain a "## Environment" heading').not.toBe('')
  })

  test('every server-read env var is in the README ## Environment table', () => {
    expect(
      missingFromReadme,
      `Add these to README "## Environment" (server reads them but they're undocumented): ${missingFromReadme.join(', ') || '—'}`
    ).toHaveLength(0)
  })

  test('every server-read env var appears in .env.example', () => {
    expect(
      missingFromEnvExample,
      `Add these to .env.example (server reads them but they're absent): ${missingFromEnvExample.join(', ') || '—'}`
    ).toHaveLength(0)
  })

  test('no dead INTERNAL_ALLOW_LIST entries (each must still be read by the server)', () => {
    expect(
      deadAllowListEntries,
      `These allow-list entries are no longer read by the server — remove them: ${deadAllowListEntries.join(', ') || '—'}`
    ).toHaveLength(0)
  })
})

// Wave-1 gate kept explicit alongside the derived parity gate: the README env
// table must name TRUST_PROXY so the operator of a direct-exposed instance
// knows the knob exists (and that leaving the default true lets clients spoof
// IPs past per-IP rate limits). The parity gate above covers this only while
// the server keeps reading TRUST_PROXY; this pins the doc row regardless.
describe('README environment table', () => {
  test('documents TRUST_PROXY', () => {
    expect(envSection, 'README must have a ## Environment section').not.toBe('')
    expect(envSection).toContain('TRUST_PROXY')
  })
})
