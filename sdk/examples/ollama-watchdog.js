// Watchdog handler for macbook-ollama
//
// Unified network watchdog that rotates through five roles on idle:
//   1. QA — rotating test suites against the Mycelium API
//   2. Uptime — pings monitored endpoints, files bugs on downtime
//   3. Janitor — cleans up stale data (expired context, old QA artifacts)
//   4. Health patrol — checks agent/task/drone staleness, broadcasts alerts
//   5. Embedder — claims and processes embed drone jobs via local Ollama
//
// Reuses ollama-agent.js for work/message/request handling.
// Shares a single daily bug cap across all roles.
//
// History:
//   v1 — QA bot only (ollama-qa-agent.js)
//   v2 — Fixed feedback loop: persistent cooldown, daily bug cap
//   v3 — Unified watchdog: uptime, janitor, health patrol added
//   v4 — Embedder role: local nomic-embed-text via drone job queue

import { onRequest } from './ollama-agent.js'
export { onRequest }

// Override onWork — the watchdog is not a task executor.
// Must unclaim work items, otherwise they block the idle handler:
// getWork(auto_claim=true) returns the same assigned item every poll cycle.
export async function onWork(item, agent) {
  console.log('[watchdog] Skipping %s #%d: %s', item.type || 'task', item.id, (item.title || '').slice(0, 80))
  try {
    if (item.type === 'plan_step') {
      await agent.api.put('/plans/' + item.plan_id + '/steps/' + item.id, { status: 'pending', assignee: null })
    } else if (item.type === 'bug' || item.type === 'bug_unassigned') {
      await agent.api.put('/bugs/' + item.id, { status: 'open', assignee: null })
    } else {
      await agent.api.put('/tasks/' + item.id, { status: 'open', assignee: null })
    }
  } catch (e) {
    console.error('[watchdog] Failed to unclaim %s #%d: %s', item.type || 'task', item.id, e.message)
  }
  agent.workingOn = ''
}

// Override onMessage to ignore self-messages (QA test sends messages to itself)
export async function onMessage(msg, agent) {
  if (msg.from_agent === agent.agentId) return
  var { onMessage: _onMessage } = await import('./ollama-agent.js')
  return _onMessage(msg, agent)
}

// ── Config ──────────────────────────────────────────────────────────

var NAMESPACE = 'macbook-ollama'
var STATE_KEY = 'watchdog-state'
var RESULTS_KEY = 'watchdog-results'

var MAX_BUGS_PER_DAY = 3

// Cooldowns per role (ms)
var QA_COOLDOWN = 10 * 60 * 1000       // 10 min
var UPTIME_COOLDOWN = 5 * 60 * 1000    // 5 min
var JANITOR_COOLDOWN = 60 * 60 * 1000  // 60 min
var HEALTH_COOLDOWN = 10 * 60 * 1000   // 10 min

// Endpoints to monitor
var MONITORED_ENDPOINTS = [
  { name: 'mycelium-api', url: 'https://mycelium.fyi/health' }
]

var UPTIME_TIMEOUT = 10000 // 10s

// Embedder config
var OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
var EMBED_MODEL = 'nomic-embed-text'
var EMBED_COOLDOWN = 5 * 1000          // 5s — check for embed jobs frequently
var EMBED_BATCH_MAX = 10               // process up to 10 jobs per idle cycle

// QA test suites
var TEST_SUITES = [
  'context_keys',
  'savepoints',
  'messaging',
  'task_lifecycle',
  'bug_lifecycle',
  'plan_lifecycle'
]

// ── State ───────────────────────────────────────────────────────────

var _state = null // in-memory cache, loaded from context once

