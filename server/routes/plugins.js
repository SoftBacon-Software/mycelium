// Plugin routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly from '../db.js', and the
// plugin-loader functions from '../plugins.js'. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listPluginRecords, getPluginRecord, updatePluginEnabled,
  getPluginConfig, setPluginConfig, deletePluginConfig,
} from '../db.js';
import { getLoadedPlugins, getPluginMcpTools, getWorkerStatus } from '../plugins.js';

// ---- Marketplace ----
//
// SECURITY: the plugin registry is PINNED to a specific commit SHA, never a
// moving branch (main/master/HEAD). A moving ref would let a compromised branch
// on SoftBacon-Software/mycelium-plugins push arbitrary plugin manifests to
// every install. BUMP PROCEDURE:
//   1. Get the target HEAD SHA:
//        git ls-remote https://github.com/SoftBacon-Software/mycelium-plugins.git refs/heads/main
//   2. Review the compare diff before trusting the new commit:
//        https://github.com/SoftBacon-Software/mycelium-plugins/compare/<OLD_SHA>...<NEW_SHA>
//   3. Update REGISTRY_COMMIT below to the new 40-char SHA.
// pinned: mycelium-plugins registry commit (SoftBacon-Software/mycelium-plugins).
// To rotate, follow the steps above (git ls-remote + review the compare diff),
// then update REGISTRY_COMMIT to the new 40-char SHA. The load-time guard + tests
// (test/unit/registry-commit-pin.test.js) validate the pin for any valid SHA.
var REGISTRY_COMMIT = '972a3b351c952d6b39a8e47f62a12cb8aa9c465b';
var REGISTRY_URL = 'https://raw.githubusercontent.com/SoftBacon-Software/mycelium-plugins/' + REGISTRY_COMMIT + '/registry.json';
// Fail fast at module load if REGISTRY_URL is ever moved back to a moving ref.
if (!/[0-9a-f]{40}/.test(REGISTRY_URL)) {
  throw new Error('REGISTRY_URL must be commit-pinned to a 40-char hex SHA; got: ' + REGISTRY_URL);
}
export { REGISTRY_COMMIT, REGISTRY_URL };

var registryCache = { data: null, fetched: 0 };
var REGISTRY_TTL = 3600000; // 1 hour

