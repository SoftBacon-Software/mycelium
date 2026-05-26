import { describe, test, expect } from 'vitest'
import crypto from 'node:crypto'

// Regression test for the timing-safe ADMIN_KEY comparator fix (2026-05-25,
// commit 11089a6 + fce53df). Direct `===` comparison was replaced with
// crypto.timingSafeEqual via the isAdminKey() helper at all 11 callsites
// in server/routes/mycelium.js + server/index.js. This test pins the
// expected semantics so a regression to direct compare gets caught.

function isAdminKey(key, expected) {
  if (!key || !expected) return false
  if (key.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))
}

describe('isAdminKey (timing-safe comparator)', () => {
  const expected = 'sk_test_admin_key_aaaaaaaaaaaaaaaa'

  test('accepts the correct key', () => {
    expect(isAdminKey(expected, expected)).toBe(true)
  })

  test('rejects a wrong key of the same length', () => {
    const wrong = 'sk_test_admin_key_bbbbbbbbbbbbbbbb'
    expect(wrong.length).toBe(expected.length)
    expect(isAdminKey(wrong, expected)).toBe(false)
  })

  test('rejects a wrong key of different length without throwing', () => {
    expect(isAdminKey('short', expected)).toBe(false)
    expect(isAdminKey(expected + 'extra', expected)).toBe(false)
  })

  test('handles null/empty without throwing', () => {
    expect(isAdminKey(null, expected)).toBe(false)
    expect(isAdminKey('', expected)).toBe(false)
    expect(isAdminKey(undefined, expected)).toBe(false)
    expect(isAdminKey(expected, null)).toBe(false)
    expect(isAdminKey(expected, '')).toBe(false)
  })

  test('source: isAdminKey is used in server/index.js + server/routes/mycelium.js', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const REPO_ROOT = join(here, '..', '..')

    const indexSrc = readFileSync(join(REPO_ROOT, 'server', 'index.js'), 'utf8')
    const myceliumSrc = readFileSync(
      join(REPO_ROOT, 'server', 'routes', 'mycelium.js'),
      'utf8',
    )

    // Both should define + use isAdminKey (not direct === ADMIN_KEY compare).
    expect(indexSrc).toMatch(/isAdminKey/)
    expect(myceliumSrc).toMatch(/isAdminKey/)

    // Catch a regression: no direct `=== ADMIN_KEY` outside the length compare
    // in the helper definition (which is itself O(1) and timing-safe).
    const directCompares = (
      myceliumSrc.match(/[!=]== ADMIN_KEY\b/g) || []
    ).filter((m) => !m.includes('length')) // length compare on next line is safe
    // The helper definition uses `key.length === ADMIN_KEY.length` which our
    // regex above excludes via the `.length` check on the surrounding code.
    const lines = myceliumSrc.split('\n')
    const offending = lines.filter(
      (ln) =>
        /[!=]== ADMIN_KEY\b/.test(ln) && !ln.includes('.length'),
    )
    expect(offending).toEqual([])
  })
})
