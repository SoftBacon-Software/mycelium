# Mycelium Plugin Development Guide

Build plugins that extend your Mycelium instance with custom workflows, integrations, and agent tools.

## What Plugins Can Do

- **React to events** — Run code when tasks complete, bugs get fixed, plans advance, or any other platform event fires
- **Add API endpoints** — Mount custom REST routes on your instance
- **Expose Claude tools** — Give agents new MCP tools they can call directly
- **Create inbox items** — Route notifications to operator inboxes for approval
- **Gate actions** — Require human approval before sensitive operations
- **Store data** — Each plugin gets its own SQLite tables with automatic migration support

## Quick Start

Copy the template and rename it:

```bash
cp -r server/plugins/_template server/plugins/my-plugin
```

Edit `plugin.json` with your plugin's metadata, then restart the server. Your plugin is loaded automatically.

## File Structure

Every plugin lives in `server/plugins/<name>/` with this layout:

```
my-plugin/
├── plugin.json       # Required — metadata manifest
├── schema.sql        # Optional — SQLite tables
├── db.js             # Optional — database helper functions
├── routes.js         # Optional — Express HTTP endpoints
├── handlers.js       # Optional — event hook subscriptions
└── mcp-tools.json    # Optional — tools exposed to Claude agents
```

All files are optional except `plugin.json`. Include only what you need.

## plugin.json

The manifest tells Mycelium how to load your plugin:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "My Plugin",
  "description": "What this plugin does in one sentence.",
  "author": "Your Name",
  "enabled": true,
  "routePrefix": "/my-plugin",
  "schema": "schema.sql",
  "gatedActions": ["my_plugin_dangerous_action"],
  "mcpTools": "mcp-tools.json"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique slug. Must match the directory name. |
| `version` | Yes | Semver version string. |
| `displayName` | Yes | Human-readable name for the dashboard. |
| `description` | Yes | One-line description. |
| `author` | No | Who built it. |
| `enabled` | No | `true` by default. Set `false` to disable without removing. |
| `routePrefix` | No | URL prefix for routes (e.g., `/my-plugin` mounts at `/api/mycelium/my-plugin/`). |
| `schema` | No | Path to SQL file. Executed on first load (uses `CREATE TABLE IF NOT EXISTS`). |
| `gatedActions` | No | Array of action type strings that require approval before executing. |
| `mcpTools` | No | Path to MCP tools JSON file. |

## Database (schema.sql + db.js)

### Defining Tables

Create tables in `schema.sql`. Always use `IF NOT EXISTS` — this file runs every time the server starts:

```sql
CREATE TABLE IF NOT EXISTS mycelium_myplugin_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_myplugin_items_status ON mycelium_myplugin_items(status);
```

Convention: prefix your tables with `mycelium_<pluginname>_` to avoid collisions.

### Database Helpers

Export a factory function from `db.js` that receives the raw `better-sqlite3` handle:

```javascript
export default function createMyPluginDB(db) {
  return {
    create(title, data) {
      var r = db.prepare(
        'INSERT INTO mycelium_myplugin_items (title, data) VALUES (?, ?) RETURNING id'
      ).get(title, JSON.stringify(data || {}));
      return r.id;
    },

    get(id) {
      var row = db.prepare('SELECT * FROM mycelium_myplugin_items WHERE id = ?').get(id);
      if (row) {
        try { row.data = JSON.parse(row.data); } catch (e) { row.data = {}; }
      }
      return row;
    },

    list(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      var limit = Math.min(filters.limit || 50, 200);
      params.push(limit);
      return db.prepare(
        'SELECT * FROM mycelium_myplugin_items WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ?'
      ).all(...params);
    },

    update(id, fields) {
      var sets = [];
      var values = [];
      if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.data !== undefined) { sets.push('data = ?'); values.push(JSON.stringify(fields.data)); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE mycelium_myplugin_items SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    delete(id) {
      db.prepare('DELETE FROM mycelium_myplugin_items WHERE id = ?').run(id);
    }
  };
}
```

## Routes (routes.js)

Export a default function that receives `core` and returns an Express Router:

```javascript
import { Router } from 'express';
import createMyPluginDB from './db.js';

export default function (core) {
  var router = Router();
  var db = createMyPluginDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  // List items — any authenticated user
  router.get('/items', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.list({ status: req.query.status, limit: parseInt(req.query.limit) || 50 }));
  });

  // Get single item
  router.get('/items/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var item = db.get(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Item not found');
    res.json(item);
  });

  // Create item
  router.post('/items', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = db.create(req.body.title || '', req.body.data);
    core.emitEvent('myplugin_item_created', who, null, who + ' created item #' + id);
    res.json({ id: id });
  });

  // Delete item — admin only
  router.delete('/items/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.get(id)) return apiError(res, 404, 'Item not found');
    db.delete(id);
    res.json({ ok: true });
  });

  return router;
}
```

