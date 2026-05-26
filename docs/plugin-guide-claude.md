# Mycelium Plugin Reference — For Claude Agents

Compact reference for building Mycelium plugins. Use this when an operator asks you to build a plugin for their instance.

## File Structure

Create a directory in `server/plugins/<name>/` with these files:

```
server/plugins/<name>/
├── plugin.json       # REQUIRED — metadata
├── schema.sql        # DB tables (CREATE TABLE IF NOT EXISTS)
├── db.js             # DB helper factory: export default function(db) { return {...} }
├── routes.js         # Express router: export default function(core) { return Router() }
├── handlers.js       # Event hooks: export function registerHooks(core) { ... }
└── mcp-tools.json    # MCP tool definitions array
```

## plugin.json

```json
{
  "name": "PLUGIN_SLUG",
  "version": "1.0.0",
  "displayName": "Human Name",
  "description": "One-line description.",
  "author": "Author",
  "enabled": true,
  "routePrefix": "/PLUGIN_SLUG",
  "schema": "schema.sql",
  "gatedActions": [],
  "mcpTools": "mcp-tools.json"
}
```

`name` must match directory name. `routePrefix` mounts routes at `/api/mycelium/<prefix>/`.

## schema.sql

```sql
CREATE TABLE IF NOT EXISTS mycelium_PLUGINNAME_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  data        TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_PLUGINNAME_items_status ON mycelium_PLUGINNAME_items(status);
```

Prefix tables with `mycelium_PLUGINNAME_`. Always use `IF NOT EXISTS`. Runs on every server start.

## db.js

Factory pattern — receives raw better-sqlite3 handle, returns helper object:

```javascript
export default function createPluginDB(db) {
  return {
    create(title, data, createdBy) {
      return db.prepare(
        'INSERT INTO mycelium_PLUGINNAME_items (title, data, created_by) VALUES (?, ?, ?) RETURNING id'
      ).get(title, JSON.stringify(data || {}), createdBy || '').id;
    },
    get(id) {
      var row = db.prepare('SELECT * FROM mycelium_PLUGINNAME_items WHERE id = ?').get(id);
      if (row) try { row.data = JSON.parse(row.data); } catch(e) { row.data = {}; }
      return row;
    },
    list(filters) {
      var where = ['1=1'], params = [];
      if (filters.status) { where.push('status = ?'); params.push(filters.status); }
      params.push(Math.min(filters.limit || 50, 200));
      return db.prepare(
        'SELECT * FROM mycelium_PLUGINNAME_items WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
      ).all(...params).map(function(row) {
        try { row.data = JSON.parse(row.data); } catch(e) { row.data = {}; }
        return row;
      });
    },
    update(id, fields) {
      var sets = [], values = [];
      if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.data !== undefined) { sets.push('data = ?'); values.push(JSON.stringify(fields.data)); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE mycelium_PLUGINNAME_items SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },
    delete(id) {
      db.prepare('DELETE FROM mycelium_PLUGINNAME_items WHERE id = ?').run(id);
    }
  };
}
```

## routes.js

Export default function receiving `core`, return Express Router:

```javascript
import { Router } from 'express';
import createPluginDB from './db.js';

export default function(core) {
  var router = Router();
  var db = createPluginDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  router.get('/items', function(req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.list({ status: req.query.status, limit: parseInt(req.query.limit) || 50 }));
  });

  router.get('/items/:id', function(req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var item = db.get(parseIntParam(req.params.id));
    if (!item) return apiError(res, 404, 'Not found');
    res.json(item);
  });

  router.post('/items', function(req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = db.create(req.body.title || '', req.body.data, who);
    core.emitEvent('PLUGINNAME_item_created', who, null, who + ' created item #' + id, { item_id: id });
    res.json({ id: id });
  });

  router.put('/items/:id', function(req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.get(id)) return apiError(res, 404, 'Not found');
    db.update(id, req.body);
    res.json({ ok: true, item: db.get(id) });
  });

  router.delete('/items/:id', function(req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.get(id)) return apiError(res, 404, 'Not found');
    db.delete(id);
    res.json({ ok: true });
  });

  return router;
}
```

## handlers.js

Subscribe to platform events:

```javascript
import createPluginDB from './db.js';

export function registerHooks(core) {
  var db = createPluginDB(core.db);

  // Hook specific events
  core.onEvent('task_completed', function(eventData) {
    // eventData shape: { type, agent, project_id, summary, data, created_at }
    db.create(eventData.summary, eventData.data, eventData.agent);
    core.inbox.createInboxItemForAllOperators(
      'PLUGINNAME_notification', 'PLUGINNAME_item', null,
      'New: ' + eventData.summary, 'Auto-created from task completion',
      { trigger: eventData.type }, 'normal'
    );
  });

  // Hook ALL events (wildcard)
  core.onEvent('*', function(eventData) {
    // Use sparingly — fires for every event
  });
}
```

