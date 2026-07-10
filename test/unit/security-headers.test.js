import { describe, test, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  SECURITY_HEADERS,
  CSP_VALUE,
  HSTS_VALUE,
  securityHeadersMiddleware
} from '../../server/lib/security-headers.js'

// Minimal app: just the middleware + two representative routes (an HTML doc and
// a JSON API response). The middleware is global in server/index.js; this proves
// the policy it stamps onto res regardless of handler.
function buildApp() {
  const app = express()
  app.use(securityHeadersMiddleware())
  app.get('/', (req, res) => res.type('text/html').send('<!doctype html><p>ok</p>'))
  app.get('/api/mycelium/ping', (req, res) => res.json({ ok: true }))
  return app
}

describe('security-headers middleware (public-site + API origin policy)', () => {
  const app = buildApp()

  test('every declared header is present with its exact value on an HTML response', async () => {
    const res = await request(app).get('/')
    for (const [key, value] of SECURITY_HEADERS) {
      expect(res.headers[key.toLowerCase()], `header ${key}`).toBe(value)
    }
  })

  test('Strict-Transport-Security is set (HSTS cannot be a <meta> tag — header is the only origin)', async () => {
    const res = await request(app).get('/')
    expect(res.headers['strict-transport-security']).toBe(HSTS_VALUE)
    // Real max-age, includes subdomains, no accidental preload (one-way door).
    expect(HSTS_VALUE).toMatch(/^max-age=\d+; includeSubDomains$/)
    expect(HSTS_VALUE).not.toContain('preload')
  })

  test('Content-Security-Policy locks the site down (no eval, no wildcards, no plugins, no framing)', async () => {
    const res = await request(app).get('/')
    expect(res.headers['content-security-policy']).toBe(CSP_VALUE)
    expect(CSP_VALUE).toContain("default-src 'self'")
    expect(CSP_VALUE).toContain("object-src 'none'")
    expect(CSP_VALUE).toContain("base-uri 'self'")
    expect(CSP_VALUE).toContain("frame-ancestors 'none'")
    // 'unsafe-eval' is the one directive that would re-open real script injection /
    // prototype-pollution-to-RCE — the policy must never carry it.
    expect(CSP_VALUE).not.toContain("'unsafe-eval'")
    // No wildcard hosts/sources anywhere.
    expect(CSP_VALUE).not.toMatch(/\*/)
  })

  test('X-Frame-Options: DENY backs up CSP frame-ancestors none for legacy browsers', async () => {
    const res = await request(app).get('/')
    expect(res.headers['x-frame-options']).toBe('DENY')
  })

  test('the legacy XSS auditor is explicitly disabled (X-XSS-Protection: 0)', async () => {
    const res = await request(app).get('/')
    expect(res.headers['x-xss-protection']).toBe('0')
  })

  test('headers also apply to JSON API responses (defense in depth)', async () => {
    const res = await request(app).get('/api/mycelium/ping')
    expect(res.headers['strict-transport-security']).toBe(HSTS_VALUE)
    expect(res.headers['content-security-policy']).toBe(CSP_VALUE)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
  })

  test('OPTIONS (preflight) responses are also stamped', async () => {
    const res = await request(app).options('/')
    expect(res.headers['strict-transport-security']).toBe(HSTS_VALUE)
    expect(res.headers['content-security-policy']).toBe(CSP_VALUE)
  })
})
