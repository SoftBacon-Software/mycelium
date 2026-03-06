// Provider: claude-agent-sdk
// Uses @anthropic-ai/claude-agent-sdk query() — full Claude Code with MCP, tools, file access.
// Best for: main and agent tiers where full capability is needed.

import { query } from '@anthropic-ai/claude-agent-sdk';
import * as logger from '../logger.js';

export async function runSession(agentConfig, systemPrompt, prompt, callbacks) {
  const agentId = agentConfig.id;

  // Ensure we can spawn claude subprocesses (unset nesting guard)
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;

  // Per-agent API key override — swap env var before subprocess spawns, restore after
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  if (agentConfig.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = agentConfig.anthropicApiKey;
  }

  const maxTurns = agentConfig.maxTurns || 100;
  const warningThreshold = Math.floor(maxTurns * 0.8);

  let result = null;
  let turnCount = 0;    // total SSE messages (SDK events)
  let agentTurns = 0;  // actual assistant turns
  let warningFired = false;

  for await (const message of query({
    prompt,
    options: {
      cwd: agentConfig.cwd,
      systemPrompt,
      allowedTools: agentConfig.tools,
      mcpServers: agentConfig.mcpServers,
      model: agentConfig.model,
      maxTurns,
      permissionMode: 'bypassPermissions',
      stderr: (data) => process.stderr.write(data),
    },
  })) {
    if ('result' in message) {
      result = message.result;
      logger.info(agentId, 'Session complete', { result: result?.slice(0, 200) });
    } else if ('subtype' in message && message.subtype === 'init') {
      logger.debug(agentId, 'Session initialized', { session_id: message.session_id });
    } else if ('subtype' in message && message.subtype === 'compact_boundary') {
      const meta = message.compact_metadata || {};
      logger.info(agentId, 'Context compacted', {
        trigger: meta.trigger,
        pre_tokens: meta.pre_tokens,
      });
      if (callbacks?.onCompaction) {
        callbacks.onCompaction(meta).catch((e) => {
          logger.debug(agentId, `Compaction callback error: ${e.message}`);
        });
      }
    }

    // Count actual agent turns (assistant messages = one full Claude response)
    if (message.type === 'assistant') {
      agentTurns++;

      // Fire context warning at 80% of maxTurns — once only
      if (!warningFired && agentTurns >= warningThreshold) {
        warningFired = true;
        const pct = Math.round((agentTurns / maxTurns) * 100);
        logger.warn(agentId, `Context warning: ${agentTurns}/${maxTurns} turns (${pct}%) — approaching limit`);
        if (callbacks?.onContextWarning) {
          callbacks.onContextWarning(agentTurns, maxTurns).catch((e) => {
            logger.debug(agentId, `Context warning callback error: ${e.message}`);
          });
        }
      }
    }

    turnCount++;
  }

  // Restore global API key after session
  if (agentConfig.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = savedApiKey;
  }

  return { result, turnCount, agentTurns, warningFired };
}