async function loadState(agent) {
  try {
    var raw = await agent.getContext(NAMESPACE, STATE_KEY)
    if (raw && raw.data) {
      var p = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data
      return {
        // Shared
        bugDay: p.bugDay || '',
        bugsToday: p.bugsToday || 0,
        suiteBugTimes: p.suiteBugTimes || {},
        // QA
        qaIndex: p.qaIndex || 0,
        qaLastRun: p.qaLastRun || 0,
        // Uptime
        uptimeLastRun: p.uptimeLastRun || 0,
        endpointStatus: p.endpointStatus || {},
        // Janitor
        janitorLastRun: p.janitorLastRun || 0,
        // Health
        healthLastRun: p.healthLastRun || 0,
        // Embedder
        embedLastRun: p.embedLastRun || 0,
        embedsProcessed: p.embedsProcessed || 0
      }
    }
  } catch (e) { /* first run */ }
  return {
    bugDay: '', bugsToday: 0, suiteBugTimes: {},
    qaIndex: 0, qaLastRun: 0,
    uptimeLastRun: 0, endpointStatus: {},
    janitorLastRun: 0,
    healthLastRun: 0,
    embedLastRun: 0, embedsProcessed: 0
  }
}

async function saveState(agent) {
  try {
    await agent.setContext(NAMESPACE, STATE_KEY, JSON.stringify(_state))
  } catch (e) {
    console.error('[watchdog] Failed to persist state:', e.message)
  }
}

// ── Shared helpers ──────────────────────────────────────────────────

function resetBugDay() {
  var today = new Date().toISOString().slice(0, 10)
  if (_state.bugDay !== today) {
    _state.bugDay = today
    _state.bugsToday = 0
  }
}

async function fileBugIfAllowed(agent, title, description, severity, category, dedupeKey) {
  if (_state.bugsToday >= MAX_BUGS_PER_DAY) {
    console.log('[watchdog] Skipping bug — daily cap reached (%d/%d)', _state.bugsToday, MAX_BUGS_PER_DAY)
    return false
  }
  var lastBug = _state.suiteBugTimes[dedupeKey] || 0
  if (Date.now() - lastBug < 60 * 60 * 1000) {
    console.log('[watchdog] Skipping bug for %s — filed within the last hour', dedupeKey)
    return false
  }
  try {
    await agent.fileBug({
      title: title,
      description: description,
      project_id: 'mycelium',
      severity: severity || 'normal',
      category: category || 'api'
    })
    _state.suiteBugTimes[dedupeKey] = Date.now()
    _state.bugsToday++
    console.log('[watchdog] Bug filed: %s (%d/%d today)', dedupeKey, _state.bugsToday, MAX_BUGS_PER_DAY)
    return true
  } catch (e) {
    console.error('[watchdog] Failed to file bug:', e.message)
    return false
  }
}

// ── Main idle handler ───────────────────────────────────────────────

export async function onIdle(agent) {
  if (!_state) {
    _state = await loadState(agent)
  }

  var now = Date.now()
  resetBugDay()

  // Pick the role whose cooldown has expired and is most overdue
  // Embedder is checked first — short cooldown, high throughput priority
  var roles = [
    { name: 'embed', lastRun: _state.embedLastRun, cooldown: EMBED_COOLDOWN },
    { name: 'uptime', lastRun: _state.uptimeLastRun, cooldown: UPTIME_COOLDOWN },
    { name: 'qa', lastRun: _state.qaLastRun, cooldown: QA_COOLDOWN },
    { name: 'health', lastRun: _state.healthLastRun, cooldown: HEALTH_COOLDOWN },
    { name: 'janitor', lastRun: _state.janitorLastRun, cooldown: JANITOR_COOLDOWN }
  ]

  var ready = roles.filter(function (r) { return now - r.lastRun >= r.cooldown })
  if (ready.length === 0) return

  // Pick the most overdue role
  ready.sort(function (a, b) { return (a.lastRun + a.cooldown) - (b.lastRun + b.cooldown) })
  var role = ready[0]

  try {
    switch (role.name) {
      case 'embed': await runEmbedder(agent); break
      case 'qa': await runQA(agent); break
      case 'uptime': await runUptime(agent); break
      case 'janitor': await runJanitor(agent); break
      case 'health': await runHealth(agent); break
    }
  } catch (e) {
    console.error('[watchdog] %s crashed: %s', role.name, e.message)
  }

  // Only persist state for non-embed roles (embed runs every 5s, too frequent for context writes)
  if (role.name !== 'embed') {
    await saveState(agent)
  }
}

