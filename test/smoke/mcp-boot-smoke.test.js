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
import { spawnSync } from 'node:child_process'
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

  // KNOWN-BROKEN POSITIVE PATH — SKIP WITH REASON (the brief's sanctioned idiom,
  // not a hollow skip). This boot smoke surfaced a real master regression that
  // NO existing test catches (mcp has no boot smoke on master — until now).
  //
  // `mcp/index.js` does NOT reach its "running" line on master HEAD with the
  // current dependency tree: registerTools() (mcp/index.js:32) throws because
  // mcp/src/tools.js registers each tool with a JSON-schema-descriptor object
  //   e.g. { auto_claim: { type: 'boolean', description: '…' } }
  // but @modelcontextprotocol/sdk 1.30.0's McpServer.tool() requires a Zod
  // *raw shape* (values must be Zod schemas). Its isZodRawShapeCompat() rejects
  // the descriptor, the arg parser then mistakes it for ToolAnnotations, sees
  // nested objects, and throws:
  //   "Tool mycelium_get_work expected a Zod schema or ToolAnnotations, but
  //    received an unrecognized object"
  // The crash is synchronous and role/env-independent — `npm run start:mcp`
  // fails on every boot. The likely trigger is the root override bump to
  // @modelcontextprotocol/sdk ^1.30.0 (commit 6d1d630 "fix(deps): patch 7
  // advisories via overrides"); tools.js was written for an older SDK that
  // accepted these descriptors. Confirmed against a clean, lockfile-deterministic
  // tree (zod 4.4.3, single deduped instance — not a dual-zod skew).
  //
  // Fix (out of THIS brief's scope — one concern per branch): convert each
  // tool's descriptor to a Zod raw shape, e.g.
  //   { auto_claim: z.boolean().describe('Auto-claim the top work item …') }
  // Once that lands, UN-SKIP this test and assert the "running" boot line.
  test.skip('POSITIVE: with a key, stands up the stdio server and reaches the "running" line (currently broken — see comment)', () => {
    // When un-skipped: spawn `node mcp/index.js` with MYCELIUM_API_KEY set, poll
    // stderr for /Mycelium MCP server running/, SIGTERM, assert exit 0.
  })
})
