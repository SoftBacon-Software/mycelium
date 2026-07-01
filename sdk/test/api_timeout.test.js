// Fix under test: request()'s fetch() had no timeout, so a hung/dropped backend
// connection left the promise pending forever (zombie agent, stalled loops).
// The fix attaches AbortSignal.timeout(defaultTimeout) so a hung request aborts.
// defaultTimeout is configurable via the client's `timeout` option (default 30s).
//
// Run:  node --test sdk/test/api_timeout.test.js

import { test } from 'node:test'
import assert from 'node:assert'
import { createClient } from '../src/api.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('a hung request aborts after the configured timeout, not forever', async () => {
  const realFetch = globalThis.fetch
  // Hung connection that rejects only when the abort signal fires — mirroring
  // how a real fetch rejects when AbortSignal.timeout elapses.
  globalThis.fetch = (url, opts = {}) => new Promise((_, reject) => {
    const signal = opts.signal
    if (!signal) return // never resolves (defensive; we always pass a signal)
    if (signal.aborted) {
      const e = new Error('The operation timed out'); e.name = 'TimeoutError'; return reject(e)
    }
    signal.addEventListener('abort', () => {
      const e = new Error('The operation timed out'); e.name = 'TimeoutError'; reject(e)
    })
  })

  try {
    const api = createClient({
      apiUrl: 'http://localhost:9/api/mycelium',
      apiKey: 'x',
      timeout: 50
    })

    const start = Date.now()
    await assert.rejects(
      () => api.get('/test'),
      (err) => err.name === 'TimeoutError' || /timeout|abort/i.test(err.message)
    )
    const elapsed = Date.now() - start

    assert.ok(elapsed < 1000, `request should abort quickly, took ${elapsed}ms`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('default 30s timeout is used when not overridden', async () => {
  const realFetch = globalThis.fetch
  const realTimeout = AbortSignal.timeout
  // Capture the timeout the client requested WITHOUT arming a real 30s timer
  // (which would keep the test process alive for 30s). Return a benign signal.
  let requestedMs = null
  AbortSignal.timeout = (ms) => { requestedMs = ms; return new AbortController().signal }
  globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 200 }))

  try {
    const api = createClient({ apiUrl: 'http://localhost:9/api/mycelium', apiKey: 'x' })
    await api.get('/test')
    assert.strictEqual(requestedMs, 30000, 'default timeout should be 30000ms')
  } finally {
    globalThis.fetch = realFetch
    AbortSignal.timeout = realTimeout
  }
})

test('constructor timeout override is respected', async () => {
  const realFetch = globalThis.fetch
  const realTimeout = AbortSignal.timeout
  let requestedMs = null
  AbortSignal.timeout = (ms) => { requestedMs = ms; return new AbortController().signal }
  globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 200 }))

  try {
    const api = createClient({
      apiUrl: 'http://localhost:9/api/mycelium',
      apiKey: 'x',
      timeout: 5000
    })
    await api.get('/test')
    assert.strictEqual(requestedMs, 5000, 'constructor timeout override should be used')
  } finally {
    globalThis.fetch = realFetch
    AbortSignal.timeout = realTimeout
  }
})
