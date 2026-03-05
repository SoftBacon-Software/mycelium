// SSE client for real-time event subscription
// Connects to the Mycelium /events/stream endpoint and surfaces
// relevant events (messages, directives, requests) to the agent.

import { API_URL, API_KEY, ROLE } from './api.js';
import { getState } from './state.js';

var RECONNECT_DELAY = 5000;
var controller = null;
var reconnectTimer = null;
var connected = false;

export function isSSEConnected() { return connected; }

var mcpServerRef = null;

export function startSSE(onEvent, mcpServer) {
  if (mcpServer) mcpServerRef = mcpServer;
  stopSSE();
  connect(onEvent);
}

export function stopSSE() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (controller) { controller.abort(); controller = null; }
  connected = false;
}

async function connect(onEvent) {
  var st = getState();
  // Build URL — auth via X-Agent-Key / X-Admin-Key headers (set below)
  var url = API_URL + '/events/stream';

  controller = new AbortController();

  try {
    var headers = {};
    if (ROLE === 'admin') {
      headers['X-Admin-Key'] = API_KEY;
    } else {
      headers['X-Agent-Key'] = API_KEY;
    }

    var res = await fetch(url, {
      headers: headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      process.stderr.write('[mycelium-sse] Connection failed: HTTP ' + res.status + '\n');
      scheduleReconnect(onEvent);
      return;
    }

    connected = true;
    process.stderr.write('[mycelium-sse] Connected to event stream\n');

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE format: "data: {...}\n\n"
      var lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (var line of lines) {
        if (line.startsWith('data: ')) {
          try {
            var event = JSON.parse(line.slice(6));
            if (event.type === 'connected') continue; // Skip connection confirmation
            handleEvent(event, st.agentId, onEvent);
          } catch {
            // Ignore parse errors
          }
        }
        // Ignore comments (: ping) and empty lines
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // Intentional disconnect
    process.stderr.write('[mycelium-sse] Connection error: ' + err.message + '\n');
  }

  connected = false;
  scheduleReconnect(onEvent);
}

function scheduleReconnect(onEvent) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect(onEvent);
  }, RECONNECT_DELAY);
}

function handleEvent(event, agentId, onEvent) {
  // Filter: only surface events relevant to this agent
  var type = event.type || '';
  var summary = event.summary || '';

  // event.data arrives as a JSON string from the server — parse it
  var data = {};
  if (event.data) {
    try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { data = {}; }
  }

  // Messages sent TO this agent
  // The server emits message_sent with data={message_id} and summary like:
  // "sender sent message to <agentId>" or "sender sent directive to <agentId>"
  // We check if the summary mentions this agent as recipient.
  if (type === 'message_sent' || type === 'message_received') {
    var summaryLower = summary.toLowerCase();
    var agentLower = (agentId || '').toLowerCase();
    var isForMe = agentLower && (summaryLower.indexOf(' to ' + agentLower) !== -1 || summaryLower.indexOf('→ ' + agentLower) !== -1);
    var isDirective = summaryLower.indexOf('directive') !== -1 || summaryLower.indexOf('request') !== -1;
    if (isForMe) {
      if (isDirective) {
        process.stderr.write('[mycelium-sse] *** INCOMING MESSAGE for you: ' + summary + ' (check mycelium_boot) ***\n');
      } else {
        process.stderr.write('[mycelium-sse] Incoming message: ' + summary + '\n');
      }
    }
  }

  // Directive or request events (message_id in data, check summary for our agent)
  if (type === 'request_created' || type === 'approval_created') {
    var sum = summary.toLowerCase();
    var aid = (agentId || '').toLowerCase();
    if (aid && sum.indexOf(aid) !== -1) {
      process.stderr.write('[mycelium-sse] ' + type.replace('_', ' ') + ': ' + summary + ' (check mycelium_boot)\n');
    }
  }

  // Task assigned/updated — check summary for agent mention
  if (type === 'task_created' || type === 'task_updated') {
    if (data.assignee === agentId) {
      process.stderr.write('[mycelium-sse] Task #' + (data.task_id || '?') + ' assigned to you: ' + summary + '\n');
    }
  }

  // Plan step assigned to this agent (check assignee in data)
  if (type === 'plan_step_updated' || type === 'work_claimed') {
    if (data.assignee === agentId || (type === 'work_claimed' && (event.agent || '') === agentId)) {
      process.stderr.write('[mycelium-sse] Work update: ' + summary + '\n');
    }
  }

  // Sleep mode activated — inject work directive into this Claude Code session
  if (type === 'sleep_mode_on' && mcpServerRef && mcpServerRef.server) {
    var directive = (data && data.directive) || '';
    var prompt = 'Sleep mode is now active. The operator has gone to sleep.\n\n' +
      (directive ? 'Night directive: ' + directive + '\n\n' : '') +
      'Run your autonomous work loop:\n' +
      '1. Call mycelium_boot to load current state\n' +
      '2. Call mycelium_get_work with auto_claim=true to claim your top priority item\n' +
      '3. Execute the work fully\n' +
      '4. Mark it done, then repeat until the queue is empty\n' +
      'Keep working until mycelium_get_work returns empty or sleep mode ends.';
    mcpServerRef.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens: 8096,
      includeContext: 'thisServer'
    }).catch(function(e) {
      process.stderr.write('[mycelium-sse] Could not inject sleep directive: ' + e.message + '\n');
    });
    process.stderr.write('[mycelium-sse] Sleep mode active — work directive injected\n');
  }

  // Pass all events to callback if provided
  if (onEvent) onEvent(event);
}
