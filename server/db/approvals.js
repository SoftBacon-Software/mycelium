// =============== MYCELIUM — DB entity: approvals + approval votes ===============
// Extracted from server/db.js (Wave 2 of the decomposition). `decideApproval`
// writes `operator_inbox` (auto-actions related inbox items) by raw SQL — an
// approvals→inbox seam that stays in-body. The functions below use only the
// live `db` + `stmt` bindings from ./core.js (no sibling db/* imports). Bodies
// moved VERBATIM — bare db.prepare(...) / stmt(...) keep working via the ESM
// live bindings (initDBConnection assigns db; nobody else may). The barrel
// server/db.js re-exports these via `export * from './db/approvals.js'` so no
// consumer changes a single import.
import { db, stmt } from './core.js';

// =============== APPROVALS ===============

var GATED_ACTIONS = ['deploy', 'git_push', 'plan_create', 'money_action', 'delete', 'external_comm'];
export { GATED_ACTIONS };

export function createApproval(actionType, requestedBy, title, payload, projectId, riskTier, requiredApprovals) {
  var result = stmt('dvCreateApproval2',
    "INSERT INTO approvals (action_type, requested_by, title, payload, project_id, risk_tier, required_approvals) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(actionType, requestedBy, title || '', typeof payload === 'string' ? payload : JSON.stringify(payload || {}), projectId || 'mycelium', riskTier || 'medium', requiredApprovals || 1);
  return result.id;
}

export function getApproval(id) {
  return stmt('dvGetApproval', "SELECT * FROM approvals WHERE id = ?").get(id);
}

export function listApprovals(filters) {
  var where = ['1=1']; var params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.action_type) { where.push('action_type = ?'); params.push(filters.action_type); }
  if (filters.requested_by) { where.push('requested_by = ?'); params.push(filters.requested_by); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  var limit = Math.min(filters.limit || 50, 500);
  params.push(limit);
  return db.prepare('SELECT * FROM approvals WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
}

export function decideApproval(id, status, decidedBy, reason) {
  db.prepare(
    "UPDATE approvals SET status = ?, decided_by = ?, decided_at = datetime('now'), reason = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, decidedBy, reason || '', id);
  // Auto-action related inbox items so approve/reject buttons disappear
  db.prepare(
    "UPDATE operator_inbox SET status = 'actioned', read_at = COALESCE(read_at, datetime('now')) WHERE entity_type = 'approval' AND entity_id = ? AND status != 'dismissed'"
  ).run(String(id));
}

export function markApprovalExecuted(id) {
  db.prepare("UPDATE approvals SET status = 'executed', executed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
}

export function countPendingApprovals() {
  return stmt('dvCountApprovals', "SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'").get();
}

export function listPendingApprovalsByAgent(agentId) {
  return db.prepare("SELECT * FROM approvals WHERE requested_by = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC").all(agentId);
}

// -- Approval Votes --

export function castApprovalVote(approvalId, voter, vote, notes) {
  stmt('dvCastVote', `INSERT INTO approval_votes (approval_id, voter, vote, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(approval_id, voter) DO UPDATE SET vote = excluded.vote, notes = excluded.notes, created_at = datetime('now')`
  ).run(approvalId, voter, vote || 'approve', notes || '');
}

export function getApprovalVotes(approvalId) {
  return stmt('dvGetVotes', 'SELECT * FROM approval_votes WHERE approval_id = ? ORDER BY created_at').all(approvalId);
}

export function countApprovalVotes(approvalId) {
  var row = db.prepare(
    "SELECT SUM(CASE WHEN vote = 'approve' THEN 1 ELSE 0 END) as approves, SUM(CASE WHEN vote = 'deny' THEN 1 ELSE 0 END) as denies FROM approval_votes WHERE approval_id = ?"
  ).get(approvalId);
  return { approves: row.approves || 0, denies: row.denies || 0 };
}
