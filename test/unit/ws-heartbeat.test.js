import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

// Task 186 §2 (AUDIT-lab-clockwork-2026-09-12): the voice (10s) and file-drone
// (15s) WebSocket ping timers ran unconditionally from boot and were never
// .unref()'d — two live timers for surfaces with ZERO clients today. They now
// start lazily on the first client connection and are unref'd so they never
// hold the process open.

import { createHeartbeat } from '../../server/lib/ws-heartbeat.js'

function fakeWs(alive) {
  return {
    isAlive: alive,
    pinged: 0,
    terminated: false,
    ping() { this.pinged++ },
    terminate() { this.terminated = true },
  }
}

describe('ws-heartbeat (task 186 §2)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('no timer until the first client connects', () => {
    var clients = []
    var hb = createHeartbeat({ clients: () => clients, intervalMs: 10000 })
    expect(hb.isRunning()).toBe(false)
    vi.advanceTimersByTime(60000)
    expect(hb.isRunning()).toBe(false) // nothing scheduled
  })

  test('ensure() starts exactly one interval; idempotent on every connection', () => {
    var clients = []
    var hb = createHeartbeat({ clients: () => clients, intervalMs: 10000 })
    hb.ensure()
    hb.ensure()
    hb.ensure()
    expect(hb.isRunning()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  test('the timer is unref\'d — it never holds the daemon open', () => {
    // Real timers here (fake-timer objects have no meaningful unref): wrap
    // global setInterval so we can observe the lib calling .unref() on the
    // returned Node Timeout, then stop() the real timer immediately.
    var captured = null
    var orig = globalThis.setInterval
    globalThis.setInterval = function (fn, ms) {
      var t = orig(fn, ms)
      var calls = { unref: 0 }
      var realUnref = t.unref.bind(t)
      t.unref = function () { calls.unref++; return realUnref() }
      captured = { timer: t, calls: calls }
      return t
    }
    var hb
    try {
      hb = createHeartbeat({ clients: () => [], intervalMs: 10000 })
      hb.ensure()
    } finally {
      globalThis.setInterval = orig
    }
    expect(captured).not.toBe(null)
    expect(captured.calls.unref).toBe(1)
    hb.stop()
  })

  test('tick pings live clients and marks them for the next round', () => {
    var a = fakeWs(true)
    var hb = createHeartbeat({ clients: () => [a], intervalMs: 10000 })
    hb.ensure()
    vi.advanceTimersByTime(10000)
    expect(a.pinged).toBe(1)
    expect(a.isAlive).toBe(false) // must pong before the next tick
    a.isAlive = true
    vi.advanceTimersByTime(10000)
    expect(a.pinged).toBe(2)
  })

  test('a dead client is terminated, onDead runs first (voice cleanup seam)', () => {
    var dead = []
    var a = fakeWs(false)
    var hb = createHeartbeat({
      clients: () => [a],
      intervalMs: 10000,
      onDead: (ws) => dead.push(ws),
    })
    hb.ensure()
    vi.advanceTimersByTime(10000)
    expect(dead).toEqual([a])
    expect(a.terminated).toBe(true)
  })

  test('stop() clears the timer', () => {
    var hb = createHeartbeat({ clients: () => [], intervalMs: 10000 })
    hb.ensure()
    hb.stop()
    expect(hb.isRunning()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('an empty client list ticks harmlessly (the zero-clients shape)', () => {
    var hb = createHeartbeat({ clients: () => [], intervalMs: 10000 })
    hb.ensure()
    expect(() => vi.advanceTimersByTime(30000)).not.toThrow()
  })
})
