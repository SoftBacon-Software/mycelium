# Command Structure v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve Mycelium from a bulletin-board model to a command structure with operators (people), agent roles, Claude Admin routing, risk-tiered approvals, blocking directives, asset delivery, and session continuity.

**Architecture:** Additive changes to existing Express + SQLite codebase. New tables (`dv_operators`, `dv_instance_config`, `dv_approval_votes`) plus migration columns on existing tables. New API endpoints under the existing router. Dashboard gets new panels. MCP tools get new commands. No breaking changes to existing API.

**Tech Stack:** Node.js (ES modules), Express, better-sqlite3 (WAL mode), vanilla JS dashboard, MCP SDK

---

## Phase 1: Data Model

### Task 1: Create `dv_operators` Table

**Files:**
- Modify: `server/schema.sql:324` (append after last line)
- Modify: `server/db.js:43` (add migration columns)
- Modify: `server/db.js:107` (add CRUD functions after updateAgent)

**Step 1: Add table to schema.sql**

Append after line 324 (after the last `dv_approvals` index):

```sql
-- Operators (human team members)
CREATE TABLE IF NOT EXISTS dv_operators (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  responsibilities TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  studio_user_id  INTEGER REFERENCES dv_studio_users(id),
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_operators_role ON dv_operators(role);
CREATE INDEX IF NOT EXISTS idx_dv_operators_status ON dv_operators(status);
```

**Step 2: Add DB functions to db.js**

After `updateAgent` (line 107), add:

```javascript
// -- Operators (people) --

export function createOperator(id, displayName, role, responsibilities, email, studioUserId) {
  stmt('dvCreateOp', `INSERT INTO dv_operators (id, display_name, role, responsibilities, email, studio_user_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, displayName, role || 'member', responsibilities || '', email || '', studioUserId || null);
}

export function getOperator(id) {
  return stmt('dvGetOp', 'SELECT * FROM dv_operators WHERE id = ?').get(id);
}

export function listOperators() {
  return stmt('dvListOps', 'SELECT * FROM dv_operators ORDER BY created_at').all();
}

export function updateOperator(id, fields) {
  var sets = []; var values = [];
  if (fields.display_name !== undefined) { sets.push('display_name = ?'); values.push(fields.display_name); }
  if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.responsibilities !== undefined) { sets.push('responsibilities = ?'); values.push(fields.responsibilities); }
  if (fields.email !== undefined) { sets.push('email = ?'); values.push(fields.email); }
  if (fields.studio_user_id !== undefined) { sets.push('studio_user_id = ?'); values.push(fields.studio_user_id); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare('UPDATE dv_operators SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteOperator(id) {
  stmt('dvDeleteOp', 'DELETE FROM dv_operators WHERE id = ?').run(id);
}
```

**Step 3: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); console.log(db.listOperators()); })"
```

Expected: Empty array `[]` (table created, no rows).

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/schema.sql server/db.js && git commit -m "feat: add dv_operators table for human team members"
```

---

### Task 2: Create `dv_instance_config` Table

**Files:**
- Modify: `server/schema.sql` (append after operators table)
- Modify: `server/db.js` (add functions after operator functions)

**Step 1: Add table to schema.sql**

Append after the operators indexes:

```sql
-- Instance configuration (per-deployment settings)
CREATE TABLE IF NOT EXISTS dv_instance_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT NOT NULL DEFAULT ''
);
```

**Step 2: Add DB functions to db.js**

After operator functions, add:

```javascript
// -- Instance Config --

export function getInstanceConfig(key) {
  var row = stmt('dvGetConfig', 'SELECT * FROM dv_instance_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setInstanceConfig(key, value, updatedBy) {
  db.prepare(
    "INSERT INTO dv_instance_config (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now'), updated_by = ?"
  ).run(key, value, updatedBy || '', value, updatedBy || '');
}

export function listInstanceConfig() {
  return stmt('dvListConfig', 'SELECT * FROM dv_instance_config ORDER BY key').all();
}

export function deleteInstanceConfig(key) {
  stmt('dvDeleteConfig', 'DELETE FROM dv_instance_config WHERE key = ?').run(key);
}
```

**Step 3: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); db.setInstanceConfig('instance_mode', 'developer', 'greatness'); console.log(db.getInstanceConfig('instance_mode')); })"
```

Expected: `developer`

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/schema.sql server/db.js && git commit -m "feat: add dv_instance_config table for per-deployment settings"
```

---

### Task 3: Create `dv_approval_votes` Table

**Files:**
- Modify: `server/schema.sql` (append after instance config table)
- Modify: `server/db.js` (add functions after instance config functions)

**Step 1: Add table to schema.sql**

Append:

```sql
-- Multi-human approval voting
CREATE TABLE IF NOT EXISTS dv_approval_votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES dv_approvals(id),
  voter       TEXT NOT NULL,
  vote        TEXT NOT NULL DEFAULT 'approve',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(approval_id, voter)
);

CREATE INDEX IF NOT EXISTS idx_dv_approval_votes_approval ON dv_approval_votes(approval_id);
CREATE INDEX IF NOT EXISTS idx_dv_approval_votes_voter ON dv_approval_votes(voter);
```

**Step 2: Add DB functions to db.js**

After instance config functions, add:

```javascript
// -- Approval Votes --

export function castApprovalVote(approvalId, voter, vote, notes) {
  db.prepare(
    "INSERT INTO dv_approval_votes (approval_id, voter, vote, notes) VALUES (?, ?, ?, ?) ON CONFLICT(approval_id, voter) DO UPDATE SET vote = ?, notes = ?, created_at = datetime('now')"
  ).run(approvalId, voter, vote, notes || '', vote, notes || '');
}

