import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// Security regression: the plugin registry URL MUST be pinned to a specific
// commit SHA, never a moving branch (main/master/HEAD). Otherwise a compromised
// branch on SoftBacon-Software/mycelium-plugins could push arbitrary plugin
// manifests to every install. These tests pin that contract.
//
// Harness mirrors test/unit/auth-roles.test.js: real router, fresh temp DB, env
// set before the dynamic import; pool:'forks' isolates us.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let db
let app
let REGISTRY_URL

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-registry-pin-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routesMod = await import('../../server/routes/mycelium.js')
  REGISTRY_URL = routesMod.REGISTRY_URL
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routesMod.default)
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('plugin registry commit-pinning', () => {
  test('REGISTRY_URL is pinned to a 40-char commit SHA, not a moving branch', () => {
    // Must contain a 40-char lowercase-hex commit SHA path segment ...
    expect(REGISTRY_URL).toMatch(/\/[0-9a-f]{40}\//)
    // ... and must NOT point at a moving ref.
    expect(REGISTRY_URL).not.toMatch(/\/(main|master|HEAD)\//)
  })

  test('registry refresh fetches the pinned commit URL (not a moving branch)', async () => {
    const fetched = vi.fn(async () => ({
      ok: true,
      json: async () => ({ plugins: [] }),
    }))
    const origFetch = globalThis.fetch
    globalThis.fetch = fetched
    try {
      const res = await request(app)
        .get('/api/mycelium/plugins/registry')
        .set('X-Admin-Key', ADMIN_KEY)
        .set('X-Acting-As', 'admin')
      expect(res.status).toBe(200)
      expect(fetched).toHaveBeenCalled()
      // The URL handed to fetch must be the pinned commit URL, verbatim.
      expect(fetched).toHaveBeenCalledWith(REGISTRY_URL)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
