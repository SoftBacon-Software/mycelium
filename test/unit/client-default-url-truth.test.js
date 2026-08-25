import { describe, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression gate for the "published docs lie about the MYCELIUM_API_URL default"
// bug. The CODE default — what a stranger actually gets when they omit
// MYCELIUM_API_URL — is their OWN local instance:
//
//   mcp/src/api.js    return env.MYCELIUM_API_URL || 'http://localhost:3002/api/mycelium'
//   sdk/bin/init.js   var API_URL = process.env.MYCELIUM_API_URL || 'http://localhost:3002/api/mycelium'
//   sdk/src/agent.js  this.apiUrl = opts.apiUrl || 'http://localhost:3002/api/mycelium'   (constructor)
//   sdk/src/api.js    var apiUrl = opts.apiUrl || 'http://localhost:3002/api/mycelium'    (createClient)
//
// ...and every one of those sites carries a comment that the hosted mycelium.fyi
// surface is deprecated. That is the authority. But the CLIENT-PACKAGE READMEs
// that SHIP to npm (sdk/package.json `files` includes README.md) told strangers
// the default was https://mycelium.fyi/api/mycelium — the opposite of sovereignty
// and the opposite of what the code does. A stranger who trusted the README
// example and omitted the URL landed on a DIFFERENT target than the docs
// promised, or pointed a production adapter at a deprecating third-party host.
//
// This gate makes code and docs impossible to drift again:
//   1. DERIVE the code default by parsing the live `||` string literal in source
//      (never hardcode it — if the default changes, this gate follows it).
//   2. SCAN every client-package doc + adapter header comment for an /api/mycelium
//      URL and assert it EQUALS the derived code default.
//   3. Assert the discord adapter's code, its header comment, and the SDK
//      constructor default all agree (a prior bug had all three disagreeing).
//
// The allow-list is EMPTY by design. Add an entry ONLY if a doc legitimately
// describes a NON-default (e.g. an example pointing at an example.com host) and
// justify it. NEVER add a .fyi "default" here — fix the doc instead. If a doc
// says .fyi is the default and the code says localhost, the DOC is wrong.

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

// { file: '<repo-relative path>', url: '<exact url>', reason: '...' }
// Empty: every client-package doc that names a MYCELIUM_API_URL default must
// equal the code default.
const ALLOWED_NON_DEFAULT_URLS = []

// --- helpers --------------------------------------------------------------

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

// Parse the string literal after `||` on a line that resolves
// MYCELIUM_API_URL (the bin/init + mcp/src/api form: `... || 'literal'`).
function extractEnvOrDefault(rel) {
  const m = read(rel).match(/MYCELIUM_API_URL\b[^\n]*?\|\|\s*(['"])([^'"]+)\1/)
  return m ? m[2] : null
}

// Parse the `||` literal for the opts.apiUrl form (constructor + createClient:
// `... = opts.apiUrl || 'literal'`). These don't mention MYCELIUM_API_URL by
// name, so they need their own extractor.
function extractOptOrDefault(rel) {
  const m = read(rel).match(/opts\.apiUrl\s*\|\|\s*(['"])([^'"]+)\1/)
  return m ? m[2] : null
}

// Every https://.../api/mycelium URL in a block of text, with its line number.
const URL_RE = /https?:\/\/[\w.\-:]+\/api\/mycelium/g
function urlSites(text) {
  const out = []
  for (const m of text.matchAll(URL_RE)) {
    const line = text.slice(0, m.index).split('\n').length
    out.push({ url: m[0], line })
  }
  return out
}

// Recursively collect every *.md under a dir (skipping node_modules).
function walkMd(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkMd(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

// The client-package doc + adapter-comment surface this gate polices.
// .md everywhere under sdk/ + mcp/ (the published READMEs, guides, CLAUDE.md),
// plus the three adapter files whose header comments are user-facing docs.
// Code authorities (sdk/src/*, mcp/src/*, sdk/bin/init.js) are NOT here — they
// are the derivation sources, checked in the first test. Test fixtures
// (sdk/test/**, which deliberately use a non-routable localhost:9) are not docs
// and are not collected.
function docFiles() {
  return [
    ...walkMd(join(ROOT, 'sdk')),
    ...walkMd(join(ROOT, 'mcp')),
    join(ROOT, 'sdk/adapters/discord.js'),
    join(ROOT, 'sdk/adapters/slack.js'),
    join(ROOT, 'sdk/adapters/voice.js'),
  ]
}

// Naive balanced-paren extractor for a `Name(...)` call. Sufficient for the
// adapter's MyceliumAgent(...) config literal (no parens inside strings there).
function extractCallBlock(text, callName) {
  const idx = text.indexOf(callName + '(')
  if (idx === -1) return null
  let depth = 1
  let i = idx + callName.length + 1
  while (i < text.length && depth > 0) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  return depth === 0 ? text.slice(idx + callName.length + 1, i - 1) : null
}

// --- the gate -------------------------------------------------------------

describe('client-package MYCELIUM_API_URL default tells the truth', () => {
  test('the code default is derived from the live || fallback, not hardcoded', () => {
    const fromMcp = extractEnvOrDefault('mcp/src/api.js')
    const fromInit = extractEnvOrDefault('sdk/bin/init.js')
    if (fromMcp === null) {
      throw new Error('mcp/src/api.js no longer has a MYCELIUM_API_URL || <literal> fallback — update this gate to read the new default source.')
    }
    if (fromInit === null) {
      throw new Error('sdk/bin/init.js no longer has a MYCELIUM_API_URL || <literal> fallback — update this gate to read the new default source.')
    }
    // The two named derivation authorities must agree.
    if (fromMcp !== fromInit) {
      throw new Error(`code defaults disagree: mcp/src/api.js="${fromMcp}" vs sdk/bin/init.js="${fromInit}"`)
    }
    // The constructor + createClient defaults must agree too (defense in depth).
    const fromCtor = extractOptOrDefault('sdk/src/agent.js')
    const fromClient = extractOptOrDefault('sdk/src/api.js')
    if (fromCtor !== fromInit) {
      throw new Error(`sdk/src/agent.js constructor default "${fromCtor}" != sdk/bin/init.js "${fromInit}"`)
    }
    if (fromClient !== fromInit) {
      throw new Error(`sdk/src/api.js createClient default "${fromClient}" != sdk/bin/init.js "${fromInit}"`)
    }
  })

  test('every documented default in sdk/** + mcp/** equals the code default', () => {
    const codeDefault = extractEnvOrDefault('sdk/bin/init.js')
    const violations = []
    for (const file of docFiles()) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(ROOT, file)
      for (const { url, line } of urlSites(text)) {
        if (url === codeDefault) continue
        const allowed = ALLOWED_NON_DEFAULT_URLS.some(
          (a) => a.file === rel && a.url === url
        )
        if (!allowed) violations.push(`${rel}:${line}  "${url}"`)
      }
    }
    if (violations.length) {
      throw new Error(
        `client-package docs name a MYCELIUM_API_URL default that disagrees with ` +
          `the code default "${codeDefault}".\n` +
          `Fix the doc — or, for a legitimate NON-default example only, add an ` +
          `ALLOWED_NON_DEFAULT_URLS entry with a reason. Never allow-list a .fyi ` +
          `"default"; fix it.\n` +
          violations.map((v) => '  ' + v).join('\n')
      )
    }
  })

  test('discord adapter: code, header comment, and SDK constructor default all agree', () => {
    const codeDefault = extractEnvOrDefault('sdk/bin/init.js')
    const text = read('sdk/adapters/discord.js')

    // (a) the header comment must document a default that matches the code.
    const cm = text.match(
      /MYCELIUM_API_URL\b[^\n]*?\(default:\s*(https?:\/\/[^\s)]+)\)/i
    )
    if (!cm) {
      throw new Error('discord.js header comment no longer documents a MYCELIUM_API_URL default')
    }
    if (cm[1] !== codeDefault) {
      throw new Error(`discord.js header comment default "${cm[1]}" != code default "${codeDefault}"`)
    }

    // (b) the config block handed to new MyceliumAgent(...).
    const block = extractCallBlock(text, 'new MyceliumAgent')
    if (block === null) {
      throw new Error('discord.js no longer constructs a MyceliumAgent')
    }
    // Reject the bare-passthrough smell: `apiUrl: process.env.MYCELIUM_API_URL,`
    // passes undefined masked as a real value. Give it a || fallback or omit
    // apiUrl so the constructor default applies cleanly.
    const bareSmell = /^[ \t]*apiUrl:\s*process\.env\.MYCELIUM_API_URL\s*,?[ \t]*$/m.test(
      block
    )
    if (bareSmell) {
      throw new Error(
        'discord.js passes apiUrl as a bare process.env.MYCELIUM_API_URL (undefined masked as a value). ' +
          'Use `|| codeDefault` or omit apiUrl when unset so the constructor default applies.'
      )
    }
    // If an explicit || fallback is present, it must match the code default.
    const fallback = block.match(/apiUrl:\s*[^\n]*?\|\|\s*(['"])([^'"]+)\1/)
    if (fallback && fallback[2] !== codeDefault) {
      throw new Error(`discord.js explicit apiUrl fallback "${fallback[2]}" != code default "${codeDefault}"`)
    }

    // (c) the SDK constructor default the adapter falls through to == code default.
    if (extractOptOrDefault('sdk/src/agent.js') !== codeDefault) {
      throw new Error('sdk/src/agent.js constructor default drifted from the code default')
    }
  })
})
