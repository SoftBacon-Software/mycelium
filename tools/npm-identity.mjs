#!/usr/bin/env node
// npm-identity.mjs — does every package name our entry docs teach actually
// resolve to US on the npm registry?
//
// Why this exists: in 2026-08 the entry docs taught `mycelium-mcp` as this
// repo's MCP server while `npm view mycelium-mcp` resolved 1.2.1 to the
// SEPARATE repo SoftBacon-Software/mycelium-mcp — an older client that
// defaults to the retired mycelium.fyi endpoint. A stranger following the
// docs got the wrong code and nothing errored. No other check in the repo
// looks at the registry: the shipped-packages gate only asserts that README
// mentions workspace names, so a name that COLLIDES with a foreign-published
// package passed every gate we had.
//
// Rule — a package name the entry docs (README.md, CONTRIBUTING.md,
// sdk/README.md) present via an install/run instruction (`npm install`,
// `npm i`, `npm exec`, `npx`) or a Packages-table binding PASSES iff:
//   (a) it is published and repository.url resolves to the
//       SoftBacon-Software/mycelium monorepo, or
//   (b) it is unpublished (E404) and the doc section teaching it shows a
//       from-source path for it (git clone / node or cd into its dir /
//       npm link), or
//   (c) it is not a package of this repo and the doc section explicitly
//       marks it external (links a github repo that is NOT the monorepo).
// A table row binding a name to one of this repo's package dirs must also
// agree with that dir's package.json — the docs↔tree half of the collision.
// Anything else FAILs — including "published but declares no repository.url"
// and "registry unreachable" (cannot-verify is not a pass).
//
// LOCAL MAINTAINER TOOL — NOT a CI step: it needs the network and the
// registry flakes. The network-free half of this rule is gated by
// test/unit/readme-package-identity-gate.test.js, which imports the pure
// helpers below so the parsing has exactly one implementation.
//
// Usage: node tools/npm-identity.mjs     (exit 0 = all pass, 1 = failures)

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The docs whose install/run instructions a stranger is expected to follow.
export const ENTRY_DOCS = ['README.md', 'CONTRIBUTING.md', 'sdk/README.md']

// The monorepo itself — anchored so sibling repos (mycelium-mcp, mycelium-app,
// mycelium-lab, ...) do NOT count as "ours". The collision this tool exists
// for was exactly such a sibling: SoftBacon-Software/mycelium-mcp contains
// this string as a prefix, which is why the anchor is [/.] and not nothing.
export function isMonorepoUrl(url) {
  if (typeof url !== 'string') return false
  return /github\.com[/:]SoftBacon-Software\/mycelium(?=[/.\s]|$)/i.test(url.trim())
}

// Any github repo URL in the text that is NOT the monorepo = an explicit
// external attribution (the marker that lets docs teach a foreign name).
export function findExternalRepoUrls(text) {
  const out = []
  const re = /github\.com[/:]([\w.-]+)\/([\w.-]+)/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const owner = m[1]
    const repo = m[2].replace(/\.git.*$/i, '')
    if (!(owner === 'SoftBacon-Software' && repo === 'mycelium')) {
      out.push(`https://github.com/${owner}/${repo}`)
    }
  }
  return out
}

// Split a markdown doc into sections at headings, keeping the 1-based start
// line so findings can cite doc:line. Text before the first heading is its
// own "(top)" section.
export function splitSections(text) {
  const lines = text.split('\n')
  const sections = []
  let cur = { heading: '(top)', startLine: 1, lines: [] }
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/)
    if (h) {
      sections.push({ heading: cur.heading, startLine: cur.startLine, text: cur.lines.join('\n') })
      cur = { heading: h[1].trim(), startLine: i + 1, lines: [] }
    }
    cur.lines.push(lines[i])
  }
  sections.push({ heading: cur.heading, startLine: cur.startLine, text: cur.lines.join('\n') })
  return sections
}

function looksLikePackageName(rawTok) {
  // A name lifted out of prose may still carry markdown punctuation —
  // `npm install mycelium-mcp` in backticks yields "mycelium-mcp`".
  const tok = rawTok.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '')
  if (!tok) return false
  if (tok.includes('://') || tok.startsWith('.') || tok.startsWith('/')) return false
  if (/\.(js|mjs|cjs|json|sh|py)$/.test(tok)) return false
  const scoped = tok.match(/^@[\w.-]+\/[\w.-]+(?:@[\w.-]+)?$/)
  if (scoped) return true
  return /^([A-Za-z][\w.-]*)(?:@[\w.-]+)?$/.test(tok)
}

