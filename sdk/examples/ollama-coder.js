// Example: Local coding agent powered by Ollama
//
// This agent claims coding tasks from the Mycelium network,
// sends them to a local Ollama instance, and executes the result.
//
// Prerequisites:
//   - Ollama running locally with deepseek-coder-v2 or similar
//   - Agent registered on Mycelium network
//
// Run with:
//   MYCELIUM_AGENT_ID=local-coder MYCELIUM_API_KEY=dvk_xxx \
//   OLLAMA_MODEL=deepseek-coder-v2 \
//   MYCELIUM_HANDLER=./examples/ollama-coder.js mycelium-agent

// To register with proper profile metadata, set these env vars:
//   OLLAMA_URL=http://localhost:11434
//   OLLAMA_MODEL=deepseek-coder-v2
//
// Or in your agent constructor:
//   new MyceliumAgent({
//     agentId: 'local-coder',
//     apiKey: 'dvk_...',
//     runtime: 'sdk',
//     llmBackend: 'ollama',
//     llmModel: 'deepseek-coder-v2',
//     capabilities: ['code', 'git']
//   })

import { execSync } from 'child_process'

var OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
var OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2'

async function askOllama(prompt) {
  var res = await fetch(OLLAMA_URL + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false
    })
  })
  var data = await res.json()
  return data.response
}

export async function onWork(item) {
  console.log('[ollama-coder] Claimed:', item.title)

  // Get task details
  var prompt = [
    'You are a coding assistant. Complete this task:',
    '',
    'Title: ' + item.title,
    item.description ? 'Description: ' + item.description : '',
    '',
    'Respond with the code changes needed. Be concise.'
  ].join('\n')

  try {
    var response = await askOllama(prompt)
    console.log('[ollama-coder] Ollama response:', response.slice(0, 200) + '...')
    // In a real implementation: parse response, apply changes, run tests, commit
  } catch (err) {
    console.error('[ollama-coder] Ollama error:', err.message)
  }
}

export function onMessage(msg) {
  console.log('[ollama-coder] Message from %s: %s', msg.from_agent, msg.content)
}

export async function onRequest(req, type) {
  console.log('[ollama-coder] %s from %s: %s', type, req.from_agent, req.content)
}