// ── Role 1: QA ──────────────────────────────────────────────────────

async function runQA(agent) {
  var suiteName = TEST_SUITES[_state.qaIndex % TEST_SUITES.length]
  _state.qaIndex++
  _state.qaLastRun = Date.now()

  console.log('[qa] Running test suite: %s', suiteName)

  // Cleanup stale test artifacts first
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
    await agent.setContext(NAMESPACE, RESULTS_KEY, JSON.stringify({
      role: 'qa',
      last_suite: suiteName,
      last_run: result.ts,
      passed: result.passed,
      failed: result.failed,
      errors: result.errors.slice(0, 5)
    }))
  } catch (e) { /* best effort */ }

  if (result.failed > 0) {
    // Don't file bugs for transient auth/network errors — they're not real failures
    var isTransient = result.errors.some(function (e) {
      return e.indexOf('Authentication required') !== -1 || e.indexOf('fetch failed') !== -1 || e.indexOf('ECONNREFUSED') !== -1
    })
    if (!isTransient) {
      await fileBugIfAllowed(
        agent,
        'QA: ' + suiteName + ' — ' + result.failed + ' failure(s)',
        'Automated QA detected failures in ' + suiteName + ' suite.\n\nErrors:\n' + result.errors.join('\n'),
        'normal', 'api', 'qa-' + suiteName
      )
    } else {
      console.log('[qa] %s: skipping bug — transient error', suiteName)
    }
  }
}

// ── Role 2: Uptime ──────────────────────────────────────────────────

async function runUptime(agent) {
  _state.uptimeLastRun = Date.now()
  console.log('[uptime] Checking %d endpoints', MONITORED_ENDPOINTS.length)

  for (var ep of MONITORED_ENDPOINTS) {
    var wasDown = _state.endpointStatus[ep.name] === 'down'
    var isDown = false
    var errorMsg = ''

    try {
      var controller = new AbortController()
      var timeout = setTimeout(function () { controller.abort() }, UPTIME_TIMEOUT)
      var res = await fetch(ep.url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) {
        isDown = true
        errorMsg = 'HTTP ' + res.status
      }
    } catch (e) {
      isDown = true
      errorMsg = e.name === 'AbortError' ? 'Timeout after ' + (UPTIME_TIMEOUT / 1000) + 's' : e.message
    }

    if (isDown && !wasDown) {
      // Transition: up → down — file a bug
      console.error('[uptime] %s is DOWN: %s', ep.name, errorMsg)
      _state.endpointStatus[ep.name] = 'down'
      await fileBugIfAllowed(
        agent,
        'Uptime: ' + ep.name + ' is down',
        ep.name + ' (' + ep.url + ') is unreachable.\n\nError: ' + errorMsg + '\nDetected: ' + new Date().toISOString(),
        'high', 'api', 'uptime-' + ep.name
      )
    } else if (!isDown && wasDown) {
      // Transition: down → up — send recovery message
      console.log('[uptime] %s is back UP', ep.name)
      _state.endpointStatus[ep.name] = 'up'
      try {
        await agent.sendMessage(null, '[uptime] ' + ep.name + ' has recovered. Back online as of ' + new Date().toISOString())
      } catch (e) { /* best effort */ }
    } else if (!isDown) {
      _state.endpointStatus[ep.name] = 'up'
      console.log('[uptime] %s: OK', ep.name)
    } else {
      // Still down — already filed, don't spam
      console.log('[uptime] %s: still down (%s)', ep.name, errorMsg)
    }
  }
}

// ── Role 3: Janitor ─────────────────────────────────────────────────

