// Orchestrator — manages per-agent poll loops, session lifecycle, health

import { MyceliumAPI } from './api.js';
import { runSession } from './session.js';
import { ensureWorkspace, pushChanges } from './workspace.js';
import { getGitHubStatus, isGitHubDown } from './github-status.js';
import * as logger from './logger.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const STALE_SESSION_MS = 25 * 60 * 1000;   // 25 min — session considered hung

// --- API limit detection ---

function isRateLimitError(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    err.status === 429 || err.status === 529 ||
    msg.includes('rate limit') || msg.includes('overloaded') ||
    msg.includes('too many requests') || msg.includes('529')
  );
}

// Track drone process so we don't spawn duplicates
let _droneProcess = null;

function tryAutoTriggerDrone() {
  const droneKey = process.env.MYCELIUM_DRONE_KEY;
  const droneWorker = process.env.MYCELIUM_DRONE_WORKER ||
    join(dirname(fileURLToPath(import.meta.url)), '../../mycelium/tools/drone_mode.sh');

  if (!droneKey) return; // no key configured, skip
  if (_droneProcess && !_droneProcess.exitCode !== null) return; // already running

  if (!existsSync(droneWorker)) {
    logger.debug(null, `Auto-drone: drone_mode.sh not found at ${droneWorker}`);
    return;
  }

  logger.info(null, `Auto-drone: API limits hit — spawning drone worker`);
  _droneProcess = spawn('bash', [droneWorker], {
    env: { ...process.env, MYCELIUM_KEY: droneKey },
    detached: true,
    stdio: 'ignore',
  });
  _droneProcess.unref();
  _droneProcess.on('exit', (code) => {
    logger.info(null, `Auto-drone: drone worker exited (code ${code})`);
    _droneProcess = null;
  });
}
const MAX_CONSECUTIVE_ERRORS = 10;            // reset + alert after this many
const HEALTH_REPORT_INTERVAL_MS = 15 * 60 * 1000; // 15 min health report to Mycelium

// SSE event types that should wake admin-tier agents immediately
// (anything that means "someone needs you right now")
const WAKE_EVENT_TYPES = new Set([
  'request_created',
  'directive_created',
  'work_request',
  'approval_requested',
  'spawn_requested',  // dynamic agent spawn request
]);

const SPAWN_POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
const RUNNER_ID = process.env.RUNNER_ID || 'runner-' + process.pid;

export class Orchestrator {
  constructor(config) {
    this.config = config;
    this.api = new MyceliumAPI(config.mycelium.apiUrl, config.mycelium.adminKey);
    this.agents = new Map(); // agentId -> { config, state }
    this.running = false;
    this.shutdownPromise = null;
    this.startedAt = Date.now();
  }