export function getApprovalVotes(approvalId) {
  return db.prepare('SELECT * FROM dv_approval_votes WHERE approval_id = ? ORDER BY created_at').all(approvalId);
}

export function countApprovalVotes(approvalId) {
  var approves = db.prepare("SELECT COUNT(*) as count FROM dv_approval_votes WHERE approval_id = ? AND vote = 'approve'").get(approvalId);
  var denies = db.prepare("SELECT COUNT(*) as count FROM dv_approval_votes WHERE approval_id = ? AND vote = 'deny'").get(approvalId);
  return { approves: approves.count, denies: denies.count };
}
```

**Step 3: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); console.log('votes table ready'); })"
```

Expected: `votes table ready` (no errors)

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/schema.sql server/db.js && git commit -m "feat: add dv_approval_votes table for multi-human quorum"
```

---

### Task 4: Add `role` + `operator_id` Columns to `dv_agents`

**Files:**
- Modify: `server/db.js:43-44` (add migration columns to `migrations` array)
- Modify: `server/db.js:83-84` (update `listAgents` SELECT)
- Modify: `server/db.js:100-107` (update `updateAgent` to handle new fields)
- Modify: `server/db.js:470-472` (update boot payload `otherAgents` query)

**Step 1: Add migration columns**

In `server/db.js`, change the `migrations` array (currently ends at line 43 with `avatar_url`). Add before the closing `];`:

```javascript
    ["dv_agents", "role", "TEXT NOT NULL DEFAULT 'agent'"],
    ["dv_agents", "operator_id", "TEXT NOT NULL DEFAULT ''"],
    ["dv_agents", "project", "TEXT NOT NULL DEFAULT ''"],
```

**Step 2: Update `listAgents` SELECT**

Change line 84 from:
```javascript
  return stmt('dvListAgents', 'SELECT id, name, game, status, working_on, last_heartbeat, capabilities, avatar_url, created_at FROM dv_agents ORDER BY created_at').all();
```
to:
```javascript
  return stmt('dvListAgents2', 'SELECT id, name, game, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project, created_at FROM dv_agents ORDER BY created_at').all();
```

**Step 3: Update `updateAgent` to handle new fields**

Change lines 100-107 to:
```javascript
export function updateAgent(id, fields) {
  var sets = []; var values = [];
  if (fields.avatar_url !== undefined) { sets.push('avatar_url = ?'); values.push(fields.avatar_url); }
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.operator_id !== undefined) { sets.push('operator_id = ?'); values.push(fields.operator_id); }
  if (fields.project !== undefined) { sets.push('project = ?'); values.push(fields.project); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_agents SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}
```

**Step 4: Update boot payload `otherAgents` query**

Change line 470-472 from:
```javascript
  var otherAgents = db.prepare(
    "SELECT id, name, game, status, working_on, last_heartbeat, capabilities, avatar_url FROM dv_agents WHERE id != ? ORDER BY created_at"
  ).all(agentId);
```
to:
```javascript
  var otherAgents = db.prepare(
    "SELECT id, name, game, status, working_on, last_heartbeat, capabilities, avatar_url, role, operator_id, project FROM dv_agents WHERE id != ? ORDER BY created_at"
  ).all(agentId);
```

**Step 5: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); var agents = db.listAgents(); console.log(agents[0].role, agents[0].operator_id); })"
```

Expected: `agent ` (defaults)

**Step 6: Commit**

```bash
cd D:/mycelium && git add server/db.js && git commit -m "feat: add role + operator_id columns to dv_agents"
```

---

### Task 5: Add Risk Tier + Quorum Fields to `dv_approvals`

**Files:**
- Modify: `server/db.js:43` (add migration columns)
- Modify: `server/db.js:927-932` (update `createApproval` to accept tier fields)
- Modify: `server/db.js:949-953` (update `decideApproval`)

**Step 1: Add migration columns**

Add to the `migrations` array (after the agent columns from Task 4):

```javascript
    ["dv_approvals", "risk_tier", "TEXT NOT NULL DEFAULT 'medium'"],
    ["dv_approvals", "required_approvals", "INTEGER NOT NULL DEFAULT 1"],
    ["dv_approvals", "current_approvals", "INTEGER NOT NULL DEFAULT 0"],
```

**Step 2: Update `createApproval` function**

Change lines 927-932 to:

```javascript
export function createApproval(actionType, requestedBy, title, payload, project, riskTier, requiredApprovals) {
  var result = stmt('dvCreateApproval2',
    "INSERT INTO dv_approvals (action_type, requested_by, title, payload, project, risk_tier, required_approvals) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(actionType, requestedBy, title || '', typeof payload === 'string' ? payload : JSON.stringify(payload || {}), project || 'mycelium', riskTier || 'medium', requiredApprovals || 1);
  return result.id;
}
```

**Step 3: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); console.log('approval columns migrated'); })"
```

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/db.js && git commit -m "feat: add risk_tier + quorum fields to dv_approvals"
```

---

### Task 6: Add Asset Delivery Fields to `dv_assets`

**Files:**
- Modify: `server/db.js:43` (add migration columns)

**Step 1: Add migration columns**

Add to the `migrations` array:

```javascript
    ["dv_assets", "file_path", "TEXT NOT NULL DEFAULT ''"],
    ["dv_assets", "download_url", "TEXT NOT NULL DEFAULT ''"],
    ["dv_assets", "requested_by", "TEXT NOT NULL DEFAULT ''"],
    ["dv_assets", "assigned_to", "TEXT NOT NULL DEFAULT ''"],
```

