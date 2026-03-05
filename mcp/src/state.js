// Session state and auto-heartbeat management

import { apiPost, apiPut } from './api.js';
import { startSSE, stopSSE } from './sse.js';

var state = {
  agentId: process.env.MYCELIUM_AGENT_ID || null,
  role: process.env.MYCELIUM_ROLE || 'admin',
  workingOn: '',
  booted: false,
  heartbeatTimer: null,
  bootData: null,
  messagesAcked: [],
  sessionId: null,
  customState: {},
  // Auto-tracked working state — populates state_snapshot automatically
  claimedItem: null,    // { type, id, title } — from claim_task, claim_bug, get_work auto_claim
  currentStep: null,    // { plan_id, step_id, title } — from update_step
  progressNotes: []     // brief notes accumulated during work
};

export function getState() { return state; }

export function setWorkingOn(text) {
  state.workingOn = text || '';
}

export function setBooted(bootData) {
  state.booted = true;
  state.bootData = bootData;
  // Generate session ID on first boot
  if (!state.sessionId) {
    state.sessionId = state.agentId + '-' + Date.now().toString(36);
  }
  // Track message IDs from boot data
  if (bootData.new_messages) {
    for (var m of bootData.new_messages) {
      if (state.messagesAcked.indexOf(m.id) === -1) state.messagesAcked.push(m.id);
    }
  }
  if (bootData.pending_requests) {
    for (var r of bootData.pending_requests) {
      if (state.messagesAcked.indexOf(r.id) === -1) state.messagesAcked.push(r.id);
    }
  }
}

export function ackMessage(messageId) {
  if (state.messagesAcked.indexOf(messageId) === -1) state.messagesAcked.push(messageId);
}

export function setCustomState(key, value) {
  state.customState[key] = value;
}

export function setClaimedItem(item) {
  state.claimedItem = item || null;
}

export function setCurrentStep(step) {
  state.currentStep = step || null;
}

export function addProgressNote(note) {
  state.progressNotes.push(note);
  // Keep only last 20 notes to avoid unbounded growth
  if (state.progressNotes.length > 20) {
    state.progressNotes = state.progressNotes.slice(-20);
  }
}

export function getAutoSnapshot() {
  var snapshot = Object.assign({}, state.customState);
  if (state.claimedItem) snapshot.claimed_item = state.claimedItem;
  if (state.currentStep) snapshot.current_step = state.currentStep;
  if (state.progressNotes.length) snapshot.progress = state.progressNotes;
  return snapshot;
}

export async function sendHeartbeat() {
  if (state.role !== 'agent' || !state.agentId) return;
  try {
    var result = await apiPost('/agents/heartbeat', {
      status: 'online',
      working_on: state.workingOn,
      session_id: state.sessionId,
      messages_acked: JSON.stringify(state.messagesAcked),
      state_snapshot: JSON.stringify(getAutoSnapshot())
    });
    // Alert agent if there are pending messages/requests/directives (granular)
    if (result && result.pending) {
      var p = result.pending;
      var total = (p.directives || 0) + (p.requests || 0) + (p.unread || 0);
      if (p.directives > 0) {
        process.stderr.write('[mycelium] *** ' + p.directives + ' PENDING DIRECTIVE(S) — check messages immediately ***\n');
      } else if (p.requests > 0) {
        process.stderr.write('[mycelium] ' + p.requests + ' pending request(s) waiting for response\n');
      } else if (total > 0) {
        process.stderr.write('[mycelium] ' + total + ' unread message(s)\n');
      }
    }
    // Warn when messages/requests/directives are waiting (simple count fallback)
    if (result && result.pending_count > 0) {
      process.stderr.write('[mycelium] ' + result.pending_count + ' pending message(s) waiting for ' + state.agentId + ' — run mycelium_boot or check messages\n');
    }
    // Surface work queue items discovered on heartbeat
    if (result && result.work_queue && result.work_queue.length > 0) {
      process.stderr.write('[mycelium] === Work Queue (' + result.work_queue.length + ' items) ===\n');
      for (var item of result.work_queue) {
        var label = (item.type || 'unknown').toUpperCase();
        var snippet = (item.title || item.content || '').substring(0, 80);
        process.stderr.write('[mycelium]   ' + label + ' #' + item.id + ': ' + snippet + '\n');
      }
    }
  } catch (e) {
    process.stderr.write('Heartbeat failed: ' + e.message + '\n');
  }
}

export function setMcpServer(mcpServer) {
  state.mcpServer = mcpServer;
}

export function startHeartbeat(mcpServer) {
  if (state.role !== 'agent') return;
  if (mcpServer) state.mcpServer = mcpServer;
  stopHeartbeat();
  // Heartbeat every 5 minutes (boot already marks agent online — no need to send immediately)
  state.heartbeatTimer = setInterval(sendHeartbeat, 5 * 60 * 1000);
  // Send one immediately
  sendHeartbeat();
  // Start SSE subscription — pass server so sleep_mode_on can wake this session
  startSSE(null, state.mcpServer);
}

export function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

export async function shutdown() {
  stopHeartbeat();
  stopSSE();
  if (state.role === 'agent' && state.agentId) {
    // Auto-save session summary
    try {
      var sessionData = {
        working_on: state.workingOn || '',
        timestamp: new Date().toISOString()
      };
      await apiPut('/context/keys/' + state.agentId + '/last_session', {
        value: JSON.stringify(sessionData)
      });
    } catch (e) { /* best effort */ }

    // Clear working_on on shutdown
    try {
      await apiPost('/agents/heartbeat', {
        status: 'offline',
        working_on: ''
      });
    } catch { /* best effort */ }
  }
}
