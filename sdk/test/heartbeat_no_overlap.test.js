// Fix under test: start() used setInterval for heartbeats. setInterval fires on
// a fixed cadence regardless of whether the previous async beat has settled, so
// when server latency exceeds the interval multiple heartbeats overlap (stampede).
// The fix reschedules the next beat only after the current one settles, so at
// most one heartbeat is ever in flight.
//
// Run:  node --test sdk/test/heartbeat_no_overlap.test.js

import { test } from 'node:test'
import assert from 'node:assert'
import { MyceliumAgent } from '../src/agent.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('heartbeats do not overlap when a beat takes longer than the interval', async () => {
  const agent = new MyceliumAgent({
    agentId: 'test-agent',
    apiUrl: 'http://localhost:9/api/mycelium',
    apiKey: 'test-key',
    heartbeatInterval: 50,    // very short cadence
    pollInterval: 600000      // not exercised — no work handler registered
  })

  // No network. stop() issues a final api.post heartbeat, so stub the client.
  agent.api = {
    get: async () => ({}),
    post: async () => ({}),
    put: async () => ({}),
    del: async () => ({})
  }

  // Slow heartbeat: each beat takes 80ms — LONGER than the 50ms interval. With
  // the old setInterval this would fire ~5 times in 250ms (overlapping beats);
  // with the self-rescheduling fix beats are serial.
  let beats = 0
  agent.heartbeat = async () => {
    beats++
    await sleep(80)
  }

  agent.start()
  await sleep(250)
  await agent.stop()

  // Fixed (self-rescheduling): ~2 beats in the window — first starts at ~50ms,
  // settles at ~130ms, the next is scheduled at +50ms = ~180ms. The old
  // setInterval would have fired ~5. The wide ceiling avoids timing flakiness
  // while still proving no stampede.
  assert.ok(beats >= 1, `expected at least one heartbeat, got ${beats}`)
  assert.ok(
    beats <= 3,
    `heartbeats overlapped — ${beats} beats fired in 250ms with an 80ms beat (the bug)`
  )
})
