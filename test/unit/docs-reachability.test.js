import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..', '..')
const docsDir = path.resolve(root, 'docs')

// The README and CONTRIBUTING are the docs a stranger reads first. Every guide
// in docs/ must be reachable (by basename) from one of them — or live under an
// explorable-by-directory exempt subdir (docs/specs/, docs/examples/). Without
// this, a guide ships publicly but no landing doc can lead anyone to it, which
// is exactly how the agent-onboarding and runner-setup guides went unreachable.
const entryDocs = ['README.md', 'CONTRIBUTING.md'].map((f) =>
  readFileSync(path.resolve(root, f), 'utf8')
)
const exemptSubdirs = ['specs', 'examples']

// Walk docs/ recursively for .md files. The set is derived from the directory,
// not a hardcoded list, so a newly added docs/orphan-guide.md fails the gate
// without anyone having to remember to register it.
function collectMarkdown(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const docsFiles = collectMarkdown(docsDir)

describe('docs reachability from entry docs', () => {
  test('every docs/*.md is linked from README/CONTRIBUTING or filed under an exempt subdir', () => {
    const orphans = docsFiles
      .map((full) => {
        const rel = path.relative(docsDir, full).split(path.sep)
        const basename = path.basename(full)
        const inExemptSubdir = exemptSubdirs.includes(rel[0])
        const linkedFromEntry = entryDocs.some((doc) => doc.includes(basename))
        return inExemptSubdir || linkedFromEntry ? null : rel.join('/')
      })
      .filter(Boolean)

    expect(
      orphans,
      'These docs/*.md files are not reachable from README.md or CONTRIBUTING.md ' +
        'and do not live under docs/specs/ or docs/examples/ — link them from an ' +
        'entry doc or move them under an exempt subdir:\n  ' +
        orphans.join('\n  ')
    ).toEqual([])
  })
})