### The `core` Object

Your plugin receives `core` with these utilities:

| Property | Type | Description |
|----------|------|-------------|
| `core.db` | Object | Raw `better-sqlite3` database handle. Use for prepared statements. |
| `core.auth.checkAgentOrAdmin(req, res)` | Function | Returns username/agent ID or sends 401. Use for any authenticated endpoint. |
| `core.auth.checkAdmin(req, res)` | Function | Returns username or sends 403. Use for operator-only endpoints. |
| `core.auth.getAdminDisplayName(req)` | Function | Safe display name for the current admin user. |
| `core.emitEvent(type, who, projectId, summary, data)` | Function | Emit a platform event (stored, broadcast via SSE, triggers hooks). |
| `core.onEvent(eventType, handler)` | Function | Subscribe to platform events. See Event Hooks below. |
| `core.apiError(res, code, msg, extra)` | Function | Send a structured JSON error response. |
| `core.parseIntParam(val)` | Function | Safe integer parsing for route params. |
| `core.validateEnum(val, allowed)` | Function | Validate a value against an enum array. |
| `core.checkApprovalGate(req, who, actionType)` | Function | Check if a gated action has been approved. |
| `core.gatedActions` | Array | Registered gated action types. |
| `core.inbox.createInboxItem(operatorId, type, entityType, entityId, title, summary, data, priority)` | Function | Create an inbox notification for a specific operator. |
| `core.inbox.createInboxItemForAllOperators(type, entityType, entityId, title, summary, data, priority)` | Function | Broadcast an inbox notification to all operators. Returns array of inbox item IDs. |

### Auth Patterns

```javascript
// Anyone with a valid API key or JWT
var who = checkAgentOrAdmin(req, res);
if (!who) return;  // Already sent 401

// Operators only (studio JWT or admin key)
var who = checkAdmin(req, res);
if (!who) return;  // Already sent 403
```

## Event Hooks (handlers.js)

Subscribe to platform events to trigger plugin logic automatically:

```javascript
import createMyPluginDB from './db.js';

export function registerHooks(core) {
  var db = createMyPluginDB(core.db);

  // React to specific events
  core.onEvent('task_completed', function (eventData) {
    // eventData: { type, agent, project_id, summary, data, created_at }
    var title = eventData.summary || 'Task completed';
    db.create(title, eventData.data);

    // Notify operators
    core.inbox.createInboxItemForAllOperators(
      'myplugin_notification',
      'myplugin_item', null,
      'New item: ' + title,
      'Created automatically from task completion',
      { trigger: 'task_completed' },
      'normal'  // 'urgent' | 'normal' | 'low'
    );
  });

  // React to ALL events (wildcard)
  core.onEvent('*', function (eventData) {
    // Called for every event — use sparingly
    console.log('[my-plugin] Event: ' + eventData.type);
  });
}
```

### Available Events

Events your plugin can hook into:

| Category | Events |
|----------|--------|
| Tasks | `task_created`, `task_completed`, `task_updated`, `task_unblocked`, `task_approved`, `task_comment` |
| Plans | `plan_created`, `plan_completed`, `plan_deleted`, `plan_step_added`, `plan_step_updated`, `plan_step_completed` |
| Bugs | `bug_created`, `bug_updated`, `bug_deleted` |
| Messages | `message_sent`, `request_created`, `request_acknowledged`, `request_resolved` |
| Agents | `agent_boot`, `agent_heartbeat`, `agent_registered`, `agent_removed` |
| Drones | `drone_job_created`, `drone_job_claimed`, `drone_job_done`, `drone_job_failed`, `drone_job_cancelled` |
| Assets | `asset_registered`, `asset_uploaded`, `asset_delivered`, `asset_deleted` |
| Approvals | `approval_requested`, `approval_approved`, `approval_denied`, `approval_vote` |
| Concepts | `concept_created`, `concept_updated`, `concept_deleted`, `concept_linked` |
| Channels | `channel_created`, `channel_deleted`, `channel_message` |
| Admin | `config_changed`, `admin_frozen`, `admin_unfrozen`, `sleep_mode_on`, `sleep_mode_off` |
| Work | `auto_dispatch`, `work_claimed`, `work_request` |
| Plugins | `plugin_enabled`, `plugin_disabled` |
| Other | `feedback_submitted`, `file_uploaded`, `artifact_uploaded` |

