// Agent session — routes to the appropriate LLM provider and executes work
//
// Providers:
//   claude-agent-sdk   (default) — Full Claude Code with MCP, tools, file access
//   openai-compatible  — Any OpenAI /v1/chat/completions endpoint (Ollama, LM Studio, OpenRouter)
//
// Tiers (agentConfig.tier):
//   main   — Human's AI partner. Bootstrap wizard on fresh instances. Strategic coordinator.
//   admin  — Operational workhorse. Routes work, triages bugs, keeps agents busy.
//   agent  — Executes work. Implements code, fixes bugs, generates assets.
//   drone  — Script-level automation. Minimal authority. No messaging.
//
// Set agentConfig.provider to choose provider. Defaults to claude-agent-sdk.
// Set agentConfig.tier to specialize the system prompt. Defaults to 'agent'.

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as logger from './logger.js';
import { getGitHubStatus } from './github-status.js';

function loadClaudeMd(cwd) {
  const candidates = [
    resolve(cwd, 'CLAUDE.md'),
    resolve(cwd, '.claude', 'CLAUDE.md'),
  ];
  const parts = [];
  for (const path of candidates) {
    if (existsSync(path)) parts.push(readFileSync(path, 'utf-8'));
  }
  return parts.join('\n\n---\n\n');
}

// Tier-specialized system prompts — Step 171
function buildMainSystemPrompt(agentConfig, claudeMd) {
  return `You are ${agentConfig.id}, Main Claude for this Mycelium instance. Strategic partner to the human operator.

Hierarchy: main > admin > agent > drone. You handle vision and strategy. admin-claude handles daily ops.

Fresh instance? Detect via GET /agents. If only you exist: run onboarding interview (project name, team, first milestone), create projects/agents/plans, brief admin-claude.

Established instance: review network state, unblock stalled plans, send strategic status to operator.

Rules: Work autonomously. Escalate only irreversible dilemmas. Never message drones.

${claudeMd ? '## Context\n' + claudeMd : ''}`;
}

function buildAdminSystemPrompt(agentConfig, claudeMd) {
  return `You are ${agentConfig.id}, admin-claude. Operational workhorse — keep every agent busy, every request resolved, every plan moving.

Work loop: boot → directives first → triage unassigned bugs → check idle agents → check stalled work → send handoffs → broadcast status.

Authority: Create/assign tasks, respond to requests, triage bugs, add plan steps. NO deploys, NO external actions, NO money — escalate those.

Anti-hallucination: No action without an API call. IDs must come from the API. Verify after batch assignments. Uncertain = skip.

${claudeMd ? '## Context\n' + claudeMd : ''}`;
}

function buildAgentSystemPrompt(agentConfig, claudeMd, networkMode) {
  const mode = networkMode || {};
  const modeLine = mode.autonomous
    ? 'AUTONOMOUS MODE — all operators sleeping.' + (mode.directive ? ' Night directive: ' + mode.directive : '') + ' Full autonomy. Only queue approvals for irreversible high-risk actions.'
    : 'SUPERVISED MODE.' + (mode.availableOperators && mode.availableOperators.length ? ' Online: ' + mode.availableOperators.join(', ') + '.' : '') + ' Escalate risky decisions.';

  return `You are ${agentConfig.id}, autonomous agent on Mycelium. Runner-managed.

Boot: mycelium_boot → directives first → get_work(auto_claim=true) → execute → mark done → next item.

Rules:
- Blocked? File request via mycelium_send_request, move to next item.
- Never message drones.
- Commit frequently. Heartbeat with working_on updates.

${modeLine}

${claudeMd ? '## Context\n' + claudeMd : ''}`;
}

function buildGitHubOutageWarning(githubStatus) {
  if (!githubStatus || githubStatus.operational) return '';
  return `
## EXTERNAL SERVICE OUTAGE — GitHub is DOWN
GitHub status: ${githubStatus.indicator} — "${githubStatus.description}"

Do NOT attempt any of the following (they will fail and waste turns):
- git push / git pull / git fetch from GitHub
- Creating or merging pull requests (gh pr create, gh pr merge)
- GitHub API calls
- Railway deploys (Railway pulls from GitHub)

Focus on LOCAL work only:
- Implement code, write files, run local tests
- Update Mycelium task/bug/plan status
- Send messages to other agents
- Commit locally (git commit is fine — just don't push)

GitHub operations should be deferred until the outage resolves.
`;
}

function buildSystemPrompt(agentConfig, claudeMd, networkMode, githubStatus) {
  const tier = agentConfig.tier || agentConfig.agent_type || 'agent';
  const outageWarning = buildGitHubOutageWarning(githubStatus);
  let prompt;
  switch (tier) {
    case 'main':  prompt = buildMainSystemPrompt(agentConfig, claudeMd); break;
    case 'admin': prompt = buildAdminSystemPrompt(agentConfig, claudeMd); break;
    default:      prompt = buildAgentSystemPrompt(agentConfig, claudeMd, networkMode); break;
  }
  return outageWarning ? outageWarning + '\n---\n\n' + prompt : prompt;
}

function buildPrompt(agentConfig, workItem) {
  if (workItem) {
    if (workItem.type === 'spawn') {
      var ctx = workItem.spawn_context;
      var ctxStr = ctx && Object.keys(ctx).length > 0
        ? '\n\nContext:\n' + JSON.stringify(ctx, null, 2)
        : '';
      return `You are a spawned agent for a specific task. Boot, execute the task below, then stop.\n\nTask: ${workItem.title}${ctxStr}\n\nExecute this focused task. When done, send a brief summary message to the platform and stop.`;
    }
    return `You have work waiting. Boot, then execute:\n\nType: ${workItem.type}\nID: #${workItem.id}\nTitle: ${workItem.title}\n${workItem.summary ? 'Summary: ' + workItem.summary : ''}\n${workItem.plan_title ? 'Plan: ' + workItem.plan_title : ''}\n\nClaim it (if not already) and execute. When done, check for more work.`;
  }
  return 'Boot, check for directives, use get_work with auto_claim=true. Execute until queue is empty.';
}

async function loadProvider(provider) {
  switch (provider) {
    case 'openai-compatible':
      return (await import('./providers/openai-compatible.js'));
    case 'claude-agent-sdk':
    default:
      return (await import('./providers/claude-agent-sdk.js'));
  }
}

export async function runSession(agentConfig, workItem, networkMode, callbacks) {
  const agentId = agentConfig.id;
  const provider = agentConfig.provider || 'claude-agent-sdk';
  const cwd = agentConfig.cwd;
  const claudeMd = loadClaudeMd(cwd);
  const githubStatus = await getGitHubStatus();
  const systemPrompt = buildSystemPrompt(agentConfig, claudeMd, networkMode, githubStatus);
  const prompt = buildPrompt(agentConfig, workItem);

  if (!githubStatus.operational) {
    logger.warn(agentId, `GitHub is DOWN (${githubStatus.indicator}: ${githubStatus.description}) — injecting outage warning into session`);
  }

  logger.info(agentId, `Starting session`, {
    provider,
    cwd,
    model: agentConfig.model,
    maxTurns: agentConfig.maxTurns,
  });

  const mod = await loadProvider(provider);
  return mod.runSession(agentConfig, systemPrompt, prompt, callbacks);
}