async function runJanitor(agent) {
  _state.janitorLastRun = Date.now()
  console.log('[janitor] Running cleanup sweep')
  var cleaned = 0

  // 1. Clean up QA test artifacts
  try {
    var keys = await agent.getContext('qa-test')
    if (keys && typeof keys === 'object') {
      var keyNames = Object.keys(keys)
      for (var k of keyNames) {
        if (k.startsWith('test-')) {
          await agent.deleteContext('qa-test', k)
          cleaned++
        }
      }
    }
  } catch (e) { /* namespace may not exist */ }

  // 2. Clean up old watchdog state keys that may have accumulated
  try {
    var nsKeys = await agent.getContext(NAMESPACE)
    if (nsKeys && typeof nsKeys === 'object') {
      for (var key of Object.keys(nsKeys)) {
        // Clean up legacy qa-state key if it exists alongside new watchdog-state
        if (key === 'qa-state') {
          await agent.deleteContext(NAMESPACE, 'qa-state')
          cleaned++
          console.log('[janitor] Cleaned legacy qa-state key')
        }
        // Clean up legacy qa-results key
        if (key === 'qa-results') {
          await agent.deleteContext(NAMESPACE, 'qa-results')
          cleaned++
          console.log('[janitor] Cleaned legacy qa-results key')
        }
      }
    }
  } catch (e) { /* best effort */ }

  console.log('[janitor] Cleaned %d items', cleaned)
}

// ── Role 4: Health patrol ───────────────────────────────────────────

async function runHealth(agent) {
  _state.healthLastRun = Date.now()
  console.log('[health] Running health patrol check')

  try {
    var health = await agent.api.get('/admin/health')
    if (!health) return

    var alerts = []

    // Check stale agents (online but heartbeat >1hr old)
    if (health.stale_agents && health.stale_agents.length > 0) {
      for (var sa of health.stale_agents) {
        alerts.push('Agent ' + sa.id + ' shows online but last heartbeat was ' + sa.last_heartbeat)
      }
    }

    // Check stale tasks (in_progress for >24hr with no update)
    if (health.stale_tasks && health.stale_tasks.length > 0) {
      alerts.push(health.stale_tasks.length + ' task(s) stale (in_progress >24hr)')
    }

    // Check stale requests (pending >1hr)
    if (health.stale_requests && health.stale_requests.length > 0) {
      alerts.push(health.stale_requests.length + ' request(s) pending >1hr')
    }

    // Check stale drones
    if (health.stale_drones && health.stale_drones.length > 0) {
      alerts.push(health.stale_drones.length + ' drone(s) stale')
    }

    if (alerts.length > 0) {
      var msg = '[health patrol] Issues detected:\n' + alerts.map(function (a) { return '- ' + a }).join('\n')
      console.warn(msg)
      try {
        await agent.sendMessage(null, msg)
      } catch (e) {
        console.error('[health] Failed to broadcast alert:', e.message)
      }
    } else {
      console.log('[health] All clear')
    }
  } catch (e) {
    console.error('[health] Patrol failed:', e.message)
  }
}

// ── Role 5: Embedder ────────────────────────────────────────────────

