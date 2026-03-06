// Configuration loader — resolves env: references, validates required fields
// Supports: config.json file, RUNNER_CONFIG env var (JSON string), or all-env-var mode

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function resolveEnvRefs(obj) {
  if (typeof obj === 'string' && obj.startsWith('env:')) {
    const varName = obj.slice(4);
    const val = process.env[varName];
    if (!val) throw new Error(`Environment variable ${varName} not set (referenced in config)`);
    return val;
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveEnvRefs(v);
    }
    return out;
  }
  return obj;
}

function buildConfigFromEnv() {
  // Build config entirely from environment variables
  // MYCELIUM_API_URL, MYCELIUM_ADMIN_KEY, RUNNER_AGENTS (JSON array)
  const apiUrl = process.env.MYCELIUM_API_URL;
  const adminKey = process.env.MYCELIUM_ADMIN_KEY;
  const agentsJson = process.env.RUNNER_AGENTS;

  if (!apiUrl || !adminKey || !agentsJson) return null;

  let agents;
  try {
    agents = JSON.parse(agentsJson);
  } catch (e) {
    throw new Error(`RUNNER_AGENTS is not valid JSON: ${e.message}`);
  }

  return {
    mycelium: { apiUrl, adminKey },
    defaults: {
      model: process.env.RUNNER_MODEL || 'claude-sonnet-4-6',
      maxTurns: parseInt(process.env.RUNNER_MAX_TURNS || '100'),
      pollIntervalMs: parseInt(process.env.RUNNER_POLL_INTERVAL_MS || '300000'),
      cooldownMs: parseInt(process.env.RUNNER_COOLDOWN_MS || '30000'),
    },
    agents,
  };
}

export function loadConfig(configPath) {
  let raw;

  // Priority 1: RUNNER_CONFIG env var (full JSON)
  if (process.env.RUNNER_CONFIG) {
    try {
      raw = JSON.parse(process.env.RUNNER_CONFIG);
    } catch (e) {
      throw new Error(`RUNNER_CONFIG env var is not valid JSON: ${e.message}`);
    }
  }

  // Priority 2: Individual env vars
  if (!raw) {
    raw = buildConfigFromEnv();
  }

  // Priority 3: Config file
  if (!raw) {
    const fullPath = resolve(configPath || 'config.json');
    if (!existsSync(fullPath)) {
      throw new Error(
        `No config found. Provide one of:\n` +
        `  1. config.json file\n` +
        `  2. RUNNER_CONFIG env var (full JSON)\n` +
        `  3. MYCELIUM_API_URL + MYCELIUM_ADMIN_KEY + RUNNER_AGENTS env vars`
      );
    }
    raw = JSON.parse(readFileSync(fullPath, 'utf-8'));
  }

  const config = resolveEnvRefs(raw);

  // Validate
  if (!config.mycelium?.apiUrl) throw new Error('config.mycelium.apiUrl is required');
  if (!config.mycelium?.adminKey) throw new Error('config.mycelium.adminKey is required');
  if (!config.agents || config.agents.length === 0) throw new Error('config.agents must have at least one agent');

  // Apply defaults
  const defaults = config.defaults || {};
  for (const agent of config.agents) {
    agent.model = agent.model || defaults.model || 'claude-sonnet-4-6';
    agent.maxTurns = agent.maxTurns || defaults.maxTurns || 100;
    agent.pollIntervalMs = agent.pollIntervalMs || defaults.pollIntervalMs || 300000;
    agent.cooldownMs = agent.cooldownMs || defaults.cooldownMs || 30000;
    agent.provider = agent.provider || defaults.provider || 'claude-agent-sdk';
    agent.providerConfig = agent.providerConfig || defaults.providerConfig || {};
    agent.tools = agent.tools || defaults.tools || ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
    agent.mcpServers = agent.mcpServers || defaults.mcpServers || {};
  }

  return config;
}
