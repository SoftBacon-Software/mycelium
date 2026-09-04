import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
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
//
// Runner extension (2026-09-04, runner-platform-truth): the RUNNER package had
// the worst version of the same bug — its setup wizard HARDCODED .fyi as the
// only target with no override, sent `X-Admin-Key: <what the operator typed>`
// to it on every call, and persisted it into the generated config.json. The
// `runner package platform truth` describe below extends this gate's idiom to
// runner/: same derivation authorities, a zero-.fyi scan over runner/**, and a
// driven wizard proving the admin key goes only to the URL the operator
// answered. Same package family, same authority, one gate.

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const RUNNER_DIR = join(ROOT, 'runner')

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

// --- runner extension: helpers ---------------------------------------------

// Every text file (js/json/md) under runner/, node_modules skipped and the
// operator's own gitignored config.json skipped — the gate polices SHIPPED
// truth, not a local operator's working file.
function runnerTextFiles() {
  const out = []
  const EXTS = new Set(['.js', '.json', '.md'])
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'config.json') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && EXTS.has(extname(e.name))) out.push(p)
    }
  }
  walk(RUNNER_DIR)
  return out
}

describe('runner package platform truth', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('setup.js default is derived from the live || fallback and equals the platform-wide default', () => {
    const runnerDefault = extractEnvOrDefault('runner/setup.js')
    if (runnerDefault === null) {
      throw new Error(
        'runner/setup.js no longer resolves MYCELIUM_API_URL with a `|| <literal>` fallback — ' +
          'the default the wizard ships is unparsed and unverified. Restore the derivation ' +
          'site this gate reads, or update this gate to the new shape.'
      )
    }
    // The same authorities the client-package tests above derive from.
    const fromMcp = extractEnvOrDefault('mcp/src/api.js')
    const fromInit = extractEnvOrDefault('sdk/bin/init.js')
    if (fromMcp === null || fromInit === null) {
      throw new Error(
        'the platform default authorities (mcp/src/api.js, sdk/bin/init.js) no longer carry a ' +
          'MYCELIUM_API_URL || <literal> fallback — update this gate to the new derivation source.'
      )
    }
    if (fromMcp !== fromInit) {
      throw new Error(`platform defaults disagree: mcp/src/api.js="${fromMcp}" vs sdk/bin/init.js="${fromInit}"`)
    }
    expect(
      runnerDefault,
      `runner/setup.js default "${runnerDefault}" != the platform default "${fromMcp}" — ` +
        `the runner drifted from the rest of the house. Fix setup.js.`
    ).toBe(fromMcp)
    expect(
      runnerDefault.includes('mycelium.fyi'),
      `runner/setup.js defaults to mycelium.fyi — a third-party host is not the operator's instance`
    ).toBe(false)
  })

  test('no runner/ file asserts mycelium.fyi anywhere (js + json + md) — allow-list is EMPTY', () => {
    const hits = []
    const files = runnerTextFiles()
    expect(files.length, 'runner/ scan found no js/json/md files — the package moved or the walker broke').toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(ROOT, file)
      text.split('\n').forEach((line, i) => {
        if (line.includes('mycelium.fyi')) {
          hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 140)}`)
        }
      })
    }
    expect(
      hits,
      'runner/ names mycelium.fyi — a retired third-party host that is NOT the platform. ' +
        'The runner target is the operator\'s own instance (setup.js asks for it; config ' +
        'carries it). Fix the file. If a hit is genuinely cosmetic (not a platform target), ' +
        'prefer fixing it to a neutral value over allow-listing — the git user.email was ' +
        'fixed to a .local placeholder, not allow-listed:\n'
    ).toEqual([])
  })

  test('the wizard sends the admin key ONLY to the URL the operator answered, and wires config.json there', async () => {
    let setup
    try {
      setup = await import(join(RUNNER_DIR, 'setup.js'))
    } catch (e) {
      throw new Error(
        `runner/setup.js is no longer importable (${e.message}) — the wizard credential path is unverified`,
        { cause: e }
      )
    }
    if (typeof setup.runSetup !== 'function') {
      throw new Error(
        'runner/setup.js no longer exports runSetup() — the wizard credential path cannot be ' +
          'driven, so nothing verifies where the operator\'s admin key is sent. Restore the ' +
          'injectable surface (ask/fetchImpl/configDir) this gate drives.'
      )
    }

    // The operator answers a URL that is .fyi's opposite. If setup.js ever
    // reverts to a hardcoded const, the stub records the key going there and
    // this reds — without a single packet leaving the machine.
    const ANSWERED = 'http://my-instance.test:3999/api/mycelium'
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET' })
      return {
        ok: true,
        json: async () => (init?.method === 'POST' ? { api_key: 'dvk_test' } : []),
      }
    }
    const configDir = mkdtempSync(join(tmpdir(), 'myc-runner-wizard-'))

    // Answer the prompts in order: admin key, instance URL, pick "register
    // new", display name, agent id (default), project id, cwd (default),
    // mcp path (default), model (default). Empty env forces the key prompt.
    vi.stubEnv('MYCELIUM_ADMIN_KEY', '')
    const answers = [
      'test-admin-key-not-real',
      ANSWERED,
      '1',
      'Test Machine',
      '',
      'my-project',
      '',
      '',
      '',
    ]
    try {
      await setup.runSetup({
        ask: async () => answers.shift() ?? '',
        fetchImpl,
        configDir,
      })
    } finally {
      vi.unstubAllEnvs()
    }

    expect(calls.length, 'the wizard made no API calls — the flow under test is broken').toBeGreaterThan(0)
    const offTarget = calls.filter((c) => !c.url.startsWith(ANSWERED + '/'))
    expect(
      offTarget,
      `the wizard contacted a host the operator did not answer. Every admin-key-bearing ` +
        `request must go to the answered instance (${ANSWERED}). Off-target calls:\n` +
        offTarget.map((c) => `  ${c.method} ${c.url}`).join('\n')
    ).toEqual([])
    expect(
      calls.filter((c) => c.url.includes('mycelium.fyi')),
      'the wizard sent a request to mycelium.fyi'
    ).toEqual([])

    // The persistence half: config.json on disk points the runner (and the
    // agent's MCP env) at the answered instance, never anywhere else.
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    expect(
      config.mycelium.apiUrl,
      `config.json mycelium.apiUrl is not the URL the operator answered`
    ).toBe(ANSWERED)
    const mcpEnv = config.agents?.[0]?.mcpServers?.mycelium?.env
    if (mcpEnv) {
      expect(
        mcpEnv.MYCELIUM_API_URL,
        `config.json wires the agent's MYCELIUM_API_URL somewhere other than the answered instance`
      ).toBe(ANSWERED)
    }
    for (const c of calls) {
      expect(
        c.url.includes('test-admin-key-not-real'),
        'the admin key leaked into a request URL (keys travel in headers, never the URL)'
      ).toBe(false)
    }

    rmSync(configDir, { recursive: true, force: true })
  })
})