**Step 2: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); console.log('asset columns migrated'); })"
```

**Step 3: Commit**

```bash
cd D:/mycelium && git add server/db.js && git commit -m "feat: add asset delivery fields to dv_assets"
```

---

### Task 7: Seed Instance Data

**Files:**
- Modify: `server/db.js` (add seeding in `initDB` or create a seed function)

**Step 1: Add seed function**

After the `initDB` function (after migrations loop, around line 49), add a seed helper that runs only once:

```javascript
  // Seed operators + instance config if empty
  var opCount = db.prepare('SELECT COUNT(*) as c FROM dv_operators').get();
  if (opCount.c === 0) {
    db.prepare("INSERT INTO dv_operators (id, display_name, role, responsibilities, email) VALUES (?, ?, ?, ?, ?)").run(
      'greatness', 'Greatness', 'owner', 'Platform dev, WS game, asset generation, coordination', 'grbarajas@gmail.com'
    );
    db.prepare("INSERT INTO dv_operators (id, display_name, role, responsibilities, email) VALUES (?, ?, ?, ?, ?)").run(
      'hijack', 'Hijack', 'ui_lead', 'UI/UX, Project A development, visual design', ''
    );
    db.prepare("INSERT INTO dv_operators (id, display_name, role, responsibilities) VALUES (?, ?, ?, ?)").run(
      'unakron', 'Unakron', 'member', 'Infrastructure, GPU compute'
    );
  }

  // Seed instance config if empty
  var cfgCount = db.prepare('SELECT COUNT(*) as c FROM dv_instance_config').get();
  if (cfgCount.c === 0) {
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('instance_mode', 'developer', 'system');
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_agent_id', 'greatness-claude', 'system');
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_status', 'coordinator', 'system');
    db.prepare("INSERT INTO dv_instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('risk_tiers', JSON.stringify({
      plan_create: 'low',
      context_change: 'low',
      deploy: 'medium',
      git_push: 'medium',
      delete: 'medium',
      outreach_send: 'high',
      external_comm: 'high',
      money_action: 'critical',
      delete_agent: 'critical',
      instance_config: 'critical'
    }), 'system');
  }

  // Update agent roles (idempotent)
  try {
    db.prepare("UPDATE dv_agents SET role = 'admin', operator_id = 'greatness', project = 'example-project' WHERE id = 'greatness-claude'").run();
    db.prepare("UPDATE dv_agents SET role = 'agent', operator_id = 'hijack', project = 'project-a' WHERE id = 'hijack-claude'").run();
    db.prepare("UPDATE dv_agents SET role = 'drone', operator_id = 'greatness', project = 'drone' WHERE id = 'unakron-gpu'").run();
  } catch (e) { /* agents may not exist yet */ }
```

**Step 2: Verify locally**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); console.log('ops:', db.listOperators()); console.log('mode:', db.getInstanceConfig('instance_mode')); console.log('agents:', db.listAgents().map(a => a.id + ':' + a.role)); })"
```

Expected: operators list with greatness+hijack+unakron, mode=developer, agents with correct roles.

**Step 3: Commit**

```bash
cd D:/mycelium && git add server/db.js && git commit -m "feat: seed operators, instance config, and agent roles"
```

---

## Phase 2: API Endpoints

### Task 8: Operators CRUD API

**Files:**
- Modify: `server/routes/mycelium.js:24-56` (add imports)
- Modify: `server/routes/mycelium.js` (add routes after studio user routes, around line 977)

**Step 1: Add imports**

Add to the import block (line 24-56):
```javascript
  createOperator, getOperator, listOperators, updateOperator, deleteOperator,
```

**Step 2: Add routes**

After the studio user routes (around line 977), add:

```javascript
// ======== OPERATORS (people) ========

router.get('/operators', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOperators());
});

router.get('/operators/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var op = getOperator(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operator not found' });
  res.json(op);
});

router.post('/operators', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;
  var { id, display_name, role, responsibilities, email, studio_user_id } = req.body;
  if (!id || !display_name) return res.status(400).json({ error: 'id and display_name required' });
  if (getOperator(id)) return res.status(409).json({ error: 'Operator already exists' });
  createOperator(id, display_name, role, responsibilities, email, studio_user_id);
  emitEvent('operator_created', who, null, 'Operator ' + id + ' created');
  res.json(getOperator(id));
});

router.put('/operators/:id', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;
  var op = getOperator(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operator not found' });
  updateOperator(req.params.id, req.body);
  emitEvent('operator_updated', who, null, 'Operator ' + req.params.id + ' updated');
  res.json(getOperator(req.params.id));
});

router.delete('/operators/:id', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;
  if (!getOperator(req.params.id)) return res.status(404).json({ error: 'Operator not found' });
  deleteOperator(req.params.id);
  emitEvent('operator_deleted', who, null, 'Operator ' + req.params.id + ' deleted');
  res.json({ ok: true });
});
```

**Step 3: Verify via curl**

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" http://localhost:3002/api/mycelium/operators | python -m json.tool
```

Expected: Array with greatness, hijack, unakron operators.

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js && git commit -m "feat: operators CRUD API endpoints"
```

---

### Task 9: Instance Config API

**Files:**
- Modify: `server/routes/mycelium.js` (add imports + routes)

**Step 1: Add imports**

Add to import block:
```javascript
  getInstanceConfig, setInstanceConfig, listInstanceConfig, deleteInstanceConfig,
```

**Step 2: Add routes**

After operators routes, add:

