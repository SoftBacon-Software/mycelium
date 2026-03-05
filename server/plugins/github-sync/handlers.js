// GitHub Sync event handlers
// Subscribes to Mycelium events and emits outbound sync events for linked GitHub entities.

import createGithubDB from './db.js';

export function registerHooks(core) {
  var db = createGithubDB(core.db);

  core.onEvent('task_completed', function (eventData) {
    try {
      var data = eventData.data || {};
      var taskId = data.task_id || data.id;
      if (!taskId) return;

      var link = db.getLinkByMycelium('task', taskId);
      if (!link) return;

      core.emitEvent('github_sync_outbound', '__system__', eventData.project_id,
        'Task #' + taskId + ' completed — linked to ' + link.github_repo + '#' + link.github_number,
        { link: link, event: 'task_completed', task_id: taskId });

      console.log('[github-sync] Outbound sync: task #' + taskId + ' completed -> ' + link.github_repo + '#' + link.github_number);
    } catch (e) {
      console.error('[github-sync] Error in task_completed hook:', e.message);
    }
  });

  core.onEvent('bug_fixed', function (eventData) {
    try {
      var data = eventData.data || {};
      var bugId = data.bug_id || data.id;
      if (!bugId) return;

      var link = db.getLinkByMycelium('bug', bugId);
      if (!link) return;

      core.emitEvent('github_sync_outbound', '__system__', eventData.project_id,
        'Bug #' + bugId + ' fixed — linked to ' + link.github_repo + '#' + link.github_number,
        { link: link, event: 'bug_fixed', bug_id: bugId });

      console.log('[github-sync] Outbound sync: bug #' + bugId + ' fixed -> ' + link.github_repo + '#' + link.github_number);
    } catch (e) {
      console.error('[github-sync] Error in bug_fixed hook:', e.message);
    }
  });
}
