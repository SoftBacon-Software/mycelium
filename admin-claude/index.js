// =============== admin-claude — Mycelium Admin Automation ===============
// Supports two modes:
//   MODE=webhook — Express server receives Mycelium webhooks (needs public URL)
//   MODE=poll    — Polls Mycelium API for work (works behind NAT, on laptops, etc.)

import express from 'express';
import crypto from 'crypto';
import { PORT, WEBHOOK_SECRET, AGENT_ID, GITHUB_REPOS, GITHUB_TOKEN, MYCELIUM_API_URL, MODE, POLL_INTERVAL, LLM_BACKEND, OLLAMA_URL, OLLAMA_MODEL } from './config.js';
import { apiPost, apiPut, apiGet } from './api.js';
import { handleEvent } from './handlers.js';

console.log('[config] Mode: ' + MODE);
console.log('[config] LLM backend: ' + LLM_BACKEND + (LLM_BACKEND === 'ollama' ? ' (' + OLLAMA_MODEL + ' @ ' + OLLAMA_URL + ')' : ''));
console.log('[config] API: ' + MYCELIUM_API_URL);

// ---- Shared helpers ----

async function heartbeat(workingOn, status) {
  try {
    await apiPut('/admin/agents/' + AGENT_ID + '/heartbeat', {
      status: status || 'online',
      working_on: workingOn || (MODE === 'poll' ? 'Polling for work' : 'Listening for webhooks')
    });
  } catch (err) {
    console.error('[heartbeat] Failed:', err.message);
  }
}

async function processBacklog() {
  try {
    var msgs = await apiGet('/messages?limit=20&to_agent=' + AGENT_ID);
    var unresolved = msgs.filter(function (m) {
      return !m.resolved_at
        && (m.msg_type === 'directive' || m.msg_type === 'request')
        && m.from_agent !== AGENT_ID
        && m.from_agent !== '__admin__'
        && m.from_agent !== '__system__';
    });
    if (unresolved.length > 0) {
      console.log('[backlog] Found ' + unresolved.length + ' unresolved directives/requests');
      for (var msg of unresolved) {
        await handleEvent('message_sent', { message_id: msg.id, from: msg.from_agent, content: msg.content }, msg.from_agent);
      }
    }
  } catch (err) {
    console.error('[backlog] Error:', err.message);
  }
}

async function checkGitHubPRs() {
  try {
    var { checkGitHubPRs: check } = await import('./handlers.js');
    await check();
  } catch (err) {
    console.error('[github-prs] Error:', err.message);
  }
}

// ---- Poll mode: pull work from API ----

async function pollForWork() {
  try {
    // Check for new messages/requests to admin-claude
    var msgs = await apiGet('/messages?limit=20&to_agent=' + AGENT_ID);
    var unresolved = msgs.filter(function (m) {
      return !m.resolved_at
        && m.from_agent !== AGENT_ID
        && m.from_agent !== '__admin__'
        && m.from_agent !== '__system__';
    });

    for (var msg of unresolved) {
      var event = (msg.msg_type === 'request' || msg.msg_type === 'directive') ? 'message_sent' : 'message_sent';
      await handleEvent(event, { message_id: msg.id, from: msg.from_agent, content: msg.content }, msg.from_agent);
    }

    // Check for unassigned bugs
    var ops = await apiGet('/admin/ops');
    if (ops.unassigned_bugs) {
      for (var bug of ops.unassigned_bugs) {
        await handleEvent('bug_created', { bug_id: bug.id }, bug.reporter);
      }
    }

    // Check for pending approvals
    if (ops.pending_approvals) {
      for (var approval of ops.pending_approvals) {
        if (approval.status === 'pending') {
          await handleEvent('approval_requested', { approval_id: approval.id }, approval.requested_by);
        }
      }
    }
  } catch (err) {
    console.error('[poll] Error:', err.message);
  }
}

// ---- Start based on mode ----

