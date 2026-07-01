// Verifies the fix for: agent.stop() strands the work loop's poll-pause Promise
// (clearTimeout cancels the timer but the resolve is unreachable → the loop hangs).
//
// Run:  node --test sdk/test/agent_stop.test.js

import { test } from 'node:test'
import assert from 'node:assert'
import { MyceliumAgent } from '../src/agent.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('stop() terminates the work loop promptly — does not hang', async () => {
  const agent = new MyceliumAgent({
    agentId: 'test-agent',
    apiKey: 'test-key',
    pollInterval: 100,        // short so the test is fast
    heartbeatInterval: 600000 // never fires during this test
  })

  // Stub the HTTP client so NO real network is needed. getWork() calls
  // api.get() → {} (no `.claimed`), so the loop just idles and polls.
  agent.api = {
    get: async () => ({}),
    post: async () => ({}),
    put: async () => ({}),
    del: async () => ({})
  }

  // start() only launches the work loop when a handler is registered.
  agent.onIdle(async () => {})

  // Capture the work-loop promise so we can assert it actually settles.
  let loopPromise
  const realStartWorkLoop = agent._startWorkLoop.bind(agent)
  agent._startWorkLoop = function () {
    loopPromise = realStartWorkLoop()
    return loopPromise
  }

  agent.start()

  // Let the loop run a poll and settle into its poll-pause.
  await sleep(150)

  let settled = false
  loopPromise.then(() => { settled = true })

  const t0 = Date.now()
  await agent.stop()
  const stopElapsed = Date.now() - t0

  // Grace window for the loop to unwind after stop() resolves the pause.
  await sleep(300)

  assert.strictEqual(agent._running, false, '_running must be false after stop()')
  assert.ok(stopElapsed < 1000, `stop() took ${stopElapsed}ms, expected < 1000ms`)
  // This is the assertion that catches the bug: without the fix the loop's
  // poll-pause Promise never resolves, so loopPromise never settles.
  assert.ok(settled, 'work loop did NOT terminate after stop() — it hung (the bug)')
})
