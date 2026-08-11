#!/usr/bin/env node
// Interactive setup — registers agent if needed, generates config.json for this machine

import { writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { resolve, join } from 'path';
import { platform, homedir } from 'os';
import { pathToFileURL } from 'url';

// Default target is the operator's OWN instance — a local one unless they say
// otherwise. It is only a DEFAULT: the wizard asks for the instance URL below,
// and the ANSWER (never this constant) is what every request and the generated
// config.json use. The admin key travels only to the host the operator names.
export const DEFAULT_API_URL = process.env.MYCELIUM_API_URL || 'http://localhost:3002/api/mycelium';

// HTTP helpers bound to ONE base URL. baseUrl is passed in rather than read
// from a module constant, so the credential path — where the admin key goes —
// is explicit and testable, and can never silently fall back to a host the
// operator did not choose.
export function makeApi(baseUrl, adminKey, fetchImpl = fetch) {
  const headers = { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' };
  return {
    async get(path) {
      const res = await fetchImpl(`${baseUrl}${path}`, { headers });
      if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
      return res.json();
    },
    async post(path, body) {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API POST ${path}: ${res.status} ${text.slice(0, 200)}`);
      }
      return res.json();
    },
  };
}

// io (all optional) makes the wizard drivable by tests without touching a
// network or stdin: ask() supplies prompt answers, fetchImpl intercepts HTTP,
// configDir is where config.json lands. Run directly, all three default to
// the real thing.
export async function runSetup(io = {}) {
  let rl = null;
  let ask = io.ask;
  const fetchImpl = io.fetchImpl ?? fetch;
  const configDir = io.configDir ?? process.cwd();
  if (!ask) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    ask = (q) => new Promise(r => rl.question(q, r));
  }

  try {
    console.log('\n=== Mycelium Runner Setup ===\n');
    console.log('This sets up an autonomous agent runner on this machine.\n');

    const isWindows = platform() === 'win32';

    // 1. Admin key
    // Admin key must NOT be hardcoded — it grants X-Admin-Key root over the API.
    // Prefer the environment; otherwise prompt and require a non-empty value.
    let adminKey = (process.env.MYCELIUM_ADMIN_KEY || '').trim();
    if (!adminKey) {
      adminKey = (await ask('Mycelium admin key (required): ')).trim();
    }
    if (!adminKey) {
      console.error('Admin key is required (set MYCELIUM_ADMIN_KEY or enter it when prompted). Aborting.');
      return 1;
    }

    // 2. Instance URL — the admin key is only ever sent where the operator says
    const urlAnswer = (await ask(`Mycelium instance URL [${DEFAULT_API_URL}]: `)).trim();
    const apiUrl = (urlAnswer || DEFAULT_API_URL).replace(/\/+$/, '');
    console.log(`\nUsing instance: ${apiUrl}`);
    console.log('(Your admin key is sent only to this URL.)\n');
    const api = makeApi(apiUrl, adminKey, fetchImpl);

    // 3. Fetch existing agents from Mycelium
    console.log('Fetching agents from Mycelium...');
    let existingAgents;
    try {
      existingAgents = await api.get('/agents');
      console.log(`Found ${existingAgents.length} registered agent(s):`);
      existingAgents.forEach((a, i) => {
        console.log(`  ${i + 1}. ${a.id} (${a.role}) — ${a.status}`);
      });
    } catch (e) {
      console.log(`Could not fetch agents: ${e.message}`);
      console.log('Continuing with manual setup.\n');
      existingAgents = [];
    }

    // 4. Pick existing or register new
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
        const result = await api.post('/admin/agents', {
          id: agentId,
          name: name.trim() || agentId,
          project_id: projectId,
          capabilities: ['code'],
          agent_type: 'agent',
        });
        console.log(`Registered! Agent key: ${result.api_key}`);
        console.log('(Save this key — it will not be shown again)\n');
      } catch (e) {
        console.log(`Registration failed: ${e.message}`);
        console.log('You can still configure the runner — the agent just needs to exist in Mycelium.\n');
      }
    }

    // 5. Working directory
    const defaultCwd = guessProjectDir(agentId, isWindows);
    const cwdInput = await ask(`Working directory for ${agentId} [${defaultCwd || 'none detected'}]: `);
    const cwd = cwdInput.trim() || defaultCwd || process.cwd();

    // 6. MCP server path
    const mcpDefault = guessMcpDir(isWindows);
    const mcpInput = await ask(`MCP server path (mycelium-mcp) [${mcpDefault || 'not found'}]: `);
    const mcpPath = mcpInput.trim() || mcpDefault;

    if (!mcpPath) {
      console.log('\nWARNING: No MCP server found. Agent will not be able to interact with Mycelium tools.');
      console.log('Clone it: git clone https://github.com/SoftBacon-Software/mycelium-mcp.git && cd mycelium-mcp && npm install\n');
    }

    // 7. Model choice
    console.log('\nModel options:');
    console.log('  1. claude-sonnet-4-6 (fast, cost-effective) [default]');
    console.log('  2. claude-opus-4-6 (most capable, higher cost)');
    const modelChoice = await ask('Model [1]: ');
    const model = modelChoice.trim() === '2' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

    // 8. Build config — every platform reference points at the instance the
    //    operator named, never at a hardcoded host.
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
            MYCELIUM_API_URL: apiUrl,
            MYCELIUM_ROLE: 'admin',
            MYCELIUM_API_KEY: adminKey,
          },
        },
      };
    }

    const config = {
      mycelium: { apiUrl, adminKey },
      defaults: {
        model,
        maxTurns: 100,
        pollIntervalMs: 300000,
        cooldownMs: 30000,
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      },
      agents: [agent],
    };

    // 9. Write config
    const configPath = resolve(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`\nConfig written to ${configPath}`);

    // 10. Instructions
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
  } finally {
    if (rl) rl.close();
  }
  return 0;
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

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runSetup()
    .then((code) => { process.exitCode = code || 0; })
    .catch(e => {
      console.error('Setup failed:', e.message);
      process.exit(1);
    });
}
