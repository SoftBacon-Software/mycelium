import { describe, test, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

describe('boot env validation', () => {
  test('server exits non-zero with FATAL on stderr when ADMIN_KEY + JWT_SECRET are unset', () => {
    // Inherit the host env but explicitly strip the two required secrets so the
    // child hits the startup-validation guard regardless of the test runner's env.
    const env = { ...process.env }
    delete env.ADMIN_KEY
    delete env.JWT_SECRET

    const result = spawnSync('node', ['server/index.js'], {
      cwd: repoRoot,
      env,
      timeout: 15000,
      encoding: 'utf8'
    })

    // The process must terminate (not be killed by the timeout).
    expect(result.status, 'server should exit on its own, not time out').not.toBeNull()
    // Non-zero exit code.
    expect(result.status).not.toBe(0)
    // The FATAL guard message must appear on stderr.
    expect(result.stderr, 'stderr should contain the FATAL message').toContain('FATAL')
  })
})
