// =============== MYCELIUM — DB entity: agent spend ===============
// Extracted from server/db.js (Wave 1 of the decomposition). Zero coupling:
// the three functions below use only the live `db` binding from ./core.js (no
// stmt / buildUpdate, no sibling db/* imports). Bodies moved VERBATIM — bare
// db.prepare(...) keeps working via the ESM live binding (initDBConnection
// assigns db; nobody else may). The barrel server/db.js re-exports these via
// `export * from './db/spend.js'` so no consumer changes a single import.
import { db } from './core.js';

// ---- Agent Spend Tracking ----

export function logAgentSpend(agentId, projectId, costUsd, source, description, model, tokensIn, tokensOut) {
  db.prepare(
    "INSERT INTO agent_spend (agent_id, project_id, cost_usd, source, description, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(agentId, projectId || '', costUsd || 0, source || '', description || '', model || '', tokensIn || 0, tokensOut || 0);
}

export function getAgentSpend(agentId, opts) {
  var since = (opts && opts.since) || null;
  var projectId = (opts && opts.project_id) || null;
  var limit = (opts && opts.limit) || 50;

  var where = ['agent_id = ?'];
  var params = [agentId];
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }
  params.push(limit);

  return db.prepare(
    'SELECT * FROM agent_spend WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function getSpendSummary(opts) {
  var since = (opts && opts.since) || null;
  var projectId = (opts && opts.project_id) || null;

  var where = ['1=1'];
  var params = [];
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }

  var rows = db.prepare(
    'SELECT agent_id, project_id, SUM(cost_usd) as total_cost, COUNT(*) as entry_count, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out FROM agent_spend WHERE ' + where.join(' AND ') + ' GROUP BY agent_id, project_id ORDER BY total_cost DESC'
  ).all(...params);
  return rows;
}
