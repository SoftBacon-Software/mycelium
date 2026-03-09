// Semantic Memory event handlers — auto-index platform content

import createMemoryDB from './db.js';

export function registerHooks(core) {
  var db = createMemoryDB(core.db);

  function isAutoIndexEnabled() {
    return db.getConfig('auto_index') === 'true';
  }

  // Auto-index context key updates
  core.onEvent('context_key_updated', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var namespace = data.namespace || '';
      var key = data.key || '';
      var value = data.value || data.data || '';
      if (typeof value === 'object') value = JSON.stringify(value);
      if (!value || value.length < 10) return; // skip tiny values

      db.index('context_key', namespace + ':' + key, value, {
        namespace: namespace,
        metadata: { namespace: namespace, key: key, agent_id: eventData.agent }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index context_key failed:', e.message);
    }
  });

  // Auto-index messages (non-trivial ones only)
  core.onEvent('message_created', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var content = data.content || eventData.summary || '';
      if (content.length < 20) return; // skip short messages
      if (content.startsWith('AUTO-DISPATCH:')) return; // skip system dispatch messages

      var messageId = data.message_id || data.id || '';
      db.index('message', String(messageId), content, {
        metadata: {
          from_agent: data.from_agent || eventData.agent,
          to_agent: data.to_agent,
          project_id: data.project_id || eventData.project_id,
          msg_type: data.msg_type
        }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index message failed:', e.message);
    }
  });

  // Auto-index concept updates
  core.onEvent('concept_updated', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var conceptId = data.concept_id || data.id || '';
      var text = (data.name || '') + ': ' + (data.description || '');
      if (data.data) {
        var conceptData = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
        text += '\n' + conceptData;
      }
      if (text.length < 10) return;

      db.index('concept', String(conceptId), text, {
        metadata: { concept_id: conceptId, name: data.name, type: data.type }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index concept failed:', e.message);
    }
  });

  // Auto-index task creation/updates
  core.onEvent('task_created', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var taskId = data.task_id || data.id || '';
      var text = (data.title || eventData.summary || '') + '\n' + (data.description || '');
      if (text.length < 10) return;

      db.index('task', String(taskId), text, {
        metadata: { task_id: taskId, project_id: data.project_id || eventData.project_id }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index task failed:', e.message);
    }
  });

  core.onEvent('task_completed', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var taskId = data.task_id || data.id || '';
      var text = 'COMPLETED: ' + (eventData.summary || '');
      if (text.length < 10) return;

      db.index('task', String(taskId), text, {
        metadata: { task_id: taskId, project_id: eventData.project_id, status: 'done', agent_id: eventData.agent }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index task_completed failed:', e.message);
    }
  });
}
