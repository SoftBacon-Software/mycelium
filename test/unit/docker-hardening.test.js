import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// Static gate for the published Docker image hardening (2026-08-11). The image
// used to run `node server/boot.js` as root (no USER directive) and ship a leaky
// build context. This gate pins the two fixes so they cannot regress WITHOUT a
// conscious test update:
//   1. The container's main process runs as a non-root user (the base image's
//      existing `node` account, uid 1000 — no custom useradd, keeps it lean).
//   2. `.dockerignore` excludes every tree the Dockerfile does not COPY (so
//      test fixtures, internal notes, stray node_modules and secrets never
//      reach the build daemon), while keeping the critical exclusions.
// It also pins `npm ci --omit=dev` (the --production alias is deprecated on
// npm v9+, which node:22-slim ships as npm 10).
//
// The runtime smoke (docker build + run + curl /health + `id -u` == 1000) is
// automated in scripts/docker-smoke.sh and runs in CI (job `docker-smoke` in
// .github/workflows/test.yml). This static gate is the COMPLEMENTARY regression
// guard — it needs no Docker daemon, so a stranger still catches a USER/
// .dockerignore regression in plain `npm test`.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8')
const dockerignore = readFileSync(resolve(ROOT, '.dockerignore'), 'utf8')

describe('Docker image hardening (non-root + least-privilege build context)', () => {
  describe('Dockerfile runs the server as a non-root user', () => {
    // The effective runtime user is the LAST USER directive in the file.
    const userLines = dockerfile
      .split('\n')
      .filter((l) => /^\s*USER\s+\S+/i.test(l) && !/^\s*#/.test(l))
    const namedUser = userLines.length
      ? userLines[userLines.length - 1].match(/^\s*USER\s+(\S+)/i)[1]
      : null

    test('declares a USER directive (does not run as uid 0)', () => {
      expect(
        userLines.length,
        'Dockerfile must declare a USER directive so the server does not run as root',
      ).toBeGreaterThan(0)
    })

    test('the named user is not root', () => {
      expect(namedUser, `USER must not be root (got "${namedUser}")`).not.toBe('root')
      expect(namedUser, `USER must not be uid 0 (got "${namedUser}")`).not.toBe('0')
    })

    test('uses the base image node user (uid 1000) — lean, no useradd', () => {
      expect(namedUser).toBe('node')
    })
  })

  test('installs deps with npm ci --omit=dev, not the deprecated --production alias', () => {
    expect(dockerfile, 'use `npm ci --omit=dev`').toMatch(/npm ci --omit=dev\b/)
    expect(dockerfile, '`--production` is the deprecated alias on npm v9+').not.toMatch(/--production/)
  })

  describe('.dockerignore excludes what the Dockerfile does not COPY', () => {
    const patterns = new Set(
      dockerignore
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    )

    test.each([
      ['.env', '.env'],
      ['.git/', '.git/'],
      ['node_modules/', 'node_modules/'],
      ['*.db', '*.db'],
      ['server/data/', 'server/data/'],
    ])('keeps critical exclusion "%s"', (_label, pattern) => {
      expect(patterns.has(pattern), `.dockerignore must include "${pattern}"`).toBe(true)
    })

    test.each([
      ['test/'],
      ['docs/'],
      ['.claude/'],
      ['admin-claude/'],
      ['studio-react/'],
      ['*.md'],
    ])('excludes non-shipped tree "%s"', (pattern) => {
      expect(
        patterns.has(pattern),
        `.dockerignore should exclude "${pattern}" (the Dockerfile does not COPY it)`,
      ).toBe(true)
    })

    test('does not carry the stale studio-react/node_modules/ line', () => {
      expect(
        patterns.has('studio-react/node_modules/'),
        'studio-react/ was retired — exclude the whole tree, not just its node_modules',
      ).toBe(false)
    })
  })
})
