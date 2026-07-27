// =============== MYCELIUM — DB entity: agent savepoints ===============
// Extracted from server/db.js (Wave 3 of the decomposition). `computeSavepointDiff`
// is a cross-entity read (messages, tasks, context_keys, plans, bugs, drone_jobs,
// events — all raw SQL, no imports). High fan-in: drones, node-profiles, and the
// boot payload import `getLatestSavepoint` — they stay local to the barrel for
// now and get a named re-import there. The seven functions below use only the
// live `db` binding from ./core.js (no sibling db/* imports). Bodies moved
// VERBATIM — bare db.prepare(...) keeps working via the ESM live binding
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/savepoints.js'` so no consumer
// changes a single import.
import { db } from './core.js';

export function cleanupSavepoints(keepPerAgent) {
  var keep = keepPerAgent || 50;
  var agents = db.prepare("SELECT DISTINCT agent_id FROM agent_savepoints").all();
  var totalCleaned = 0;
  for (var i = 0; i < agents.length; i++) {
    var agentId = agents[i].agent_id;
    var result = db.prepare(
      "DELETE FROM agent_savepoints WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT ?)"
    ).run(agentId, agentId, keep);
    totalCleaned += result.changes;
  }
  if (totalCleaned > 0) {
    console.log('[mycelium] Cleaned up %d old savepoints (keep: %d per agent)', totalCleaned, keep);
  }
  return totalCleaned;
}

// ======== AGENT SAVEPOINTS ========

export function createSavepoint(agentId, data) {
  // Validate state_snapshot is valid JSON
  var stateSnapshot = '{}';
  if (data.state_snapshot) {
    try {
      stateSnapshot = typeof data.state_snapshot === 'string'
        ? (JSON.parse(data.state_snapshot), data.state_snapshot)
        : JSON.stringify(data.state_snapshot);
    } catch (e) {
      console.warn('[mycelium] Invalid state_snapshot JSON for %s, using empty object', agentId);
      stateSnapshot = '{}';
    }
  }

  var messagesAcked = '[]';
  if (data.messages_acked) {
    try {
      messagesAcked = typeof data.messages_acked === 'string'
        ? (JSON.parse(data.messages_acked), data.messages_acked)
        : JSON.stringify(data.messages_acked);
    } catch (e) {
      messagesAcked = '[]';
    }
  }

  return db.prepare(
    `INSERT INTO agent_savepoints (agent_id, session_id, heartbeat_at, working_on, state_snapshot, messages_acked, context_versions, notes)
     VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)`
  ).run(
    agentId,
    data.session_id || null,
    data.working_on || '',
    stateSnapshot,
    messagesAcked,
    JSON.stringify(data.context_versions || {}),
    data.notes || null
  );
}

export function getLatestSavepoint(agentId) {
  return db.prepare(
    'SELECT * FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT 1'
  ).get(agentId);
}

export function getSavepointHistory(agentId, limit) {
  return db.prepare(
    'SELECT id, agent_id, session_id, heartbeat_at, working_on, notes, created_at FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT ?'
  ).all(agentId, limit || 10);
}

export function updateSavepointNotes(agentId, notes) {
  var latest = getLatestSavepoint(agentId);
  if (!latest) return null;
  db.prepare('UPDATE agent_savepoints SET notes = ? WHERE id = ?').run(notes, latest.id);
  return latest.id;
}

export function computeSavepointDiff(agentId) {
  var savepoint = getLatestSavepoint(agentId);
  if (!savepoint) return { has_savepoint: false };

  var ackedIds = [];
  try { ackedIds = JSON.parse(savepoint.messages_acked || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for savepoint.messages_acked (agent: ' + agentId + '):', e.message); }

  var ctxVersions = {};
  try { ctxVersions = JSON.parse(savepoint.context_versions || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for savepoint.context_versions (agent: ' + agentId + '):', e.message); }

  var snapshot = {};
  try { snapshot = JSON.parse(savepoint.state_snapshot || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for savepoint.state_snapshot (agent: ' + agentId + '):', e.message); }

  // Messages the agent hasn't seen (not in acked list, sent after savepoint)
  var newMessages = db.prepare(
    "SELECT * FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND id NOT IN (SELECT value FROM json_each(?)) AND created_at > ? ORDER BY created_at ASC LIMIT 100"
  ).all(agentId, JSON.stringify(ackedIds), savepoint.heartbeat_at);

  // Tasks that changed since savepoint
  var tasksChanged = db.prepare(
    "SELECT * FROM tasks WHERE (assignee = ? OR assignee IS NULL) AND updated_at > ? ORDER BY updated_at DESC LIMIT 50"
  ).all(agentId, savepoint.heartbeat_at);

  // Context keys that changed since savepoint
  var contextChanged = db.prepare(
    "SELECT * FROM context_keys WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 50"
  ).all(savepoint.heartbeat_at);

  // Plans that changed since savepoint
  var plansChanged = db.prepare(
    "SELECT p.* FROM plans p WHERE p.updated_at > ? ORDER BY p.updated_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at);

  // Bugs that changed since savepoint
  var bugsChanged = db.prepare(
    "SELECT * FROM bugs WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at);

  // Drone jobs that changed since savepoint
  var droneJobsChanged = db.prepare(
    "SELECT * FROM drone_jobs WHERE (started_at > ? OR completed_at > ? OR created_at > ?) ORDER BY created_at DESC LIMIT 20"
  ).all(savepoint.heartbeat_at, savepoint.heartbeat_at, savepoint.heartbeat_at);

  // Events since savepoint
  var eventsSince = db.prepare(
    "SELECT * FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT 50"
  ).all(savepoint.heartbeat_at);

  return {
    has_savepoint: true,
    savepoint_id: savepoint.id,
    savepoint_at: savepoint.heartbeat_at,
    session_id: savepoint.session_id,
    was_working_on: savepoint.working_on,
    notes: savepoint.notes,
    previous_state: snapshot,
    changes: {
      new_messages: newMessages,
      tasks_changed: tasksChanged,
      context_changed: contextChanged,
      plans_changed: plansChanged,
      bugs_changed: bugsChanged,
      drone_jobs_changed: droneJobsChanged,
      events_since: eventsSince.length
    },
    summary: {
      messages: newMessages.length,
      tasks: tasksChanged.length,
      context: contextChanged.length,
      plans: plansChanged.length,
      bugs: bugsChanged.length,
      drone_jobs: droneJobsChanged.length,
      events: eventsSince.length,
      time_since: savepoint.heartbeat_at
    }
  };
}

export function pruneSavepoints(agentId, keepCount) {
  // Keep only the most recent N savepoints per agent
  var count = keepCount || 50;
  var cutoff = db.prepare(
    'SELECT heartbeat_at FROM agent_savepoints WHERE agent_id = ? ORDER BY heartbeat_at DESC LIMIT 1 OFFSET ?'
  ).get(agentId, count);
  if (cutoff) {
    db.prepare('DELETE FROM agent_savepoints WHERE agent_id = ? AND heartbeat_at < ?').run(agentId, cutoff.heartbeat_at);
  }
}