if (MODE === 'poll') {
  // Poll mode: no Express server needed
  console.log('admin-claude starting in POLL mode (interval: ' + POLL_INTERVAL + 'ms)');
  heartbeat('Starting up — poll mode');

  // Wait for Ollama to be ready if using local LLM
  if (LLM_BACKEND === 'ollama') {
    await waitForOllama();
  }

  // Initial backlog + poll
  setTimeout(processBacklog, 5000);
  setTimeout(pollForWork, 10000);

  // Periodic polling
  setInterval(pollForWork, POLL_INTERVAL);
  setInterval(function () { heartbeat('Polling for work'); }, 5 * 60 * 1000);

  // GitHub PR check
  if (GITHUB_TOKEN && GITHUB_REPOS.length > 0) {
    console.log('[startup] GitHub PR reviews enabled for: ' + GITHUB_REPOS.join(', '));
    setTimeout(checkGitHubPRs, 30000);
    setInterval(checkGitHubPRs, 15 * 60 * 1000);
  }

  // Keep process alive
  process.on('SIGTERM', function () {
    console.log('[shutdown] SIGTERM received — going offline');
    heartbeat('Shutting down', 'offline').catch(function () {}).finally(function () { process.exit(0); });
  });
  process.on('SIGINT', function () {
    console.log('[shutdown] SIGINT received — going offline');
    heartbeat('Shutting down', 'offline').catch(function () {}).finally(function () { process.exit(0); });
  });

} else {
  // Webhook mode: Express server
  var app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', function (req, res) {
    res.json({
      status: 'ok',
      agent: AGENT_ID,
      mode: MODE,
      llm_backend: LLM_BACKEND,
      uptime: process.uptime(),
      github_enabled: !!(GITHUB_TOKEN && GITHUB_REPOS.length > 0),
      github_repos: GITHUB_REPOS,
      api_url: MYCELIUM_API_URL
    });
  });

  app.post('/webhook', function (req, res) {
    if (WEBHOOK_SECRET) {
      var sig = req.headers['x-webhook-signature'];
      var expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest('hex');
      if (sig !== expected) {
        console.warn('[webhook] Invalid signature — rejecting');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    res.json({ ok: true });

    var event = req.body.event;
    var data = req.body.data;
    var agentId = req.body.agent_id;
    var timestamp = req.body.timestamp;

    console.log('[webhook] Received:', event, '| agent:', agentId, '| time:', timestamp);

    handleEvent(event, data, agentId).catch(function (err) {
      console.error('[handler] Error processing', event, ':', err.message);
    });
  });

  var server = app.listen(PORT, function () {
    console.log('admin-claude running on port ' + PORT + ' (webhook mode)');
    heartbeat('Starting up — listening for webhooks');
    setTimeout(processBacklog, 10000);
    setInterval(function () { heartbeat('Listening for webhooks'); }, 5 * 60 * 1000);
    setInterval(processBacklog, 5 * 60 * 1000);

    if (GITHUB_TOKEN && GITHUB_REPOS.length > 0) {
      console.log('[startup] GitHub PR reviews enabled for: ' + GITHUB_REPOS.join(', '));
      setTimeout(checkGitHubPRs, 30000);
      setInterval(checkGitHubPRs, 15 * 60 * 1000);
    }
  });

  process.on('SIGTERM', function () {
    console.log('[shutdown] SIGTERM received — going offline');
    heartbeat('Shutting down', 'offline').catch(function () {}).finally(function () {
      server.close();
      process.exit(0);
    });
  });
}

// ---- Ollama readiness check ----

async function waitForOllama() {
  var maxRetries = 30;
  for (var i = 0; i < maxRetries; i++) {
    try {
      var res = await fetch(OLLAMA_URL + '/api/tags');
      if (res.ok) {
        var data = await res.json();
        var models = (data.models || []).map(function (m) { return m.name; });
        console.log('[ollama] Connected. Available models:', models.join(', '));
        return;
      }
    } catch (err) {
      // Not ready yet
    }
    console.log('[ollama] Waiting for Ollama to be ready... (' + (i + 1) + '/' + maxRetries + ')');
    await new Promise(function (r) { setTimeout(r, 2000); });
  }
  console.error('[ollama] Could not connect to Ollama at ' + OLLAMA_URL + ' after ' + maxRetries + ' attempts');
  process.exit(1);
}
