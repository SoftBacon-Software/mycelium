import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import { resolveTrustProxy } from '../../server/lib/trust-proxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(
  path.resolve(__dirname, '..', '..', 'server', 'index.js'),
  'utf8'
)

// index.js calls app.listen() (and boots DB + plugins) at import time, so it
// can't be imported into a unit test. We therefore (1) unit-test the pure
// resolver that index.js delegates to, (2) feed its result to a real Express
// app to assert the exact `app.settings['trust proxy']` value, and (3) guard
// that index.js actually wires the resolver — so a revert to a hardcoded
// `app.set('trust proxy', true)` reds here.

describe('TRUST_PROXY env knob', () => {
  describe('resolveTrustProxy', () => {
    test('DEFAULT is preserved: unset / empty / "true" -> true', () => {
      expect(resolveTrustProxy({})).toBe(true)
      expect(resolveTrustProxy({ TRUST_PROXY: '' })).toBe(true)
      expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(true)
      expect(resolveTrustProxy(undefined)).toBe(true) // defensive: no env object
    })

    test('"false" disables trust proxy (the direct-exposed escape hatch)', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false)
    })

    test('a bare number is parsed as a proxy hop count', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: '1' })).toBe(1)
      expect(resolveTrustProxy({ TRUST_PROXY: '3' })).toBe(3)
    })

    test('other strings pass through verbatim (CIDR / proxy lists)', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })).toBe(
        'loopback, 10.0.0.0/8'
      )
    })
  })

  test('index.js wires the resolver to app.set (no hardcoded true)', () => {
    expect(indexSrc).toContain(
      "app.set('trust proxy', resolveTrustProxy(process.env))"
    )
    expect(indexSrc).not.toContain("app.set('trust proxy', true)")
  })

  describe('fed to a real Express app', () => {
    test('app.settings["trust proxy"] === false when TRUST_PROXY=false', () => {
      const app = express()
      app.set('trust proxy', resolveTrustProxy({ TRUST_PROXY: 'false' }))
      expect(app.settings['trust proxy']).toBe(false)
    })

    test('app.settings["trust proxy"] === true by default (behavior unchanged)', () => {
      const app = express()
      app.set('trust proxy', resolveTrustProxy({}))
      expect(app.settings['trust proxy']).toBe(true)
    })
  })
})
