// Auto-Memory event handlers — Observer pattern for automated knowledge extraction

import createAutoMemoryDB from './db.js';
import { extractFacts } from './routes.js';

var _consolidationTimer = null;

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

      // Fire-and-forget async extraction
      extractFacts(db, config, text, eventData.agent, data.project_id || eventData.project_id).catch(function (e) {
        console.error('[auto-memory] Observer extraction failed:', e.message);
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
      });
    } catch (e) {
      console.error('[auto-memory] context_key_updated hook error:', e.message);
    }
  });

  // Reflector: periodic consolidation timer
  function startConsolidationTimer() {
    var intervalHours = parseInt(db.getConfig('consolidation_interval_hours')) || 6;
    var intervalMs = intervalHours * 60 * 60 * 1000;

    if (_consolidationTimer) clearInterval(_consolidationTimer);
    _consolidationTimer = setInterval(function () {
      var config = getConfig();
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
    }, intervalMs);
    _consolidationTimer.unref();
  }

  // Start consolidation timer
  try { startConsolidationTimer(); } catch (e) { console.error('[auto-memory] Timer start failed:', e.message); }
}
