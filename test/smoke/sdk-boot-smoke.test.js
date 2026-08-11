// SDK boot smoke — minimal parity baseline for the `sdk` workspace.
//
// `@mycelium/sdk` (sdk/src) is one of the four package.json workspace
// entrypoints. Its boot surface is MyceliumAgent.boot() (sdk/src/agent.js):
// GET /boot/:agentId + POST /agents/heartbeat. F-mycelium/21 owns the RICH
// onboarding boot smoke (spawn the real server, register an agent, drive the
// full boot → heartbeat round-trip, assert the role contract). This is the
// MINIMAL parity baseline the workspace-boot-parity gate requires: the SDK's
// boot path is wired and FAILS FAST against an unreachable server instead of
// hanging. A regression that makes boot() silently swallow a dead server — or
// never settle — turns this red.
//
// Note: the SDK's sovereignty default is ALREADY localhost, not .fyi
// (sdk/src/agent.js + api.js) — there is no default-URL footgun here. That class
// of bug lives in printer-drone; see printer-drone-boot-smoke.test.js.

import { describe, test, expect } from 'vitest'
import { createServer } from 'node:net'
import { MyceliumAgent } from '../../sdk/src/index.js'

// Grab an OS-assigned ephemeral port, then release it → nothing listens, so the
// SDK's boot fetch hits a closed port and rejects immediately (ECONNREFUSED).
function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

describe('sdk boot (MyceliumAgent.boot parity baseline)', () => {
  test('boot() against an unreachable server rejects fast, does not hang', async () => {
    const port = await getEphemeralPort() // grabbed then released — nothing listens here
    const agent = new MyceliumAgent({
      agentId: 'sdk-parity-smoke',
      apiKey: 'dvk_deadbeef'.padEnd(52, '0'),
      apiUrl: `http://127.0.0.1:${port}/api/mycelium`,
    })

    const bootPromise = agent.boot()
    // Hard ceiling: if boot ever hangs instead of rejecting (the regression this
    // gate exists to catch), fail the test fast rather than waiting on the SDK's
    // own 30s request timeout.
    const hangGuard = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('boot() hung instead of rejecting on a dead server')), 5000).unref(),
    )

    await expect(Promise.race([bootPromise, hangGuard])).rejects.toThrow()
  })
})