```javascript
// ======== INSTANCE CONFIG ========

router.get('/admin/config', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listInstanceConfig());
});

router.get('/admin/config/:key', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var val = getInstanceConfig(req.params.key);
  if (val === null) return res.status(404).json({ error: 'Config key not found' });
  res.json({ key: req.params.key, value: val });
});

router.put('/admin/config/:key', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;
  var { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  setInstanceConfig(req.params.key, typeof value === 'string' ? value : JSON.stringify(value), who);
  emitEvent('config_changed', who, null, 'Config ' + req.params.key + ' updated');
  res.json({ key: req.params.key, value: getInstanceConfig(req.params.key) });
});
```

**Step 3: Verify via curl**

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" http://localhost:3002/api/mycelium/admin/config | python -m json.tool
```

Expected: Array of config rows (instance_mode, admin_agent_id, etc.)

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js && git commit -m "feat: instance config API endpoints"
```

---

### Task 10: Human Kill Switch API

**Files:**
- Modify: `server/routes/mycelium.js` (add route after config routes)

**Step 1: Add route**

```javascript
// ======== KILL SWITCH ========

router.put('/admin/override', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;
  var action = req.body.action || 'freeze';
  if (action === 'freeze') {
    setInstanceConfig('admin_status', 'frozen', who);
    emitEvent('admin_frozen', who, null, who + ' froze Claude Admin');
    res.json({ ok: true, admin_status: 'frozen', message: 'Claude Admin frozen. All work assignments paused.' });
  } else if (action === 'unfreeze') {
    setInstanceConfig('admin_status', 'coordinator', who);
    emitEvent('admin_unfrozen', who, null, who + ' unfroze Claude Admin');
    res.json({ ok: true, admin_status: 'coordinator', message: 'Claude Admin unfrozen. Resuming operations.' });
  } else {
    res.status(400).json({ error: 'action must be freeze or unfreeze' });
  }
});
```

**Step 2: Verify via curl**

```bash
# Freeze
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  http://localhost:3002/api/mycelium/admin/override -d '{"action":"freeze"}' | python -m json.tool

# Unfreeze
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  http://localhost:3002/api/mycelium/admin/override -d '{"action":"unfreeze"}' | python -m json.tool
```

**Step 3: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js && git commit -m "feat: human kill switch for Claude Admin freeze/unfreeze"
```

---

### Task 11: Approval Voting API

**Files:**
- Modify: `server/routes/mycelium.js` (add imports + route)

**Step 1: Add imports**

Add to import block:
```javascript
  castApprovalVote, getApprovalVotes, countApprovalVotes,
```

**Step 2: Add vote route**

After existing approval routes (after line 1547), add:

```javascript
router.put('/approvals/:id/vote', function (req, res) {
  var who = checkAdmin(req, res);
  if (!who) return;
  var approval = getApproval(parseInt(req.params.id));
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval is already ' + approval.status });

  var vote = req.body.vote || 'approve';
  var notes = req.body.notes || '';
  if (vote !== 'approve' && vote !== 'deny') return res.status(400).json({ error: 'vote must be approve or deny' });

  // Any single deny = instant denial
  if (vote === 'deny') {
    castApprovalVote(approval.id, who, 'deny', notes);
    decideApproval(approval.id, 'denied', who, notes || 'Denied by ' + who);
    emitEvent('approval_denied', who, null, who + ' denied approval #' + approval.id + ': ' + approval.title);
    return res.json({ ok: true, status: 'denied', message: 'Approval denied.' });
  }

  // Cast approve vote
  castApprovalVote(approval.id, who, 'approve', notes);
  var counts = countApprovalVotes(approval.id);

  // Check if quorum reached
  if (counts.approves >= approval.required_approvals) {
    decideApproval(approval.id, 'approved', who, 'Quorum reached (' + counts.approves + '/' + approval.required_approvals + ')');
    emitEvent('approval_approved', who, null, who + ' approved #' + approval.id + ': ' + approval.title + ' (quorum reached)');
    return res.json({ ok: true, status: 'approved', votes: counts, message: 'Quorum reached. Approval granted.' });
  }

  emitEvent('approval_vote', who, null, who + ' voted approve on #' + approval.id + ' (' + counts.approves + '/' + approval.required_approvals + ')');
  res.json({ ok: true, status: 'pending', votes: counts, remaining: approval.required_approvals - counts.approves });
});

router.get('/approvals/:id/votes', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(getApprovalVotes(parseInt(req.params.id)));
});
```

**Step 3: Verify via curl**

```bash
# Create test approval requiring 2 approvals
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  http://localhost:3002/api/mycelium/approvals \
  -d '{"action_type":"deploy","requested_by":"greatness-claude","title":"Test quorum","risk_tier":"high","required_approvals":2}'

# Vote approve (won't resolve yet - needs 2)
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  http://localhost:3002/api/mycelium/approvals/APPROVAL_ID/vote -d '{"vote":"approve","notes":"LGTM"}'
```

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js && git commit -m "feat: approval voting API with quorum support"
```

---

### Task 12: Asset Upload/Download API

**Files:**
- Modify: `server/routes/mycelium.js` (add routes after existing asset routes, around line 596)

**Step 1: Add upload route**

After existing asset PUT route (around line 596), add:

