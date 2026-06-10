// Semantic Memory event handlers — auto-index platform content

import createMemoryDB from './db.js';
import { generateEmbedding } from './embeddings.js';

export function registerHooks(core) {
  var db = createMemoryDB(core.db);

  // Auto-index defaults ON — set auto_index='false' (PUT /memory/config) to disable.
  // (It used to default OFF, which kept platform-native content out of the index.)
  function isAutoIndexEnabled() {
    return db.getConfig('auto_index') !== 'false';
  }

  function getEmbeddingConfig() {
    return db.getAllConfig();
  }

  function parseEventData(eventData) {
    return typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
  }

  // Fire-and-forget embedding after indexing content
  // For drone provider: queues async job (embedding arrives later via callback)
  // For ollama/openai: embeds synchronously and stores immediately
  function autoEmbed(sourceType, sourceId, contentText, chunkIndex) {
    var config = getEmbeddingConfig();
    if (!config.embedding_provider || config.embedding_provider === 'none') return;
    generateEmbedding(config, contentText, {
      db: core.db, sourceType: sourceType, sourceId: sourceId, chunkIndex: chunkIndex || 0
    }).then(function (embedding) {
      if (embedding) {
        db.updateEmbedding(sourceType, sourceId, chunkIndex || 0, embedding, config.embedding_model || config.embedding_provider);
      }
    }).catch(function (e) {
      console.error('[semantic-memory] auto-embed failed for ' + sourceType + ':' + sourceId + ':', e.message);
    });
  }

  // Index + embed in one step, chunk-aware (oversized content splits into
  // chunk rows that each embed inside the model's window). Skips when the
  // indexed content is unchanged AND every chunk is already embedded
  // (heartbeats re-fire with the same savepoint — don't re-embed what
  // hasn't moved); chunking is lossless, so the chunks reassemble the doc
  // for comparison. Note db.index's upsert NULLs the embedding, so indexing
  // without re-embedding would silently lose vectors.
  function indexAndEmbed(sourceType, sourceId, contentText, opts) {
    var existing = db.getDocChunks(sourceType, sourceId);
    if (existing.length > 0) {
      var joined = existing.map(function (c) { return c.content_text; }).join('');
      var allEmbedded = existing.every(function (c) { return c.embedding; });
      if (joined === contentText && allEmbedded) return;
    }
    var chunks = db.indexDoc(sourceType, sourceId, contentText, opts);
    for (var i = 0; i < chunks.length; i++) {
      autoEmbed(sourceType, sourceId, chunks[i], i);
    }
  }

  // Auto-index context key updates
  core.onEvent('context_key_updated', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = parseEventData(eventData);
      var namespace = data.namespace || '';
      var key = data.key || '';
      var value = data.value || data.data || '';
      if (typeof value === 'object') value = JSON.stringify(value);
      if (!value || value.length < 10) return; // skip tiny values

      var sourceId = namespace + ':' + key;
      indexAndEmbed('context_key', sourceId, value, {
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
      var data = parseEventData(eventData);
      var content = data.content || eventData.summary || '';
      if (content.length < 20) return; // skip short messages
      if (content.startsWith('AUTO-DISPATCH:')) return; // skip system dispatch messages

      var messageId = data.message_id || data.id || '';
      indexAndEmbed('message', String(messageId), content, {
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

  // Shared concept indexer. The platform emits concept_created/concept_updated
  // WITHOUT a data payload (summary only), so fall back to parsing the name
  // out of the summary and reading the row from the concepts table.
  function indexConceptFromEvent(eventData) {
    var data = parseEventData(eventData);
    var conceptId = data.concept_id || data.id || null;
    var name = data.name || null;
    var description = data.description || '';
    var type = data.type || null;
    var conceptData = data.data || null;

    if (!conceptId) {
      var rest = (eventData.summary || '').replace(/^(?:Created|Updated) concept: /, '');
      if (rest === eventData.summary) return; // not a concept summary we know
      var lookup = core.db.prepare('SELECT * FROM concepts WHERE name = ? ORDER BY id DESC LIMIT 1');
      // created summaries end with " (type)" — try stripped first, then raw
      var row = lookup.get(rest.replace(/ \(\w+\)$/, '')) || lookup.get(rest);
      if (!row) return;
      conceptId = row.id;
      name = row.name;
      description = row.description || '';
      type = row.type;
      conceptData = row.data;
    }

    var text = (name || '') + ': ' + (description || '');
    if (conceptData) {
      var extra = typeof conceptData === 'string' ? conceptData : JSON.stringify(conceptData);
      if (extra && extra !== '{}') text += '\n' + extra;
    }
    if (text.length < 10) return;

    indexAndEmbed('concept', String(conceptId), text, {
      metadata: { concept_id: conceptId, name: name, type: type }
    });
  }

  // Auto-index concept creation (#191 — the on-ramp gap)
  core.onEvent('concept_created', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      indexConceptFromEvent(eventData);
    } catch (e) {
      console.error('[semantic-memory] auto-index concept_created failed:', e.message);
    }
  });

  // Auto-index concept updates
  core.onEvent('concept_updated', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      indexConceptFromEvent(eventData);
    } catch (e) {
      console.error('[semantic-memory] auto-index concept failed:', e.message);
    }
  });

  // Auto-index task creation/updates
  core.onEvent('task_created', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = parseEventData(eventData);
      var taskId = data.task_id || data.id || '';
      var text = (data.title || eventData.summary || '') + '\n' + (data.description || '');
      if (text.length < 10) return;

      indexAndEmbed('task', String(taskId), text, {
        metadata: { task_id: taskId, project_id: data.project_id || eventData.project_id }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index task failed:', e.message);
    }
  });

  core.onEvent('task_completed', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = parseEventData(eventData);
      var taskId = data.task_id || data.id || '';
      var text = 'COMPLETED: ' + (eventData.summary || '');
      if (text.length < 10) return;

      indexAndEmbed('task', String(taskId), text, {
        metadata: { task_id: taskId, project_id: eventData.project_id, status: 'done', agent_id: eventData.agent }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index task_completed failed:', e.message);
    }
  });

  // Savepoints — written on every heartbeat (agent_heartbeat) and annotated
  // via savepoint_notes. Index the latest savepoint's working_on + notes,
  // one doc per agent; indexAndEmbed's unchanged-skip keeps the per-minute
  // heartbeat from re-embedding identical content.
  function indexLatestSavepoint(agentId) {
    if (!agentId || agentId === '__system__' || agentId === '__admin__') return;
    var sp = core.db.prepare(
      'SELECT id, working_on, notes, heartbeat_at FROM agent_savepoints WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
    ).get(agentId);
    if (!sp) return;
    var text = (sp.working_on || '') + (sp.notes ? '\n' + sp.notes : '');
    if (text.length < 10) return;

    indexAndEmbed('savepoint', agentId, text, {
      metadata: { agent_id: agentId, savepoint_id: sp.id, heartbeat_at: sp.heartbeat_at }
    });
  }

  core.onEvent('agent_heartbeat', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      indexLatestSavepoint(eventData.agent);
    } catch (e) {
      console.error('[semantic-memory] auto-index savepoint failed:', e.message);
    }
  });

  core.onEvent('savepoint_notes', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      // Summary shape: 'Admin left notes for <agentId>: <notes...>'
      var m = /^Admin left notes for (\S+):/.exec(eventData.summary || '');
      if (m) indexLatestSavepoint(m[1]);
    } catch (e) {
      console.error('[semantic-memory] auto-index savepoint_notes failed:', e.message);
    }
  });

  // Workflows (workflows plugin) — payload carries workflow_id; fetch name +
  // invocation briefs from the plugin's tables. Tables only exist when the
  // workflows plugin is enabled — the try/catch covers their absence.
  function indexWorkflowFromEvent(eventData, completed) {
    var data = parseEventData(eventData);
    var workflowId = data.workflow_id;
    if (!workflowId) return;
    var wf = core.db.prepare(
      'SELECT id, name, shape, status, project_id FROM workflows WHERE id = ?'
    ).get(workflowId);
    if (!wf) return;
    var invocations = core.db.prepare(
      'SELECT agent_id, brief FROM workflow_invocations WHERE workflow_id = ? ORDER BY id'
    ).all(workflowId);

    var text = (completed ? 'COMPLETED: ' : '') + wf.name + ' [' + wf.shape + ']';
    for (var inv of invocations) {
      if (inv.brief) text += '\n' + inv.agent_id + ': ' + inv.brief;
    }
    if (text.length < 10) return;

    indexAndEmbed('workflow', String(wf.id), text, {
      metadata: { workflow_id: wf.id, project_id: wf.project_id, shape: wf.shape, status: wf.status }
    });
  }

  core.onEvent('workflow_created', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      indexWorkflowFromEvent(eventData, false);
    } catch (e) {
      console.error('[semantic-memory] auto-index workflow_created failed:', e.message);
    }
  });

  core.onEvent('workflow_completed', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      indexWorkflowFromEvent(eventData, true);
    } catch (e) {
      console.error('[semantic-memory] auto-index workflow_completed failed:', e.message);
    }
  });

  // Plans — plan_created payload carries plan_id; fetch title + description.
  core.onEvent('plan_created', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = parseEventData(eventData);
      var planId = data.plan_id || data.id;
      if (!planId) return;
      var plan = core.db.prepare(
        'SELECT id, title, description, project_id, status FROM plans WHERE id = ?'
      ).get(planId);
      if (!plan) return;
      var text = plan.title + (plan.description ? '\n' + plan.description : '');
      if (text.length < 10) return;

      indexAndEmbed('plan', String(plan.id), text, {
        metadata: { plan_id: plan.id, project_id: plan.project_id }
      });
    } catch (e) {
      console.error('[semantic-memory] auto-index plan_created failed:', e.message);
    }
  });

  // plan_step_completed fires from the auto-complete cascade with { task_id } —
  // the completed steps are the ones linked to that task.
  core.onEvent('plan_step_completed', function (eventData) {
    if (!isAutoIndexEnabled()) return;
    try {
      var data = parseEventData(eventData);
      var taskId = data.task_id;
      if (!taskId) return;
      var steps = core.db.prepare(
        "SELECT id, plan_id, title, description FROM plan_steps WHERE linked_task_id = ? AND status = 'completed'"
      ).all(taskId);
      for (var step of steps) {
        var text = 'COMPLETED: ' + step.title + (step.description ? '\n' + step.description : '');
        if (text.length < 10) continue;
        indexAndEmbed('plan_step', String(step.id), text, {
          metadata: { plan_id: step.plan_id, step_id: step.id, task_id: taskId, agent_id: eventData.agent }
        });
      }
    } catch (e) {
      console.error('[semantic-memory] auto-index plan_step_completed failed:', e.message);
    }
  });
}
