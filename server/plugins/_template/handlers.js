// Plugin event handlers — subscribe to platform events
// Remove this file if your plugin doesn't need event hooks.

import createTemplateDB from './db.js';

export function registerHooks(core) {
  var db = createTemplateDB(core.db);

  // Example: auto-create an item when a task completes
  core.onEvent('task_completed', function (eventData) {
    try {
      var id = db.create(
        'From task: ' + (eventData.summary || 'completed'),
        { trigger: eventData.type, source: eventData.data },
        eventData.agent || '__system__'
      );

      // Notify operators via inbox
      core.inbox.createInboxItemForAllOperators(
        'template_notification',
        'template_item',
        String(id),
        'New item from task completion',
        eventData.summary || 'A task was completed',
        { item_id: id, trigger_event: eventData.type },
        'low'
      );

      console.log('[template] Created item #' + id + ' from ' + eventData.type);
    } catch (e) {
      console.error('[template] Hook error:', e.message);
    }
  });
}