  start() {
    this.running = true;
    logger.info(null, `Starting orchestrator with ${this.config.agents.length} agent(s)`);

    for (const agentConfig of this.config.agents) {
      const state = {
        active: false,       // session currently running
        lastPoll: 0,
        lastSession: 0,
        sessionCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        lastError: null,
        wakeResolve: null,   // set when sleeping in poll loop — call to wake immediately
      };
      this.agents.set(agentConfig.id, { config: agentConfig, state });
      logger.info(agentConfig.id, `Registered`, {
        cwd: agentConfig.cwd,
        model: agentConfig.model,
        pollInterval: agentConfig.pollIntervalMs / 1000 + 's',
      });
    }

    // Check GitHub status before workspace setup (avoid hanging on git fetch during outages)
    getGitHubStatus().then(status => {
      if (!status.operational) {
        logger.warn(null, `GitHub is DOWN (${status.indicator}) — workspace git pull will be skipped`);
      }
    }).catch(() => {});

    // Set up workspaces (clone repos if configured)
    for (const agentConfig of this.config.agents) {
      try {
        ensureWorkspace(agentConfig);
      } catch (e) {
        logger.error(agentConfig.id, `Workspace setup failed: ${e.message}`);
      }
    }

    // Start poll loops
    for (const [agentId] of this.agents) {
      this._pollLoop(agentId);
    }

    // Start SSE watcher — wakes agents immediately on relevant events
    this._sseWatcher();

    // Start dynamic spawn loop — fires ephemeral sessions for on-demand work
    this._dynamicSpawnLoop();

    // Start watchdog and health reporter
    this._watchdogLoop();
    this._healthReportLoop();

    // Graceful shutdown
    const shutdown = (signal) => {
      logger.info(null, `Received ${signal}, shutting down...`);
      this.stop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  async stop() {
    this.running = false;
    // Update heartbeats to offline
    for (const [agentId] of this.agents) {
      try {
        await this.api.heartbeat(agentId, 'offline', '');
        logger.info(agentId, 'Set offline');
      } catch (e) {
        logger.warn(agentId, `Failed to set offline: ${e.message}`);
      }
    }
    // Wait for active sessions to finish (with timeout)
    const timeout = 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const anyActive = [...this.agents.values()].some(a => a.state.active);
      if (!anyActive) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    logger.info(null, 'Orchestrator stopped');
    process.exit(0);
  }

  // Wake an idle agent immediately — short-circuits the poll sleep
  _triggerWake(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.state.active) return; // already running, skip
    if (entry.state.wakeResolve) {
      logger.debug(agentId, 'SSE wake triggered');
      entry.state.wakeResolve();
      entry.state.wakeResolve = null;
    } else {
      // Not sleeping yet — zero out lastPoll so next iteration skips the wait
      entry.state.lastPoll = 0;
    }
  }

  async _pollLoop(agentId) {
    const { config: agentConfig, state } = this.agents.get(agentId);

    while (this.running) {
      // Wait for poll interval — interruptible via wakeResolve
      const elapsed = Date.now() - state.lastPoll;
      const wait = Math.max(0, agentConfig.pollIntervalMs - elapsed);
      if (wait > 0) {
        await new Promise(r => {
          state.wakeResolve = r;
          setTimeout(() => { state.wakeResolve = null; r(); }, wait);
        });
      }
      if (!this.running) break;

      state.lastPoll = Date.now();

      // Skip if session already running
      if (state.active) {
        logger.debug(agentId, 'Session active, skipping poll');
        continue;
      }

      // Back off on consecutive errors
      if (state.consecutiveErrors > 0) {
        const backoff = Math.min(state.consecutiveErrors * agentConfig.cooldownMs, 600000); // max 10min
        logger.debug(agentId, `Backing off ${backoff / 1000}s after ${state.consecutiveErrors} errors`);
        await new Promise(r => setTimeout(r, backoff));
        if (!this.running) break;
      }

      try {
        // Check network mode + work in parallel
        logger.debug(agentId, 'Polling for work...');
        const [networkMode, work] = await Promise.all([
          this.api.getNetworkMode(),
          this.api.getWork(agentId),
        ]);
        const queue = work.queue || [];

        if (networkMode.autonomous) {
          logger.debug(agentId, `Autonomous mode (sleeping: ${networkMode.sleepingOperators.join(', ') || 'all'})`);
        } else {
          logger.debug(agentId, `Supervised mode (online: ${networkMode.availableOperators.join(', ') || 'none'})`);
        }

        if (queue.length === 0) {
          logger.debug(agentId, 'Queue empty, sleeping');
          // Heartbeat as idle
          try {
            await this.api.heartbeat(agentId, 'idle', '');
          } catch (e) { /* non-critical */ }
          continue;
        }

        const topItem = queue[0];
        logger.info(agentId, `Work available: ${topItem.type} #${topItem.id} — ${topItem.title}`, {
          queueDepth: queue.length,
          autonomous: networkMode.autonomous,
        });

        // Heartbeat as working
        try {
          await this.api.heartbeat(agentId, 'online', `Runner: starting ${topItem.type} #${topItem.id} — ${topItem.title}`);
        } catch (e) { /* non-critical */ }

        // Run session
        state.active = true;
        state.lastSession = Date.now();
        state.sessionCount++;

        // Callbacks — context warning fires at 80% of maxTurns
        const sessionCallbacks = {
          onContextWarning: async (agentTurns, maxTurns) => {
            const pct = Math.round((agentTurns / maxTurns) * 100);
            try {
              await this.api.sendEvent(agentId,
                `[Runner] Context warning: ${agentTurns}/${maxTurns} turns used (${pct}%). Session approaching turn limit — agent should wrap up soon.`
              );
            } catch (e) { /* non-critical */ }
          },
          onCompaction: async (metadata) => {
            try {
              await this.api.heartbeat(agentId, 'online',
                `Context compacted (${metadata.trigger}, ${metadata.pre_tokens} tokens pre-compact)`
              );
              logger.info(agentId, 'Savepoint triggered on compaction', {
                trigger: metadata.trigger,
                pre_tokens: metadata.pre_tokens,
              });
            } catch (e) { /* non-critical */ }
          },
        };

        try {
          const result = await runSession(agentConfig, topItem, networkMode, sessionCallbacks);
          const duration = ((Date.now() - state.lastSession) / 1000).toFixed(0);
          logger.info(agentId, `Session finished`, {
            turns: result.agentTurns,
            totalEvents: result.turnCount,
            duration: duration + 's',
            warningFired: result.warningFired,
          });
          state.consecutiveErrors = 0;

          // Write handoff savepoint — captures what was worked on for next session
          const workDesc = `${topItem.type} #${topItem.id}: ${topItem.title}`;
          const notes = [
            `Session ended after ${result.agentTurns} turns (${duration}s).`,
            `Work item: ${workDesc}.`,
            result.result ? `Result: ${result.result.slice(0, 500)}` : '',
            result.warningFired ? `Note: session hit 80% turn limit — may need continuation.` : '',
          ].filter(Boolean).join(' ');
          await this.api.saveHandoffSnapshot(agentId, notes);

          // Push any commits the agent made (skip if GitHub is down)
          if (!isGitHubDown()) {
            try { pushChanges(agentConfig); } catch (e) { /* non-critical */ }
          } else {
            logger.debug(agentId, 'Skipping pushChanges — GitHub is down');
          }
        } catch (err) {
          state.errorCount++;
          state.consecutiveErrors++;
          state.lastError = err.message;

          if (isRateLimitError(err)) {
            logger.warn(agentId, `API rate limit / overloaded (${err.status || 'unknown'})`);
            try {
              await this.api.sendEvent(agentId, `api_limit_hit: Runner hit API rate limit — backing off. Auto-drone may activate if MYCELIUM_DRONE_KEY is set.`);
            } catch (e) { /* non-critical */ }
            tryAutoTriggerDrone();
          } else {
            logger.error(agentId, `Session failed: ${err.message}`);
            try {
              await this.api.sendEvent(agentId, `Runner session failed: ${err.message.slice(0, 200)}`);
            } catch (e) { /* non-critical */ }
          }
        }

        state.active = false;

        // Cooldown between sessions
        logger.debug(agentId, `Cooldown ${agentConfig.cooldownMs / 1000}s`);
        await new Promise(r => setTimeout(r, agentConfig.cooldownMs));

      } catch (err) {
        state.errorCount++;
        state.consecutiveErrors++;
        state.lastError = err.message;
        logger.error(agentId, `Poll error: ${err.message}`);
      }
    }
  }

  // SSE watcher — subscribes to the event stream and wakes admin-tier agents immediately
  // on request_created, directive_created, etc. Falls back to poll-only if SSE fails.
  async _sseWatcher() {
    const sseUrl = `${this.api.apiUrl}/events/stream`;
    const headers = { 'X-Admin-Key': this.api.adminKey, 'Accept': 'text/event-stream' };

    // Which agents should be woken on demand (admin and main tier)
    const wakeableAgents = [...this.agents.entries()]
      .filter(([, { config }]) => (config.tier || 'agent') === 'admin' || (config.tier || 'agent') === 'main')
      .map(([id]) => id);

    if (wakeableAgents.length === 0) {
      logger.debug(null, 'SSE watcher: no admin/main agents to wake, skipping');
      return;
    }

    logger.info(null, `SSE watcher started — will wake: ${wakeableAgents.join(', ')}`);

    while (this.running) {
      try {
        const res = await fetch(sseUrl, { headers, signal: AbortSignal.timeout(5 * 60 * 1000) });
        if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (WAKE_EVENT_TYPES.has(event.type)) {
                logger.debug(null, `SSE wake event: ${event.type} — waking admin agents`);
                for (const agentId of wakeableAgents) {
                  this._triggerWake(agentId);
                }
              }
            } catch { /* malformed SSE data, ignore */ }
          }
        }
      } catch (err) {
        if (!this.running) break;
        logger.warn(null, `SSE watcher disconnected: ${err.message} — reconnecting in 10s`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }

  // Watchdog: detect hung sessions and sustained error loops
  async _watchdogLoop() {
    while (this.running) {
      await new Promise(r => setTimeout(r, 60000)); // check every minute
      if (!this.running) break;

      for (const [agentId, { config: agentConfig, state }] of this.agents) {
        // Hung session detection
        if (state.active && state.lastSession > 0) {
          const sessionAge = Date.now() - state.lastSession;
          if (sessionAge > STALE_SESSION_MS) {
            logger.warn(agentId, `Session appears hung (${Math.round(sessionAge / 60000)}min), forcing reset`);
            state.active = false;
            state.errorCount++;
            state.consecutiveErrors++;
            state.lastError = `Session hung for ${Math.round(sessionAge / 60000)}min`;
            try {
              await this.api.sendEvent(agentId, `Runner watchdog: session hung ${Math.round(sessionAge / 60000)}min, forced reset`);
            } catch (e) { /* non-critical */ }
          }
        }

        // Sustained error loop: alert + reset counter so agent can try again
        if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(agentId, `${MAX_CONSECUTIVE_ERRORS} consecutive errors — alerting Mycelium, resetting counter`);
          try {
            await this.api.sendEvent(agentId,
              `Runner health alert: ${MAX_CONSECUTIVE_ERRORS} consecutive failures. Last error: ${state.lastError?.slice(0, 150)}. Resetting error counter.`
            );
          } catch (e) { /* non-critical */ }
          state.consecutiveErrors = 0; // reset so agent retries rather than staying in max backoff
        }
      }
    }
  }

