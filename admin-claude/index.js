// =============== admin-claude — Mycelium Admin Automation ===============
// Webhook-driven Node service using Claude API for judgment calls.
// Receives all Mycelium events via __global__ webhook, processes async.

import express from 'express';
import crypto from 'crypto';
import { PORT, WEBHOOK_SECRET, AGENT_ID, GITHUB_REPOS, GITHUB_TOKEN, MYCELIUM_API_URL } from './config.js';
import { apiPost, apiPut, apiGet } from './api.js';
import { handleEvent } from './handlers.js';

var app = express();
app.use(express.json({ limit: '1mb' }));

// ---- Health check ----
app.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    agent: AGENT_ID,
    uptime: process.uptime(),
    github_enabled: !!(GITHUB_TOKEN && GITHUB_REPOS.length > 0),
    github_repos: GITHUB_REPOS,
    api_url: MYCELIUM_API_URL
  });
});

// ---- Webhook receiver ----
app.post('/webhook', function (req, res) {
  // Verify signature if secret is configured
  if (WEBHOOK_SECRET) {
    var sig = req.headers['x-webhook-signature'];
    var expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest('hex');
    if (sig !== expected) {
      console.warn('[webhook] Invalid signature — rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Respond 200 immediately, process async
  res.json({ ok: true });

  var event = req.body.event;
  var data = req.body.data;
  var agentId = req.body.agent_id;
  var timestamp = req.body.timestamp;

  console.log('[webhook] Received:', event, '| agent:', agentId, '| time:', timestamp);

  // Dispatch to handler (fire-and-forget with error logging)
  handleEvent(event, data, agentId).catch(function (err) {
    console.error('[handler] Error processing', event, ':', err.message);
  });
});

// ---- Startup ----
var server = app.listen(PORT, function () {
  console.log('admin-claude running on port ' + PORT);

  // Register heartbeat as online
  heartbeat('Starting up — listening for webhooks');

  // Process any unresolved directives/requests from before we were online
  setTimeout(processBacklog, 10000);

  // Periodic heartbeat every 5 minutes + backlog check
  setInterval(function () {
    heartbeat('Listening for webhooks');
  }, 5 * 60 * 1000);
  setInterval(processBacklog, 5 * 60 * 1000);

  // Periodic GitHub PR check every 15 minutes (if token configured)
  if (GITHUB_TOKEN && GITHUB_REPOS.length > 0) {
    console.log('[startup] GitHub PR reviews enabled for: ' + GITHUB_REPOS.join(', '));
    // Initial check after 30s startup delay
    setTimeout(checkGitHubPRs, 30000);
    setInterval(checkGitHubPRs, 15 * 60 * 1000);
  } else {
    console.log('[startup] GitHub PR reviews DISABLED (no GITHUB_TOKEN or GITHUB_REPOS)');
  }
});

// ---- Graceful shutdown ----
process.on('SIGTERM', function () {
  console.log('[shutdown] SIGTERM received — going offline');
  heartbeat('Shutting down', 'offline')
    .catch(function () {})
    .finally(function () {
      server.close();
      process.exit(0);
    });
});

// ---- Helpers ----

async function heartbeat(workingOn, status) {
  try {
    await apiPut('/admin/agents/' + AGENT_ID + '/heartbeat', {
      status: status || 'online',
      working_on: workingOn || 'Listening for webhooks'
    });
  } catch (err) {
    console.error('[heartbeat] Failed:', err.message);
  }
}

async function processBacklog() {
  try {
    var msgs = await apiGet('/messages?limit=20&to_agent=' + AGENT_ID);
    var unresolved = msgs.filter(function (m) {
      // Only process unresolved directives/requests NOT from ourselves
      return !m.resolved_at
        && (m.msg_type === 'directive' || m.msg_type === 'request')
        && m.from_agent !== AGENT_ID
        && m.from_agent !== '__admin__';
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
