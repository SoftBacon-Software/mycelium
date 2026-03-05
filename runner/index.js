#!/usr/bin/env node
// Mycelium Runner — autonomous agent runner for Mycelium platform

import { loadConfig } from './src/config.js';
import { Orchestrator } from './src/orchestrator.js';
import { startHealthServer } from './src/health.js';
import { setLogLevel, info, error } from './src/logger.js';

const configPath = process.argv[2] || 'config.json';
const logLevel = process.env.LOG_LEVEL || 'info';
const healthPort = parseInt(process.env.PORT || process.env.HEALTH_PORT || '8080');

setLogLevel(logLevel);
info(null, `Mycelium Runner v1.0.0`);
info(null, `Config: ${configPath}, Log level: ${logLevel}`);

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  error(null, `Config error: ${err.message}`);
  process.exit(1);
}

// Set ANTHROPIC_API_KEY from config global key (fallback for agents without a per-agent key)
// Per-agent keys are set in agentConfig.anthropicApiKey and applied per-session in the provider.
if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  info(null, 'ANTHROPIC_API_KEY loaded from config (global)');
} else if (!config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
  // Check if all agents have per-agent keys configured
  const allHaveKeys = config.agents.every(a => a.anthropicApiKey);
  if (!allHaveKeys) {
    error(null, 'No ANTHROPIC_API_KEY set — add anthropicApiKey to config or set env var');
    process.exit(1);
  }
  // Set a placeholder so SDK initializes; per-agent keys will override per-session
  process.env.ANTHROPIC_API_KEY = config.agents.find(a => a.anthropicApiKey)?.anthropicApiKey || '';
  info(null, 'Per-agent API keys configured — no global key needed');
}

info(null, `Mycelium API: ${config.mycelium.apiUrl}`);
info(null, `Agents: ${config.agents.map(a => a.id).join(', ')}`);

const orchestrator = new Orchestrator(config);
startHealthServer(orchestrator, healthPort);
orchestrator.start();
