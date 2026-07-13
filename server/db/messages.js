// =============== MYCELIUM — DB entity: messages, requests, reads, team chat, operator inbox ===============
// Extracted from server/db.js (Wave 2 of the decomposition). Zero coupling
// outgoing (`createInboxItemForAllOperators` queries operators by raw SQL —
// stays). Mirrors routes/messages.js exactly (messages + inbox). The functions
// below use only the live `db` binding from ./core.js (no sibling db/* imports).
// `markMessagesRead` declares a local `var stmt` — legal shadowing, this module
// doesn't import the `stmt()` helper from core. Bodies moved VERBATIM — bare
// db.prepare(...) keeps working via the ESM live binding (initDBConnection
// assigns db; nobody else may). The barrel server/db.js re-exports these via
// `export * from './db/messages.js'` so no consumer changes a single import.
import { db } from './core.js';

// -- Messages --

var VALID_MSG_PRIORITIES = ['urgent', 'normal', 'fyi'];

export function createMessage(fromAgent, toAgent, threadId, projectId, content, metadata, msgType, channelId, priority) {
  var prio = VALID_MSG_PRIORITIES.includes(priority) ? priority : 'normal';
  if (msgType && msgType !== 'message') {
    var result = db.prepare(
      "INSERT INTO messages (from_agent, to_agent, thread_id, project_id, content, metadata, msg_type, channel_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}', msgType, channelId || null, prio);
    return result.id;
  }
  var result = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, thread_id, project_id, content, metadata, channel_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}', channelId || null, prio);
  return result.id;
}

export function createRequest(fromAgent, toAgent, threadId, projectId, content, metadata) {
  var result = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, thread_id, project_id, content, metadata, msg_type, status, priority) VALUES (?, ?, ?, ?, ?, ?, 'request', 'pending', 'urgent') RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, projectId || null, content, metadata || '{}');
  return result.id;
}

export function acknowledgeMessage(id) {
  db.prepare("UPDATE messages SET status = 'acknowledged' WHERE id = ?").run(id);
}

export function resolveMessage(id, resolvedBy) {
  db.prepare("UPDATE messages SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").run(resolvedBy, id);
}

export function listPendingRequests(agentId) {
  return db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
}

export function countPendingForAgent(agentId) {
  var row = db.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent')) as requests, " +
    "(SELECT COUNT(*) FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent')) as directives, " +
    "(SELECT COUNT(*) FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND status = 'sent') as unread"
  ).get(agentId, agentId, agentId);
  return row;
}

export function getAgentInbox(agentId, limit) {
  limit = limit || 20;
  // Directives (blocking, must handle first)
  var directives = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent') ORDER BY created_at ASC"
  ).all(agentId);
  // Requests (blocking, must respond)
  var requests = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
  // Unread messages (directed to me or broadcast, status=sent)
  var messages = db.prepare(
    "SELECT id, from_agent, to_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND status = 'sent' ORDER BY created_at DESC LIMIT ?"
  ).all(agentId, limit);
  return { directives: directives, requests: requests, messages: messages };
}

export function getMessage(id) {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
}

// Mark messages as read by an agent (idempotent via UNIQUE constraint)
export function markMessagesRead(agentId, messageIds) {
  var stmt = db.prepare("INSERT OR IGNORE INTO message_reads (message_id, agent_id) VALUES (?, ?)");
  var tx = db.transaction(function (ids) {
    for (var id of ids) stmt.run(id, agentId);
  });
  tx(messageIds);
}

// Get unread messages for an agent (excludes messages they've already acked)
export function getUnreadMessages(agentId, limit) {
  limit = limit || 20;
  // Directives + requests (blocking — always unread if status is pending/sent)
  var directives = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('pending', 'sent') ORDER BY created_at ASC"
  ).all(agentId);
  var requests = db.prepare(
    "SELECT id, from_agent, content, msg_type, priority, project_id, created_at FROM messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('pending', 'sent') ORDER BY created_at DESC"
  ).all(agentId);
  // Regular messages: directed to me OR broadcast, not yet read by me
  var messages = db.prepare(
    "SELECT m.id, m.from_agent, m.to_agent, m.content, m.msg_type, m.priority, m.project_id, m.created_at " +
    "FROM messages m " +
    "LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ? " +
    "WHERE (m.to_agent = ? OR m.to_agent IS NULL) AND m.msg_type IN ('message', 'info') AND m.status = 'sent' " +
    "AND r.id IS NULL " +
    "ORDER BY m.created_at DESC LIMIT ?"
  ).all(agentId, agentId, limit);
  return { directives, requests, messages };
}