  // Periodic health report to Mycelium
  async _healthReportLoop() {
    await new Promise(r => setTimeout(r, HEALTH_REPORT_INTERVAL_MS));
    while (this.running) {
      try {
        const uptime = Math.round((Date.now() - this.startedAt) / 60000);
        const summaries = [];
        for (const [agentId, { state }] of this.agents) {
          const status = state.active ? 'running' : state.consecutiveErrors > 0 ? 'degraded' : 'idle';
          summaries.push(`${agentId}: ${status} (${state.sessionCount} sessions, ${state.errorCount} errors)`);
        }
        const msg = `Runner health [uptime ${uptime}min]: ${summaries.join(' | ')}`;
        await this.api.sendEvent('__system__', msg);
        logger.debug(null, `Health report sent: ${msg}`);
      } catch (e) {
        logger.debug(null, `Health report failed: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, HEALTH_REPORT_INTERVAL_MS));
    }
  }

  // Dynamic spawn loop — polls Mycelium for spawn requests and fires one-shot sessions
  // Enables the "swarm" model: Mycelium requests agents, runner scales to meet demand.
  async _dynamicSpawnLoop() {
    // Wait a bit on startup to let static agents settle
    await new Promise(r => setTimeout(r, 15000));

    while (this.running) {
      try {
        const spawns = await this.api.getSpawnQueue();
        const pending = Array.isArray(spawns) ? spawns : (spawns.spawns || []);

        for (const spawn of pending) {
          if (!this.running) break;
          logger.info(null, `Spawn request #${spawn.id}: ${spawn.title} [${spawn.tier}]`);

          // Claim it atomically
          try {
            await this.api.claimSpawn(spawn.id, RUNNER_ID);
          } catch (e) {
            logger.debug(null, `Spawn #${spawn.id} already claimed: ${e.message}`);
            continue;
          }

          // Build ephemeral agent config from spawn request
          // Find a base agent to inherit cwd/repos from (prefer matching tier, else first agent)
          const baseAgent = [...this.agents.values()].find(a => a.config.tier === spawn.tier)?.config
            || [...this.agents.values()][0]?.config;

          const ephemeralConfig = {
            id: `spawn-${spawn.id}`,
            tier: spawn.tier || 'agent',
            model: spawn.model || baseAgent?.model || 'claude-sonnet-4-6',
            cwd: spawn.cwd || baseAgent?.cwd || process.cwd(),
            maxTurns: spawn.max_turns || 50,
            pollIntervalMs: 300000,
            cooldownMs: 5000,
            tools: baseAgent?.tools || ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            mcpServers: baseAgent?.mcpServers || {},
            // Pass spawn context as extra prompt context
            spawnContext: spawn.work_context || {},
            spawnTitle: spawn.title,
          };

          // Run session in the background — don't block the spawn loop
          this._runSpawnSession(spawn.id, ephemeralConfig).catch(e => {
            logger.error(null, `Spawn #${spawn.id} session failed: ${e.message}`);
            this.api.doneSpawn(spawn.id, `Error: ${e.message}`, 'failed').catch(() => {});
          });
        }
      } catch (e) {
        if (this.running) {
          logger.debug(null, `Spawn poll error: ${e.message}`);
        }
      }

      await new Promise(r => setTimeout(r, SPAWN_POLL_INTERVAL_MS));
    }
  }

