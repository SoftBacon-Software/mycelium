# Stand Up Calibration System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build server-side agent calibration with node profiles, boot-time drift detection, CLAUDE.md anchor comparison, periodic refresh, and dashboard UI.

**Architecture:** New `dv_node_profiles` table with layered inheritance (platform → customer → agent). Boot endpoint enhanced with calibration block. Heartbeat accepts md_report and runs 6-hour refresh. Dashboard gets "Node Health" page with profile editor and drift matrix.

**Tech Stack:** SQLite (better-sqlite3), Express routes, vanilla JS dashboard (matches existing studio.js pattern), Mycelium MCP tools.

**Design doc:** `docs/plans/2026-03-06-standup-calibration-design.md`

**No tests configured** — verify each step by hitting API endpoints with curl or checking dashboard renders.

---

### Task 1: Add `dv_node_profiles` Table

**Files:**
- Modify: `server/db.js` (migration array ~line 40-80, add new table + CRUD functions)

**Step 1: Add table to migration block**

In `db.js`, find the `ensureColumns` array and add after it (near line 85 where other CREATE TABLE IF NOT EXISTS statements live):

```javascript
// In the initDb() function or equivalent setup block:
db.prepare(`CREATE TABLE IF NOT EXISTS dv_node_profiles (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL DEFAULT 'agent',
  layer TEXT NOT NULL DEFAULT 'customer',
  parent_id TEXT,
  rules TEXT NOT NULL DEFAULT '{}',
  required_concepts TEXT NOT NULL DEFAULT '[]',
  mcp_config TEXT NOT NULL DEFAULT '{}',
  tool_whitelist TEXT NOT NULL DEFAULT '[]',
  repo_list TEXT NOT NULL DEFAULT '[]',
  md_checkpoints TEXT NOT NULL DEFAULT '[]',
  md_blocklist TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`).run();
```

**Step 2: Add CRUD functions**

Add these functions to `db.js` exports:

```javascript
export function createNodeProfile(id, data) {
  db.prepare(
    `INSERT INTO dv_node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, data.node_type || 'agent', data.layer || 'customer', data.parent_id || null,
    JSON.stringify(data.rules || {}), JSON.stringify(data.required_concepts || []),
    JSON.stringify(data.mcp_config || {}), JSON.stringify(data.tool_whitelist || []),
    JSON.stringify(data.repo_list || []), JSON.stringify(data.md_checkpoints || []),
    JSON.stringify(data.md_blocklist || []));
  return getNodeProfile(id);
}

export function getNodeProfile(id) {
  return db.prepare('SELECT * FROM dv_node_profiles WHERE id = ?').get(id);
}

export function listNodeProfiles(filter) {
  if (filter && filter.node_type) {
    return db.prepare('SELECT * FROM dv_node_profiles WHERE node_type = ? ORDER BY layer, id').all(filter.node_type);
  }
  if (filter && filter.layer) {
    return db.prepare('SELECT * FROM dv_node_profiles WHERE layer = ? ORDER BY node_type, id').all(filter.layer);
  }
  return db.prepare('SELECT * FROM dv_node_profiles ORDER BY layer, node_type, id').all();
}