```javascript
router.post('/assets/:id/upload', upload.single('file'), function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseInt(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  var filePath = req.file.path;
  var downloadUrl = '/api/mycelium/assets/' + asset.id + '/download';
  updateDvAsset(asset.id, { status: 'ready', file_path: filePath, download_url: downloadUrl, path: req.file.filename });
  emitEvent('asset_uploaded', who, asset.game, 'Asset #' + asset.id + ' (' + asset.name + ') uploaded');
  res.json({ ok: true, asset_id: asset.id, download_url: downloadUrl });
});

router.get('/assets/:id/download', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var asset = getDvAsset(parseInt(req.params.id));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.file_path && !asset.path) return res.status(404).json({ error: 'No file attached to this asset' });

  var filePath = asset.file_path || nodePath.join(FILES_DIR, asset.path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
  res.download(filePath);
});
```

**Step 2: Update `updateDvAsset` in db.js to handle new fields**

In `server/db.js`, find the `updateDvAsset` function (around line 280) and add handling for the new fields:

```javascript
  if (fields.file_path !== undefined) { sets.push('file_path = ?'); values.push(fields.file_path); }
  if (fields.download_url !== undefined) { sets.push('download_url = ?'); values.push(fields.download_url); }
  if (fields.requested_by !== undefined) { sets.push('requested_by = ?'); values.push(fields.requested_by); }
  if (fields.assigned_to !== undefined) { sets.push('assigned_to = ?'); values.push(fields.assigned_to); }
```

**Step 3: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js server/db.js && git commit -m "feat: asset upload/download API endpoints"
```

---

### Task 13: Directive Message Type

**Files:**
- Modify: `server/routes/mycelium.js` (update message POST route, around line 706)
- Modify: `server/db.js:445-513` (update boot payload to include directives)

**Step 1: Update message POST to support directives**

In the `POST /messages` route (line 706), the existing handler already supports `msg_type` from `req.body`. Add validation that only admin/operators can send directives. After the existing msg_type handling, add:

```javascript
  // Only admin and operators can send directives
  if (msg_type === 'directive') {
    if (who !== '__admin__' && who.indexOf('-claude') !== -1) {
      return res.status(403).json({ error: 'Only admin or operators can send directives' });
    }
  }
```

**Step 2: Update boot payload to include pending directives**

In `server/db.js`, in `getBootPayload` (line 445), add after the `newMessages` query (line 459):

```javascript
  var pendingDirectives = db.prepare(
    "SELECT * FROM dv_messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
  ).all(agentId);
```

And add to the return object (line 497):
```javascript
    pending_directives: pendingDirectives,
```

**Step 3: Update boot payload to filter directives from new_messages**

Change the `newMessages` query to exclude directives (they're in their own field now):

```javascript
  var newMessages = db.prepare(
    "SELECT * FROM dv_messages WHERE (to_agent = ? OR to_agent IS NULL) AND msg_type IN ('message', 'info') AND created_at > ? ORDER BY created_at DESC LIMIT 50"
  ).all(agentId, since);
```

**Step 4: Commit**

```bash
cd D:/mycelium && git add server/db.js server/routes/mycelium.js && git commit -m "feat: directive message type with blocking semantics"
```

---

### Task 14: Work Routing Endpoint

**Files:**
- Modify: `server/routes/mycelium.js` (add route)
- Modify: `server/db.js` (add import for `getInstanceConfig`)

**Step 1: Add work request route**

```javascript
// ======== WORK ROUTING ========

router.post('/work/request', function (req, res) {
  var who = checkAgent(req, res);
  if (!who) return;

  // Check if Claude Admin is frozen
  var adminStatus = getInstanceConfig('admin_status');
  if (adminStatus === 'frozen') {
    return res.status(503).json({ error: 'Claude Admin is frozen. Work routing paused. Contact a human operator.' });
  }

  var { type, target, description, priority } = req.body;
  if (!type) return res.status(400).json({ error: 'type required (task_request, asset_request, work_request)' });

  // Create as a work_request message to Claude Admin
  var adminAgentId = getInstanceConfig('admin_agent_id') || 'greatness-claude';
  var msgId = createDvRequest(who, adminAgentId, null,
    JSON.stringify({ type: type, target: target || null, description: description || '', priority: priority || 'normal' }),
    JSON.stringify({ work_request: true, type: type })
  );

  emitEvent('work_request', who, null, who + ' requested work: ' + type + (target ? ' → ' + target : ''));
  res.json({ ok: true, message_id: msgId, routed_to: adminAgentId });
});
```

**Step 2: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js && git commit -m "feat: work routing endpoint for agent-to-admin requests"
```

---

### Task 15: Update Agent Profile Endpoint

**Files:**
- Modify: `server/routes/mycelium.js:264-279` (expand existing PUT /agents/:id)

**Step 1: Update existing route to handle role and operator_id**

The existing route (line 264) already handles `avatar_url` and `name`. Expand it to also handle `role`, `operator_id`, `project`:

After line 274 (`if (req.body.avatar_url !== undefined) fields.avatar_url = req.body.avatar_url;`), add:

```javascript
  // Admin-only fields
  if (who === '__admin__') {
    if (req.body.role !== undefined) fields.role = req.body.role;
    if (req.body.operator_id !== undefined) fields.operator_id = req.body.operator_id;
    if (req.body.project !== undefined) fields.project = req.body.project;
  }
```

**Step 2: Commit**

```bash
cd D:/mycelium && git add server/routes/mycelium.js && git commit -m "feat: expand agent profile to support role + operator_id (admin-only)"
```

---

## Phase 3: Dashboard

> **Note:** Dashboard tasks (16-21) are assigned to hijack-claude. Provide design specs here; hijack implements.

### Task 16: Dashboard — Operators Panel

**Files:**
- Modify: `public/studio/index.html` (add operators section in left column)
- Modify: `public/studio/studio.js` (add renderOperators function)
- Modify: `public/studio/studio.css` (add operator styles)