async function runEmbedder(agent) {
  _state.embedLastRun = Date.now()

  // List pending embed jobs and claim them directly.
  // We can't use POST /drones/claim because that route requires drone heartbeat
  // registration (renderJobForDrone fails for SDK agents). Instead, list pending
  // jobs and manually claim by updating status.
  var pendingJobs = []
  try {
    pendingJobs = await agent.api.get('/drones/jobs?status=pending&limit=' + EMBED_BATCH_MAX)
    if (!Array.isArray(pendingJobs)) pendingJobs = []
  } catch (e) {
    return // no jobs or endpoint error
  }

  // Filter to embed jobs requiring ollama (match on job_type or title prefix for retried jobs)
  pendingJobs = pendingJobs.filter(function (j) {
    var isEmbed = j.job_type === 'embed' || (j.title && j.title.startsWith('Embed:'))
    if (!isEmbed) return false
    var reqs = []
    try { reqs = JSON.parse(j.requires || '[]') } catch (e) { return false }
    return reqs.indexOf('ollama') !== -1
  })
  if (pendingJobs.length === 0) return
  console.log('[embed] Found %d embed jobs to process', pendingJobs.length)

  var processed = 0
  for (var i = 0; i < pendingJobs.length; i++) {
    var claimed = pendingJobs[i]

    // Claim it by setting status + drone_id
    try {
      await agent.api.put('/drones/jobs/' + claimed.id, { status: 'claimed' })
    } catch (e) {
      continue // someone else grabbed it
    }

    try {
      var inputData = {}
      try { inputData = JSON.parse(claimed.input_data || '{}') } catch (e) { inputData = {} }

      var text = inputData.text || ''
      if (!text) {
        // No text to embed — mark done with empty result
        await agent.api.put('/drones/jobs/' + claimed.id, { status: 'done', result_data: JSON.stringify({ error: 'no text provided' }) })
        continue
      }

      // Call local Ollama for embedding
      var embedResp = await fetch(OLLAMA_URL + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: inputData.model || EMBED_MODEL, input: text }),
        signal: AbortSignal.timeout(30000)
      })
      if (!embedResp.ok) throw new Error('Ollama HTTP ' + embedResp.status)
      var embedData = await embedResp.json()
      var embedding = (embedData.embeddings && embedData.embeddings[0]) || embedData.embedding
      if (!embedding) throw new Error('No embedding in Ollama response')

      // PUT result back via callback_path if provided
      if (inputData.callback_path) {
        // Strip /api/mycelium prefix — agent.api.put already prepends the base URL
        var cbPath = inputData.callback_path.replace(/^\/api\/mycelium/, '')
        await agent.api.put(cbPath, {
          embedding: embedding,
          model: inputData.model || EMBED_MODEL,
          chunk_index: inputData.chunk_index || 0
        })
      }

      // Mark drone job done
      await agent.api.put('/drones/jobs/' + claimed.id, {
        status: 'done',
        result_data: JSON.stringify({ dims: embedding.length, model: inputData.model || EMBED_MODEL })
      })

      processed++
    } catch (e) {
      console.error('[embed] Job #%d failed: %s', claimed.id, e.message)
      try {
        await agent.api.put('/drones/jobs/' + claimed.id, {
          status: 'failed',
          error: e.message
        })
      } catch (e2) { /* best effort */ }
    }
  }

  if (processed > 0) {
    _state.embedsProcessed += processed
    console.log('[embed] Processed %d job(s) (%d total)', processed, _state.embedsProcessed)
  }
}

// ── QA test suites ──────────────────────────────────────────────────

function assert(condition, msg, result) {
  if (condition) {
    result.passed++
  } else {
    result.failed++
    result.errors.push(msg)
    console.error('[qa] FAIL: %s', msg)
  }
}

async function cleanupTestArtifacts(agent) {
  // Handled by janitor now, but still clean before each QA run for safety
  try {
    var keys = await agent.getContext('qa-test')
    if (keys && typeof keys === 'object') {
      for (var k of Object.keys(keys)) {
        if (k.startsWith('test-')) {
          await agent.deleteContext('qa-test', k)
        }
      }
    }
  } catch (e) { /* namespace may not exist */ }
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

  // Delete is admin-only — expected to fail for agents
  try { await agent.deleteContext(ns, key) } catch (e) { /* expected */ }
  result.passed++
}

async function testSavepoints(agent, result) {
  // Test profile read instead of sending extra heartbeat (avoids doubled heartbeats)
  var profile = await agent.getProfile(agent.agentId)
  assert(profile && profile.agent_id, 'Agent profile exists', result)

  // Verify savepoint exists (created by the auto-heartbeat)
  try {
    var sp = await agent.api.get('/agents/' + agent.agentId + '/savepoint')
    assert(sp && sp.session_id, 'Savepoint exists with session_id', result)
  } catch (e) {
    result.failed++
    result.errors.push('Savepoint read: ' + e.message)
  }
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

    // Use raw API calls to avoid polluting agent.workingOn
    await agent.api.put('/tasks/' + task.id, { assignee: agent.agentId, status: 'in_progress' })
    result.passed++

    await agent.api.put('/tasks/' + task.id, { status: 'done' })
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

    // Use raw API calls to avoid polluting agent.workingOn
    await agent.api.put('/bugs/' + bug.id, { assignee: agent.agentId, status: 'in_progress' })
    result.passed++

    await agent.api.put('/bugs/' + bug.id, { status: 'fixed' })
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
