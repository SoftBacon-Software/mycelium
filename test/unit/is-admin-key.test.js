import { describe, test, expect } from 'vitest'

describe('isAdminKey null-guard', () => {
  test('returns false without throwing when ADMIN_KEY env is missing', async () => {
    const saved = process.env.ADMIN_KEY
    delete process.env.ADMIN_KEY
    // Re-import to pick up the cleared env (pool: forks isolates module state)
    const { isAdminKey } = await import('../../server/routes/mycelium.js')
    expect(() => isAdminKey('x')).not.toThrow()
    expect(isAdminKey('x')).toBe(false)
    process.env.ADMIN_KEY = saved
  })
})