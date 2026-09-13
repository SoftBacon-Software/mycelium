import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// Static gate for compose services' runtime commands (2026-09-04). The public
// quick start told strangers to add a "GPU drone worker" with
// `docker compose --profile gpu up -d`, and that `drone` service ran
// `command: ["python", "tools/drone-worker.py"]` in an image built
// `FROM node:22-slim` — which ships no python (and no `requests`). Proven on
// master 69b05a6: the node image's entrypoint reinterprets the command, the
// container dies with `Error: Cannot find module '/app/python'` (exit 1), and
// `restart: unless-stopped` turns that into a crash loop — RestartCount hit 9
// within ~30s of `up`. A stranger's first encounter with the drone surface was
// a container that never starts, with an error that never mentions python.
//
// The contract pinned here: every compose service that names an interpreter in
// an exec-form `command:` must have evidence, DERIVED FROM THE TREE at test
// time, that the image it actually runs provides that interpreter. Both sides
// are derived — the command's argv from docker-compose.yml text, the image's
// contents from its FROM base plus RUN install steps — so the gate tracks
// reality instead of a frozen list: a service added tomorrow is evaluated the
// same way with no edits here.
//
// Evidence model (what makes an interpreter "provided"):
//   - base image: `node:*` → node/npm/npx; `python:*` → python/python3/pip.
//     Debian-family bases (incl. `-slim` variants) ship `sh` and `bash`;
//     `alpine` ships `sh` only.
//   - RUN steps: `apt-get install python3` evidences `python3` — deliberately
//     NOT bare `python` (debian ships no /usr/bin/python alias without the
//     python-is-python3 package). That precision is the point: the shipped bug
//     named `python`, and no plausible install line would have made it true.
//     `pip install` in a RUN evidences python3/pip (pip cannot run without a
//     python). `apt-get install nodejs` evidences `node`.
//   - anything else fails CLOSED: an exec command naming an interpreter the
//     model cannot evidence REDs with a message saying to extend this gate
//     consciously — never silently skipped (a silent skip is the exact hole
//     that let the drone ship).
//
// Deliberate scope (stated, not silent):
//   - exec-form `command:` on one line (`command: ["interp", ...]`). A
//     `command:` in any other shape fails loud ("not exec-form") rather than
//     being skipped. Shell-wrapped commands (`sh -c`) are probed for a leading
//     interpreter token so `-c "python x.py"` is not a route around the gate;
//     arbitrary shell script content beyond that first token is not parsed.
//   - a service with no `command:` relies on its image's own CMD/ENTRYPOINT —
//     the image's contract, not the compose file's.
//   - `healthcheck.test` CMD/CMD-SHELL is not evaluated.
//   - The runtime smoke (docker build + run + probe) stays separate per the
//     docker-smoke split (scripts/docker-smoke.sh, CI job `docker-smoke`);
//     this gate needs no daemon, so it runs in plain `npm test`.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// docker-compose.yml text parsing — no yaml dependency; the file is small and
// the shape we need (services / build / image / command) is stable. Same choice
// the docs gates make reading source text. Compose files here use 2-space
// service indent, the compose convention.
// ---------------------------------------------------------------------------

export function parseComposeServices(composeText) {
  const lines = composeText.split('\n')
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('docker-compose.yml: no top-level `services:` block found')

  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (!line.startsWith(' ')) break // next top-level key (volumes:, networks:, ...)
    block.push(line)
  }

  const services = []
  let cur = null
  for (const line of block) {
    const header = /^ {2}([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(line)
    if (header) {
      cur = { name: header[1], lines: [] }
      services.push(cur)
    } else if (cur) {
      cur.lines.push(line)
    } else if (line.trim()) {
      throw new Error(`docker-compose.yml: content before the first service header ("${line.trim()}")`)
    }
  }
  return services
}

// Indented entries under a 4-space `key:` block line inside a service.
function blockEntries(lines, key) {
  const start = lines.findIndex((l) => new RegExp(`^ {4}${key}:\\s*(#.*)?$`).test(l))
  if (start === -1) return null
  const entries = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') continue
    if (l.startsWith('      ')) entries.push(l.trim())
    else break
  }
  return entries
}

