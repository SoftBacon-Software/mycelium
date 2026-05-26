// =============== MYCELIUM — Plugin Loader ===============
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';
import http from 'http';
import { ensurePluginRecord, getPluginRecord, listPluginRecords, getPluginMigrationVersion, recordPluginMigration, getDB } from './db.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PLUGINS_DIR = path.join(__dirname, 'plugins');

var loadedPlugins = [];
var allMcpTools = [];
var workerProcesses = {}; // name -> { process, port, manifest, restarts }

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

// ---- Worker plugin process management ----

var WORKER_BASE_PORT = 9100;
var WORKER_MAX_RESTARTS = 5;
var WORKER_HEALTH_TIMEOUT = 15000; // 15s to become healthy
var WORKER_HEALTH_INTERVAL = 500;

function getWorkerPort(index) {
  return WORKER_BASE_PORT + index;
}

function healthCheck(port) {
  return new Promise(function (resolve) {
    var req = http.get('http://127.0.0.1:' + port + '/health', function (res) {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', function () { resolve(false); });
    req.setTimeout(2000, function () { req.destroy(); resolve(false); });
  });
}

async function waitForHealth(port, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck(port)) return true;
    await new Promise(function (r) { setTimeout(r, WORKER_HEALTH_INTERVAL); });
  }
  return false;
}

function spawnWorker(manifest, pluginDir, port, configEnv) {
  var startCmd = manifest.worker && manifest.worker.start;
  if (!startCmd) {
    console.error('[plugins] Worker ' + manifest.name + ': no worker.start command in manifest');
    return null;
  }

  var parts = startCmd.split(/\s+/);
  var cmd = parts[0];
  var args = parts.slice(1);

  var env = Object.assign({}, process.env, {
    MYCELIUM_PLUGIN_PORT: String(port),
    MYCELIUM_PLUGIN_NAME: manifest.name,
    MYCELIUM_API_URL: 'http://127.0.0.1:' + (process.env.PORT || '3002') + '/api/mycelium',
  }, configEnv || {});

  var child = spawn(cmd, args, {
    cwd: pluginDir,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', function (data) {
    process.stdout.write('[worker:' + manifest.name + '] ' + data);
  });
  child.stderr.on('data', function (data) {
    process.stderr.write('[worker:' + manifest.name + '] ' + data);
  });

  return child;
}

async function startWorker(manifest, pluginDir, port, configEnv) {
  var entry = workerProcesses[manifest.name] || { process: null, port: port, manifest: manifest, restarts: 0 };
  workerProcesses[manifest.name] = entry;
  entry.port = port;

  var child = spawnWorker(manifest, pluginDir, port, configEnv);
  if (!child) return false;

  entry.process = child;

  child.on('exit', function (code, signal) {
    console.log('[plugins] Worker ' + manifest.name + ' exited (code=' + code + ', signal=' + signal + ')');
    entry.process = null;

    // Auto-restart if under limit
    if (entry.restarts < WORKER_MAX_RESTARTS) {
      entry.restarts++;
      console.log('[plugins] Restarting worker ' + manifest.name + ' (attempt ' + entry.restarts + '/' + WORKER_MAX_RESTARTS + ')');
      setTimeout(function () {
        startWorker(manifest, pluginDir, port, configEnv);
      }, 1000 * entry.restarts); // backoff
    } else {
      console.error('[plugins] Worker ' + manifest.name + ' exceeded max restarts (' + WORKER_MAX_RESTARTS + ')');
    }
  });

  var healthy = await waitForHealth(port, WORKER_HEALTH_TIMEOUT);
  if (healthy) {
    console.log('[plugins] Worker ' + manifest.name + ' healthy on port ' + port);
    entry.restarts = 0; // reset on successful start
  } else {
    console.error('[plugins] Worker ' + manifest.name + ' failed health check after ' + WORKER_HEALTH_TIMEOUT + 'ms');
  }
  return healthy;
}

function forwardEventToWorker(name, port, eventType, eventData) {
  var body = JSON.stringify(eventData);
  var req = http.request({
    hostname: '127.0.0.1', port: port, path: '/hooks/' + eventType,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', function () { /* worker may not handle this event — that's fine */ });
  req.end(body);
}

function createWorkerToolProxy(name, port, toolName) {
  return async function (req, res) {
    var body = JSON.stringify(req.body);
    var proxyReq = http.request({
      hostname: '127.0.0.1', port: port, path: '/tools/' + toolName,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, function (proxyRes) {
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', function (err) {
      res.status(502).json({ error: 'Worker ' + name + ' unavailable: ' + err.message });
    });
    proxyReq.end(body);
  };
}

export function stopAllWorkers() {
  for (var name of Object.keys(workerProcesses)) {
    var entry = workerProcesses[name];
    if (entry.process) {
      entry.restarts = WORKER_MAX_RESTARTS; // prevent restart on kill
      entry.process.kill('SIGTERM');
      console.log('[plugins] Stopped worker: ' + name);
    }
  }
}

export function getWorkerStatus() {
  var result = {};
  for (var name of Object.keys(workerProcesses)) {
    var entry = workerProcesses[name];
    result[name] = {
      running: !!entry.process,
      port: entry.port,
      restarts: entry.restarts,
      pid: entry.process ? entry.process.pid : null,
    };
  }
  return result;
}

var workerPortIndex = 0;

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

      // Worker plugins: spawn as external HTTP process
      if (manifest.type === 'worker') {
        var workerPort = (manifest.worker && manifest.worker.port) || getWorkerPort(workerPortIndex++);
        var configEnv = {};
        // Load plugin config from plugin_config if available
        try {
          var configRows = getDB().prepare('SELECT key, value FROM plugin_config WHERE plugin_name = ?').all(manifest.name);
          for (var row of configRows) configEnv['PLUGIN_' + row.key.toUpperCase()] = row.value;
        } catch (e) { /* table may not exist yet */ }

        var healthy = await startWorker(manifest, pluginDir, workerPort, configEnv);

        if (healthy) {
          // Forward platform events to worker
          registerEventHook('*', function (eventData) {
            forwardEventToWorker(manifest.name, workerPort, eventData.type || 'unknown', eventData);
          });

          // Create proxy routes for worker's MCP tools
          var prefix = manifest.routePrefix || ('/' + manifest.name);
          for (var tool of mcpTools) {
            var toolRoute = prefix + '/tools/' + tool.name;
            router.post(toolRoute, createWorkerToolProxy(manifest.name, workerPort, tool.name));
          }

          // Proxy catch-all for any other worker routes
          var { createProxyMiddleware } = await import('http-proxy-middleware').catch(function () { return {}; });
          if (createProxyMiddleware) {
            router.use(prefix, createProxyMiddleware({ target: 'http://127.0.0.1:' + workerPort, changeOrigin: true }));
          }
        }

        // Collect MCP tools and finish — skip inline routes/handlers
        for (var tool of mcpTools) {
          allMcpTools.push({ ...tool, plugin: manifest.name });
        }
        loadedPlugins.push(manifest);
        console.log('[plugins] Loaded worker ' + manifest.name + ' v' + manifest.version + ' on port ' + workerPort + (healthy ? ' (healthy)' : ' (unhealthy)'));
        continue;
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
