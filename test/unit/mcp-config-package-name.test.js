import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// The MCP install config the server hands a brand-new agent must reference the
// package that ACTUALLY publishes to npm. The published name is `mycelium-mcp`
// (`npm view mycelium-mcp` -> 1.2.1); the scoped `@softbacon/mycelium-mcp` does
// NOT exist (`npm view @softbacon/mycelium-mcp` -> E404). A stranger who clones
// this repo and registers their first agent copies the emitted config verbatim,
// so a wrong package name here breaks the very last step of onboarding.
//
// Two gates:
//  (1) BEHAVIOR — boot a throwaway temp-DB server (random JWT_SECRET/ADMIN_KEY,
//      /tmp DATA_DIR), register an agent via POST /admin/agents exactly the way
//      an operator would, and assert the returned mcp_config args.
//  (2) BELT-AND-SUSPENDERS — no source file under server/ may hardcode the
//      non-existent scoped name (read-and-assert, in the style of
//      test/smoke/license-and-version.test.js). Survives even if the boot path
//      above is bypassed.
//
// Harness mirrors test/unit/host-header-hardening.test.js; pool:'forks' isolates
// our env mutations from other test files.

const ADMIN_KEY = 'test-admin-key-' + crypto.randomBytes(16).toString('hex')
const JWT_SECRET = 'test-jwt-secret-' + crypto.randomBytes(16).toString('hex')

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const SERVER_DIR = join(REPO_ROOT, 'server')

let tmpDataDir
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-mcp-pkg-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET
  // getInstanceUrl legacy-fallback path: no override, no allowlist -> no throw,
  // derives from the request Host header.
  delete process.env.PUBLIC_BASE_URL
  delete process.env.ALLOWED_HOSTS

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)
})

afterAll(() => {
  delete process.env.PUBLIC_BASE_URL
  delete process.env.ALLOWED_HOSTS
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Recursively collect regular files under dir, skipping node_modules and data
// (vendored deps + runtime DB/logs must not be scanned for source literals).
function sourceFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

describe('emitted MCP config references the published npm package', () => {
  test('POST /admin/agents hands back an install command for `mycelium-mcp`', async () => {
    const res = await request(app)
      .post('/api/mycelium/admin/agents')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('Host', 'localhost:3002')
      .send({ id: 'stranger-1', name: 'Stranger One', project_id: 'onboarding' })

    // A wrong package name must not hide behind a non-200: pin the contract.
    expect(res.status).toBe(200)

    const server = res.body.mcp_config.mcpServers.mycelium
    expect(server.command).toBe('npx')

    const args = server.args
    expect(Array.isArray(args)).toBe(true)
    // Positive: the install command names the package that resolves on npm.
    expect(args.join(' ')).toContain('mycelium-mcp')
    // Negative: must not name the non-existent scoped package.
    expect(args.join(' ')).not.toContain('@softbacon/')
  })
})

describe('no server/ source emits the non-existent scoped package', () => {
  test('no file under server/ contains the literal "@softbacon/mycelium-mcp"', () => {
    const offenders = sourceFiles(SERVER_DIR, [])
      .filter((f) => {
        try {
          return readFileSync(f, 'utf8').includes('@softbacon/mycelium-mcp')
        } catch (_) {
          return false // unreadable (binary, perms) -> not a source literal
        }
      })

    expect(offenders, '@softbacon/mycelium-mcp found in: ' + offenders.join(', ')).toEqual([])
  })
})
