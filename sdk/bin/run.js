#!/usr/bin/env node
// mycelium-agent — run a Mycelium agent from the command line
//
// Environment variables:
//   MYCELIUM_AGENT_ID  — agent identifier (required)
//   MYCELIUM_API_KEY   — agent API key (required)
//   MYCELIUM_API_URL   — API base URL (default: http://localhost:3002/api/mycelium)
//                        Sovereignty default: your own local instance, never a
//                        hosted third party (mycelium.fyi is deprecated)
//   MYCELIUM_HANDLER   — path to JS module with work/message handlers (optional)
//
// The handler module should export:
//   onWork(item, agent)        — called when work is claimed
//   onMessage(msg, agent)      — called on incoming messages
//   onRequest(req, type, agent) — called on directives/requests

import { MyceliumAgent } from '../src/agent.js'

var agentId = process.env.MYCELIUM_AGENT_ID
var apiKey = process.env.MYCELIUM_API_KEY
var apiUrl = process.env.MYCELIUM_API_URL
var handlerPath = process.env.MYCELIUM_HANDLER

if (!agentId || !apiKey) {
  console.error('Usage: MYCELIUM_AGENT_ID=xxx MYCELIUM_API_KEY=dvk_xxx mycelium-agent')
  console.error('')
  console.error('Required environment variables:')
  console.error('  MYCELIUM_AGENT_ID  — Your agent ID on the network')
  console.error('  MYCELIUM_API_KEY   — Your agent API key')
  console.error('')
  console.error('Optional:')
  console.error('  MYCELIUM_API_URL   — API base URL (default: http://localhost:3002/api/mycelium)')
  console.error('  MYCELIUM_HANDLER   — Path to JS module with handler functions')
  process.exit(1)
}

var agent = new MyceliumAgent({
  agentId: agentId,
  apiKey: apiKey,
  apiUrl: apiUrl
})

// Load custom handler if provided
if (handlerPath) {
  try {
    var handler = await import(handlerPath)
    if (handler.onWork) agent.onWork(function(item) { return handler.onWork(item, agent) })
    if (handler.onMessage) agent.onMessage(function(msg) { return handler.onMessage(msg, agent) })
    if (handler.onRequest) agent.onRequest(function(req, type) { return handler.onRequest(req, type, agent) })
    if (handler.onIdle) agent.onIdle(function() { return handler.onIdle(agent) })
    console.log('[mycelium] Loaded handler from', handlerPath)
  } catch (err) {
    console.error('[mycelium] Failed to load handler:', err.message)
    process.exit(1)
  }
} else {
  // Default: log everything
  agent.onWork(async function(item) {
    console.log('[mycelium] Work claimed:', item.type, '#' + item.id, '-', item.title)
    console.log('[mycelium] No handler configured — set MYCELIUM_HANDLER to process work')
  })
  agent.onMessage(function(msg) {
    console.log('[mycelium] Message from', msg.from_agent + ':', msg.content)
  })
  agent.onRequest(function(req, type) {
    console.log('[mycelium]', type, 'from', req.from_agent + ':', req.content)
  })
}

// Boot and start
try {
  var boot = await agent.boot()
  console.log('[mycelium] Booted as', agentId)
  console.log('[mycelium] Project:', boot.project ? boot.project.name : 'none')
  if (boot.counts) {
    console.log('[mycelium] Pending: %d directives, %d requests, %d messages, %d tasks',
      boot.counts.directives || 0,
      boot.counts.requests || 0,
      boot.counts.messages_unread || 0,
      boot.counts.tasks_mine || 0
    )
  }
  agent.start()
  console.log('[mycelium] Agent running — heartbeat every %ds, polling every %ds',
    agent.heartbeatInterval / 1000,
    agent.pollInterval / 1000
  )
} catch (err) {
  console.error('[mycelium] Boot failed:', err.message)
  process.exit(1)
}