**Step 1: Add HTML section**

In `index.html`, after the agents panel (line 65), add:

```html
        <section class="panel operators-panel">
          <h2>Team</h2>
          <div id="operators-list"></div>
        </section>
```

**Step 2: Add JS render function**

In `studio.js`, add a `renderOperators` function that fetches `/operators` and renders cards showing display_name, role, linked agents, and status. Each card should show the operator's role as a badge and list their linked agents below.

**Step 3: Add CSS styles**

Add `.operator-card`, `.operator-role-badge` styles using the existing card pattern.

**Step 4: Wire into poll loop**

Add `renderOperators(data.operators)` call in the main data refresh function. Add operators to the overview endpoint response.

**Step 5: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: operators panel in dashboard"
```

---

### Task 17: Dashboard — Approval Voting UI

**Files:**
- Modify: `public/studio/studio.js` (update `showApprovalDetail` to show votes + vote buttons)
- Modify: `public/studio/studio.css` (add vote styles)

**Step 1: Update approval detail modal**

In `showApprovalDetail`, fetch `/approvals/:id/votes` and display vote list. Show vote buttons (Approve/Deny) for human operators. Show risk tier badge and quorum progress bar (X/Y approvals).

**Step 2: Add tier badge colors**

```css
.tier-low { color: var(--green); }
.tier-medium { color: var(--yellow); }
.tier-high { color: var(--red); }
.tier-critical { background: var(--red); color: white; }
```

**Step 3: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: approval voting UI with quorum display"
```

---

### Task 18: Dashboard — Directive Display

**Files:**
- Modify: `public/studio/studio.js` (add directive rendering in messages)
- Modify: `public/studio/studio.css` (add directive styles)

**Step 1: Identify directives in message rendering**

In the message rendering code, check `msg.msg_type === 'directive'`. Render with red background, "MUST RESPOND" badge, and prominent placement at top of message list.

**Step 2: Add CSS**

```css
.msg-directive {
  border-left: 3px solid var(--red);
  background: rgba(196, 91, 62, 0.08);
}
.directive-badge {
  background: var(--red);
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
```

**Step 3: Add directive option to send message modal**

In `index.html`, add `<option value="directive">Directive (blocking)</option>` to the `#msg-type` select.

**Step 4: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: directive display with blocking badge in dashboard"
```

---

### Task 19: Dashboard — Asset Pipeline UI

**Files:**
- Modify: `public/studio/studio.js` (update asset rendering to show pipeline status)
- Modify: `public/studio/studio.css` (add pipeline styles)

**Step 1: Update asset cards**

Show `requested_by`, `assigned_to`, `status` pipeline. Add upload button for assets in `requested` status. Show download button for `ready` assets.

**Step 2: Add upload form**

Add a file input in the asset detail view that POSTs to `/assets/:id/upload`.

**Step 3: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: asset pipeline UI with upload/download"
```

---

### Task 20: Dashboard — Instance Config Panel

**Files:**
- Modify: `public/studio/index.html` (add config section in right column)
- Modify: `public/studio/studio.js` (add renderConfig function)

**Step 1: Add config section**

In right column, add:
```html
        <div class="right-section">
          <div class="queue-header queue-header-config">Instance Config</div>
          <div id="config-list" class="queue-tiles"></div>
        </div>
```

**Step 2: Render config values**

Fetch `/admin/config` and render key-value pairs. Show instance mode, admin status, risk tier config. Editable for admin users.

**Step 3: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: instance config panel in dashboard"
```

---

### Task 21: Dashboard — Kill Switch Button

**Files:**
- Modify: `public/studio/index.html` (add kill switch button in header)
- Modify: `public/studio/studio.js` (add freeze/unfreeze handler)
- Modify: `public/studio/studio.css` (add kill switch styles)

**Step 1: Add button to header**

In header-actions (line 29-36), add:
```html
        <button id="kill-switch-btn" class="action-btn btn-danger" style="display:none">FREEZE</button>
```

**Step 2: Add handler**

Show button only when admin_status is not frozen. On click, PUT `/admin/override` with `{action: "freeze"}`. When frozen, button shows "UNFREEZE" and sends `{action: "unfreeze"}`.

**Step 3: Add red button style**

```css
.btn-danger {
  background: var(--red) !important;
  color: white !important;
  font-weight: 700;
}
```

**Step 4: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: kill switch button for Claude Admin freeze/unfreeze"
```

---

## Phase 4: MCP Tools

### Task 22: MCP — `studio_request_work`

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js` (add tool after approval tools, around line 764)

**Step 1: Add tool**

```javascript
  // ---- Work Routing ----
  registerDual(server, 'studio_request_work',
    'Request work assignment from Claude Admin. Types: task_request, asset_request, work_request.',
    {
      type: { type: 'string', description: 'Request type: task_request, asset_request, work_request', enum: ['task_request', 'asset_request', 'work_request'] },
      target: { type: 'string', description: 'Target agent (for cross-agent requests)' },
      description: { type: 'string', description: 'What work is needed' },
      priority: { type: 'string', description: 'Priority: low, normal, high, urgent', enum: ['low', 'normal', 'high', 'urgent'] }
    },
    async function (params) {
      var res = await apiPost('/work/request', {
        type: params.type,
        target: params.target || '',
        description: params.description || '',
        priority: params.priority || 'normal'
      });
      return { content: [{ type: 'text', text: 'Work request filed. Message #' + res.message_id + ' routed to ' + res.routed_to + '.\nClaude Admin will review and assign work.' }] };
    }
  );
