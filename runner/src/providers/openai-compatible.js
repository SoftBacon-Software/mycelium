// Provider: openai-compatible
// Uses any OpenAI-compatible /v1/chat/completions endpoint.
// Works with: Ollama (local), LM Studio (local), OpenRouter (cloud), OpenAI directly.
// Best for: admin tier — cheap 24/7 coordination at $0/month with a local model.
//
// Config (agentConfig.providerConfig):
//   baseUrl   — e.g. "http://localhost:11434/v1" for Ollama
//   model     — e.g. "mistral-nemo", "llama3.1", "qwen2.5-coder"
//   apiKey    — "ollama" for local, real key for cloud
//
// Tools: Bash only. Admin agents hit Mycelium API via curl from Bash.

import { spawnSync } from 'child_process';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as logger from '../logger.js';

const BASH_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Execute a shell command. Use to call Mycelium API via curl, check status, coordinate work.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        description: { type: 'string', description: 'What this command does' },
      },
      required: ['command'],
    },
  },
};

function executeBash(command, agentId) {
  const result = spawnSync('bash', ['-c', command], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.error) return `Error: ${result.error.message}`;
  const out = (result.stdout || '').trim();
  const err = (result.stderr || '').trim();
  if (result.status !== 0 && err) return `Exit ${result.status}: ${err}`.slice(0, 2000);
  return (out || err || '(no output)').slice(0, 2000);
}

function httpPost(urlStr, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const payload = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${apiKey}`,
      },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('LLM request timeout')); });
    req.write(payload);
    req.end();
  });
}

export async function runSession(agentConfig, systemPrompt, prompt, callbacks) {
  const agentId = agentConfig.id;
  const cfg = agentConfig.providerConfig || {};
  const baseUrl = (cfg.baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
  const model = agentConfig.model || cfg.model || 'mistral-nemo';
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY || 'ollama';
  const maxTurns = agentConfig.maxTurns || 50;
  const warningThreshold = Math.floor(maxTurns * 0.8);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let turnCount = 0;
  let result = null;
  let warningFired = false;

  while (turnCount < maxTurns) {
    const response = await httpPost(`${baseUrl}/chat/completions`, apiKey, {
      model,
      messages,
      tools: [BASH_TOOL_DEF],
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 4096,
    });

    if (response.error) {
      throw new Error(`LLM API error: ${response.error.message || JSON.stringify(response.error)}`);
    }

    const choice = response.choices?.[0];
    if (!choice) throw new Error('No choices in LLM response');

    const msg = choice.message;
    messages.push(msg);
    turnCount++;

    // Fire context warning at 80% of maxTurns — once only
    if (!warningFired && turnCount >= warningThreshold) {
      warningFired = true;
      const pct = Math.round((turnCount / maxTurns) * 100);
      logger.warn(agentId, `Context warning: ${turnCount}/${maxTurns} turns (${pct}%) — approaching limit`);
      if (callbacks?.onContextWarning) {
        callbacks.onContextWarning(turnCount, maxTurns).catch((e) => {
          logger.debug(agentId, `Context warning callback error: ${e.message}`);
        });
      }
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      result = msg.content || '';
      logger.info(agentId, 'Session complete', { result: result.slice(0, 200), turns: turnCount });
      break;
    }

    for (const toolCall of msg.tool_calls) {
      if (toolCall.function?.name === 'Bash') {
        let args;
        try { args = JSON.parse(toolCall.function.arguments); } catch { args = {}; }
        const cmd = args.command || '';
        logger.debug(agentId, `Bash: ${args.description || cmd.slice(0, 80)}`);
        const output = executeBash(cmd, agentId);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }

    if (choice.finish_reason === 'stop') {
      result = msg.content || '';
      break;
    }
  }

  if (turnCount >= maxTurns) logger.warn(agentId, `Hit maxTurns (${maxTurns})`);
  return { result, turnCount, agentTurns: turnCount, warningFired };
}
