// Fix under test: when the work handler threw, _startWorkLoop only logged and
// reset workingOn, leaving the server-side task stranded in in_progress forever
// (an orphan). The fix reports the failure via updateTask so the task transitions
// out of in_progress. 'failed' is not a valid server status, so it uses
// 'cancelled' with a note carrying the error.
//
// Run:  node --test sdk/test/orphaned_task_failure.test.js

import { test } from 'node:test'
import assert from 'node:assert'
import { MyceliumAgent } from '../src/agent.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('a throwing work handler reports the task as cancelled, not orphaned', async () => {
  const agent = new MyceliumAgent({
    agentId: 'test-agent',
    apiUrl: 'http://localhost:9/api/mycelium',
    apiKey: 'test-key',
    pollInterval: 50,
    heartbeatInterval: 600000   // not exercised
  })

  const puts = []
  agent.api = {
    // The work queue hands back a claimed task item.
    get: async () => ({ claimed: { id: 42, type: 'task', title: 'do the thing' } }),
    post: async () => ({}),
    put: async (path, body) => { puts.push({ path, body }); return {} },
    del: async () => ({})
  }

  // The handler throws on every item.
  agent.onWork(async () => { throw new Error('boom') })

  agent.start()
  // First loop iteration runs immediately: claim → throw → report. 120ms is
  // plenty for one full cycle to complete and reset workingOn.
  await sleep(120)
  await agent.stop()

  const report = puts.find((p) => p.path === '/tasks/42')
  assert.ok(
    report,
    'updateTask was never called for the failed task — it was orphaned in in_progress (the bug)'
  )
  assert.strictEqual(report.body.status, 'cancelled')
  assert.strictEqual(report.body.notes, 'Handler error: boom')
  assert.strictEqual(agent.workingOn, '', 'workingOn must be reset after the handler error')
})
