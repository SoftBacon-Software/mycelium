import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Regression test for the MCP "talks to .fyi instead of the configured instance"
// bug. Root cause: mcp/src/api.js resolved the API KEY from ~/.claude/settings.json
// as ground truth (resolveKey, hardened against stale/missing env) but resolved the
// API URL from process.env ONLY, with a hardcoded 'https://mycelium.fyi/api/mycelium'
// fallback that NEVER consulted settings.json. So when MYCELIUM_API_URL was absent
// from process.env (the documented "env can be stale" MCP-launcher failure mode) the
// URL silently defaulted to .fyi while the key still resolved correctly — requests
// authenticated fine but hit the wrong host.
//
// Fix: resolveUrl() mirrors resolveKey() — settings.json's
// mcpServers.mycelium.env.MYCELIUM_API_URL is ground truth, process.env is the
// fallback, the .fyi literal is the last resort. We assert all three branches.
//
// resolveUrl() is exported as a pure function taking { home, env } so we can drive
// it with a fake HOME + controlled env without import-order games (API_URL is a
// load-time const, so testing the const directly would require re-importing the
// module under different env each time — the pure helper sidesteps that).

const FYI = 'https://mycelium.fyi/api/mycelium'
const LOCAL = 'http://localhost:3002/api/mycelium'

let tmpHome
let api

function writeSettings(home, urlValue) {
  const dir = join(home, '.claude')
  mkdirSync(dir, { recursive: true })
  const settings = {
    mcpServers: {
      mycelium: {
        env: {
          MYCELIUM_API_KEY: 'sk_admin_test_key',
          ...(urlValue !== undefined ? { MYCELIUM_API_URL: urlValue } : {}),
        },
      },
    },
  }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'myc-mcp-home-'))
  api = await import('../../mcp/src/api.js')
})

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
})

describe('resolveUrl() — symmetric with resolveKey()', () => {
  test('settings.json wins over env (the live bug: settings-only URL must be honored)', () => {
    // This is the exact reproduction: env is UNSET, the real config lives only in
    // settings.json's mcpServers.mycelium.env. Before the fix the URL fell through
    // to the .fyi literal because resolveUrl/the URL path never read settings.json.
    writeSettings(tmpHome, LOCAL)
    const url = api.resolveUrl({ home: tmpHome, env: {} })
    expect(url).toBe(LOCAL)
    expect(url).not.toBe(FYI)
  })

  test('settings.json wins even when env disagrees (same precedence as resolveKey)', () => {
    // resolveKey treats settings.json as authoritative over env; resolveUrl must
    // use the SAME ordering so key and url never diverge onto different hosts.
    writeSettings(tmpHome, LOCAL)
    const url = api.resolveUrl({
      home: tmpHome,
      env: { MYCELIUM_API_URL: 'http://other:9999/api/mycelium' },
    })
    expect(url).toBe(LOCAL)
  })

  test('env is used when settings.json has no URL (fallback branch)', () => {
    // settings.json present but no MYCELIUM_API_URL in it → env supplies the value.
    writeSettings(tmpHome, undefined)
    const url = api.resolveUrl({ home: tmpHome, env: { MYCELIUM_API_URL: LOCAL } })
    expect(url).toBe(LOCAL)
  })

  test('env is used when settings.json is absent entirely', () => {
    // No ~/.claude/settings.json at all → env wins over the .fyi default.
    const url = api.resolveUrl({ home: tmpHome, env: { MYCELIUM_API_URL: LOCAL } })
    expect(url).toBe(LOCAL)
  })

  test('falls back to the localhost literal only when neither settings nor env provide a URL', () => {
    // Sovereignty default (2026-06-09): a self-hosting stranger who forgets the env
    // var must land on their own instance, never the deprecated hosted .fyi.
    const url = api.resolveUrl({ home: tmpHome, env: {} })
    expect(url).toBe(LOCAL)
  })

  test('exported API_URL equals resolveUrl() over the same inputs it loaded with', () => {
    // API_URL is a load-time const (api.js: `const API_URL = resolveUrl()`); the
    // no-arg resolveUrl() captures os.homedir() + process.env at import time, so
    // the value is already baked before this test can observe it. We cannot inject
    // a controlled env into that capture without re-importing the module — the
    // exact import-order games the pure { home, env } helper was added to AVOID
    // (see file header) — so an exact-value pin to a known literal is NOT cleanly
    // expressible here.
    //
    // Strongest invariant that IS expressible: replay the SAME inputs the module
    // used (real homedir + process.env) through resolveUrl and assert the baked
    // const matches. This ties API_URL to the function the five tests above prove
    // correct per-branch, without depending on what the environment resolves to.
    //
    // A regression that DECOUPLES API_URL from resolveUrl now FAILS: hardcoding
    // the const to a stale literal (the deprecated .fyi host, the bug this file
    // guards) or computing it from a different source than resolveUrl makes the
    // literal ≠ resolveUrl({ home, env }) for the live inputs. The prior
    // `typeof === 'string'` + length>0 could catch none of that — a wrong const is
    // still a non-empty string.
    //
    // Ceiling: where settings.json + process.env carry no MYCELIUM_API_URL,
    // resolveUrl returns the localhost default, so a hardcode of that exact
    // default would coincidentally still pass. That is the inherent limit of
    // load-time capture — unclosable without a re-import under controlled env —
    // and is why the five branch tests above remain the per-branch guarantee.
    expect(api.API_URL).toBe(api.resolveUrl({ home: homedir(), env: process.env }))
  })
})
