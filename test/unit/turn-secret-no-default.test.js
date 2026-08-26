import { describe, test, expect } from 'vitest'
import crypto from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTurnCredentialIssuer } from '../../server/lib/turn-secret.js'

// THE BUG this gate pins: through 2026-08 a clean cold start WARNED about the
// default TURN secret and then used it anyway — server/index.js HMAC'd
// credentials with `process.env.TURN_SECRET || 'openrelayprojectsecret'`, a
// constant committed to public source, and served them against a third-party
// demo relay. Every default deployment of this public repo derived auth
// material from a public string. The fix (see server/lib/turn-secret.js):
// unset TURN_SECRET -> per-boot random secret (fail honest — external relays
// reject it); explicit TURN_SECRET -> used exactly as given; the public
// constant is gone from the tree (asserted recursively over server/ below).

const PUBLIC_DEMO_SECRET = 'openrelayprojectsecret'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_DIR = join(REPO_ROOT, 'server')
const SERVER_INDEX = join(SERVER_DIR, 'index.js')

describe('turn credential secret resolution (server/lib/turn-secret.js)', () => {
  test('unset TURN_SECRET -> generated per-boot secret, never the public demo constant', () => {
    const boot = createTurnCredentialIssuer({})
    expect(boot.generated).toBe(true)
    expect(boot.secret).toBeTruthy()
    // Assert against the literal — the string IS the bug.
    expect(boot.secret).not.toBe(PUBLIC_DEMO_SECRET)
    // 32 random bytes, hex.
    expect(boot.secret).toMatch(/^[0-9a-f]{64}$/)
  })

  test('issued credential is HMAC-SHA1 over the username under that secret (wire format preserved)', () => {
    const nowMs = 1700000000000
    const boot = createTurnCredentialIssuer({})
    const creds = boot.issue(nowMs)
    const expiry = Math.floor(nowMs / 1000) + 24 * 3600
    expect(creds.username).toBe(expiry + ':studiouser')
    const expected = crypto.createHmac('sha1', boot.secret).update(creds.username).digest('base64')
    expect(creds.credential).toBe(expected)
  })

  test('explicit TURN_SECRET is used exactly as given', () => {
    const known = 'operator-known-relay-shared-secret'
    const boot = createTurnCredentialIssuer({ TURN_SECRET: known })
    expect(boot.generated).toBe(false)
    expect(boot.secret).toBe(known)
    const creds = boot.issue(1700000000000)
    expect(crypto.createHmac('sha1', known).update(creds.username).digest('base64')).toBe(creds.credential)
  })

  test('two issuances within one boot derive from the same secret (per-boot, not per-request)', () => {
    const boot = createTurnCredentialIssuer({})
    const first = boot.issue(1700000000000)
    const second = boot.issue(1700000900000)
    // Both must verify under the boot-resolved secret — if the implementation
    // regenerated the secret per issuance, these would be keyed differently
    // and verification would fail.
    for (const creds of [first, second]) {
      expect(crypto.createHmac('sha1', boot.secret).update(creds.username).digest('base64')).toBe(creds.credential)
    }
  })

  test('two boots differ (the generated secret is random per boot)', () => {
    const a = createTurnCredentialIssuer({})
    const b = createTurnCredentialIssuer({})
    expect(a.secret).not.toBe(b.secret)
  })
})

describe('server wiring + tree hygiene', () => {
  const indexSrc = readFileSync(SERVER_INDEX, 'utf8')

  test('the secret is resolved ONCE at module scope — the route never re-resolves it', () => {
    // Exactly one construction site in index.js (module scope, in startup
    // validation). A second call site would mean per-request resolution and
    // the loss of per-boot stability.
    const callSites = indexSrc.match(/createTurnCredentialIssuer\(/g) || []
    expect(callSites.length).toBe(1)
    expect(indexSrc).toContain('createTurnCredentialIssuer(process.env)')
    // The route must issue from the shared boot-resolved issuer.
    expect(indexSrc).toContain('turnCredentials.issue(')
  })

  test('the startup warning reflects the new behavior (the old confession is gone)', () => {
    expect(indexSrc).not.toContain('using default OpenRelay secret')
    expect(indexSrc).toContain('per-boot random TURN credential secret')
  })

  test('the public demo secret literal exists nowhere under server/', () => {
    // The DONE criterion of the fix, made permanent: the constant cannot
    // come back (in this file, a future refactor, or a vendored copy)
    // without this gate going red. Skips runtime data and dependencies.
    const offenders = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'data' || entry === 'node_modules') continue
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) {
          walk(full)
        } else if (st.size <= 512 * 1024 && readFileSync(full, 'utf8').includes(PUBLIC_DEMO_SECRET)) {
          offenders.push(full)
        }
      }
    }
    walk(SERVER_DIR)
    expect(offenders, 'files still carrying the public demo secret: ' + offenders.join(', ')).toEqual([])
  })
})
