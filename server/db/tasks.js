// =============== MYCELIUM — DB entity: tasks, deps, comments, deliverables ===============
// Extracted from server/db.js (Wave 4 of the decomposition). Coupling:
// `updateTask` imports `resolveAssignee` (agents). The route-level done-cascade
// (routes/tasks.js) spans tasks + plans + agent-profiles + messages via
// getDB().transaction — unaffected by this split. The functions below use the
// live `db` + `stmt` + `buildUpdate` bindings from ./core.js. Bodies moved
// VERBATIM — bare db.prepare(...) / stmt(...) / buildUpdate(...) keep working
// via the ESM live bindings (initDBConnection assigns db; nobody else may).
// The barrel server/db.js re-exports these via `export * from './db/tasks.js'`
// so no consumer changes a single import.
import { db, stmt, buildUpdate } from './core.js';
import { resolveAssignee } from './agents.js';

// -- Tasks --

export function createTask(title, description, projectId, requester, priority, tags) {
  var result = stmt('dvCreateTask', `INSERT INTO tasks (title, description, project_id, requester, priority, tags)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(title, description || '', projectId || '', requester, priority || 'normal', tags || '[]');
  return result.id;
}

export function getTask(id) {
  return stmt('dvGetTask', 'SELECT * FROM tasks WHERE id = ?').get(id);
}

export function listTasks(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.requester) { where.push('requester = ?'); params.push(filters.requester); }
  if (filters.priority) { where.push('priority = ?'); params.push(filters.priority); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM tasks WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateTask(id, fields) {
  // Pre-process transformed fields
  var f = Object.assign({}, fields);
  if (f.assignee !== undefined && f.assignee !== null) f.assignee = resolveAssignee(f.assignee);
  if (f.needs_approval !== undefined) f.needs_approval = f.needs_approval ? 1 : 0;
  if (f.blocked_by !== undefined) f.blocked_by = JSON.stringify(f.blocked_by);
  if (f.blocks !== undefined) f.blocks = JSON.stringify(f.blocks);
  buildUpdate('tasks', id, f, ['title', 'description', 'status', 'assignee', 'priority', 'tags', 'needs_approval', 'blocked_by', 'blocks', 'branch', 'pr_url', 'repo', 'review_metadata'], { updatedAt: true });
}

// -- Task dependencies --

export function setTaskDependency(taskId, blockedById) {
  var task = getTask(taskId);
  var blocker = getTask(blockedById);
  if (!task || !blocker) return false;

  var blockedBy = [];
  try { blockedBy = JSON.parse(task.blocked_by || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocked_by (task: ' + taskId + '):', e.message); }
  if (blockedBy.indexOf(blockedById) === -1) {
    blockedBy.push(blockedById);
    db.prepare("UPDATE tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(blockedBy), taskId);
  }

  var blocks = [];
  try { blocks = JSON.parse(blocker.blocks || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocks (task: ' + blockedById + '):', e.message); }
  if (blocks.indexOf(taskId) === -1) {
    blocks.push(taskId);
    db.prepare("UPDATE tasks SET blocks = ? WHERE id = ?").run(JSON.stringify(blocks), blockedById);
  }
  return true;
}

export function resolveTaskDependencies(completedTaskId) {
  var task = getTask(completedTaskId);
  if (!task) return [];
  var blocks = [];
  try { blocks = JSON.parse(task.blocks || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocks (task: ' + completedTaskId + '):', e.message); }

  var unblocked = [];
  for (var blockedId of blocks) {
    var blocked = getTask(blockedId);
    if (!blocked) continue;
    var deps = [];
    try { deps = JSON.parse(blocked.blocked_by || '[]'); } catch (e) { console.warn('[mycelium] JSON parse failed for task.blocked_by (task: ' + blockedId + '):', e.message); }
    deps = deps.filter(function (d) { return d !== completedTaskId; });
    db.prepare("UPDATE tasks SET blocked_by = ? WHERE id = ?").run(JSON.stringify(deps), blockedId);
    if (deps.length === 0) unblocked.push(blockedId);
  }
  return unblocked;
}

// -- Task approval --

export function approveTask(taskId, approvedBy) {
  db.prepare("UPDATE tasks SET approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(approvedBy, taskId);
}

export function listTasksNeedingApproval() {
  return db.prepare("SELECT * FROM tasks WHERE needs_approval = 1 AND approved_by IS NULL AND status != 'done' ORDER BY updated_at DESC").all();
}

// -- Task Comments --

export function addTaskComment(taskId, author, content) {
  var result = db.prepare(
    "INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?) RETURNING *"
  ).get(taskId, author, content);
  return result;
}

export function getTaskComments(taskId) {
  return db.prepare(
    "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId);
}

export function getTaskComment(commentId) {
  return db.prepare("SELECT * FROM task_comments WHERE id = ?").get(commentId);
}

export function deleteTaskComment(commentId) {
  var result = db.prepare("DELETE FROM task_comments WHERE id = ?").run(commentId);
  return result.changes > 0;
}

// -- Task Deliverables --
// The agent's final output, distinct from the task_comments status thread.
// Append-only; getTaskDeliverables returns all attempts oldest-first.

export function addTaskDeliverable(taskId, author, kind, format, content, flags) {
  var result = db.prepare(
    "INSERT INTO task_deliverables (task_id, author, kind, format, content, flags) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
  ).get(taskId, author, kind || 'report', format || 'markdown', content, flags || '');
  return result;
}

export function getTaskDeliverables(taskId) {
  return db.prepare(
    "SELECT * FROM task_deliverables WHERE task_id = ? ORDER BY created_at ASC, id ASC"
  ).all(taskId);
}

export function deleteTask(id) {
  db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(id);
  var result = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return result.changes > 0;
}