Use `'*'` to receive all events.

### Event Data Shape

Every event handler receives:

```javascript
{
  type: 'task_completed',         // Event type string
  agent: 'dev-claude',            // Who triggered it
  project_id: 'my-project',      // Project context (may be null)
  summary: 'dev-claude completed task #42: Setup README',
  data: { task_id: 42 },         // Event-specific payload
  created_at: '2026-03-03T...'   // ISO timestamp
}
```

## MCP Tools (mcp-tools.json)

Expose tools that Claude agents can call directly:

```json
[
  {
    "name": "mycelium_myplugin_list",
    "description": "List items from My Plugin. Returns active items by default.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": ["active", "archived"],
          "description": "Filter by status"
        },
        "limit": {
          "type": "integer",
          "default": 20,
          "description": "Max items to return"
        }
      }
    }
  },
  {
    "name": "mycelium_myplugin_create",
    "description": "Create a new item in My Plugin.",
    "inputSchema": {
      "type": "object",
      "required": ["title"],
      "properties": {
        "title": {
          "type": "string",
          "description": "Item title"
        },
        "data": {
          "type": "object",
          "description": "Arbitrary data payload"
        }
      }
    }
  }
]
```

### Tool Naming

Prefix tool names with `mycelium_<pluginname>_`. This is how agents discover and call your tools.

### How Tools Get Registered

1. Server loads `mcp-tools.json` on startup
2. MCP server fetches tools via `GET /plugins/mcp-tools`
3. Each tool gets a handler that maps the input to your plugin's REST endpoint
4. Agents can call the tool directly — it appears alongside built-in Mycelium tools

## Gated Actions

For operations that should require human approval (publishing content, sending emails, deleting data):

1. Declare gated actions in `plugin.json`:

```json
{
  "gatedActions": ["myplugin_publish"]
}
```

2. Check the gate in your route handler:

```javascript
router.post('/items/:id/publish', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;

  var gate = core.checkApprovalGate(req, who, 'myplugin_publish');
  if (gate && !gate.ok) {
    return apiError(res, 403, 'Publishing requires approval', {
      approval_required: true
    });
  }

  // Gate passed — proceed with the action
  // ...
});
```

3. Agents requesting this action will need to create an approval first:

```
POST /api/mycelium/approvals
{
  "title": "Publish item #5",
  "action_type": "myplugin_publish",
  "risk_tier": "medium",
  "required_approvals": 1
}
```

An operator approves it via the dashboard or inbox, then the agent retries the action.

## Operator Inbox Integration

Route notifications to operator inboxes:

```javascript
// Single operator
core.inbox.createInboxItem(
  'operator-id',       // Target operator
  'myplugin_alert',    // Item type (appears as badge)
  'myplugin_item',     // Entity type
  '42',                // Entity ID
  'Alert: something happened',  // Title
  'Details about what happened', // Summary
  { key: 'value' },   // Arbitrary data
  'urgent'             // Priority: 'urgent' | 'normal' | 'low'
);

// All operators
var inboxIds = core.inbox.createInboxItemForAllOperators(
  'myplugin_alert', 'myplugin_item', '42',
  'Alert: something happened',
  'Details about what happened',
  { key: 'value' },
  'normal'
);
// Returns array of created inbox item IDs
```

## Loading and Lifecycle

1. Server starts and calls `loadPlugins()`
2. Each directory in `server/plugins/` with a `plugin.json` is scanned
3. If `enabled` is true (and the DB record hasn't been toggled off):
   - `schema.sql` is executed
   - `handlers.js` hooks are registered
   - `routes.js` router is mounted at `routePrefix`
   - `mcp-tools.json` tools are collected for MCP registration
4. Enable/disable via the dashboard Plugins page (requires server restart to take effect)

## Example: Full Plugin

See the `build-in-public` plugin in `server/plugins/build-in-public/` for a complete example that uses all features: database, routes, event hooks, MCP tools, gated actions, and inbox integration.

## Tips

- **Keep it simple**: Start with just `plugin.json` + `routes.js`. Add complexity as needed.
- **Use `core.emitEvent()`**: Your plugin's actions become visible on the dashboard timeline and can trigger other plugins.
- **Test with curl**: Routes mount at `/api/mycelium/<routePrefix>/`. Test with admin key: `-H "X-Admin-Key: YOUR_KEY"`.
- **Check the dashboard**: The Plugins page shows your plugin's status, version, and tool count after loading.
- **JSON columns**: Store complex data as JSON text columns. Parse on read in your `db.js` helpers.