## mcp-tools.json

Array of tool definitions. Prefix names with `mycelium_PLUGINNAME_`:

```json
[
  {
    "name": "mycelium_PLUGINNAME_list",
    "description": "List items from PLUGIN. Returns active items by default.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": { "type": "string", "enum": ["active", "archived"], "description": "Filter by status" },
        "limit": { "type": "integer", "default": 20, "description": "Max items to return" }
      }
    }
  },
  {
    "name": "mycelium_PLUGINNAME_create",
    "description": "Create a new PLUGIN item.",
    "inputSchema": {
      "type": "object",
      "required": ["title"],
      "properties": {
        "title": { "type": "string", "description": "Item title" },
        "data": { "type": "object", "description": "Arbitrary data payload" }
      }
    }
  }
]
```

## core API Reference

```
core.db                                              # better-sqlite3 handle
core.auth.checkAgentOrAdmin(req, res)                # Returns who (string) or null (sends 401)
core.auth.checkAdmin(req, res)                       # Returns who (string) or null (sends 403)
core.auth.getAdminDisplayName(req)                   # Display name for current admin
core.emitEvent(type, who, projectId, summary, data)  # Emit platform event
core.onEvent(eventType, handler)                     # Subscribe to events ('*' = all)
core.apiError(res, code, msg, extra?)                # Send JSON error
core.parseIntParam(val)                              # Safe parseInt for route params
core.validateEnum(val, allowed)                      # Validate against enum
core.checkApprovalGate(req, who, actionType)         # Check gated action approval
core.gatedActions                                    # Array of registered action types
core.inbox.createInboxItem(opId, type, entityType, entityId, title, summary, data, priority)
core.inbox.createInboxItemForAllOperators(type, entityType, entityId, title, summary, data, priority)
```

## Event Types Available for Hooks

```
Tasks:      task_created task_completed task_updated task_unblocked task_approved task_comment
Plans:      plan_created plan_completed plan_deleted plan_step_added plan_step_updated plan_step_completed
Bugs:       bug_created bug_updated bug_deleted
Messages:   message_sent request_created request_acknowledged request_resolved
Agents:     agent_boot agent_heartbeat agent_registered agent_removed
Drones:     drone_job_created drone_job_claimed drone_job_done drone_job_failed drone_job_cancelled
Assets:     asset_registered asset_uploaded asset_delivered asset_deleted
Approvals:  approval_requested approval_approved approval_denied approval_vote
Concepts:   concept_created concept_updated concept_deleted concept_linked
Channels:   channel_created channel_deleted channel_message
Admin:      config_changed admin_frozen admin_unfrozen sleep_mode_on sleep_mode_off
Work:       auto_dispatch work_claimed work_request
Other:      feedback_submitted file_uploaded plugin_enabled plugin_disabled
Wildcard:   * (receives all events)
```

## Gated Actions

Declare in plugin.json: `"gatedActions": ["PLUGINNAME_dangerous_action"]`

Check in route:
```javascript
var gate = core.checkApprovalGate(req, who, 'PLUGINNAME_dangerous_action');
if (gate && !gate.ok) return apiError(res, 403, 'Requires approval', { approval_required: true });
```

## Inbox Notification Priority

- `'urgent'` — Red highlight, top of inbox
- `'normal'` — Standard priority
- `'low'` — FYI, bottom of inbox

## Patterns

**Parse JSON columns on read:**
```javascript
try { row.data = JSON.parse(row.data); } catch(e) { row.data = {}; }
```

**Filtered list with pagination:**
```javascript
var where = ['1=1'], params = [];
if (filters.x) { where.push('x = ?'); params.push(filters.x); }
params.push(Math.min(filters.limit || 50, 200), filters.offset || 0);
db.prepare('SELECT * FROM t WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
```

**Emit events from your plugin** (makes actions visible on dashboard + triggers other plugins):
```javascript
core.emitEvent('PLUGINNAME_action', who, projectId, who + ' did something', { item_id: id });
```

## Checklist for a Complete Plugin

1. [ ] `plugin.json` with unique name matching directory
2. [ ] `schema.sql` with `IF NOT EXISTS` tables prefixed `mycelium_PLUGINNAME_`
3. [ ] `db.js` exporting factory function with CRUD helpers
4. [ ] `routes.js` with auth checks on every endpoint
5. [ ] `handlers.js` if reacting to events (optional)
6. [ ] `mcp-tools.json` with `mycelium_PLUGINNAME_` prefixed tools (optional)
7. [ ] `gatedActions` declared for any dangerous operations (optional)
8. [ ] Events emitted for significant actions via `core.emitEvent()`
9. [ ] Server restarted to load the plugin
10. [ ] Plugin visible and enabled on dashboard Plugins page

## Example

See `server/plugins/build-in-public/` for a complete plugin using all features.
