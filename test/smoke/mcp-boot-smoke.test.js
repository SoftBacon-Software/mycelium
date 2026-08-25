// MCP boot smoke — minimal parity baseline for the `mcp` workspace.
//
// `npm run start:mcp` (mcp/index.js) is one of the four package.json workspace
// entrypoints. Its boot-critical behavior is the startup guard at the top of
// mcp/index.js: with no MYCELIUM_API_KEY it writes ERROR to stderr and exits 1,
// and with a key it stands up the stdio MCP server and prints the "running"
// line. mcp-resolve-url.test.js already pins the URL-resolution path (the .fyi
// sovereignty default); this pins the ENTRYPOINT boot: the guard fast-fails
// without a key, and the server reaches "running" with one.
//
// This is deliberately a MINIMAL baseline — the parity surface the
// workspace-boot-parity gate requires. It does NOT register tools or drive a
// full MCP handshake; richer MCP coverage can layer on top without conflict.

import { describe, test, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const MCP_ENTRY = join(REPO_ROOT, 'mcp', 'index.js')

describe('mcp boot (mcp/index.js startup guard + stdio server)', () => {
  test('NEGATIVE: with no MYCELIUM_API_KEY, fast-fails non-zero naming the key on stderr', () => {
    // Inherit the host env (so @modelcontextprotocol/sdk resolves) then STRIP
    // MYCELIUM_API_KEY so the child hits the index.js guard regardless of the
    // test runner's env.
    const env = { ...process.env }
    delete env.MYCELIUM_API_KEY

    const result = spawnSync('node', [MCP_ENTRY], {
      cwd: REPO_ROOT,
      env,
      timeout: 15000,
      encoding: 'utf8',
      // The MCP stdio server reads stdin; give it /dev/null so a missing key is
      // the only thing that can terminate it.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    expect(result.status, 'mcp should fast-fail, not time out').not.toBeNull()
    expect(result.status).not.toBe(0)
    expect(result.stderr, 'stderr should name MYCELIUM_API_KEY').toMatch(/MYCELIUM_API_KEY/)
  })

  // POSITIVE: with a key, stands up the stdio server and reaches the "running" line
  test('POSITIVE: with a key, stands up the stdio server and reaches the "running" line', (t) => {
    const env = { ...process.env, MYCELIUM_API_KEY: 'dummy' }

    const proc = spawn('node', [MCP_ENTRY], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const cleanup = () => {
      proc.kill()
    }

    t.signal?.addEventListener('cancel', cleanup)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Test timed out waiting for "running" line'))
      }, 10000)

      proc.on('exit', (code) => {
        clearTimeout(timeout)
        if (stderr.includes('Mycelium MCP server running')) {
          resolve()
        } else {
          cleanup()
          reject(new Error('Server did not reach "running" line. stderr: ' + stderr))
        }
      })

      // Also check stderr periodically for the running line
      const checkInterval = setInterval(() => {
        if (stderr.includes('Mycelium MCP server running')) {
          clearTimeout(timeout)
          clearInterval(checkInterval)
          cleanup()
          resolve()
        }
      }, 100)
    })
  })
})