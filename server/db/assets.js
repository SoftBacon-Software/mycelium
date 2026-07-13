// =============== MYCELIUM — DB entity: assets + asset→task transaction ===============
// Extracted from server/db.js (Wave 4 of the decomposition). Coupling:
// `initTransactions` imports `createTask` (tasks) inside the transaction.
// NOTE: `initTransactions` is exported but never called anywhere —
// `autoTaskFromAsset` returns null until initTransactions() runs, and
// assets-files-widgets-characterization.test.js PINS this behavior (lines 19,
// 125). Do NOT "fix" this during extraction; moved verbatim, dead-path
// preserved. The functions below use the live `db` + `stmt` + `buildUpdate`
// bindings from ./core.js. Bodies moved VERBATIM. The barrel server/db.js
// re-exports these via `export * from './db/assets.js'` so no consumer changes
// a single import.
import { db, stmt, buildUpdate } from './core.js';
import { createTask } from './tasks.js';

// -- Assets --

export function createAsset(name, type, projectId, status, assetPath, metadata, requester) {
  var result = stmt('dvCreateAsset', `INSERT INTO assets (name, type, project_id, status, path, metadata, requester)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(name, type || 'sprite', projectId || 'shared', status || 'requested', assetPath || '', metadata || '{}', requester || '');
  return result.id;
}

export function getAsset(id) {
  return stmt('dvGetAsset', 'SELECT * FROM assets WHERE id = ?').get(id);
}

export function listAssets(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM assets WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateAsset(id, fields) {
  // Returns {changes} for callers that check result.changes
  var changed = buildUpdate('assets', id, fields, ['status', 'path', 'metadata', 'file_path', 'download_url', 'requested_by', 'assigned_to', 'drone_job_id', 'prompt'], { updatedAt: true });
  return { changes: changed ? 1 : 0 };
}

export function deleteAsset(id) {
  return db.prepare('DELETE FROM assets WHERE id = ?').run(id);
}

export function listAssetsByDroneJob(droneJobId) {
  return db.prepare('SELECT * FROM assets WHERE drone_job_id = ?').all(droneJobId);
}
// -- Auto-task from asset request --

var _autoTaskFromAsset = null;

export function initTransactions() {
  _autoTaskFromAsset = db.transaction(function (assetId, projectId, requester) {
    var agents = db.prepare("SELECT id FROM agents WHERE capabilities LIKE '%assets%'").all();
    var assignee = agents.length > 0 ? agents[0].id : null;

    var asset = getAsset(assetId);
    if (!asset) return null;

    var taskId = createTask(
      'Generate asset: ' + asset.name,
      'Auto-created from asset request #' + assetId + '. Type: ' + asset.type + '. Project: ' + projectId,
      projectId,
      requester,
      'normal',
      JSON.stringify(['auto', 'assets'])
    );

    db.prepare("UPDATE tasks SET assignee = ?, linked_asset_id = ? WHERE id = ?").run(assignee, assetId, taskId);

    return { task_id: taskId, assignee: assignee };
  });
}

export function autoTaskFromAsset(assetId, projectId, requester) {
  if (!_autoTaskFromAsset) return null;
  return _autoTaskFromAsset(assetId, projectId, requester);
}