```

**Step 2: Commit**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: studio_request_work MCP tool"
```

---

### Task 23: MCP — `studio_file_directive`

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js`

**Step 1: Add tool**

```javascript
  registerDual(server, 'studio_file_directive',
    'Issue a blocking directive to an agent. Only Claude Admin can use this. Agent must respond before getting new work.',
    {
      to: { type: 'string', description: 'Target agent ID' },
      content: { type: 'string', description: 'Directive content (what the agent must do/respond to)' },
      game: { type: 'string', description: 'Project context' }
    },
    async function (params) {
      var st = getState();
      var res = await apiPost('/messages', {
        from: st.agentId || '__admin__',
        to: params.to,
        msg_type: 'directive',
        content: params.content,
        game: params.game || ''
      });
      return { content: [{ type: 'text', text: 'Directive sent to ' + params.to + '. Message #' + res.id + '.\nAgent MUST respond before receiving new work assignments.' }] };
    }
  );
```

**Step 2: Commit**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: studio_file_directive MCP tool"
```

---

### Task 24: MCP — `studio_upload_asset`

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js`

**Step 1: Add tool**

Note: MCP tool can't directly upload files (no multipart support). Instead, update the asset status and path for assets stored locally. For actual file upload, agents use curl or the dashboard.

```javascript
  registerDual(server, 'studio_upload_asset',
    'Mark an asset as ready and set its file path. For actual file upload, use the dashboard or curl POST /assets/:id/upload.',
    {
      asset_id: { type: 'number', description: 'Asset ID to update' },
      path: { type: 'string', description: 'File path or URL where the asset is available' },
      status: { type: 'string', description: 'New status (default: ready)', enum: ['ready', 'in_progress', 'review'] }
    },
    async function (params) {
      var res = await apiPut('/assets/' + params.asset_id, {
        status: params.status || 'ready',
        path: params.path || ''
      });
      return { content: [{ type: 'text', text: 'Asset #' + params.asset_id + ' updated. Status: ' + (params.status || 'ready') + '.\nPath: ' + (params.path || '(none)') }] };
    }
  );
```

**Step 2: Commit**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: studio_upload_asset MCP tool"
```

---

### Task 25: MCP — `studio_download_asset`

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js`

**Step 1: Add tool**

```javascript
  registerDual(server, 'studio_download_asset',
    'Get download info for a ready asset.',
    {
      asset_id: { type: 'number', description: 'Asset ID to download' }
    },
    async function (params) {
      var res = await apiGet('/assets/' + params.asset_id);
      if (res.status !== 'ready') {
        return { content: [{ type: 'text', text: 'Asset #' + params.asset_id + ' is not ready yet. Status: ' + res.status }] };
      }
      var url = res.download_url || res.path || '(no file attached)';
      return { content: [{ type: 'text', text: 'Asset #' + params.asset_id + ' (' + res.name + ') is ready.\nDownload: ' + url + '\nType: ' + res.type + '\nProject: ' + res.game }] };
    }
  );
```

**Step 2: Commit**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: studio_download_asset MCP tool"
```

---

### Task 26: Update Boot Tool for Session Context + Directives

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js:72-134` (update boot handler output)

**Step 1: Update boot handler**

In the boot handler (around line 77-128), add formatting for new boot payload fields. After the existing sections, add:

```javascript
      // Pending directives (blocking)
      if (data.pending_directives && data.pending_directives.length > 0) {
        out += '\n\n⚠️ BLOCKING DIRECTIVES (' + data.pending_directives.length + '):\n';
        out += 'You MUST respond to these before receiving work assignments.\n';
        for (var dir of data.pending_directives) {
          out += '  #' + dir.id + ' from ' + dir.from_agent + ': ' + (dir.content || '').substring(0, 200) + '\n';
        }
      }

      // Session context (from last session)
      if (data.session_context) {
        out += '\n\nLast Session Context:\n' + JSON.stringify(data.session_context, null, 2) + '\n';
      }
```

**Step 2: Update formatOverview for operators and config**

In `formatOverview` (around line 935), add sections for operators and instance config:

```javascript
    // Operators
    if (data.operators && data.operators.length > 0) {
      parts.push('TEAM (' + data.operators.length + '):\n' + data.operators.map(function (op) {
        return '  ' + op.display_name + ' (' + op.id + ') — ' + op.role + (op.responsibilities ? ': ' + op.responsibilities : '');
      }).join('\n'));
    }

    // Instance Config
    if (data.instance_config) {
      parts.push('INSTANCE CONFIG:\n' + data.instance_config.map(function (c) {
        return '  ' + c.key + ' = ' + c.value;
      }).join('\n'));
    }
```

**Step 3: Commit**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: boot tool shows directives, operators, instance config"
```

---

### Task 27: Shutdown Hook for Session Summary

**Files:**
- Modify: `D:/mycelium-mcp/src/state.js` (update shutdown to write session summary)

**Step 1: Read current state.js**

Read `D:/mycelium-mcp/src/state.js` to find the shutdown handler.

**Step 2: Update shutdown**

In the shutdown handler, before the final heartbeat, write session context:

```javascript
  // Auto-save session summary
  try {
    var sessionData = {
      working_on: state.workingOn || '',
      active_tasks: state.activeTasks || [],
      timestamp: new Date().toISOString()
    };
    await apiPut('/context/keys/' + state.agentId + '/last_session', {
      value: JSON.stringify(sessionData)
    });
  } catch (e) { /* best effort */ }
```

**Step 3: Commit**

```bash
cd D:/mycelium-mcp && git add src/state.js && git commit -m "feat: auto-save session summary on shutdown"
```

