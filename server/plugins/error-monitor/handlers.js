// Error Monitor event handlers — subscribe to platform events

import createErrorDB from './db.js';

export function registerHooks(core) {
  var db = createErrorDB(core.db);

  // When a bug is fixed, resolve any linked error events
  core.onEvent('bug_fixed', function (eventData) {
    try {
      var data = eventData.data || {};
      var bugId = data.bug_id || data.id;
      if (!bugId) return;

      var errors = core.db.prepare(
        "SELECT id FROM dv_error_events WHERE bug_id = ? AND status = 'open'"
      ).all(bugId);

      for (var err of errors) {
        db.resolveError(err.id);
      }

      if (errors.length > 0) {
        console.log('[error-monitor] Resolved ' + errors.length + ' error(s) linked to bug #' + bugId);
      }
    } catch (e) {
      console.error('[error-monitor] Hook error:', e.message);
    }
  });
}