function parseBuild(lines) {
  const inline = lines.map((l) => /^ {4}build:\s*(\S.*?)\s*(#.*)?$/.exec(l)).find(Boolean)
  if (inline) {
    const spec = inline[1]
    if (spec.startsWith('{')) {
      const df = /dockerfile:\s*([^\s,}]+)/.exec(spec)
      const ctx = /context:\s*([^\s,}]+)/.exec(spec)
      return { context: ctx ? ctx[1] : '.', dockerfile: df ? df[1] : 'Dockerfile' }
    }
    return { context: spec, dockerfile: 'Dockerfile' }
  }
  const entries = blockEntries(lines, 'build')
  if (!entries) return null
  const df = entries.map((e) => /^dockerfile:\s*(\S+)/.exec(e)).find(Boolean)
  const ctx = entries.map((e) => /^context:\s*(\S+)/.exec(e)).find(Boolean)
  return { context: ctx ? ctx[1] : '.', dockerfile: df ? df[1] : 'Dockerfile' }
}

function parseImage(lines) {
  const inline = lines.map((l) => /^ {4}image:\s*(\S.*?)\s*(#.*)?$/.exec(l)).find(Boolean)
  return inline ? inline[1] : null
}

// Exec-form only, on one line. Anything else that claims to be a command is
// reported as `unsupported` so the gate can fail LOUD on it — a silently
// skipped command is the hole this gate exists to close.
function parseCommand(lines) {
  const line = lines.map((l) => /^ {4}command:\s*(.*?)\s*(#.*)?$/.exec(l)).find(Boolean)
  if (!line) return null
  const rhs = line[1]
  if (/^\[.*\]$/.test(rhs)) {
    const argv = [...rhs.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s,\]["']+)/g)]
      .map((m) => m[1] ?? m[2] ?? m[3])
      .filter((s) => s !== undefined && s !== '')
    return { kind: 'exec', argv, text: rhs }
  }
  return { kind: 'unsupported', text: rhs || '(block/list form)' }
}

// ---------------------------------------------------------------------------
// Interpreter evidence, derived at test time from FROM + RUN lines.
// ---------------------------------------------------------------------------

// RUN instructions with backslash continuations joined, so a multi-line
// `RUN apt-get update && apt-get install -y \` / `    python3` still reads.
function dockerRunCommands(dockerfileText) {
  if (!dockerfileText) return []
  return dockerfileText
    .replace(/\\\s*\n/g, ' ')
    .split('\n')
    .filter((l) => /^\s*RUN\b/i.test(l) && !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*RUN\s+/i, ''))
}

const basename = (p) => p.split('/').pop()

function imageFacts(baseImage, dockerfileText) {
  // A service that builds runs the LAST stage of its Dockerfile, so its runtime
  // base is the last FROM in that file; a service with only `image:` runs the
  // named image directly.
  let base = (baseImage || '').toLowerCase()
  if (!base && dockerfileText) {
    const froms = dockerfileText
      .split('\n')
      .filter((l) => /^\s*FROM\s+\S+/i.test(l) && !/^\s*#/.test(l))
      .map((l) => l.replace(/^\s*FROM\s+/i, '').trim().split(/\s+/)[0].toLowerCase())
    if (froms.length) base = froms[froms.length - 1]
  }
  const provides = new Set()
  if (base && base !== 'scratch') {
    provides.add('sh')
    const debianFamily =
      /(slim|bookworm|bullseye|trixie|buster|stretch|ubuntu|debian)/.test(base) ||
      /^node:/.test(base) ||
      /^python:/.test(base)
    if (debianFamily && !base.includes('alpine')) provides.add('bash')
  }
  if (/^node:/.test(base)) for (const t of ['node', 'npm', 'npx']) provides.add(t)
  if (/^python:/.test(base)) for (const t of ['python', 'python3', 'pip', 'pip3']) provides.add(t)

  for (const run of dockerRunCommands(dockerfileText)) {
    const apt = run.match(/apt-get(?:\s+\S+)*?\s+install\s+([^\n&|;]+)/)
    if (apt) {
      const pkgs = apt[1]
      if (/\bpython3\b/.test(pkgs)) provides.add('python3')
      if (/\bpython-is-python3\b/.test(pkgs)) provides.add('python')
      if (/\bnodejs\b/.test(pkgs)) provides.add('node')
    }
    if (/\bpip3?\s+install\b/.test(run)) {
      provides.add('python3')
      provides.add('pip')
      provides.add('pip3')
    }
  }
  return { base, provides }
}

// Interpreters this gate can reason about. `sh`/`bash` are evidenced via the
// base image; anything outside this vocabulary fails closed.
const KNOWN_INTERPRETERS = new Set([
  'sh',
  'bash',
  'node',
  'npm',
  'npx',
  'python',
  'python3',
  'pip',
  'pip3',
])

// command[0] — or, for `sh -c "..."`, the script's first token when that token
// is an interpreter name (so the shell is not a route around the gate).
function interpreterOf(argv) {
  let interp = basename(argv[0])
  let via = 'command[0]'
  if ((interp === 'sh' || interp === 'bash') && argv[1] === '-c' && argv[2]) {
    const first = argv[2].trim().split(/\s+/)[0].replace(/^["']+|["']+$/g, '')
    if (KNOWN_INTERPRETERS.has(basename(first))) {
      interp = basename(first)
      via = 'sh -c first token'
    }
  }
  return { interp, via }
}

function imageDescription(svc, facts, dockerfileText) {
  const source = svc.build
    ? `build: ${svc.build.context} → ${svc.build.dockerfile}`
    : `image: ${svc.image}`
  const from = facts.base ? `FROM ${facts.base}` : 'base image could not be derived'
  const runs = dockerRunCommands(dockerfileText).length
  return `${source} (${from}; ${runs} RUN step${runs === 1 ? '' : 's'})`
}

// The gate proper: returns one human problem string per violation, naming the
// service, the interpreter, and the derived image facts. Empty = clean.
export function analyzeComposeCommands(composeText, loadDockerfile) {
  const problems = []
  for (const svc of parseComposeServices(composeText)) {
    const resolved = { name: svc.name, build: parseBuild(svc.lines), image: parseImage(svc.lines) }
    const command = parseCommand(svc.lines)
    if (!command) continue // no command → the image's own CMD/ENTRYPOINT contract
    if (command.kind === 'unsupported') {
      problems.push(
        `service \`${svc.name}\`: command is not exec-form ("command: ${command.text}") — this gate can only evaluate exec-form \`command: ["interp", ...]\` on one line; rewrite the service or extend this gate consciously`,
      )
      continue
    }
    const dockerfileText = resolved.build
      ? loadDockerfile(resolved.build.context, resolved.build.dockerfile)
      : null
    if (resolved.build && dockerfileText === null) {
      problems.push(
        `service \`${svc.name}\`: build references ${resolved.build.context} → ${resolved.build.dockerfile}, which does not exist in the tree`,
      )
      continue
    }
    const facts = imageFacts(resolved.build ? null : resolved.image, dockerfileText)
    const { interp, via } = interpreterOf(command.argv)
    if (!KNOWN_INTERPRETERS.has(interp)) {
      problems.push(
        `service \`${svc.name}\`: ${via} "${interp}" is not an interpreter this gate can evidence (known: ${[...KNOWN_INTERPRETERS].join(', ')}) — extend this gate consciously if the image really provides it`,
      )
      continue
    }
    if (!facts.provides.has(interp)) {
      problems.push(
        `service \`${svc.name}\`: ${via} "${interp}", but the image it runs provides no ${interp} — ${imageDescription(resolved, facts, dockerfileText)} evidences [${[...facts.provides].join(', ')}]. The container exits immediately and restart: unless-stopped turns that into a crash loop`,
      )
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Compose profiles vs. what the docs tell strangers to activate.
// ---------------------------------------------------------------------------

export function composeProfiles(composeText) {
  const profiles = new Set()
  let inProfiles = false
  for (const line of parseComposeServices(composeText).flatMap((s) => s.lines)) {
    if (/^ {4}profiles:\s*(#.*)?$/.test(line)) {
      inProfiles = true
      continue
    }
    if (inProfiles) {
      if (line.startsWith('      ')) {
        const m = /^-\s*(\S+)/.exec(line.trim())
        if (m) profiles.add(m[1])
      } else inProfiles = false
    }
  }
  return profiles
}

export function documentedProfileActivations(docText) {
  return [...docText.matchAll(/--profile\s+([A-Za-z0-9._-]+)/g)].map((m) => m[1])
}

// ---------------------------------------------------------------------------
// The gate, run against the real tree.
// ---------------------------------------------------------------------------

const composeText = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf8')
const loadRepoDockerfile = (context, dockerfile) => {
  const p = resolve(ROOT, context || '.', dockerfile || 'Dockerfile')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const services = parseComposeServices(composeText)

describe('compose command interpreters (static, derived — no daemon)', () => {
  test('the parse is live: it sees the services that exist, not a frozen list', () => {
    expect(services.length, 'docker-compose.yml must declare at least one service').toBeGreaterThan(0)
    expect(services.map((s) => s.name)).toContain('mycelium')
  })

  test('every exec-form command names an interpreter the image it runs provides', () => {
    const problems = analyzeComposeCommands(composeText, loadRepoDockerfile)
    expect(problems, problems.join('\n')).toEqual([])
  })

  // --- BITEs: synthetic services against the REAL main Dockerfile. These keep
  // the gate honest about being derived — a frozen allow-list passes all of
  // the above vacuously once the broken service is gone.

  const plantService = (extraLines) => `services:
  mycelium:
    build: .
    container_name: mycelium-server
  pythonbug:
    build: .
${extraLines}
`

  test('BITE: a planted ["python", ...] service on the node build REDs, naming the service', () => {
    const problems = analyzeComposeCommands(
      plantService('    command: ["python", "x.py"]'),
      loadRepoDockerfile,
    )
    expect(
      problems.some(
        (p) => p.includes('`pythonbug`') && p.includes('"python"') && p.includes('node:22-slim'),
      ),
      `expected the planted python service to RED against the node build; got: ${JSON.stringify(problems)}`,
    ).toBe(true)
  })

  test('BITE: `sh -c "python x.py"` is not a route around the gate', () => {
    const problems = analyzeComposeCommands(
      plantService('    command: ["sh", "-c", "python x.py"]'),
      loadRepoDockerfile,
    )
    expect(
      problems.some((p) => p.includes('`pythonbug`') && p.includes('sh -c first token')),
      `expected the shell-wrapped python to be caught; got: ${JSON.stringify(problems)}`,
    ).toBe(true)
  })

  test('BITE: ["node", ...] on the node build is fine — the gate is not a python ban', () => {
    const problems = analyzeComposeCommands(
      plantService('    command: ["node", "x.js"]'),
      loadRepoDockerfile,
    )
    expect(problems.filter((p) => p.includes('`pythonbug`'))).toEqual([])
  })

  test('BITE: a python base evidences python — derived from FROM, not listed per service', () => {
    const problems = analyzeComposeCommands(
      `services:
  pyworker:
    image: python:3.12-slim
    command: ["python", "x.py"]
`,
      loadRepoDockerfile,
    )
    expect(problems, problems.join('\n')).toEqual([])
  })

  test('BITE: `apt-get install python3` still does not evidence bare `python`', () => {
    const problems = analyzeComposeCommands(
      plantService('    command: ["python", "x.py"]'),
      (ctx, df) =>
        df === 'Dockerfile'
          ? 'FROM node:22-slim\nRUN apt-get update && apt-get install -y python3\n'
          : loadRepoDockerfile(ctx, df),
    )
    expect(
      problems.some((p) => p.includes('`pythonbug`')),
      'bare `python` must stay unevidenced on a python3-only apt install',
    ).toBe(true)
  })

  test('BITE: a non-exec-form command fails loud instead of being skipped', () => {
    const problems = analyzeComposeCommands(
      plantService('    command: python x.py'),
      loadRepoDockerfile,
    )
    expect(problems.some((p) => p.includes('not exec-form'))).toBe(true)
  })

  // --- profiles the docs name must exist in compose (the README once told
  // strangers to activate a profile whose service could not start).

  const docsToCheck = ['README.md', 'CLAUDE.md', '.claude/CLAUDE.md']
    .map((rel) => resolve(ROOT, rel))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'))
  const profiles = composeProfiles(composeText)

  test('every compose profile the docs tell strangers to activate exists in docker-compose.yml', () => {
    for (const [i, text] of docsToCheck.entries()) {
      for (const name of documentedProfileActivations(text)) {
        expect(
          profiles.has(name),
          `${docsToCheck[i]} instructs \`--profile ${name}\` but no service in docker-compose.yml declares that profile`,
        ).toBe(true)
      }
    }
  })

  test('BITE: a documented activation of an undeclared profile REDs', () => {
    expect(documentedProfileActivations('run `docker compose --profile nope up -d`')).toEqual([
      'nope',
    ])
    expect(composeProfiles(composeText).has('nope')).toBe(false)
  })
})