---

## Phase 5: Deploy & Test

### Task 28: Add Operators + Config to Overview Endpoint

**Files:**
- Modify: `server/db.js:967-1013` (update `getDvOverview`)
- Modify: `server/routes/mycelium.js:1042` (update admin overview)

**Step 1: Update getDvOverview**

Add to the return object:

```javascript
    operators: listOperators(),
    instance_config: listInstanceConfig(),
```

**Step 2: Commit**

```bash
cd D:/mycelium && git add server/db.js server/routes/mycelium.js && git commit -m "feat: operators + config in admin overview"
```

---

### Task 29: Deploy to mycelium.fyi

**Step 1: Deploy Mycelium**

```bash
cd D:/mycelium && railway up
```

Wait for deployment to complete. Verify health:

```bash
curl -s https://mycelium.fyi/api/mycelium/admin/overview -H "X-Admin-Key: $ADMIN_KEY" | python -c "import sys,json; d=json.load(sys.stdin); print('agents:', len(d['agents']), 'operators:', len(d.get('operators',[])))"
```

Expected: `agents: 3 operators: 3`

**Step 2: Deploy MCP**

MCP runs locally, no deploy needed. Restart Claude Code to pick up new tools.

**Step 3: Commit tag**

```bash
cd D:/mycelium && git tag v2.0-command-structure
```

---

### Task 30: E2E Test — Full Command Structure Flow

**Step 1: Test operators**

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/operators | python -m json.tool
```

Expected: 3 operators (greatness, hijack, unakron)

**Step 2: Test instance config**

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/config | python -m json.tool
```

Expected: instance_mode=developer, admin_agent_id=greatness-claude, etc.

**Step 3: Test kill switch**

```bash
# Freeze
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  https://mycelium.fyi/api/mycelium/admin/override -d '{"action":"freeze"}'

# Verify frozen
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/config/admin_status

# Unfreeze
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  https://mycelium.fyi/api/mycelium/admin/override -d '{"action":"unfreeze"}'
```

**Step 4: Test directive flow**

```bash
# Send directive
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  https://mycelium.fyi/api/mycelium/messages \
  -d '{"from":"__admin__","to":"greatness-claude","msg_type":"directive","content":"Test directive - respond to confirm"}'

# Boot to see directive
curl -s -H "X-Agent-Key: $AGENT_KEY" \
  https://mycelium.fyi/api/mycelium/boot/greatness-claude | python -c "import sys,json; d=json.load(sys.stdin); print('directives:', len(d.get('pending_directives',[])))"
```

**Step 5: Test approval voting**

```bash
# Create high-tier approval (requires 2 approvals)
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  https://mycelium.fyi/api/mycelium/approvals \
  -d '{"action_type":"deploy","requested_by":"greatness-claude","title":"E2E test deploy","risk_tier":"high","required_approvals":2}'

# Vote (returns pending, need 2)
# Vote again from different identity to reach quorum
```

**Step 6: Test agent roles**

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/agents | python -c "import sys,json; [print(a['id'],a.get('role','?'),a.get('operator_id','?')) for a in json.load(sys.stdin)]"
```

Expected: greatness-claude admin greatness, hijack-claude agent hijack, unakron-gpu drone greatness

---

### Task 31: Verify Backward Compatibility + Notify Agents

**Step 1: Verify existing MCP tools still work**

Boot via MCP: call `studio_boot`. Verify all existing fields present.

**Step 2: Verify existing API endpoints**

```bash
# Tasks
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/tasks?limit=3 | python -m json.tool

# Plans
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/plans?limit=3 | python -m json.tool

# Messages
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/messages?limit=3 | python -m json.tool
```

**Step 3: Broadcast to all agents**

```bash
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  https://mycelium.fyi/api/mycelium/messages \
  -d '{"from":"__admin__","to":"broadcast","msg_type":"info","subject":"Command Structure v2 Live","content":"Mycelium Command Structure v2 is deployed. New capabilities:\n\n1. OPERATORS: People (greatness, hijack, unakron) are now tracked separately from agents. GET /operators to see the team.\n\n2. AGENT ROLES: Agents now have roles (admin, agent, drone) and are linked to their operator.\n\n3. DIRECTIVES: New blocking message type. If you receive a directive, you MUST respond before getting new work.\n\n4. WORK ROUTING: Use studio_request_work to ask Claude Admin for assignments.\n\n5. APPROVAL VOTING: Multi-human quorum system. Risk tiers: low/medium/high/critical.\n\n6. KILL SWITCH: Human operators can freeze Claude Admin via dashboard.\n\n7. INSTANCE CONFIG: Per-deployment settings at /admin/config.\n\nAll existing tools and endpoints work unchanged. New MCP tools: studio_request_work, studio_file_directive, studio_upload_asset, studio_download_asset."}'
```

**Step 4: Update Plan 7 status on network**

Mark Plan 7 steps as completed as each phase finishes.

---

## Execution Notes

- **No test framework**: This project has no automated tests. Verification is via curl commands and local `node -e` checks.
- **No breaking changes**: All schema changes use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` with defaults. Existing data is preserved.
- **Dashboard tasks (16-21)** are assigned to hijack-claude on the network plan. Implementation specs above are guidelines for hijack's reference.
- **MCP runs locally**: No deploy needed for MCP changes. Restart Claude Code to pick up new tools.
- **Phase order matters**: Phase 1 (data model) must complete before Phase 2 (API). Phase 2 before Phase 3 (dashboard) and Phase 4 (MCP). Phase 5 is last.
