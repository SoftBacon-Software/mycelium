// Daily Digest event handlers
// Subscribes to agent events and records metrics for digest generation.

import createDigestDB from './db.js';

export function registerHooks(core) {
  var db = createDigestDB(core.db);

  var METRIC_EVENTS = [
    { event: 'task_completed', metric: 'tasks_completed' },
    { event: 'bug_fixed', metric: 'bugs_fixed' },
    { event: 'plan_step_completed', metric: 'plan_steps_completed' }
  ];

  for (var entry of METRIC_EVENTS) {
    (function (eventType, metricType) {
      core.onEvent(eventType, function (eventData) {
        try {
          var today = new Date().toISOString().substring(0, 10);
          var agentId = eventData.agent || 'unknown';
          db.recordMetric(metricType, agentId, 1, today);
          db.recordMetric(metricType, 'total', 1, today);
        } catch (e) {
          console.error('[daily-digest] Error recording metric for ' + eventType + ':', e.message);
        }
      });
    })(entry.event, entry.metric);
  }
}
