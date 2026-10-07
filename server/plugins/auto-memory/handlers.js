// Auto-Memory event handlers — Observer pattern for automated knowledge extraction

import createAutoMemoryDB from './db.js';
import { extractFacts } from './routes.js';
import { applyDecay } from './decay.js';

var _consolidationTimer = null;

// Task 186 §4 (AUDIT-lab-clockwork-2026-09-12): the decay/prune half of the
// consolidation tick ran UNGATED — every interval it walked and mutated the
// facts table while the LIVE config has consolidation_enabled=false and
// llm_provider=none (extraction off too). `decay_enabled` now gates it,
// DEFAULTING TO the consolidation flag: consolidation on ⇒ decay on
// (back-compat for installs that never touched either key), the live shape
// (consolidation off) stops paying for a pass it never asked for, and an
// explicit decay_enabled=true/false overrides either way.
export function isDecayEnabled(config) {
  config = config || {};
  var explicit = config.decay_enabled;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return explicit !== 'false';
  }
  return config.consolidation_enabled !== 'false';
}

// One tick of the reflector, split out of the timer so it is unit-testable.
export function consolidationTick(db, config, core) {
  config = config || {};

  // Decay/prune pass — gated, see isDecayEnabled above (task 186 §4).
  if (isDecayEnabled(config)) {
    try {
      var decayed = applyDecay(db);
      var pruned = db.pruneLowConfidence(0.15);
      if (decayed > 0 || pruned > 0) {
        console.log('[auto-memory] Decay pass: ' + decayed + ' facts decayed, ' + pruned + ' pruned below threshold');
      }
    } catch (e) {
      console.error('[auto-memory] Decay pass failed:', e.message);
    }
  }

  if (config.consolidation_enabled === 'false') return;
  if (config.llm_provider === 'none' || !config.llm_provider) return;

  // Import runConsolidation dynamically to avoid circular deps
  import('./routes.js').then(function (mod) {
    mod.runConsolidation(db, config, core).then(function (result) {
      console.log('[auto-memory] Consolidation complete:', JSON.stringify(result));
    }).catch(function (e) {
      console.error('[auto-memory] Consolidation failed:', e.message);
    });
  });
}

