#!/usr/bin/env node
// Interactive setup — registers agent if needed, generates config.json for this machine

import { writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { resolve, join } from 'path';
import { platform, homedir, hostname } from 'os';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

const API_URL = 'https://mycelium.fyi/api/mycelium';

async function apiGet(path, adminKey) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

async function apiPost(path, body, adminKey) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API POST ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  console.log('\n=== Mycelium Runner Setup ===\n');
  console.log('This sets up an autonomous agent runner on this machine.\n');

  const isWindows = platform() === 'win32';

  // 1. Admin key
  const adminKey = (await ask('Mycelium admin key (Enter for default): ')).trim() || 'KPeO7ZspKsAQotZsrvnZ2vYk';

  // 2. Fetch existing agents from Mycelium
  console.log('\nFetching agents from Mycelium...');
  let existingAgents;
  try {
    existingAgents = await apiGet('/agents', adminKey);
    console.log(`Found ${existingAgents.length} registered agent(s):`);
    existingAgents.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.id} (${a.role}) — ${a.status}`);
    });
  } catch (e) {
    console.log(`Could not fetch agents: ${e.message}`);
    console.log('Continuing with manual setup.\n');
    existingAgents = [];
  }

  // 3. Pick existing or register new
  console.log(`\n  ${existingAgents.length + 1}. Register a NEW agent`);
  const choice = await ask('\nWhich agent runs on this machine? (number): ');
  const choiceNum = parseInt(choice.trim());

  let agentId;
  if (choiceNum > 0 && choiceNum <= existingAgents.length) {
    agentId = existingAgents[choiceNum - 1].id;
    console.log(`\nSelected: ${agentId}`);
  } else {
    // Register new agent
    console.log('\n--- Register New Agent ---');
    const name = await ask('Agent display name (e.g. "Studio MacBook"): ');
    const suggestedId = (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-claude').replace(/--+/g, '-');
    const idInput = await ask(`Agent ID [${suggestedId}]: `);
    agentId = idInput.trim() || suggestedId;

    const projectInput = await ask('Project ID (e.g. "mycelium", "king-city", "willing-sacrifice"): ');
    const projectId = projectInput.trim() || 'mycelium';

    console.log(`\nRegistering ${agentId} on Mycelium...`);
    try {
      const result = await apiPost('/admin/agents', {
        id: agentId,
        name: name.trim() || agentId,
        project_id: projectId,
        capabilities: ['code'],
        agent_type: 'agent',
      }, adminKey);
      console.log(`Registered! Agent key: ${result.api_key}`);
      console.log('(Save this key — it will not be shown again)\n');
    } catch (e) {
      console.log(`Registration failed: ${e.message}`);
      console.log('You can still configure the runner — the agent just needs to exist in Mycelium.\n');
    }
  }

  // 4. Working directory
  const defaultCwd = guessProjectDir(agentId, isWindows);
  const cwdInput = await ask(`Working directory for ${agentId} [${defaultCwd || 'none detected'}]: `);
  const cwd = cwdInput.trim() || defaultCwd || process.cwd();

  // 5. MCP server path
  const mcpDefault = guessMcpDir(isWindows);
  const mcpInput = await ask(`MCP server path (mycelium-mcp) [${mcpDefault || 'not found'}]: `);
  const mcpPath = mcpInput.trim() || mcpDefault;

  if (!mcpPath) {
    console.log('\nWARNING: No MCP server found. Agent will not be able to interact with Mycelium tools.');
    console.log('Clone it: git clone https://github.com/SoftBacon-Software/mycelium-mcp.git && cd mycelium-mcp && npm install\n');
  }

  // 6. Model choice
  console.log('\nModel options:');
  console.log('  1. claude-sonnet-4-6 (fast, cost-effective) [default]');
  console.log('  2. claude-opus-4-6 (most capable, higher cost)');
  const modelChoice = await ask('Model [1]: ');
  const model = modelChoice.trim() === '2' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

  // 7. Build config
  const agent = {
    id: agentId,
    cwd,
    model,
    maxTurns: 100,
    pollIntervalMs: 300000,
    cooldownMs: 30000,
  };

  if (mcpPath) {
    agent.mcpServers = {
      mycelium: {
        command: 'node',
        args: [join(mcpPath, 'index.js')],
        env: {
          MYCELIUM_API_URL: API_URL,
          MYCELIUM_ROLE: 'admin',
          MYCELIUM_API_KEY: adminKey,
        },
      },
    };
  }

  const config = {
    mycelium: { apiUrl: API_URL, adminKey },
    defaults: {
      model,
      maxTurns: 100,
      pollIntervalMs: 300000,
      cooldownMs: 30000,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    agents: [agent],
  };

  // 8. Write config
  const configPath = resolve('config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`\nConfig written to ${configPath}`);

  // 9. Instructions
  console.log('\n=== Ready! ===\n');
  console.log('Start the runner (from a normal terminal, NOT inside Claude Code):');
  console.log('');
  if (isWindows) {
    console.log('  Foreground:  node index.js');
    console.log('  Background:  start /B node index.js > runner.log 2>&1');
  } else {
    console.log('  Foreground:  node index.js');
    console.log('  Background:  nohup node index.js > runner.log 2>&1 &');
    console.log('  With PM2:    pm2 start index.js --name mycelium-runner');
  }
  console.log('');
  console.log('Health check: curl http://localhost:8080/health');
  console.log('');
  console.log(`The runner will poll Mycelium every 5 minutes for work assigned to ${agentId}.`);
  console.log('When work is found, it spawns a Claude session to execute it autonomously.\n');

  rl.close();
}

function guessProjectDir(agentId, isWindows) {
  const guesses = {
    'greatness-claude': isWindows
      ? ['D:/mycelium', 'D:/willing-sacrifice']
      : [homedir() + '/mycelium', homedir() + '/willing-sacrifice'],
    'macbook-claude': isWindows
      ? ['D:/willing-sacrifice', 'D:/mycelium']
      : [homedir() + '/willing-sacrifice', homedir() + '/mycelium'],
    'hijack-claude': isWindows
      ? ['D:/king-city']
      : [homedir() + '/king-city'],
  };
  const dirs = guesses[agentId] || [];
  // Also check common locations
  dirs.push(
    resolve('..', agentId.replace('-claude', '')),
    homedir() + '/projects',
  );
  for (const dir of dirs) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function guessMcpDir(isWindows) {
  const guesses = isWindows
    ? ['D:/mycelium-mcp']
    : [homedir() + '/mycelium-mcp'];
  guesses.unshift(resolve('..', 'mycelium-mcp'));
  for (const dir of guesses) {
    if (existsSync(join(dir, 'index.js'))) return dir;
  }
  return null;
}

main().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