export function registerPluginRoutes(router, deps) {
  const {
    asyncHandler, checkAdmin, checkAgentOrAdmin, emitEvent, getAdminDisplayName,
  } = deps;

  router.get('/plugins', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json(listPluginRecords());
  }));

  router.get('/plugins/mcp-tools', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(getPluginMcpTools());
  }));

  // GET /plugins/workers — worker plugin process status (admin)
  router.get('/plugins/workers', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json(getWorkerStatus());
  }));

  router.get('/plugins/registry', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var now = Date.now();
    if (registryCache.data && (now - registryCache.fetched) < REGISTRY_TTL) {
      return res.json(registryCache.data);
    }
    fetch(REGISTRY_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('Registry fetch failed: ' + r.status);
        return r.json();
      })
      .then(function (data) {
        registryCache.data = data;
        registryCache.fetched = now;
        res.json(data);
      })
      .catch(function (err) {
        if (registryCache.data) return res.json(registryCache.data);
        res.status(502).json({ error: 'Failed to fetch plugin registry' });
      });
  }));

  router.get('/plugins/all-widgets', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var result = [];
    var plugins = getLoadedPlugins();
    for (var i = 0; i < plugins.length; i++) {
      var p = plugins[i];
      var widgets = p.dashboard_widgets || p.dashboardWidgets || [];
      for (var j = 0; j < widgets.length; j++) {
        result.push({
          plugin: p.name,
          plugin_display_name: p.displayName || p.name,
          route_prefix: p.routePrefix || ('/' + p.name),
          widget: widgets[j]
        });
      }
    }
    res.json(result);
  }));

  // GET /plugins/nav — lightweight page declarations for all loaded plugins
  router.get('/plugins/nav', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var plugins = getLoadedPlugins();
    var nav = [];
    for (var i = 0; i < plugins.length; i++) {
      var p = plugins[i];
      if (!p.pages || p.pages.length === 0) continue;
      nav.push({
        name: p.name,
        display_name: p.displayName || p.name,
        route_prefix: p.routePrefix || ('/' + p.name),
        pages: p.pages
      });
    }
    res.json(nav);
  }));

  router.get('/plugins/:name', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });
    // Enrich with loaded manifest data (configSchema, hooks, gatedActions)
    var loaded = getLoadedPlugins().find(function (p) { return p.name === req.params.name; });
    var mcpTools = getPluginMcpTools().filter(function (t) { return t.plugin === req.params.name; });
    res.json({
      ...record,
      type: loaded ? (loaded.type || 'legacy') : 'legacy',
      config_schema: loaded ? (loaded.configSchema || []) : [],
      mcp_tools: mcpTools.map(function (t) { return { name: t.name, description: t.description || '' }; }),
      hooks: loaded ? (loaded.hooks || []) : [],
      gated_actions: loaded ? (loaded.gatedActions || []) : [],
      pages: loaded ? (loaded.pages || []) : [],
    });
  }));

  router.get('/plugins/:name/config', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });
    var rows = getPluginConfig(req.params.name);
    // Return config as key→value map; mask secrets
    var config = {};
    for (var row of rows) {
      config[row.key] = row.is_secret ? '••••••••' : row.value;
    }
    res.json(config);
  }));

  router.put('/plugins/:name/config', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });
    var body = req.body || {};
    // Get the loaded manifest to know which keys are secrets
    var loaded = getLoadedPlugins().find(function (p) { return p.name === req.params.name; });
    var schema = loaded ? (loaded.configSchema || []) : [];
    for (var [key, value] of Object.entries(body)) {
      // Skip if the value is the masked placeholder (user didn't change a secret)
      if (value === '••••••••') continue;
      var schemaField = schema.find(function (f) { return f.key === key; });
      var isSecret = schemaField ? (schemaField.type === 'secret') : false;
      setPluginConfig(req.params.name, key, value, isSecret);
    }
    emitEvent('plugin_config_updated', getAdminDisplayName(req), null, 'Updated config for plugin: ' + req.params.name);
    res.json({ ok: true });
  }));

  router.put('/plugins/:name/enable', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });
    updatePluginEnabled(req.params.name, 1);
    emitEvent('plugin_enabled', getAdminDisplayName(req), null, 'Enabled plugin: ' + req.params.name);
    res.json({ ok: true, name: req.params.name, enabled: 1 });
  }));

  router.put('/plugins/:name/disable', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });
    updatePluginEnabled(req.params.name, 0);
    emitEvent('plugin_disabled', getAdminDisplayName(req), null, 'Disabled plugin: ' + req.params.name);
    res.json({ ok: true, name: req.params.name, enabled: 0 });
  }));

  router.post('/plugins/install', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var name = req.body.name;
    if (!name) return res.status(400).json({ error: 'Plugin name required' });

    var record = getPluginRecord(name);
    if (!record) return res.status(404).json({ error: 'Plugin not found in server/plugins/' });

    if (record.enabled) return res.json({ ok: true, message: 'Plugin already enabled', name: name });

    // Enable the plugin — server restart will load routes/handlers
    updatePluginEnabled(name, 1);
    emitEvent('plugin_installed', getAdminDisplayName(req), null, 'Installed plugin: ' + name, { plugin: name });
    res.json({ ok: true, name: name, message: 'Plugin enabled. Server restart required to fully load.' });
  }));

  router.delete('/plugins/:name/uninstall', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });

    // Disable first
    updatePluginEnabled(req.params.name, 0);

    // Clean up config
    var configRows = getPluginConfig(req.params.name);
    for (var row of configRows) {
      deletePluginConfig(req.params.name, row.key);
    }

    emitEvent('plugin_uninstalled', getAdminDisplayName(req), null, 'Uninstalled plugin: ' + req.params.name, { plugin: req.params.name });
    res.json({ ok: true, name: req.params.name, message: 'Plugin disabled and config cleared. Server restart required. Plugin files remain in server/plugins/ for reinstall.' });
  }));

  router.get('/plugins/:name/widgets', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var record = getPluginRecord(req.params.name);
    if (!record) return res.status(404).json({ error: 'Plugin not found' });

    var loaded = getLoadedPlugins().find(function (p) { return p.name === req.params.name; });
    if (!loaded) return res.json({ widgets: [] });

    var widgets = loaded.dashboard_widgets || loaded.dashboardWidgets || [];
    res.json({ widgets: widgets, route_prefix: loaded.routePrefix || ('/' + loaded.name) });
  }));
}
