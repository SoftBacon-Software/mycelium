// Semantic Memory event handlers — auto-index platform content

import createMemoryDB from './db.js';
import { generateEmbedding } from './embeddings.js';

export function registerHooks(core) {
  var db = createMemoryDB(core.db);

  function isAutoIndexEnabled() {
    return db.getConfig('auto_index') === 'true';
  }

  function getEmbeddingConfig() {
    return db.getAllConfig();
  }

  // Fire-and-forget embedding after indexing content
  // For drone provider: queues async job (embedding arrives later via callback)
  // For ollama/openai: embeds synchronously and stores immediately
  function autoEmbed(sourceType, sourceId, contentText) {
    var config = getEmbeddingConfig();
    if (!config.embedding_provider || config.embedding_provider === 'none') return;
    generateEmbedding(config, contentText, {
      db: core.db, sourceType: sourceType, sourceId: sourceId, chunkIndex: 0
    }).then(function (embedding) {
      if (embedding) {
        db.updateEmbedding(sourceType, sourceId, 0, embedding, config.embedding_model || config.embedding_provider);
      }
    }).catch(function (e) {
      console.error('[semantic-memory] auto-embed failed for ' + sourceType + ':' + sourceId + ':', e.message);
    });
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

      var sourceId = namespace + ':' + key;
      db.index('context_key', sourceId, value, {
        namespace: namespace,
        metadata: { namespace: namespace, key: key, agent_id: eventData.agent }
      });
      autoEmbed('context_key', sourceId, value);
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
      autoEmbed('message', String(messageId), content);
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
      autoEmbed('concept', String(conceptId), text);
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
      autoEmbed('task', String(taskId), text);
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
      autoEmbed('task', String(taskId), text);
    } catch (e) {
      console.error('[semantic-memory] auto-index task_completed failed:', e.message);
    }
  });
}
