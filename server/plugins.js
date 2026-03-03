// =============== MYCELIUM — Plugin Loader ===============
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ensurePluginRecord, getPluginRecord, listPluginRecords, getPluginMigrationVersion, recordPluginMigration, getDB } from './db.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PLUGINS_DIR = path.join(__dirname, 'plugins');

var loadedPlugins = [];
var allMcpTools = [];

// ---- Plugin event hook registry ----
// Plugins call core.onEvent(eventType, handler) during load.
// emitEvent() in routes/mycelium.js calls callEventHooks() after SSE broadcast.
var pluginEventHandlers = {};

export function registerEventHook(eventType, handler) {
  if (!pluginEventHandlers[eventType]) pluginEventHandlers[eventType] = [];
  pluginEventHandlers[eventType].push(handler);
}

export function callEventHooks(eventType, eventData) {
  var handlers = pluginEventHandlers[eventType] || [];
  // Also call wildcard '*' handlers
  var wildcards = pluginEventHandlers['*'] || [];
  for (var fn of [...handlers, ...wildcards]) {
    try { fn(eventData); } catch (e) {
      console.error('[plugins] event hook error for ' + eventType + ':', e.message);
    }
  }
}

export async function loadPlugins(core, router) {
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.log('[plugins] No plugins directory found');
    return;
  }

  var entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  for (var entry of entries) {
    if (!entry.isDirectory()) continue;
    var pluginDir = path.join(PLUGINS_DIR, entry.name);
    var manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Count MCP tools from mcp-tools.json if present
      var mcpToolsPath = path.join(pluginDir, 'mcp-tools.json');
      var mcpTools = [];
      if (manifest.mcpTools && fs.existsSync(mcpToolsPath)) {
        mcpTools = JSON.parse(fs.readFileSync(mcpToolsPath, 'utf8'));
        manifest.mcpToolCount = mcpTools.length;
      }

      // Ensure DB record (insert or update metadata, preserves enabled flag)
      ensurePluginRecord(manifest);
      var record = getPluginRecord(manifest.name);

      if (!record.enabled) {
        console.log('[plugins] Skipping disabled plugin: ' + manifest.name);
        continue;
      }

      // Run schema.sql if present
      var schemaPath = path.join(pluginDir, 'schema.sql');
      if (manifest.schema && fs.existsSync(schemaPath)) {
        var schemaSql = fs.readFileSync(schemaPath, 'utf8');
        getDB().exec(schemaSql);
      }

      // Run migrations if defined
      if (manifest.migrations) {
        var currentVersion = getPluginMigrationVersion(manifest.name);
        for (var migration of manifest.migrations) {
          if (migration.version > currentVersion) {
            try {
              getDB().exec(migration.sql);
              recordPluginMigration(manifest.name, migration.version, migration.description || '');
              console.log('[plugins] ' + manifest.name + ': applied migration v' + migration.version);
            } catch (e) {
              console.error('[plugins] ' + manifest.name + ': migration v' + migration.version + ' failed:', e.message);
            }
          }
        }
      }

      // Register gated actions
      if (manifest.gatedActions && core.gatedActions) {
        for (var action of manifest.gatedActions) {
          if (!core.gatedActions.includes(action)) {
            core.gatedActions.push(action);
          }
        }
      }

      // Register event hooks from handlers.js if present
      var handlersPath = path.join(pluginDir, 'handlers.js');
      if (fs.existsSync(handlersPath)) {
        var handlerModule = await import(pathToFileURL(handlersPath).href);
        if (handlerModule.registerHooks) {
          handlerModule.registerHooks(core);
          console.log('[plugins] ' + manifest.name + ': event hooks registered');
        }
      }

      // Load routes
      var routesPath = path.join(pluginDir, 'routes.js');
      if (fs.existsSync(routesPath)) {
        var routeModule = await import(pathToFileURL(routesPath).href);
        var pluginRouter = routeModule.default(core);
        var prefix = manifest.routePrefix || ('/' + manifest.name);
        router.use(prefix, pluginRouter);
      }

      // Collect MCP tools with plugin metadata
      for (var tool of mcpTools) {
        allMcpTools.push({ ...tool, plugin: manifest.name });
      }

      loadedPlugins.push(manifest);
      console.log('[plugins] Loaded ' + manifest.name + ' v' + manifest.version + ' (' + mcpTools.length + ' MCP tools)');

    } catch (e) {
      console.error('[plugins] Failed to load ' + entry.name + ':', e.message);
    }
  }

  console.log('[plugins] ' + loadedPlugins.length + ' plugin(s) loaded');
}

export function getLoadedPlugins() { return loadedPlugins; }
export function getEnabledPlugins() { return loadedPlugins; }
export function getPluginMcpTools() { return allMcpTools; }
