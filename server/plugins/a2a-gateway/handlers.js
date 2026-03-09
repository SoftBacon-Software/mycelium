// A2A Gateway event handlers

import createA2ADB from './db.js';

export function registerHooks(core) {
  var db = createA2ADB(core.db);

  // When a task linked to an A2A inbound task completes, update the A2A task status
  core.onEvent('task_completed', function (eventData) {
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var taskId = data.task_id || data.id;
      if (!taskId) return;

      // Check if this task was created from an A2A inbound request
      var messages = core.db.prepare(
        "SELECT metadata FROM messages WHERE msg_type = 'directive' AND content LIKE 'A2A TASK:%' AND metadata LIKE ?"
      ).all('%"mycelium_task_id":' + taskId + '%');

      for (var msg of messages) {
        try {
          var meta = JSON.parse(msg.metadata || '{}');
          if (meta.a2a_task_id) {
            db.updateInboundTask(meta.a2a_task_id, {
              status: 'completed',
              result: eventData.summary || 'Task completed by ' + (eventData.agent || 'unknown')
            });
          }
        } catch (e) { /* non-critical */ }
      }
    } catch (e) {
      console.error('[a2a-gateway] task_completed hook error:', e.message);
    }
  });
}