function cleanName(rawTok) {
  const tok = rawTok.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '')
  const scoped = tok.match(/^(@[\w.-]+\/[\w.-]+)(?:@[\w.-]+)?$/)
  if (scoped) return scoped[1]
  return tok.replace(/@[\w.-]+$/, '')
}

// The idiom verbs that hand a stranger a package to install or run. Single
// line only — no entry doc continues an install across lines today.
const IDIOM_RE = /(?:^|[\s`(])(npm install|npm i|npm exec|npx)(\s|$)/

// Extract package-name references from one doc: install/run idioms (the "bare
// package names presented with an install/run instruction") and Packages-table
// bindings. Each ref carries its section's start line so callers can judge it
// against the section that teaches it.
export function extractRefs(text, doc) {
  const refs = []
  for (const section of splitSections(text)) {
    const lines = section.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const absLine = section.startLine + i

      // Install/run idioms — including mid-prose ones like
      // "`npm install mycelium-mcp` fetches that package, not this server".
      const verb = line.match(IDIOM_RE)
      if (verb) {
        const rest = line.slice(verb.index + verb[0].length).trim()
        const tokens = rest.replace(/\\$/, '').split(/\s+/).filter(Boolean)
        let name = null
        for (const tok of tokens) {
          if (tok.startsWith('-')) continue // flags: -g, -y, --global, ...
          name = tok
          break
        }
        if (name && looksLikePackageName(name)) {
          refs.push({ name: cleanName(name), doc, line: absLine, kind: 'idiom', sectionStartLine: section.startLine })
        }
        continue
      }

      // Packages-table bindings. A table is a contiguous block of "|" lines;
      // its first line is the header, the next is the |---| separator, and
      // every line after is a data row. Matching rows against "the line two
      // up" breaks on every row after the first, so the block is parsed as a
      // unit. ONLY tables whose header cell is "Package" count — the env-var,
      // plugin, and options tables teach names that are not npm packages.
      if (line.trim().startsWith('|')) {
        const prev = lines[i - 1] || ''
        if (!prev.trim().startsWith('|')) {
          const isPackageTable = /^\s*\|\s*Package\s*\|/i.test(line)
          let j = i + 1
          if (isPackageTable) {
            // skip the separator row
            if ((lines[j] || '').trim().startsWith('|') && /^[\s|:-]+$/.test(lines[j])) j++
            for (; j < lines.length && (lines[j] || '').trim().startsWith('|'); j++) {
              const cells = lines[j].split('|').map((c) => c.trim())
              if (cells.length >= 3 && cells[1]) {
                const name = cells[1].replace(/`/g, '')
                const path = cells[2].replace(/`/g, '').replace(/\/+$/, '')
                if (looksLikePackageName(name)) {
                  refs.push({ name, doc, line: section.startLine + j, kind: 'table', path, sectionStartLine: section.startLine })
                }
              }
            }
            i = j - 1
          }
        }
      }
    }
  }
  return refs
}

// Every package name THIS repo declares: npm workspaces (both shapes) plus any
// first-level dir that ships its own package.json (admin-claude is not a
// workspace but is still ours). Returns a Map name -> dir.
export function deriveDeclaredNames(root = REPO_ROOT) {
  const declared = new Map()
  const addDir = (dir) => {
    const pj = join(root, dir, 'package.json')
    if (!existsSync(pj)) return
    try {
      const name = JSON.parse(readFileSync(pj, 'utf8')).name
      if (typeof name === 'string' && name && !declared.has(name)) declared.set(name, dir)
    } catch { /* unreadable package.json — not a name we can vouch for */ }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (pkg.workspaces) {
      for (const pattern of Object.values(pkg.workspaces).flat().filter(Boolean)) {
        const dir = pattern.replace(/\/+$/, '')
        if (dir && !dir.includes('*')) addDir(dir)
      }
    }
  } catch { /* root package.json unreadable — the dir scan still finds names */ }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) addDir(entry.name)
  }
  return declared
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Does the section show the stranger how to get this package from source?
export function sectionHasFromSource(sectionText, dir) {
  if (/git clone/i.test(sectionText)) return true
  if (/npm link/.test(sectionText)) return true
  if (dir) {
    const re = new RegExp('(?:node|cd)\\s+\\S*' + escapeRegExp(dir) + '(?:/|\\b)', 'i')
    if (re.test(sectionText)) return true
  }
  return false
}

// One registry lookup. Distinguishes "not on npm" (E404) from "could not ask"
// (network/registry error) — the second must never be read as a pass.
export function npmView(name) {
  const res = spawnSync('npm', ['view', name, 'name', 'version', 'repository.url', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (res.status === 0) {
    let meta = {}
    try { meta = JSON.parse(res.stdout) } catch { /* published but unparseable */ }
    const url = meta && meta['repository.url']
    return { state: 'published', url: typeof url === 'string' ? url : null }
  }
  const err = (res.stderr || '').match(/npm error code ([A-Z0-9]+)/)
  const code = err ? err[1] : 'UNKNOWN'
  if (code === 'E404') return { state: 'unpublished' }
  return { state: 'error', code }
}

// Judge one reference. `network` resolves name -> registry state, injected so
// tests can judge refs without touching the registry.
export function verdictFor(ref, declared, network) {
  const ours = declared.has(ref.name)

  if (ours) {
    const dir = declared.get(ref.name)
    // Docs↔tree agreement: a Packages row binding a name to a dir must match
    // what that dir's package.json actually declares.
    if (ref.kind === 'table' && ref.path && !ref.path.includes('/') && ref.path !== dir) {
      return { ok: false, why: `docs bind "${ref.name}" to ${ref.path}/ but that dir declares a different package (${dir}/)` }
    }
    const reg = network(ref.name)
    if (reg.state === 'published') {
      if (isMonorepoUrl(reg.url)) return { ok: true, why: 'published from this monorepo' }
      return { ok: false, why: `COLLISION: docs present this as ours but npm resolves it to ${reg.url || '(no repository.url)'}` }
    }
    if (reg.state === 'unpublished') {
      if (sectionHasFromSource(ref.sectionText, dir)) {
        return { ok: true, why: `unpublished — docs show from-source path (${dir}/)` }
      }
      return { ok: false, why: `unpublished (npm E404) and the "${ref.sectionHeading}" section shows no from-source path — a stranger has no way to get it` }
    }
    return { ok: false, why: `registry unreachable (${reg.code}) — cannot verify` }
  }

  // Not declared here: only acceptable when the docs explicitly attribute the
  // name to an external repo.
  const external = findExternalRepoUrls(ref.sectionText)
  if (external.length) return { ok: true, why: `external — explicitly attributed: ${external[0]}` }
  const reg = network(ref.name)
  if (reg.state === 'published' && isMonorepoUrl(reg.url)) {
    return { ok: true, why: 'published from this monorepo but not declared in-repo — worth a look' }
  }
  return { ok: false, why: 'neither a package of this repo nor marked external — a stranger installing it gets someone else\'s code' }
}

function main() {
  const declared = deriveDeclaredNames()

  const refs = []
  for (const doc of ENTRY_DOCS) {
    const full = join(REPO_ROOT, doc)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8')
    const sections = splitSections(text)
    for (const ref of extractRefs(text, doc)) {
      const section = sections.find((s) => s.startLine === ref.sectionStartLine)
      refs.push({ ...ref, sectionHeading: section ? section.heading : '(?)', sectionText: section ? section.text : text })
    }
  }

  if (refs.length === 0) {
    console.error('npm-identity: no package instructions found in ' + ENTRY_DOCS.join(', '))
    console.error('  — if the docs were rewritten, check that extractRefs still parses them.')
    process.exit(1)
  }

  // One registry call per name; docs/sections differ but the registry doesn't.
  const cache = new Map()
  const network = (name) => {
    if (!cache.has(name)) cache.set(name, npmView(name))
    return cache.get(name)
  }

  const seen = new Set()
  const rows = []
  let failures = 0
  for (const ref of refs) {
    const key = `${ref.doc}:${ref.line}:${ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const v = verdictFor(ref, declared, network)
    if (!v.ok) failures++
    rows.push({ ...ref, ok: v.ok, why: v.why })
  }

  const nameW = Math.max(4, ...rows.map((r) => r.name.length))
  const whereW = Math.max(5, ...rows.map((r) => `${r.doc}:${r.line}`.length))
  const regW = Math.max(8, ...rows.map((r) => registryCell(network(r.name)).length))
  const verdictW = 5

  console.log('npm-identity: entry docs vs the npm registry')
  console.log('='.repeat(72))
  for (const r of rows) {
    console.log(
      r.name.padEnd(nameW) + '  ' +
      `${r.doc}:${r.line}`.padEnd(whereW) + '  ' +
      registryCell(network(r.name)).padEnd(regW) + '  ' +
      (r.ok ? 'PASS' : 'FAIL').padEnd(verdictW) + '  ' +
      r.why
    )
  }
  console.log('='.repeat(72))
  console.log(`${rows.length} checked, ${failures} failed`)

  process.exit(failures ? 1 : 0)
}

function registryCell(reg) {
  if (reg.state === 'published') return 'published'
  if (reg.state === 'unpublished') return 'E404'
  return `error ${reg.code}`
}

// Importable as a library by the network-free gate; run as a CLI when
// executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
