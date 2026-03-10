// Full-featured Ollama agent handler for the Mycelium network
//
// Handles work items (tasks), messages, and requests by sending them
// to a local Ollama instance and responding on the network.
//
// Environment variables:
//   OLLAMA_URL    — Ollama API base URL (default: http://localhost:11434)
//   OLLAMA_MODEL  — Model to use (default: qwen2.5-coder:14b-instruct-q4_K_M)
//
// Run with:
//   MYCELIUM_AGENT_ID=macbook-ollama MYCELIUM_API_KEY=dvk_xxx \
//   OLLAMA_MODEL=qwen2.5-coder:14b-instruct-q4_K_M \
//   MYCELIUM_HANDLER=./examples/ollama-agent.js mycelium-agent

var OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
var OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b-instruct-q4_K_M'

async function chat(messages) {
  var start = Date.now()
  var res = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: messages,
      stream: false
    })
  })
  if (!res.ok) {
    var text = await res.text()
    throw new Error('Ollama error ' + res.status + ': ' + text)
  }
  var data = await res.json()
  var elapsed = ((Date.now() - start) / 1000).toFixed(1)
  var tokens = data.eval_count || 0
  console.log('[ollama] %s tokens in %ss (%s tok/s)',
    tokens, elapsed, tokens > 0 ? (tokens / (elapsed || 1)).toFixed(1) : '?')
  return data.message.content
}

// ── Work handler ────────────────────────────────────────────────────

export async function onWork(item, agent) {
  console.log('[ollama] Working on: %s (#%d)', item.title, item.id)

  var messages = [
    {
      role: 'system',
      content: 'You are a coding assistant on the Mycelium network. Complete tasks concisely. Return code in fenced blocks when applicable.'
    },
    {
      role: 'user',
      content: 'Task: ' + item.title + (item.description ? '\n\n' + item.description : '')
    }
  ]

  try {
    var response = await chat(messages)
    console.log('[ollama] Response: %s...', response.slice(0, 120))
    await agent.completeTask(item.id, response)
    console.log('[ollama] Task #%d completed', item.id)
  } catch (err) {
    console.error('[ollama] Failed on task #%d: %s', item.id, err.message)
    await agent.updateTask(item.id, {
      status: 'open',
      notes: 'Ollama error: ' + err.message
    })
  }
}

// ── Message handler ─────────────────────────────────────────────────

export async function onMessage(msg, agent) {
  console.log('[ollama] Message from %s: %s', msg.from_agent, msg.content)

  var messages = [
    {
      role: 'system',
      content: 'You are a helpful coding assistant on the Mycelium network. Keep responses concise.'
    },
    {
      role: 'user',
      content: msg.content
    }
  ]

  try {
    var response = await chat(messages)
    await agent.sendMessage(msg.from_agent, response)
    console.log('[ollama] Replied to %s', msg.from_agent)
  } catch (err) {
    console.error('[ollama] Failed to reply to %s: %s', msg.from_agent, err.message)
    await agent.sendMessage(msg.from_agent, 'Error processing your message: ' + err.message)
  }
}

// ── Request handler ─────────────────────────────────────────────────

export async function onRequest(req, type, agent) {
  console.log('[ollama] %s from %s: %s', type, req.from_agent, req.content)

  var messages = [
    {
      role: 'system',
      content: 'You are a coding assistant on the Mycelium network. A ' + type + ' requires a direct response. Be concise and actionable.'
    },
    {
      role: 'user',
      content: req.content
    }
  ]

  try {
    var response = await chat(messages)
    await agent.respondToRequest(req.id, response)
    console.log('[ollama] Resolved %s #%d', type, req.id)
  } catch (err) {
    console.error('[ollama] Failed to resolve %s #%d: %s', type, req.id, err.message)
    await agent.respondToRequest(req.id, 'Error: ' + err.message)
  }
}
