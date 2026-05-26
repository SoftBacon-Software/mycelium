import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

describe('repo metadata', () => {
  test('LICENSE file exists and declares AGPL-3.0', () => {
    const licensePath = join(REPO_ROOT, 'LICENSE')
    expect(existsSync(licensePath)).toBe(true)
    const text = readFileSync(licensePath, 'utf8')
    expect(text).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/i)
    expect(text).toMatch(/Version 3/i)
  })

  test('package.json version is valid semver', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    )
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })

  test('package.json license matches LICENSE file', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    )
    expect(pkg.license).toBe('AGPL-3.0-only')
  })

  test('SECURITY.md and CONTRIBUTING.md exist (OSS hygiene)', () => {
    expect(existsSync(join(REPO_ROOT, 'SECURITY.md'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'CONTRIBUTING.md'))).toBe(true)
  })
})