export function listMessages(filters) {
  var where = ["msg_type != 'chat'"];
  var params = [];
  // Exclude system-to-system telemetry (runner health, etc) unless explicitly requested
  if (!filters.include_system) {
    where.push("NOT (from_agent = '__system__' AND to_agent = '__system__')");
  }
  if (filters.from_agent) { where.push('from_agent = ?'); params.push(filters.from_agent); }
  if (filters.to_agent) { where.push('(to_agent = ? OR to_agent IS NULL)'); params.push(filters.to_agent); }
  if (filters.thread_id) { where.push('thread_id = ?'); params.push(filters.thread_id); }
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.since) { where.push('created_at > ?'); params.push(filters.since); }
  if (filters.channel_id) { where.push('channel_id = ?'); params.push(filters.channel_id); }
  if (filters.msg_type) { where.push('msg_type = ?'); params.push(filters.msg_type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.priority) { where.push('priority = ?'); params.push(filters.priority); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  // Sort: urgent messages first (within same time window), then by created_at DESC
  var orderBy = filters.priority_sort
    ? "CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at DESC"
    : 'created_at DESC';
  return db.prepare('SELECT * FROM messages WHERE ' + where.join(' AND ') + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?').all(...params);
}

export function listThreads(limit) {
  return db.prepare(`SELECT thread_id, COUNT(*) as message_count,
    MAX(created_at) as last_message_at,
    (SELECT from_agent FROM messages m2 WHERE m2.thread_id = messages.thread_id ORDER BY created_at DESC LIMIT 1) as last_sender
    FROM messages WHERE thread_id IS NOT NULL
    GROUP BY thread_id ORDER BY last_message_at DESC LIMIT ?`).all(Math.min(limit || 20, 500));
}

// Archive resolved messages older than N days (default 90)
// Deletes from messages, returns count of rows removed
export function archiveOldMessages(daysOld) {
  daysOld = parseInt(daysOld) || 90;
  var result = db.prepare(
    "DELETE FROM messages WHERE created_at < datetime('now', '-' || ? || ' days')" +
    " AND (status = 'resolved' OR msg_type = 'info')"
  ).run(String(daysOld));
  return result.changes;
}

export function bulkDeleteMessages(filters) {
  var conditions = [];
  var params = [];
  if (filters.from) { conditions.push('from_agent = ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('to_agent = ?'); params.push(filters.to); }
  if (filters.content_like) { conditions.push('content LIKE ?'); params.push('%' + filters.content_like + '%'); }
  if (conditions.length === 0) return 0;
  var sql = 'DELETE FROM messages WHERE ' + conditions.join(' AND ');
  return db.prepare(sql).run(...params).changes;
}

// -- Team Chat (human-only messages) --

export function createTeamChat(fromUser, content) {
  var result = db.prepare(
    "INSERT INTO messages (from_agent, content, msg_type) VALUES (?, ?, 'chat') RETURNING id"
  ).get(fromUser, content);
  return result.id;
}

export function listTeamChat(limit) {
  return db.prepare(
    "SELECT * FROM messages WHERE msg_type = 'chat' ORDER BY created_at DESC LIMIT ?"
  ).all(limit || 50);
}

export function resolveStaleRequests(hoursOld) {
  var hours = hoursOld || 72;
  var stale = db.prepare(
    "SELECT id FROM messages WHERE msg_type = 'request' AND status IN ('pending', 'sent') AND created_at < datetime('now', '-' || ? || ' hours')"
  ).all(hours);
  for (var req of stale) {
    db.prepare(
      "UPDATE messages SET status = 'resolved', resolved_at = datetime('now'), resolved_by = 'system', content = content || '\n\n[Auto-resolved: request was pending for over ' || ? || ' hours]' WHERE id = ?"
    ).run(hours, req.id);
  }
  return stale.length;
}

// -- Operator Inbox --

export function createInboxItem(operatorId, type, entityType, entityId, title, summary, data, priority) {
  var result = db.prepare(
    'INSERT INTO operator_inbox (operator_id, type, entity_type, entity_id, title, summary, data, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(operatorId, type || 'message', entityType || '', entityId || '', title || '', summary || '', JSON.stringify(data || {}), priority || 'normal');
  return result.id;
}

export function createInboxItemForAllOperators(type, entityType, entityId, title, summary, data, priority) {
  var ops = db.prepare("SELECT id FROM operators WHERE status = 'active'").all();
  var ids = [];
  var insertStmt = db.prepare(
    'INSERT INTO operator_inbox (operator_id, type, entity_type, entity_id, title, summary, data, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  );
  for (var op of ops) {
    var row = insertStmt.get(op.id, type || 'message', entityType || '', entityId || '', title || '', summary || '', JSON.stringify(data || {}), priority || 'normal');
    ids.push(row.id);
  }
  return ids;
}

export function getInboxItem(id) {
  return db.prepare('SELECT * FROM operator_inbox WHERE id = ?').get(id);
}

export function listInboxItems(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.operator_id) { where.push('operator_id = ?'); params.push(filters.operator_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  else { where.push("status != 'dismissed'"); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.entity_type) { where.push('entity_type = ?'); params.push(filters.entity_type); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  var sql = 'SELECT * FROM operator_inbox WHERE ' + where.join(' AND ') + ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'normal\' THEN 1 ELSE 2 END, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function markInboxItemRead(id) {
  db.prepare("UPDATE operator_inbox SET status = 'read', read_at = datetime('now') WHERE id = ? AND status = 'unread'").run(id);
}

export function markInboxItemActioned(id) {
  db.prepare("UPDATE operator_inbox SET status = 'actioned', read_at = COALESCE(read_at, datetime('now')) WHERE id = ?").run(id);
}

export function dismissInboxItem(id) {
  db.prepare("UPDATE operator_inbox SET status = 'dismissed' WHERE id = ?").run(id);
}

export function countUnreadInbox(operatorId) {
  var row = db.prepare("SELECT COUNT(*) as c FROM operator_inbox WHERE operator_id = ? AND status = 'unread'").get(operatorId);
  return row ? row.c : 0;
}

export function countAllUnreadInbox() {
  return db.prepare("SELECT operator_id, COUNT(*) as count FROM operator_inbox WHERE status = 'unread' GROUP BY operator_id").all();
}
