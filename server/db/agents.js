// =============== MYCELIUM — DB entity: agents + agent templates ===============
// Extracted from server/db.js (Wave 3 of the decomposition). `deleteAgent` is a
// 9-table raw-SQL cascade (tasks, messages, bugs, drone_jobs, agent_savepoints,
// webhooks, message_reads, channel_members, agents) — moves whole, no sibling
// imports. `resolveAssignee` is imported by tasks + plans (still local to the
// barrel — named re-import there). The functions below use only the live `db` +
// `stmt` + `buildUpdate` bindings from ./core.js (no sibling db/* imports).
// Bodies moved VERBATIM — bare db.prepare(...) / stmt(...) / buildUpdate(...)
// keep working via the ESM live bindings (initDBConnection assigns db; nobody
// else may). The barrel server/db.js re-exports these via
// `export * from './db/agents.js'` so no consumer changes a single import.
import { db, stmt, buildUpdate } from './core.js';

// -- Agents --

export function createAgent(id, name, projectId, apiKeyHash, capabilities) {
  stmt('dvCreateAgent', `INSERT INTO agents (id, name, project_id, api_key_hash, capabilities)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, projectId, apiKeyHash, capabilities || '[]');
}

export function getAgent(id) {
  return stmt('dvGetAgent', 'SELECT * FROM agents WHERE id = ?').get(id);
}

export function getAgentByKeyHash(apiKeyHash) {
  return stmt('dvGetAgentByKey', 'SELECT * FROM agents WHERE api_key_hash = ?').get(apiKeyHash);
}

// Resolve an assignee to a canonical agent id. Accepts an agent id OR display
// name, case-insensitively — so the app, a human, or a script can assign by name
// ("Ada") and it still matches the agent whose id is "ada". Unmatched assignees
// (operator names, not-yet-registered agents, "", null) pass through unchanged.
export function resolveAssignee(assignee) {
  if (typeof assignee !== 'string') return assignee;
  var a = assignee.trim();
  if (!a) return assignee;
  var row = stmt('dvResolveAssignee',
    'SELECT id FROM agents WHERE id = ? COLLATE NOCASE OR name = ? COLLATE NOCASE LIMIT 1'
  ).get(a, a);
  return row ? row.id : assignee;
}

export function listAgents() {
  return stmt('dvListAgents4', "SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, llm_backend, llm_model, runtime, system_diagnostics, agent_type, primary_team_id, created_at FROM agents WHERE project_id != 'drone' ORDER BY created_at").all();
}

export function listAllAgentsIncludingDrones() {
  return stmt('dvListAllAgents', 'SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, created_at FROM agents ORDER BY created_at').all();
}

export function updateAgentHeartbeat(id, status, workingOn) {
  stmt('dvHeartbeat', `UPDATE agents SET status = ?, working_on = ?, last_heartbeat = datetime('now')
    WHERE id = ?`).run(status || 'online', workingOn || '', id);
}

export function updateAgentKey(id, apiKeyHash) {
  stmt('dvUpdateAgentKey', 'UPDATE agents SET api_key_hash = ? WHERE id = ?').run(apiKeyHash, id);
}

export function deleteAgent(id) {
  db.prepare('DELETE FROM tasks WHERE assignee = ?').run(id);
  db.prepare('DELETE FROM messages WHERE from_agent = ? OR to_agent = ?').run(id, id);
  db.prepare('DELETE FROM bugs WHERE assignee = ?').run(id);
  db.prepare('DELETE FROM drone_jobs WHERE requester = ? OR drone_id = ?').run(id, id);
  db.prepare('DELETE FROM agent_savepoints WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM webhooks WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM message_reads WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM channel_members WHERE user_id = ? AND user_type = ?').run(id, 'agent');
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

export function updateAgent(id, fields) {
  // Pre-process JSON fields
  if (fields.system_diagnostics !== undefined && typeof fields.system_diagnostics !== 'string') {
    fields = Object.assign({}, fields, { system_diagnostics: JSON.stringify(fields.system_diagnostics) });
  }
  buildUpdate('agents', id, fields, ['avatar_url', 'name', 'role', 'operator_id', 'project', 'project_id', 'llm_backend', 'llm_model', 'agent_type', 'capabilities', 'system_diagnostics', 'runtime']);
}

// ---- Agent Templates ----

export function createAgentTemplate(id, name, description, data, createdBy) {
  db.prepare(
    "INSERT INTO agent_templates (id, name, description, runtime, llm_backend, llm_model, agent_type, capabilities, project_id, team_ids, profile_rules, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, description || '', data.runtime || '', data.llm_backend || '', data.llm_model || '', data.agent_type || 'agent', JSON.stringify(data.capabilities || ['code', 'assets']), data.project_id || '', JSON.stringify(data.team_ids || []), JSON.stringify(data.profile_rules || {}), createdBy || '');
  return getAgentTemplate(id);
}

export function getAgentTemplate(id) {
  var row = db.prepare("SELECT * FROM agent_templates WHERE id = ?").get(id);
  if (!row) return null;
  try { row.capabilities = JSON.parse(row.capabilities); } catch (_) { row.capabilities = []; }
  try { row.team_ids = JSON.parse(row.team_ids); } catch (_) { row.team_ids = []; }
  try { row.profile_rules = JSON.parse(row.profile_rules); } catch (_) { row.profile_rules = {}; }
  return row;
}

export function listAgentTemplates() {
  var rows = db.prepare("SELECT * FROM agent_templates ORDER BY name").all();
  for (var row of rows) {
    try { row.capabilities = JSON.parse(row.capabilities); } catch (_) { row.capabilities = []; }
    try { row.team_ids = JSON.parse(row.team_ids); } catch (_) { row.team_ids = []; }
    try { row.profile_rules = JSON.parse(row.profile_rules); } catch (_) { row.profile_rules = {}; }
  }
  return rows;
}

export function updateAgentTemplate(id, fields) {
  var f = Object.assign({}, fields);
  if (f.capabilities !== undefined) f.capabilities = JSON.stringify(f.capabilities);
  if (f.team_ids !== undefined) f.team_ids = JSON.stringify(f.team_ids);
  if (f.profile_rules !== undefined) f.profile_rules = JSON.stringify(f.profile_rules);
  var changed = buildUpdate('agent_templates', id, f, ['name', 'description', 'runtime', 'llm_backend', 'llm_model', 'agent_type', 'project_id', 'capabilities', 'team_ids', 'profile_rules'], { updatedAt: true });
  if (!changed) return getAgentTemplate(id);
  return getAgentTemplate(id);
}

export function deleteAgentTemplate(id) {
  db.prepare("DELETE FROM agent_templates WHERE id = ?").run(id);
}
