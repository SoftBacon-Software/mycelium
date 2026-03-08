#!/usr/bin/env node
// mycelium init — one-command agent setup
//
// Usage:
//   npx @mycelium/sdk init
//   mycelium-init
//
// Prompts for agent name, runtime, LLM, projects, then:
//   1. Registers agent on the Mycelium network
//   2. Generates config file (.mycelium.json or MCP config)
//   3. Writes a starter CLAUDE.md with boot instructions

import { createInterface } from 'readline'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

var API_URL = process.env.MYCELIUM_API_URL || 'https://mycelium.fyi/api/mycelium'

function prompt(rl, question, defaultVal) {
  return new Promise(function(resolve) {
    var suffix = defaultVal ? ' [' + defaultVal + ']' : ''
    rl.question(question + suffix + ': ', function(answer) {
      resolve(answer.trim() || defaultVal || '')
    })
  })
}

function choose(rl, question, options) {
  return new Promise(function(resolve) {
    console.log('\n' + question)
    for (var i = 0; i < options.length; i++) {
      console.log('  ' + (i + 1) + '. ' + options[i])
    }
    rl.question('Choose [1]: ', function(answer) {
      var idx = parseInt(answer) - 1
      if (isNaN(idx) || idx < 0 || idx >= options.length) idx = 0
      resolve(options[idx])
    })
  })
}

async function registerAgent(adminKey, agentId, name, projectId, opts) {
  var body = {
    id: agentId,
    name: name,
    project_id: projectId,
    llm_backend: opts.llmBackend || '',
    llm_model: opts.llmModel || '',
    runtime: opts.runtime || 'sdk',
    agent_type: opts.agentType || 'agent',
    capabilities: opts.capabilities || ['code']
  }

  var res = await fetch(API_URL + '/agents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': adminKey
    },
    body: JSON.stringify(body)
  })
  var data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Registration failed: ' + res.status)
  return data
}

async function main() {
  var rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('')
  console.log('  ┌─────────────────────────────────┐')
  console.log('  │     Mycelium Agent Setup         │')
  console.log('  │     Connect to the network       │')
  console.log('  └─────────────────────────────────┘')
  console.log('')

  // Admin key for registration
  var adminKey = await prompt(rl, 'Admin API key (X-Admin-Key)')
  if (!adminKey) {
    console.error('Admin key is required to register a new agent.')
    process.exit(1)
  }

  // Fetch available projects
  var projects = []
  try {
    var res = await fetch(API_URL + '/projects', {
      headers: { 'X-Admin-Key': adminKey }
    })
    projects = await res.json()
  } catch {}

  // Agent details
  var agentId = await prompt(rl, 'Agent ID (e.g. my-machine-claude)')
  if (!agentId) {
    console.error('Agent ID is required.')
    process.exit(1)
  }

  var name = await prompt(rl, 'Display name', agentId)

  // Project selection
  var projectId = 'mycelium'
  if (projects.length > 0) {
    var projectNames = projects.map(function(p) { return p.id + ' — ' + p.name })
    var selected = await choose(rl, 'Which project?', projectNames)
    projectId = selected.split(' — ')[0]
  } else {
    projectId = await prompt(rl, 'Project ID', 'mycelium')
  }

  // Runtime
  var runtime = await choose(rl, 'What runtime will this agent use?', [
    'claude-code',
    'sdk (HTTP polling)',
    'cursor',
    'codex',
    'script (custom)'
  ])
  runtime = runtime.split(' ')[0]

  // LLM
  var llmBackend = await choose(rl, 'LLM provider?', [
    'anthropic',
    'ollama (local)',
    'openai',
    'deepseek',
    'custom'
  ])
  llmBackend = llmBackend.split(' ')[0]

  var llmModel = await prompt(rl, 'Model name', llmBackend === 'anthropic' ? 'claude-sonnet-4-6' : llmBackend === 'ollama' ? 'deepseek-coder-v2' : '')

  // Capabilities
  var capsStr = await prompt(rl, 'Capabilities (comma-separated)', 'code')
  var capabilities = capsStr.split(',').map(function(c) { return c.trim() }).filter(Boolean)

  console.log('')
  console.log('Registering agent...')

  try {
    var result = await registerAgent(adminKey, agentId, name, projectId, {
      runtime: runtime,
      llmBackend: llmBackend,
      llmModel: llmModel,
      capabilities: capabilities
    })

    var apiKey = result.api_key
    console.log('Agent registered! API key: ' + apiKey)

    // Generate config based on runtime
    if (runtime === 'claude-code') {
      // Write MCP config
      var mcpConfig = {
        mcpServers: {
          mycelium: {
            command: 'node',
            args: ['/path/to/mycelium/mcp/index.js'],
            env: {
              MYCELIUM_API_URL: API_URL,
              MYCELIUM_ROLE: 'agent',
              MYCELIUM_API_KEY: apiKey,
              MYCELIUM_AGENT_ID: agentId
            }
          }
        }
      }

      var mcpPath = join(process.cwd(), '.mcp.json')
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n')
      console.log('Wrote MCP config: ' + mcpPath)

      // Write CLAUDE.md
      var claudeMd = [
        '# Mycelium Agent — ' + agentId,
        '',
        'On session start, call the `mycelium_boot` MCP tool to initialize the agent session.',
        '',
        '## Boot Sequence',
        '1. Call `mycelium_boot`',
        '2. Check pending messages/requests',
        '3. Resume previous work or claim new from work queue',
        '',
        '## Identity',
        '- Agent ID: `' + agentId + '`',
        '- Project: `' + projectId + '`',
        '- Runtime: `' + runtime + '`',
        '- Model: `' + llmModel + '`',
        ''
      ].join('\n')

      var claudePath = join(process.cwd(), 'CLAUDE.md')
      if (!existsSync(claudePath)) {
        writeFileSync(claudePath, claudeMd)
        console.log('Wrote CLAUDE.md: ' + claudePath)
      } else {
        console.log('CLAUDE.md already exists — skipped')
      }
    } else {
      // Write SDK config
      var sdkConfig = {
        agentId: agentId,
        apiUrl: API_URL,
        apiKey: apiKey,
        runtime: runtime,
        llmBackend: llmBackend,
        llmModel: llmModel,
        capabilities: capabilities,
        heartbeatInterval: 60000,
        pollInterval: 30000
      }

      var configPath = join(process.cwd(), '.mycelium.json')
      writeFileSync(configPath, JSON.stringify(sdkConfig, null, 2) + '\n')
      console.log('Wrote SDK config: ' + configPath)
      console.log('')
      console.log('Start your agent:')
      console.log('  MYCELIUM_AGENT_ID=' + agentId + ' MYCELIUM_API_KEY=' + apiKey + ' mycelium-agent')
    }

    console.log('')
    console.log('Done! Your agent is registered on the Mycelium network.')
    console.log('Dashboard: https://mycelium.fyi/studio/')
  } catch (err) {
    console.error('Registration failed:', err.message)
    process.exit(1)
  }

  rl.close()
}

main().catch(function(err) {
  console.error('Error:', err.message)
  process.exit(1)
})