  async _runSpawnSession(spawnId, agentConfig) {
    const workItem = {
      type: 'spawn',
      id: spawnId,
      title: agentConfig.spawnTitle || `Spawn #${spawnId}`,
      spawn_context: agentConfig.spawnContext || {},
    };

    logger.info(agentConfig.id, `Running spawn session for #${spawnId}: ${workItem.title}`);

    const spawnCallbacks = {
      onContextWarning: async (agentTurns, maxTurns) => {
        const pct = Math.round((agentTurns / maxTurns) * 100);
        logger.warn(agentConfig.id, `Spawn #${spawnId} context warning: ${agentTurns}/${maxTurns} turns (${pct}%)`);
        // Spawns are ephemeral so just log — no persistent agent to message
      },
      onCompaction: async (metadata) => {
        logger.info(agentConfig.id, `Spawn #${spawnId} context compacted`, {
          trigger: metadata.trigger,
          pre_tokens: metadata.pre_tokens,
        });
      },
    };

    try {
      const networkMode = await this.api.getNetworkMode();
      const result = await runSession(agentConfig, workItem, networkMode, spawnCallbacks);
      const summary = `Completed in ${result.agentTurns} turns.${result.result ? ' ' + result.result.slice(0, 300) : ''}`;
      logger.info(agentConfig.id, `Spawn #${spawnId} done: ${result.agentTurns} turns`);
      await this.api.doneSpawn(spawnId, summary, 'done');
    } catch (e) {
      logger.error(agentConfig.id, `Spawn #${spawnId} failed: ${e.message}`);
      await this.api.doneSpawn(spawnId, `Error: ${e.message}`, 'failed');
    }
  }

  getStatus() {
    const agents = {};
    for (const [id, { config, state }] of this.agents) {
      const sessionAgeMs = state.lastSession ? Date.now() - state.lastSession : null;
      agents[id] = {
        active: state.active,
        status: state.active ? 'running' : state.consecutiveErrors > 0 ? 'degraded' : 'idle',
        sessionCount: state.sessionCount,
        errorCount: state.errorCount,
        consecutiveErrors: state.consecutiveErrors,
        lastError: state.lastError,
        lastPoll: state.lastPoll ? new Date(state.lastPoll).toISOString() : null,
        lastSession: state.lastSession ? new Date(state.lastSession).toISOString() : null,
        sessionAgeSec: sessionAgeMs ? Math.round(sessionAgeMs / 1000) : null,
        hungWarning: state.active && sessionAgeMs > STALE_SESSION_MS,
      };
    }
    return {
      running: this.running,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      agents,
    };
  }
}
