// QA Bot handler for macbook-ollama
//
// When idle (no assigned work), runs rotating test suites against
// the Mycelium API to verify features work. Files bugs on failures.
//
// Reuses ollama-agent.js for work/message/request handling.
// Adds idle-cycle QA test rotation.
//
// Fix history:
//   v2 — Fixed feedback loop: added max bugs per day, persistent cooldown
//         via context key, and proper cleanup of lifecycle test artifacts.

import { onWork, onRequest } from './ollama-agent.js'
export { onWork, onRequest }

// Override onMessage to ignore self-messages (QA test sends messages to itself)
export async function onMessage(msg, agent) {
  if (msg.from_agent === agent.agentId) return
  var { onMessage: _onMessage } = await import('./ollama-agent.js')
  return _onMessage(msg, agent)
}

var QA_NAMESPACE = 'macbook-ollama'
var QA_KEY = 'qa-results'
var QA_STATE_KEY = 'qa-state'

var TEST_SUITES = [
  'context_keys',
  'savepoints',
  'messaging',
  'task_lifecycle',
  'bug_lifecycle',
  'plan_lifecycle'
]

var QA_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes between QA cycles
var MAX_BUGS_PER_DAY = 3 // stop filing after this many per calendar day
var _cachedState = null // in-memory cache — loaded from context once, then kept in memory

export async function onIdle(agent) {
  // Load from context only on first idle call (survives restarts via context)
  if (!_cachedState) {
    _cachedState = await loadQaState(agent)
  }
  var state = _cachedState

  // Cooldown check — always works because state is in memory
  var now = Date.now()
  if (now - state.lastRun < QA_COOLDOWN_MS) return

  // Daily bug cap — reset at midnight UTC
  var today = new Date().toISOString().slice(0, 10)
  if (state.bugDay !== today) {
    state.bugDay = today
    state.bugsToday = 0
  }

  var suiteName = TEST_SUITES[state.testIndex % TEST_SUITES.length]
  state.testIndex++
  state.lastRun = now

  console.log('[qa] Running test suite: %s', suiteName)

  // Cleanup stale test artifacts before running
  try { await cleanupTestArtifacts(agent) } catch (e) {
    console.error('[qa] Cleanup failed:', e.message)
  }

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

  // Save results
  try {
    await agent.setContext(QA_NAMESPACE, QA_KEY, JSON.stringify({
      last_suite: suiteName,
      last_run: result.ts,
      passed: result.passed,
      failed: result.failed,
      errors: result.errors.slice(0, 5)
    }))
  } catch (e) {
    console.error('[qa] Failed to save results:', e.message)
  }

  // File bug only if under daily cap and not a duplicate suite within this session
  if (result.failed > 0 && state.bugsToday < MAX_BUGS_PER_DAY) {
    var lastBugForSuite = state.suiteBugTimes[suiteName] || 0
    if (now - lastBugForSuite > 60 * 60 * 1000) {
      try {
        await agent.fileBug({
          title: 'QA: ' + suiteName + ' — ' + result.failed + ' failure(s)',
          description: 'Automated QA detected failures in ' + suiteName + ' suite.\n\nErrors:\n' + result.errors.join('\n'),
          project_id: 'mycelium',
          severity: 'normal',
          category: 'api'
        })
        state.suiteBugTimes[suiteName] = now
        state.bugsToday++
        console.log('[qa] Bug filed for %s (%d/%d today)', suiteName, state.bugsToday, MAX_BUGS_PER_DAY)
      } catch (e) {
        console.error('[qa] Failed to file bug:', e.message)
      }
    } else {
      console.log('[qa] Skipping bug for %s — already filed within the last hour', suiteName)
    }
  } else if (result.failed > 0) {
    console.log('[qa] Skipping bug — daily cap reached (%d/%d)', state.bugsToday, MAX_BUGS_PER_DAY)
  }

  // Persist state so cooldowns survive restarts
  await saveQaState(agent, state)
}

async function loadQaState(agent) {
  try {
    var raw = await agent.getContext(QA_NAMESPACE, QA_STATE_KEY)
    if (raw && raw.data) {
      var parsed = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data
      return {
        testIndex: parsed.testIndex || 0,
        lastRun: parsed.lastRun || 0,
        bugDay: parsed.bugDay || '',
        bugsToday: parsed.bugsToday || 0,
        suiteBugTimes: parsed.suiteBugTimes || {}
      }
    }
  } catch (e) { /* first run */ }
  return { testIndex: 0, lastRun: 0, bugDay: '', bugsToday: 0, suiteBugTimes: {} }
}

async function saveQaState(agent, state) {
  try {
    await agent.setContext(QA_NAMESPACE, QA_STATE_KEY, JSON.stringify(state))
  } catch (e) {
    console.error('[qa] Failed to persist QA state:', e.message)
  }
}

async function cleanupTestArtifacts(agent) {
  try {
    var keys = await agent.getContext('qa-test')
    if (keys && typeof keys === 'object') {
      var keyNames = Object.keys(keys)
      for (var k of keyNames) {
        if (k.startsWith('test-')) {
          await agent.deleteContext('qa-test', k)
        }
      }
      if (keyNames.length > 0) {
        console.log('[qa] Cleaned up %d stale test keys', keyNames.length)
      }
    }
  } catch (e) { /* namespace may not exist */ }
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

  // Always clean up test key
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
  var msgs = await agent.readMessages({ limit: 5 })
  assert(Array.isArray(msgs), 'readMessages returns array', result)
}

async function testTaskLifecycle(agent, result) {
  var task = null
  try {
    task = await agent.createTask({
      title: '[QA] lifecycle test ' + Date.now(),
      description: 'Automated QA — safe to delete.',
      project_id: 'mycelium'
    })
    assert(task && task.id, 'Task created with ID', result)
    if (!task || !task.id) return

    await agent.claimTask(task.id)
    result.passed++

    await agent.completeTask(task.id, 'QA test complete')
    result.passed++
  } catch (e) {
    result.failed++
    result.errors.push('Task lifecycle: ' + e.message)
  }
}

async function testBugLifecycle(agent, result) {
  var bug = null
  try {
    bug = await agent.fileBug({
      title: '[QA] lifecycle test ' + Date.now(),
      description: 'Automated QA — safe to delete.',
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
  } catch (e) {
    result.failed++
    result.errors.push('Bug lifecycle: ' + e.message)
  }
}

async function testPlanLifecycle(agent, result) {
  var plans = await agent.listPlans({ limit: 5 })
  assert(Array.isArray(plans), 'listPlans returns array', result)
}
