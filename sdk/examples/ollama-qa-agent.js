// QA Bot handler for macbook-ollama
//
// When idle (no assigned work), runs rotating test suites against
// the Mycelium API to verify features work. Files bugs on failures.
//
// Reuses ollama-agent.js for work/message/request handling.
// Adds idle-cycle QA test rotation.

import { onWork, onRequest } from './ollama-agent.js'
export { onWork, onRequest }

// Override onMessage to ignore self-messages (QA test sends messages to itself)
export async function onMessage(msg, agent) {
  if (msg.from_agent === agent.agentId) return // ignore self-messages from QA tests
  var { onMessage: _onMessage } = await import('./ollama-agent.js')
  return _onMessage(msg, agent)
}

var QA_NAMESPACE = 'macbook-ollama'
var QA_KEY = 'qa-results'

var TEST_SUITES = [
  'context_keys',
  'savepoints',
  'messaging',
  'task_lifecycle',
  'bug_lifecycle',
  'plan_lifecycle'
]

var _testIndex = 0

export async function onIdle(agent) {
  var suiteName = TEST_SUITES[_testIndex % TEST_SUITES.length]
  _testIndex++

  console.log('[qa] Running test suite: %s', suiteName)

  var result = { suite: suiteName, ts: new Date().toISOString(), passed: 0, failed: 0, errors: [] }

  try {
    switch (suiteName) {
      case 'context_keys': await testContextKeys(agent, result); break
      case 'savepoints': await testSavepoints(agent, result); break
      case 'messaging': await testMessaging(agent, result); break
      case 'task_lifecycle': await testTaskLifecycle(agent, result); break
      case 'bug_lifecycle': await testBugLifecycle(agent, result); break
      case 'plan_lifecycle': await testPlanLifecycle(agent, result); break
    }
  } catch (e) {
    result.errors.push('Suite crash: ' + e.message)
    result.failed++
  }

  console.log('[qa] %s: %d passed, %d failed', suiteName, result.passed, result.failed)

  try {
    await agent.setContext(QA_NAMESPACE, QA_KEY, JSON.stringify({
      last_suite: suiteName,
      last_run: result.ts,
      passed: result.passed,
      failed: result.failed,
      errors: result.errors.slice(0, 10)
    }))
  } catch (e) {
    console.error('[qa] Failed to save results:', e.message)
  }

  if (result.failed > 0) {
    try {
      await agent.fileBug({
        title: 'QA: ' + suiteName + ' — ' + result.failed + ' failure(s)',
        description: 'Automated QA detected failures in ' + suiteName + ' suite.\n\nErrors:\n' + result.errors.join('\n'),
        project_id: 'mycelium',
        severity: 'normal',
        category: 'api'
      })
    } catch (e) {
      console.error('[qa] Failed to file bug:', e.message)
    }
  }
}

function assert(condition, msg, result) {
  if (condition) {
    result.passed++
  } else {
    result.failed++
    result.errors.push(msg)
    console.error('[qa] FAIL: %s', msg)
  }
}

async function testContextKeys(agent, result) {
  var ns = 'qa-test'
  var key = 'test-' + Date.now()
  var testData = JSON.stringify({ test: true, ts: Date.now() })

  await agent.setContext(ns, key, testData)
  result.passed++

  var read = await agent.getContext(ns, key)
  assert(read && read.data, 'Context key read returned data', result)

  await agent.setContext(ns, key, JSON.stringify({ test: true, updated: true }))
  var history = await agent.contextHistory(ns, key, 5)
  assert(Array.isArray(history) && history.length > 0, 'Context history has entries after update', result)

  await agent.deleteContext(ns, key)
  result.passed++
}

async function testSavepoints(agent, result) {
  await agent.heartbeat({ qa_test: true, ts: Date.now() })
  result.passed++

  var profile = await agent.getProfile(agent.agentId)
  assert(profile && profile.agent_id, 'Agent profile exists after heartbeat', result)
}

async function testMessaging(agent, result) {
  await agent.sendMessage(agent.agentId, 'QA self-test message ' + Date.now())
  result.passed++

  var msgs = await agent.readMessages({ limit: 5 })
  assert(Array.isArray(msgs), 'readMessages returns array', result)
}

async function testTaskLifecycle(agent, result) {
  var task = await agent.createTask({
    title: 'QA test task ' + Date.now(),
    description: 'Automated QA — will be completed immediately',
    project_id: 'mycelium'
  })
  assert(task && task.id, 'Task created with ID', result)

  if (!task || !task.id) return

  await agent.claimTask(task.id)
  result.passed++

  await agent.completeTask(task.id, 'QA test complete')
  result.passed++
}

async function testBugLifecycle(agent, result) {
  var bug = await agent.fileBug({
    title: 'QA test bug ' + Date.now(),
    description: 'Automated QA — will be fixed immediately',
    project_id: 'mycelium',
    severity: 'low',
    category: 'other'
  })
  assert(bug && bug.id, 'Bug filed with ID', result)

  if (!bug || !bug.id) return

  await agent.claimBug(bug.id)
  result.passed++

  await agent.fixBug(bug.id, 'QA auto-fix')
  result.passed++
}

async function testPlanLifecycle(agent, result) {
  var plans = await agent.listPlans({ limit: 5 })
  assert(Array.isArray(plans), 'listPlans returns array', result)
}