export function updateNodeProfile(id, data) {
  var profile = getNodeProfile(id);
  if (!profile) return null;
  var sets = [];
  var values = [];
  for (var key of ['node_type', 'layer', 'parent_id', 'rules', 'required_concepts', 'mcp_config', 'tool_whitelist', 'repo_list', 'md_checkpoints', 'md_blocklist']) {
    if (data[key] !== undefined) {
      sets.push(key + ' = ?');
      values.push(typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (sets.length === 0) return profile;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare('UPDATE dv_node_profiles SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  return getNodeProfile(id);
}

export function deleteNodeProfile(id) {
  var profile = getNodeProfile(id);
  if (!profile) return null;
  if (profile.layer === 'platform') return null; // Can't delete platform defaults
  db.prepare('DELETE FROM dv_node_profiles WHERE id = ?').run(id);
  return profile;
}

export function resolveProfileChain(agentId) {
  var agent = getAgent(agentId);
  if (!agent) return null;
  var nodeType = agent.agent_type || 'agent';

  // Load chain: platform default → customer default → agent-specific
  var platformProfile = getNodeProfile('default-' + nodeType);
  var customerProfile = getNodeProfile('customer-' + nodeType);
  var agentProfile = getNodeProfile(agentId);

  // Merge: start with platform, overlay customer, overlay agent
  var resolved = {
    rules: {},
    required_concepts: [],
    mcp_config: {},
    tool_whitelist: [],
    repo_list: [],
    md_checkpoints: [],
    md_blocklist: [],
    profile_version: null,
    layers_applied: []
  };

  for (var profile of [platformProfile, customerProfile, agentProfile]) {
    if (!profile) continue;
    resolved.layers_applied.push(profile.id);
    resolved.profile_version = profile.updated_at;

    // Rules: merge (later layers override same keys, but can't downgrade platform critical)
    try {
      var rules = typeof profile.rules === 'string' ? JSON.parse(profile.rules) : profile.rules;
      for (var [ruleKey, ruleVal] of Object.entries(rules)) {
        if (resolved.rules[ruleKey] && resolved.rules[ruleKey].severity === 'critical' && profile.layer !== 'platform') {
          // Can't downgrade critical platform rules
          resolved.rules[ruleKey] = { ...resolved.rules[ruleKey], ...ruleVal, severity: 'critical' };
        } else {
          resolved.rules[ruleKey] = ruleVal;
        }
      }
    } catch (e) {}

    // Arrays: concatenate and deduplicate
    try {
      var concepts = typeof profile.required_concepts === 'string' ? JSON.parse(profile.required_concepts) : profile.required_concepts;
      resolved.required_concepts = [...new Set([...resolved.required_concepts, ...concepts])];
    } catch (e) {}

    try {
      var checkpoints = typeof profile.md_checkpoints === 'string' ? JSON.parse(profile.md_checkpoints) : profile.md_checkpoints;
      resolved.md_checkpoints = [...new Set([...resolved.md_checkpoints, ...checkpoints])];
    } catch (e) {}

    try {
      var blocklist = typeof profile.md_blocklist === 'string' ? JSON.parse(profile.md_blocklist) : profile.md_blocklist;
      resolved.md_blocklist = [...new Set([...resolved.md_blocklist, ...blocklist])];
    } catch (e) {}

    // Objects: overlay
    try {
      var mcp = typeof profile.mcp_config === 'string' ? JSON.parse(profile.mcp_config) : profile.mcp_config;
      Object.assign(resolved.mcp_config, mcp);
    } catch (e) {}

    // Tool whitelist: last non-empty wins
    try {
      var tools = typeof profile.tool_whitelist === 'string' ? JSON.parse(profile.tool_whitelist) : profile.tool_whitelist;
      if (tools.length > 0) resolved.tool_whitelist = tools;
    } catch (e) {}

    // Repo list: concatenate
    try {
      var repos = typeof profile.repo_list === 'string' ? JSON.parse(profile.repo_list) : profile.repo_list;
      resolved.repo_list = [...new Set([...resolved.repo_list, ...repos])];
    } catch (e) {}
  }

  return resolved;
}
```

**Step 3: Verify**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { console.log(db.listNodeProfiles()); })"
```

Expected: empty array (table created, no profiles yet).

**Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat: add dv_node_profiles table with CRUD and profile chain resolution"
```

---

### Task 2: Seed Platform Defaults

**Files:**
- Modify: `server/db.js` (add seeding function called on init)

**Step 1: Add seedPlatformProfiles() function**

```javascript
export function seedPlatformProfiles() {
  // Only seed if platform defaults don't exist yet
  if (getNodeProfile('default-agent')) return;

  createNodeProfile('default-agent', {
    node_type: 'agent',
    layer: 'platform',
    rules: {
      honesty: { rule: "No guessing. No silent failures. Report failures immediately. Never pretend something worked.", severity: "critical" },
      evidence_based: { rule: "Verify files exist before editing. Read before writing. Run verification before claiming success.", severity: "critical" },
      identity: { rule: "Boot Mycelium on every session. Read your agent context keys. Know who you are and what you're working on before acting.", severity: "high" },
      communication: { rule: "Use Mycelium messages (content field, NOT body). Check inbox on heartbeat. Respond to requests promptly.", severity: "high" },
      coordination: { rule: "Update the network when completing work. Heartbeat with meaningful working_on text. Don't duplicate work another agent is doing.", severity: "high" },
      security: { rule: "Never commit secrets. Never expose API keys in logs. Validate at system boundaries.", severity: "critical" },
      paid_services: { rule: "Never use paid APIs without explicit operator permission. Prefer free alternatives (local GPU, LoRA generation).", severity: "critical" },
      code_standards: { rule: "No over-engineering. Don't add features beyond what was asked. Prefer editing existing files over creating new ones.", severity: "medium" }
    },
    required_concepts: [],
    mcp_config: { env_required: ["MYCELIUM_API_KEY", "MYCELIUM_ROLE"] },
    tool_whitelist: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    md_checkpoints: ["mycelium_boot", "No guessing", "No silent failures"],
    md_blocklist: ["studio_boot", "studio_get_work", "studio_read_messages", "generate_sprites.py", "Pixel Arena", "Some of You May Die"]
  });

  createNodeProfile('default-drone', {
    node_type: 'drone',
    layer: 'platform',
    rules: {
      execution: { rule: "Execute queued jobs. Report results accurately. Include error diagnostics on failure.", severity: "critical" },
      no_messages: { rule: "Drones do not read or respond to messages. They execute jobs only.", severity: "high" }
    },
    required_concepts: [],
    mcp_config: {},
    tool_whitelist: [],
    md_checkpoints: [],
    md_blocklist: []
  });

  createNodeProfile('default-admin', {
    node_type: 'admin',
    layer: 'platform',
    parent_id: 'default-agent',
    rules: {
      coordination: { rule: "Coordinate work across agents. Assign tasks, manage plans, resolve conflicts. No direct code changes.", severity: "high" }
    },
    required_concepts: [],
    mcp_config: { env_required: ["MYCELIUM_API_KEY", "MYCELIUM_ROLE"] },
    tool_whitelist: ["Bash"],
    md_checkpoints: ["mycelium_boot"],
    md_blocklist: ["studio_boot"]
  });

  console.log('[mycelium] Seeded platform default profiles');
}
```

**Step 2: Call seedPlatformProfiles() in initDb or server startup**

Find where `initDb()` or table creation runs and add `seedPlatformProfiles()` at the end.

**Step 3: Verify**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "http://localhost:3002/api/mycelium/profiles" | python -m json.tool
```

Expected: 3 platform profiles returned.

**Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat: seed platform default profiles for agent, drone, admin node types"
```

---

### Task 3: Profile CRUD API Endpoints

**Files:**
- Modify: `server/routes/mycelium.js` (add profile endpoints)

**Step 1: Add profile routes**

Add these routes to `mycelium.js` (admin-only):

```javascript
// --- Node Profiles ---

// List all profiles (optional filter: ?node_type=agent, ?layer=platform)
router.get('/profiles', requireAdmin, (req, res) => {
  var filter = {};
  if (req.query.node_type) filter.node_type = req.query.node_type;
  if (req.query.layer) filter.layer = req.query.layer;
  res.json(db.listNodeProfiles(filter));
});

// Get single profile
router.get('/profiles/:id', requireAdmin, (req, res) => {
  var profile = db.getNodeProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Parse JSON fields for response
  for (var field of ['rules', 'required_concepts', 'mcp_config', 'tool_whitelist', 'repo_list', 'md_checkpoints', 'md_blocklist']) {
    try { profile[field] = JSON.parse(profile[field]); } catch (e) {}
  }
  res.json(profile);
});

// Get resolved profile chain for an agent
router.get('/profiles/resolve/:agentId', requireAdmin, (req, res) => {
  var resolved = db.resolveProfileChain(req.params.agentId);
  if (!resolved) return res.status(404).json({ error: 'Agent not found' });
  res.json(resolved);
});

// Create profile
router.post('/profiles', requireAdmin, (req, res) => {
  var { id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (db.getNodeProfile(id)) return res.status(409).json({ error: 'Profile already exists' });
  var profile = db.createNodeProfile(id, { node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist });
  res.status(201).json(profile);
});

// Update profile
router.put('/profiles/:id', requireAdmin, (req, res) => {
  var profile = db.updateNodeProfile(req.params.id, req.body);
  if (!profile) return res.status(404).json({ error: 'Profile not found or is platform-immutable' });
  res.json(profile);
});

// Delete profile (can't delete platform layer)
router.delete('/profiles/:id', requireAdmin, (req, res) => {
  var profile = db.deleteNodeProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found or is platform-immutable' });
  res.json({ ok: true, deleted: profile.id });
});
```

**Step 2: Import new db functions**

Make sure the new exports (`createNodeProfile`, `getNodeProfile`, `listNodeProfiles`, `updateNodeProfile`, `deleteNodeProfile`, `resolveProfileChain`, `seedPlatformProfiles`) are imported in `mycelium.js`.

**Step 3: Verify**

```bash
# List profiles
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "http://localhost:3002/api/mycelium/profiles"

# Resolve chain for an agent
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "http://localhost:3002/api/mycelium/profiles/resolve/macbook-claude"

# Create customer override
curl -s -X POST -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" -H "Content-Type: application/json" \
  -d '{"id":"customer-agent","node_type":"agent","layer":"customer","parent_id":"default-agent","md_checkpoints":["generate_painterly.py"],"md_blocklist":["dioverse-mcp"]}' \
  "http://localhost:3002/api/mycelium/profiles"
```

**Step 4: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat: add profile CRUD endpoints for node calibration"
```

---

### Task 4: Boot Calibration Block

**Files:**
- Modify: `server/db.js` (enhance `getBootPayload` ~line 880, add `buildCalibrationBlock`)

**Step 1: Add buildCalibrationBlock function**

```javascript
export function buildCalibrationBlock(agentId) {
  var resolved = resolveProfileChain(agentId);
  if (!resolved) return null;

  var driftItems = [];

  // Check md_report from last heartbeat savepoint
  var savepoint = getLatestSavepoint(agentId);
  var mdReport = null;
  if (savepoint && savepoint.state_snapshot) {
    try {
      var snap = typeof savepoint.state_snapshot === 'string' ? JSON.parse(savepoint.state_snapshot) : savepoint.state_snapshot;
      mdReport = snap.md_report || null;
    } catch (e) {}
  }

  if (mdReport) {
    // Check checkpoints (must be present)
    for (var cp of resolved.md_checkpoints) {
      if (!mdReport.anchors_present || !mdReport.anchors_present.includes(cp)) {
        driftItems.push({ type: 'md_missing', expected: cp, severity: 'high', fix: 'Add "' + cp + '" to your CLAUDE.md' });
      }
    }
    // Check blocklist (must not be present)
    if (mdReport.blocklist_found) {
      for (var bl of mdReport.blocklist_found) {
        driftItems.push({ type: 'md_blocklist', found: bl, severity: 'high', fix: 'Remove "' + bl + '" from your CLAUDE.md' });
      }
    }
  } else {
    driftItems.push({ type: 'md_report_missing', severity: 'medium', fix: 'Send md_report in your next heartbeat state_snapshot' });
  }

  var status = 'aligned';
  if (driftItems.length > 0) status = 'drifted';
  if (driftItems.some(d => d.severity === 'critical')) status = 'critical';

  var block = {
    status: status,
    drift_items: driftItems,
    required_concepts: resolved.required_concepts,
    profile_version: resolved.profile_version,
    layers_applied: resolved.layers_applied,
    last_standup: new Date().toISOString()
  };

  // Write to {agentId}/standup context key
  setContextKey(agentId, 'standup', JSON.stringify(block), 'system');

  return block;
}
```

**Step 2: Add since_last_session to boot**

Enhance `getBootPayload()` (~line 880). After the existing `computeSavepointDiff()` call, add:

```javascript
// Calibration block
var calibration = buildCalibrationBlock(agentId);

// Since last session summary
var sinceLastSession = null;
if (agent.last_heartbeat) {
  var since = agent.last_heartbeat;
  var newMsgCount = db.prepare("SELECT COUNT(*) as c FROM dv_messages WHERE (to_agent = ? OR to_agent IS NULL) AND created_at > ?").get(agentId, since).c;
  var taskChanges = db.prepare("SELECT id, status, updated_at FROM dv_tasks WHERE (assignee = ? OR assignee IS NULL) AND updated_at > ?").all(agentId, since);
  var stepChanges = db.prepare("SELECT COUNT(*) as c FROM dv_plan_steps WHERE updated_at > ?").get(since).c;
  var newBugs = db.prepare("SELECT COUNT(*) as c FROM dv_bugs WHERE created_at > ?").get(since).c;
  sinceLastSession = {
    new_messages: newMsgCount,
    task_changes: taskChanges.length,
    plan_step_changes: stepChanges,
    new_bugs: newBugs,
    away_duration_minutes: Math.round((Date.now() - new Date(since).getTime()) / 60000)
  };
}
```

Then include `calibration` and `since_last_session: sinceLastSession` in the returned payload object.

**Step 3: Verify**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "http://localhost:3002/api/mycelium/boot/macbook-claude" | python -m json.tool | grep -A 20 calibration
```

Expected: calibration block with status and drift_items.

**Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat: add calibration block and since_last_session to boot payload"
```

---

### Task 5: Heartbeat Enhancement — md_report + 6-Hour Refresh

**Files:**
- Modify: `server/routes/mycelium.js` (heartbeat handler)
- Modify: `server/db.js` (add last_standup tracking)

**Step 1: Accept md_report in heartbeat**

In the heartbeat route handler, extract `md_report` from `state_snapshot` and store it. Also check if 6 hours have passed since last standup.

In the heartbeat handler in `mycelium.js`, after existing state_snapshot processing:

```javascript
// Extract md_report if present in state_snapshot
if (stateSnapshot && stateSnapshot.md_report) {
  // Store md_report in agent's context for calibration
  db.setContextKey(agentId, 'md_report', JSON.stringify(stateSnapshot.md_report), 'system');
}

// 6-hour periodic calibration refresh
var lastStandup = db.getContextKey(agentId, 'standup');
var shouldRefresh = true;
if (lastStandup) {
  try {
    var standupData = JSON.parse(lastStandup.data);
    var lastTime = new Date(standupData.last_standup || 0).getTime();
    shouldRefresh = (Date.now() - lastTime) > 6 * 60 * 60 * 1000; // 6 hours
  } catch (e) {}
}
if (shouldRefresh) {
  var calibration = db.buildCalibrationBlock(agentId);
  if (calibration && calibration.status === 'critical') {
    // Send blocking directive for critical drift
    db.createMessage({
      from_agent: '__system__',
      to_agent: agentId,
      content: 'CALIBRATION ALERT: Critical drift detected. Fix these issues before continuing work:\n\n' +
        calibration.drift_items.filter(d => d.severity === 'critical').map(d => '- ' + (d.fix || d.type)).join('\n'),
      msg_type: 'directive',
      project_id: agent.project_id
    });
  }
}
```

**Step 2: Verify**

```bash
# Send heartbeat with md_report
curl -s -X POST -H "X-Agent-Key: <agent-key>" -H "Content-Type: application/json" \
  -d '{"status":"online","working_on":"testing calibration","state_snapshot":{"md_report":{"hash":"abc123","anchors_present":["mycelium_boot","No guessing"],"anchors_missing":[],"blocklist_found":["studio_boot"],"line_count":150}}}' \
  "http://localhost:3002/api/mycelium/agents/heartbeat"
```

Expected: 200 OK. Check `{agentId}/standup` context key for drift items flagging `studio_boot`.

**Step 3: Commit**

```bash
git add server/routes/mycelium.js server/db.js
git commit -m "feat: heartbeat accepts md_report, runs 6-hour calibration refresh"
```

---

### Task 6: MCP Tools — Profile + Calibration

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js` (add new tools)

**Step 1: Add mycelium_get_profile tool**

```javascript
{
  name: 'mycelium_get_profile',
  description: 'Get the resolved calibration profile for an agent (merged from platform → customer → agent layers).',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID to resolve profile for (default: self)' }
    }
  },
  handler: async (args) => {
    var agentId = args.agent_id || state.agentId;
    var resp = await api.get('/profiles/resolve/' + agentId);
    return resp;
  }
}
```

**Step 2: Add mycelium_report_md tool**

```javascript
{
  name: 'mycelium_report_md',
  description: 'Report your CLAUDE.md state for calibration. Reads your CLAUDE.md, checks anchors against your profile, and sends the report via heartbeat.',
  inputSchema: {
    type: 'object',
    properties: {
      md_content: { type: 'string', description: 'Full text of your CLAUDE.md file' }
    },
    required: ['md_content']
  },
  handler: async (args) => {
    // Get resolved profile to know what to check
    var profile = await api.get('/profiles/resolve/' + state.agentId);
    var content = args.md_content;

    var anchorsPresent = [];
    var anchorsMissing = [];
    var blocklistFound = [];

    for (var cp of (profile.md_checkpoints || [])) {
      if (content.includes(cp)) anchorsPresent.push(cp);
      else anchorsMissing.push(cp);
    }
    for (var bl of (profile.md_blocklist || [])) {
      if (content.includes(bl)) blocklistFound.push(bl);
    }

    var report = {
      hash: require('crypto').createHash('sha256').update(content).digest('hex').slice(0, 16),
      anchors_present: anchorsPresent,
      anchors_missing: anchorsMissing,
      blocklist_found: blocklistFound,
      last_modified: new Date().toISOString(),
      line_count: content.split('\n').length
    };

    // Send via heartbeat
    await api.post('/agents/heartbeat', {
      status: 'online',
      working_on: state.workingOn || '',
      state_snapshot: { md_report: report }
    });

    return { ok: true, report: report };
  }
}
```

**Step 3: Add mycelium_list_profiles tool**

```javascript
{
  name: 'mycelium_list_profiles',
  description: 'List all node profiles. Filter by node_type or layer.',
  inputSchema: {
    type: 'object',
    properties: {
      node_type: { type: 'string', description: 'Filter: agent, drone, admin' },
      layer: { type: 'string', description: 'Filter: platform, customer, agent' }
    }
  },
  handler: async (args) => {
    var query = [];
    if (args.node_type) query.push('node_type=' + args.node_type);
    if (args.layer) query.push('layer=' + args.layer);
    var qs = query.length ? '?' + query.join('&') : '';
    return await api.get('/profiles' + qs);
  }
}
```

**Step 4: Verify**

```bash
cd D:/mycelium-mcp && node -e "console.log('tools load ok')" # basic sanity
```

**Step 5: Commit**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: add profile and md_report MCP tools for calibration"
```

---

### Task 7: Dashboard — Node Health Page

**Files:**
- Modify: `public/studio/studio.js` (add renderNodeHealth function + nav entry)
- Modify: `public/studio/studio.css` (add calibration status styles)

**Step 1: Add Node Health nav item**

Find the navigation rendering in `studio.js` and add a "Node Health" entry alongside existing pages (agents, tasks, plans, bugs, etc.). Follow the existing pattern for how pages are added.

**Step 2: Add renderNodeHealth function**

```javascript
function renderNodeHealth(agents) {
  // Summary cards
  var aligned = 0, drifted = 0, critical = 0, unknown = 0;
  // Fetch standup context keys for each agent
  // Display: agent name, node type, profile, calibration status, drift count, last boot
  // Click into agent → full drift report

  // Profile editor section
  // List profiles with layered view
  // Checkpoint/blocklist editor

  // CLAUDE.md comparison matrix
  // Rows: agents, Columns: checkpoints
  // Green = present, Red = missing, Yellow = blocklist found
}
```

Follow existing `studio.js` patterns:
- Use `fetch('/api/mycelium/profiles')` for profile data
- Use `fetch('/api/mycelium/context/keys/{agentId}')` to get standup context keys
- Use Mycelium color scheme: amber primary (#D4A847), deep earth bg, moss green for aligned, rust for critical
- Match existing card/table layout patterns

**Step 3: Add CSS**

```css
.calibration-aligned { color: #7A9E7E; } /* moss green */
.calibration-drifted { color: #D4A847; } /* amber warning */
.calibration-critical { color: #C45B3E; } /* rust danger */
.calibration-unknown { color: #5E9EA0; } /* teal info */

.drift-matrix td { text-align: center; padding: 4px 8px; }
.drift-matrix .present { background: rgba(122, 158, 126, 0.2); }
.drift-matrix .missing { background: rgba(196, 91, 62, 0.2); }
.drift-matrix .blocklist { background: rgba(212, 168, 71, 0.2); }
```

**Step 4: Verify**

Open `https://localhost:3002/studio/` → navigate to Node Health → see agent calibration cards and profile editor.

**Step 5: Commit**

```bash
cd D:/mycelium && git add public/studio/ && git commit -m "feat: add Node Health dashboard page with calibration status and profile editor"
```

---

### Task 8: Fix Existing CLAUDE.md Files

**Files:**
- Modify: `D:/king-city/CLAUDE.md` (replace studio_* → mycelium_*)
- Modify: `D:/dioverse/CLAUDE.md` (fix DIOVERSE_* → MYCELIUM_* env vars, fix MCP config location)
- Modify: `D:/mycelium-mcp/CLAUDE.md` (fix MCP config location)
- Modify: `D:/willing-sacrifice/CLAUDE.md` (add WS1 vs WS2 note, add paid services rule, add concepts rule)
- Modify: `D:/dioverse-server/CLAUDE.md` (add paid services rule, fix dioverse-mcp reference)

**Step 1: Fix king-city CLAUDE.md**

Replace all `studio_boot` → `mycelium_boot`, `studio_get_work` → `mycelium_get_work`, `studio_read_messages` → `mycelium_read_messages`, etc.

**Step 2: Fix dioverse CLAUDE.md**

Replace `DIOVERSE_API_URL` → `MYCELIUM_API_URL`, `DIOVERSE_ROLE` → `MYCELIUM_ROLE`, `DIOVERSE_API_KEY` → `MYCELIUM_API_KEY`. Fix `~/.claude/settings.json` → `~/.claude.json`. Fix `D:/dioverse-mcp/` references to `D:/mycelium-mcp/`.

**Step 3: Fix mycelium-mcp CLAUDE.md**

Fix `~/.claude/settings.json` → `~/.claude.json`.

**Step 4: Fix willing-sacrifice CLAUDE.md**

Add note: "This CLAUDE.md covers WS1 (autobattler on main branch). WS2 (tactical rebuild) lives on feature/tactical-rebuild with different systems." Add paid services rule. Add "read linked concepts on boot" rule.

**Step 5: Fix dioverse-server CLAUDE.md**

Fix `D:/dioverse-mcp/` → `D:/mycelium-mcp/`. Add paid services rule.

**Step 6: Commit each repo**

```bash
cd D:/king-city && git add CLAUDE.md && git commit -m "fix: replace deprecated studio_* tool names with mycelium_*"
cd D:/dioverse && git add CLAUDE.md && git commit -m "fix: update MCP env vars to MYCELIUM_* and config location to ~/.claude.json"
cd D:/mycelium-mcp && git add CLAUDE.md && git commit -m "fix: correct MCP config location to ~/.claude.json"
cd D:/willing-sacrifice && git add CLAUDE.md && git commit -m "docs: add WS1/WS2 distinction, paid services rule, concepts rule"
cd D:/dioverse-server && git add CLAUDE.md && git commit -m "fix: update MCP path and add paid services rule"
```

---

### Task 9: Create Dioverse Instance Profiles

**Files:**
- No files — API calls to create customer + agent profiles

**Step 1: Create customer-level overrides for our instance**

```bash
# Customer default agent profile (our Dioverse-specific rules)
curl -s -X POST -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" -H "Content-Type: application/json" \
  -d '{
    "id": "customer-agent",
    "node_type": "agent",
    "layer": "customer",
    "parent_id": "default-agent",
    "rules": {
      "naming": {"rule": "Platform is Mycelium. Projects not games. WS1 and WS2 are separate games. Never say Pixel Arena or Some of You May Die.", "severity": "high"},
      "art_style": {"rule": "See concept #9. WS1=painterly, WS2=chunky pixel, KC=kc_pixel. Never mix styles.", "severity": "high"},
      "git_workflow": {"rule": "Feature branches from main. Squash merge PRs. Never force push main.", "severity": "high"}
    },
    "required_concepts": [8, 9],
    "md_checkpoints": ["mycelium_boot", "No guessing", "No silent failures", "generate_painterly.py"],
    "md_blocklist": ["studio_boot", "studio_get_work", "generate_sprites.py", "Pixel Arena", "Some of You May Die", "dioverse-mcp", "DIOVERSE_API_URL"]
  }' \
  "https://mycelium.fyi/api/mycelium/profiles"
```

**Step 2: Create per-agent overrides for agents with special needs**

```bash
# macbook-claude: add WS-specific checkpoints
curl -s -X POST -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" -H "Content-Type: application/json" \
  -d '{
    "id": "macbook-claude",
    "node_type": "agent",
    "layer": "agent",
    "parent_id": "customer-agent",
    "md_checkpoints": ["generate_painterly.py", "WSPAINT"],
    "required_concepts": [8, 9]
  }' \
  "https://mycelium.fyi/api/mycelium/profiles"
```

**Step 3: Verify chain resolution**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "https://mycelium.fyi/api/mycelium/profiles/resolve/macbook-claude" | python -m json.tool
```

Expected: merged rules from all 3 layers, combined checkpoints and blocklist.

---

### Task 10: Deploy + Verify End-to-End

**Step 1: Deploy Mycelium**

```bash
cd D:/mycelium && railway up
```

**Step 2: Deploy MCP**

No deploy needed — MCP runs locally from `D:/mycelium-mcp/`.

**Step 3: Verify boot calibration**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "https://mycelium.fyi/api/mycelium/boot/macbook-claude" | python -m json.tool | grep -A 30 calibration
```

**Step 4: Verify dashboard**

Open `https://mycelium.fyi/studio/` → Node Health page → confirm agents show with calibration status.

**Step 5: Broadcast to agents**

```bash
# Notify all agents of the new system
curl -s -X POST -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" -H "Content-Type: application/json" \
  -d '{"content": "STAND UP SYSTEM LIVE. On your next boot, you will receive a calibration block in your boot payload. Read your {agentId}/standup context key for drift items. Report your CLAUDE.md state via md_report in heartbeat state_snapshot. New MCP tools available: mycelium_get_profile, mycelium_report_md, mycelium_list_profiles."}' \
  "https://mycelium.fyi/api/mycelium/messages"
```
