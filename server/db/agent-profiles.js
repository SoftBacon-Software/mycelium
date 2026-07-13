// =============== MYCELIUM — DB entity: agent profiles ===============
// Extracted from server/db.js (Wave 3 of the decomposition). Coupling:
// `ensureAgentProfile` imports `getAgent` (agents). `incrementProfileCounter`
// is part of the route-level done-cascade (routes/tasks.js's
// getDB().transaction) — unaffected by this split. The functions below use the
// live `db` + `buildUpdate` bindings from ./core.js. Bodies moved VERBATIM —
// bare db.prepare(...) / buildUpdate(...) keep working via the ESM live bindings
// (initDBConnection assigns db; nobody else may). The barrel server/db.js
// re-exports these via `export * from './db/agent-profiles.js'` so no consumer
// changes a single import.
import { db, buildUpdate } from './core.js';
import { getAgent } from './agents.js';

// -- Agent Profiles --

export function getAgentProfile(agentId) {
  var row = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId);
  if (row) {
    try { row.specializations = JSON.parse(row.specializations); } catch (e) { row.specializations = []; }
    try { row.preferred_projects = JSON.parse(row.preferred_projects); } catch (e) { row.preferred_projects = []; }
    try { row.capability_history = JSON.parse(row.capability_history); } catch (e) { row.capability_history = []; }
    try { row.profile_data = JSON.parse(row.profile_data); } catch (e) { row.profile_data = {}; }
  }
  return row;
}

export function ensureAgentProfile(agentId) {
  var existing = db.prepare('SELECT agent_id FROM agent_profiles WHERE agent_id = ?').get(agentId);
  if (existing) {
    db.prepare("UPDATE agent_profiles SET session_count = session_count + 1, last_active_at = datetime('now') WHERE agent_id = ?").run(agentId);
    return getAgentProfile(agentId);
  }
  var agent = getAgent(agentId);
  var displayName = agent ? agent.name : agentId;
  db.prepare("INSERT INTO agent_profiles (agent_id, display_name, session_count) VALUES (?, ?, 1)").run(agentId, displayName);
  return getAgentProfile(agentId);
}

export function updateAgentProfile(agentId, fields) {
  var f = Object.assign({}, fields);
  if (f.specializations !== undefined) f.specializations = JSON.stringify(f.specializations);
  if (f.preferred_projects !== undefined) f.preferred_projects = JSON.stringify(f.preferred_projects);
  if (f.profile_data !== undefined) f.profile_data = JSON.stringify(f.profile_data);
  if (f.capability_history !== undefined) f.capability_history = JSON.stringify(f.capability_history);
  var changed = buildUpdate('agent_profiles', agentId, f, ['display_name', 'specializations', 'preferred_projects', 'max_concurrent', 'profile_data', 'capability_history'], { extraSets: ["last_active_at = datetime('now')"], where: 'agent_id' });
  if (!changed) return getAgentProfile(agentId);
  return getAgentProfile(agentId);
}

export function incrementProfileCounter(agentId, counter) {
  var allowed = ['total_tasks_completed', 'total_bugs_fixed', 'total_prs_created'];
  if (allowed.indexOf(counter) === -1) return;
  db.prepare('UPDATE agent_profiles SET ' + counter + ' = ' + counter + ' + 1 WHERE agent_id = ?').run(agentId);
}

export function listAgentProfiles() {
  var rows = db.prepare('SELECT * FROM agent_profiles ORDER BY total_tasks_completed DESC').all();
  return rows.map(function (row) {
    try { row.specializations = JSON.parse(row.specializations); } catch (e) { row.specializations = []; }
    try { row.preferred_projects = JSON.parse(row.preferred_projects); } catch (e) { row.preferred_projects = []; }
    try { row.capability_history = JSON.parse(row.capability_history); } catch (e) { row.capability_history = []; }
    try { row.profile_data = JSON.parse(row.profile_data); } catch (e) { row.profile_data = {}; }
    return row;
  });
}

export function getAgentLeaderboard(limit) {
  limit = Math.min(limit || 20, 100);
  var rows = db.prepare(
    'SELECT agent_id, display_name, specializations, total_tasks_completed, total_bugs_fixed, total_prs_created, session_count, first_seen_at, last_active_at FROM agent_profiles ORDER BY total_tasks_completed DESC LIMIT ?'
  ).all(limit);
  return rows.map(function (row) {
    try { row.specializations = JSON.parse(row.specializations); } catch (e) { row.specializations = []; }
    return row;
  });
}