export function registerHooks(core) {
  var db = createAutoMemoryDB(core.db);

  function isExtractionEnabled() {
    var val = db.getConfig('extraction_enabled');
    return val !== 'false'; // enabled by default
  }

  function getConfig() {
    return db.getAllConfig();
  }

  // Observer: extract facts from task completions
  core.onEvent('task_completed', function (eventData) {
    if (!isExtractionEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var text = 'Task completed: ' + (eventData.summary || '') + '\n' + (data.title || '') + '\n' + (data.description || '');
      if (text.length < 30) return;

      var config = getConfig();
      if (config.llm_provider === 'none' || !config.llm_provider) return;

      // Fire-and-forget async extraction. TRUST LAYER P1.4: the task id rides
      // along on the facts' (source_type, source_id) columns, so deleting the
      // task later cascades to the facts extracted from it.
      var sourceRef = (data.task_id != null) ? 'task:' + data.task_id : null;
      extractFacts(db, config, text, eventData.agent, data.project_id || eventData.project_id, sourceRef).catch(function (e) {
        console.error('[auto-memory] Observer extraction failed:', e.message);
        try { db.logExtractionError(eventData.agent, data.project_id || eventData.project_id, 'task_completed', e.message, text.substring(0, 500)); } catch (_) {}
      });
    } catch (e) {
      console.error('[auto-memory] task_completed hook error:', e.message);
    }
  });

  // Observer: extract facts from resolved requests (these contain decisions/answers)
  core.onEvent('request_resolved', function (eventData) {
    if (!isExtractionEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var text = 'Request resolved: ' + (eventData.summary || '') + '\nResponse: ' + (data.response || '');
      if (text.length < 30) return;

      var config = getConfig();
      if (config.llm_provider === 'none' || !config.llm_provider) return;

      extractFacts(db, config, text, eventData.agent, eventData.project_id).catch(function (e) {
        console.error('[auto-memory] Observer extraction failed:', e.message);
        try { db.logExtractionError(eventData.agent, eventData.project_id, 'request_resolved', e.message, text.substring(0, 500)); } catch (_) {}
      });
    } catch (e) {
      console.error('[auto-memory] request_resolved hook error:', e.message);
    }
  });

  // Observer: extract from context key updates (major knowledge writes)
  core.onEvent('context_key_updated', function (eventData) {
    if (!isExtractionEnabled()) return;
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var value = data.value || data.data || '';
      if (typeof value === 'object') value = JSON.stringify(value);
      if (value.length < 50) return; // skip trivial updates

      var text = 'Context key updated: ' + (data.namespace || '') + '/' + (data.key || '') + '\nValue: ' + value.substring(0, 2000);

      var config = getConfig();
      if (config.llm_provider === 'none' || !config.llm_provider) return;

      extractFacts(db, config, text, eventData.agent, eventData.project_id).catch(function (e) {
        console.error('[auto-memory] Observer extraction failed:', e.message);
        try { db.logExtractionError(eventData.agent, eventData.project_id, 'context_key_updated', e.message, text.substring(0, 500)); } catch (_) {}
      });
    } catch (e) {
      console.error('[auto-memory] context_key_updated hook error:', e.message);
    }
  });

  // ---- TRUST LAYER P1.4: SOURCE CASCADE (the fact-store half) ----------------
  // Deleting a source entity deletes the memory rows that came from it. The
  // semantic-memory plugin's own listeners forget the auto-indexed rows; this
  // half forgets the FACTS extracted from the entity (the extraction writer
  // puts the source entity on the facts' source_type/source_id columns, which
  // the cascade's root matcher reads) — and the forget cascade walks P1.1's
  // derived_from transitively, so summaries built on those facts fall too. Parallel listener, raw SQL via
  // the shared db — no cross-plugin import (the DAG rule); the deleted_by is
  // the AUTHENTICATED actor the core route put on the event.
  function forgetByRef(ref, by) {
    try {
      var res = db.forgetFacts([ref], { by: by || null, reason: 'source-deleted' });
      if (res.deleted > 0) console.log('[auto-memory] source cascade ' + ref + ': ' + res.deleted + ' fact(s) forgotten (' + res.cascaded + ' derived)');
    } catch (e) {
      console.error('[auto-memory] source cascade ' + ref + ' failed:', e.message);
      // Review A M2 (267c): the deletion-cascade failure is not swallowed here —
      // emitEventCascade collects it and the delete route fails LOUD (500, whole
      // transaction rolled back), the same law the direct forget routes follow.
      throw e;
    }
  }

  core.onEvent('task_deleted', function (eventData) {
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      if (data.task_id == null) return;
      forgetByRef('task:' + data.task_id, data.deleted_by);
    } catch (e) { console.error('[auto-memory] task_deleted hook error:', e.message); throw e; } // review A M2 (267c): the delete route fails loud
  });

  core.onEvent('concept_deleted', function (eventData) {
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      if (data.concept_id == null) return;
      forgetByRef('concept:' + data.concept_id, data.deleted_by);
    } catch (e) { console.error('[auto-memory] concept_deleted hook error:', e.message); throw e; } // review A M2 (267c): the delete route fails loud
  });

  core.onEvent('plan_deleted', function (eventData) {
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      if (data.plan_id == null) return;
      forgetByRef('plan:' + data.plan_id, data.deleted_by);
    } catch (e) { console.error('[auto-memory] plan_deleted hook error:', e.message); throw e; } // review A M2 (267c): the delete route fails loud
  });

  core.onEvent('context_key_deleted', function (eventData) {
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      if (!data.namespace || !data.key) return;
      forgetByRef('context_key:' + data.namespace + ':' + data.key, data.deleted_by);
    } catch (e) { console.error('[auto-memory] context_key_deleted hook error:', e.message); throw e; } // review A M2 (267c): the delete route fails loud
  });

  core.onEvent('context_keys_bulk_delete', function (eventData) {
    try {
      var data = typeof eventData.data === 'string' ? JSON.parse(eventData.data) : (eventData.data || {});
      var keys = Array.isArray(data.keys) ? data.keys : [];
      for (var k of keys) {
        if (k && k.namespace && k.key) forgetByRef('context_key:' + k.namespace + ':' + k.key, data.deleted_by);
      }
    } catch (e) { console.error('[auto-memory] context_keys_bulk_delete hook error:', e.message); throw e; } // review A M2 (267c): the delete route fails loud
  });

  // Reflector: periodic consolidation timer
  function startConsolidationTimer() {
    var intervalHours = parseInt(db.getConfig('consolidation_interval_hours')) || 6;
    var intervalMs = intervalHours * 60 * 60 * 1000;

    if (_consolidationTimer) clearInterval(_consolidationTimer);
    _consolidationTimer = setInterval(function () {
      consolidationTick(db, getConfig(), core);
    }, intervalMs);
    _consolidationTimer.unref();
  }

  // Start consolidation timer
  try { startConsolidationTimer(); } catch (e) { console.error('[auto-memory] Timer start failed:', e.message); }
}
