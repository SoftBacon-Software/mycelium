# Token Reduction Protocol — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce agent token consumption by 60-70% through slim boot payloads, compressed tool responses, and lazy-load patterns.

**Architecture:** Server-side changes to `getBootPayload()` and `getOverview()` to return compact summaries. MCP tool formatting switches from verbose text to compact JSON. Runner system prompts compressed to bullet lists. All changes backward-compatible via `?verbose=true`.

**Tech Stack:** Node.js, Express, better-sqlite3, MCP SDK

---

### Task 1: Add `getSlimBootPayload()` to db.js

**Files:**
- Modify: `server/db.js:810-916` (after `getBootPayload`)

**Step 1: Write `getSlimBootPayload()` below `getBootPayload()`**

Add after line 916 in `server/db.js`:

```js
export function getSlimBootPayload(agentId) {
  var agent = getAgent(agentId);
  if (!agent) return null;

  // Auto-heartbeat on boot
  updateAgentHeartbeat(agentId, 'online', agent.working_on);

  // Counts only — no full records
  var counts = {
    directives: db.prepare(
      "SELECT COUNT(*) as c FROM dv_messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending')"
    ).get(agentId).c,
    requests: db.prepare(
      "SELECT COUNT(*) as c FROM dv_messages WHERE to_agent = ? AND msg_type = 'request' AND status IN ('sent', 'pending')"
    ).get(agentId).c,
    messages_unread: countPendingForAgent(agentId),
    tasks_mine: db.prepare(
      "SELECT COUNT(*) as c FROM dv_tasks WHERE assignee = ? AND status IN ('open', 'in_progress')"
    ).get(agentId).c,
    bugs_open: db.prepare(
      "SELECT COUNT(*) as c FROM dv_bugs WHERE status = 'open'"
    ).get().c,
    plans_active: db.prepare(
      "SELECT COUNT(*) as c FROM dv_plans WHERE (project_id = ? OR project_id = '') AND status = 'active'"
    ).get(agent.project_id).c
  };

  // Role contract — small, always needed
  var roleContract = buildRoleContract(agent, agentId);

  // Work queue — top 5, title+type+id only
  var pendingDirectives = db.prepare(
    "SELECT * FROM dv_messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
  ).all(agentId);
  var pendingRequests = listPendingRequests(agentId);
  var myTasks = db.prepare(
    "SELECT * FROM dv_tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC"
  ).all(agentId);
  var openBugs = listBugs({ status: 'open', limit: 5 });
  var myPlans = listPlans({ project_id: agent.project_id, limit: 5 });
  var fullQueue = buildWorkQueue(agentId, agent.project_id, pendingDirectives, pendingRequests, myTasks, openBugs, myPlans);
  var workQueue = fullQueue.slice(0, 5).map(function (item) {
    return { type: item.type, id: item.id, title: item.title };
  });

  // Other agents — compact
  var otherAgents = db.prepare(
    "SELECT id, status, working_on FROM dv_agents WHERE id != ? AND (project_id = ? OR last_heartbeat > datetime('now', '-7 days')) ORDER BY created_at"
  ).all(agentId, agent.project_id);

  return {
    agent: { id: agent.id, role: agent.role, project: agent.project_id, capabilities: agent.capabilities },
    role_contract: roleContract,
    counts: counts,
    work_queue: workQueue,
    other_agents: otherAgents.map(function (a) {
      return { id: a.id, status: a.status, working_on: a.working_on || '' };
    }),
    server_time: new Date().toISOString()
  };
}
```

**Step 2: Export the new function**

Find the existing exports at the top of db.js where `getBootPayload` is exported and add `getSlimBootPayload` to the same export list.

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat: add getSlimBootPayload() for token-efficient agent boot"
```

---

### Task 2: Add slim boot route with `?verbose` toggle

**Files:**
- Modify: `server/routes/mycelium.js:573-590`

**Step 1: Update the boot route to support slim mode**

Replace the `GET /boot/:agentId` handler (lines 573-590) with:

```js
router.get('/boot/:agentId', function (req, res) {
  var agentId = checkAgent(req, res);
  if (!agentId) return;
  if (agentId !== req.params.agentId) {
    return res.status(403).json({ error: 'Agent key does not match agent ID' });
  }

  // Verbose mode returns legacy full payload
  if (req.query.verbose === 'true') {
    var fullPayload = getBootPayload(agentId);
    if (!fullPayload) return res.status(404).json({ error: 'Agent not found' });
    fullPayload.savepoint = computeSavepointDiff(agentId);
    fullPayload.sleep_mode = getSleepMode();
    fullPayload.autonomous_mode = isNetworkAutonomous();
    fullPayload.operators_available = getAvailableOperators().length;
    emitEvent('agent_boot', agentId, null, agentId + ' booted (verbose)');
    return res.json(fullPayload);
  }

  // Default: slim boot
  var payload = getSlimBootPayload(agentId);
  if (!payload) return res.status(404).json({ error: 'Agent not found' });
  payload.savepoint = computeSavepointDiff(agentId);
  payload.changes_since_last = formatSavepointSummary(computeSavepointDiff(agentId));
  emitEvent('agent_boot', agentId, null, agentId + ' booted');
  res.json(payload);
});
```

**Step 2: Add `formatSavepointSummary()` helper above the route**

```js
function formatSavepointSummary(diff) {
  if (!diff || !diff.summary) return 'No changes since last session.';
  var parts = [];
  if (diff.new_messages) parts.push(diff.new_messages + ' new message' + (diff.new_messages > 1 ? 's' : ''));
  if (diff.task_changes) parts.push(diff.task_changes + ' task change' + (diff.task_changes > 1 ? 's' : ''));
  if (diff.plan_changes) parts.push(diff.plan_changes + ' plan update' + (diff.plan_changes > 1 ? 's' : ''));
  if (diff.context_changes) parts.push(diff.context_changes + ' context change' + (diff.context_changes > 1 ? 's' : ''));
  return parts.length > 0 ? parts.join(', ') : diff.summary || 'No changes since last session.';
}
```

**Step 3: Import `getSlimBootPayload` from db.js**

Update the import at the top of `mycelium.js` to include `getSlimBootPayload`.

**Step 4: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat: slim boot by default, ?verbose=true for full payload"
```

---

### Task 3: Slim heartbeat response

**Files:**
- Modify: `server/routes/mycelium.js:710-730`

**Step 1: Remove work queue from heartbeat response**

Replace lines 710-730 (the response section at the end of the heartbeat handler) with:

```js
  var pending = countPendingForAgent(agentId);
  var wake = db.prepare(
    "SELECT COUNT(*) as c FROM dv_messages WHERE to_agent = ? AND msg_type IN ('directive', 'request') AND status IN ('sent', 'pending')"
  ).get(agentId).c > 0;
  var response = { ok: true, pending: pending, wake: wake };

  // Auto-dispatch: if agent just came online or is idle with no work, try to assign
  if (!workingOn && (status === 'online' || status === 'idle')) {
    try {
      var dispatched = dispatchWorkToIdleAgents('heartbeat:' + agentId);
      if (dispatched.length > 0) response.auto_dispatched = dispatched;
    } catch (e) { /* non-critical */ }
  }

  res.json(response);
```

This removes the `getBootPayload()` call from heartbeat (which was fetching the entire boot payload just to extract work_queue). Saves ~3-5K tokens of server-side computation per heartbeat too.

**Step 2: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat: slim heartbeat response — pending count + wake flag only"
```

---

### Task 4: Add `getSlimOverview()` to db.js

**Files:**
- Modify: `server/db.js` (after `getOverview()` at line ~2276)

**Step 1: Write `getSlimOverview()` function**

```js
export function getSlimOverview() {
  // Agent statuses — compact
  var agents = db.prepare(
    "SELECT id, status, working_on, last_heartbeat FROM dv_agents ORDER BY created_at"
  ).all().map(function (a) {
    var hb = a.last_heartbeat ? timeSince(a.last_heartbeat) : 'never';
    return { id: a.id, status: a.status, working_on: a.working_on || '', heartbeat: hb };
  });

  // Counts
  var counts = {
    tasks_open: db.prepare("SELECT COUNT(*) as c FROM dv_tasks WHERE status = 'open'").get().c,
    tasks_in_progress: db.prepare("SELECT COUNT(*) as c FROM dv_tasks WHERE status = 'in_progress'").get().c,
    bugs_open: db.prepare("SELECT COUNT(*) as c FROM dv_bugs WHERE status = 'open'").get().c,
    plans_active: db.prepare("SELECT COUNT(*) as c FROM dv_plans WHERE status = 'active'").get().c,
    requests_pending: db.prepare("SELECT COUNT(*) as c FROM dv_messages WHERE msg_type = 'request' AND status IN ('sent', 'pending')").get().c,
    approvals_pending: db.prepare("SELECT COUNT(*) as c FROM dv_approvals WHERE status = 'pending'").get().c,
    drones_online: db.prepare("SELECT COUNT(*) as c FROM dv_agents WHERE agent_type = 'drone' AND status = 'online'").get().c,
    drone_jobs_pending: db.prepare("SELECT COUNT(*) as c FROM dv_drone_jobs WHERE status = 'pending'").get().c
  };

  // Attention array — server-side triage
  var attention = [];

  // Stale requests (>1h unresolved)
  var staleRequests = db.prepare(
    "SELECT id, from_agent, content, created_at FROM dv_messages WHERE msg_type = 'request' AND status IN ('sent', 'pending') AND created_at < datetime('now', '-1 hour') ORDER BY created_at ASC LIMIT 5"
  ).all();
  for (var r of staleRequests) {
    attention.push({ type: 'stale_request', id: r.id, from: r.from_agent, title: r.content.slice(0, 80), action: 'respond', age: timeSince(r.created_at) });
  }

  // Pending approvals
  var pendingApprovals = db.prepare(
    "SELECT id, title, created_at FROM dv_approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
  ).all();
  for (var a of pendingApprovals) {
    attention.push({ type: 'pending_approval', id: a.id, title: a.title, action: 'approve_or_deny', age: timeSince(a.created_at) });
  }

  // Stale tasks (in_progress >6h without heartbeat update)
  var staleTasks = db.prepare(
    "SELECT t.id, t.title, t.assignee, t.updated_at FROM dv_tasks t WHERE t.status = 'in_progress' AND t.updated_at < datetime('now', '-6 hours') ORDER BY t.updated_at ASC LIMIT 5"
  ).all();
  for (var t of staleTasks) {
    attention.push({ type: 'stale_task', id: t.id, assignee: t.assignee, title: t.title, action: 'reassign_or_unblock', age: timeSince(t.updated_at) });
  }

  // Unassigned bugs
  var unassignedBugs = db.prepare(
    "SELECT id, title, severity, created_at FROM dv_bugs WHERE status = 'open' AND (assignee IS NULL OR assignee = '') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at ASC LIMIT 5"
  ).all();
  for (var b of unassignedBugs) {
    attention.push({ type: 'unassigned_bug', id: b.id, title: b.title, severity: b.severity, action: 'assign', age: timeSince(b.created_at) });
  }

  // Recent activity — 5 one-liners
  var recentEvents = db.prepare(
    "SELECT summary, created_at FROM dv_events ORDER BY created_at DESC LIMIT 5"
  ).all();
  var recent_activity = recentEvents.map(function (e) {
    return e.summary + ' (' + timeSince(e.created_at) + ')';
  });

  return { agents: agents, counts: counts, attention: attention, recent_activity: recent_activity };
}

function timeSince(dateStr) {
  var diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return Math.round(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
  return Math.round(diff / 86400000) + 'd ago';
}
```

**Step 2: Export `getSlimOverview`**

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat: add getSlimOverview() with attention array for admin triage"
```

---

### Task 5: Slim overview route with `?verbose` toggle

**Files:**
- Modify: `server/routes/mycelium.js:2294-2298`

**Step 1: Update the overview route**

Replace the admin overview handler with:

```js
router.get('/admin/overview', function (req, res) {
  if (!checkAdmin(req, res)) return;
  if (req.query.verbose === 'true') {
    var who = req._studioUser ? req._studioUser.display_name : 'admin';
    return res.json(getOverview(who));
  }
  res.json(getSlimOverview());
});
```

**Step 2: Import `getSlimOverview` from db.js**

**Step 3: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat: slim admin overview by default, ?verbose=true for full dump"
```

---

### Task 6: Compress MCP boot tool response

**Files:**
- Modify: `mcp/src/tools.js:91-217`

**Step 1: Rewrite the boot tool handler to format slim payload**

The boot tool calls `apiGet('/boot/' + st.agentId)` which now returns slim JSON by default. Rewrite the formatting section to pass through the compact data instead of verbose text formatting:

```js
// In the boot handler (after line 95):
var lines = [];
lines.push('Booted as ' + st.agentId + ' (' + (data.agent.project || '') + ')');

if (data.role_contract) {
  lines.push('');
  lines.push('=== Role Contract ===');
  lines.push(typeof data.role_contract === 'string' ? data.role_contract : JSON.stringify(data.role_contract));
}

if (data.counts) {
  var c = data.counts;
  var parts = [];
  if (c.directives) parts.push(c.directives + ' directive' + (c.directives > 1 ? 's' : ''));
  if (c.requests) parts.push(c.requests + ' request' + (c.requests > 1 ? 's' : ''));
  if (c.messages_unread) parts.push(c.messages_unread + ' unread');
  if (c.tasks_mine) parts.push(c.tasks_mine + ' task' + (c.tasks_mine > 1 ? 's' : ''));
  if (c.bugs_open) parts.push(c.bugs_open + ' bug' + (c.bugs_open > 1 ? 's' : ''));
  if (c.plans_active) parts.push(c.plans_active + ' active plan' + (c.plans_active > 1 ? 's' : ''));
  if (parts.length) lines.push('Pending: ' + parts.join(', '));
}

if (data.work_queue && data.work_queue.length > 0) {
  lines.push('');
  lines.push('=== Work Queue (' + data.work_queue.length + ' items) ===');
  for (var item of data.work_queue) {
    lines.push((item.type || '').toUpperCase() + ' #' + item.id + ': ' + item.title);
  }
}

if (data.other_agents && data.other_agents.length > 0) {
  lines.push('');
  lines.push('=== Agents ===');
  for (var a of data.other_agents) {
    lines.push('[' + (a.status === 'online' ? 'ON' : 'OFF') + '] ' + a.id + (a.working_on ? ': ' + a.working_on : ''));
  }
}

if (data.changes_since_last) {
  lines.push('');
  lines.push('Changes: ' + data.changes_since_last);
}
```

**Step 2: Commit**

```bash
git add src/tools.js
git commit -m "feat: compress MCP boot tool to match slim boot payload"
```

---

### Task 7: Compress MCP heartbeat tool response

**Files:**
- Modify: `mcp/src/tools.js:691-717`

**Step 1: Simplify heartbeat response formatting**

The heartbeat now returns `{ ok, pending, wake }`. Update the handler:

```js
// After the heartbeat POST call:
var line = 'Heartbeat sent. working_on: "' + (workingOn || '') + '"';
if (result.pending > 0) line += ' | ' + result.pending + ' pending';
if (result.wake) line += ' | WAKE: urgent items waiting';
if (result.auto_dispatched && result.auto_dispatched.length > 0) {
  line += '\nAuto-dispatched: ' + result.auto_dispatched.map(function (d) { return d.title; }).join(', ');
}
return text(line);
```

Remove the work queue formatting block that currently lists items from `result.work_queue`.

**Step 2: Commit**

```bash
git add src/tools.js
git commit -m "feat: compress MCP heartbeat tool to match slim response"
```

---

### Task 8: Compress MCP overview tool response

**Files:**
- Modify: `mcp/src/tools.js:224-227` and `formatOverview()` at lines 1531-1650

**Step 1: Rewrite `formatOverview()` for slim payload**

The overview now returns `{ agents, counts, attention, recent_activity }`. Rewrite formatter:

```js
function formatOverview(data) {
  var lines = [];

  // Agents
  if (data.agents && data.agents.length > 0) {
    lines.push('=== Agents ===');
    for (var a of data.agents) {
      lines.push('[' + (a.status === 'online' ? 'ON' : 'OFF') + '] ' + a.id + (a.working_on ? ': ' + a.working_on : '') + ' (' + a.heartbeat + ')');
    }
  }

  // Counts
  if (data.counts) {
    var c = data.counts;
    lines.push('');
    lines.push('=== Counts ===');
    lines.push('Tasks: ' + c.tasks_open + ' open, ' + c.tasks_in_progress + ' in progress');
    lines.push('Bugs: ' + c.bugs_open + ' open | Plans: ' + c.plans_active + ' active');
    lines.push('Requests: ' + c.requests_pending + ' pending | Approvals: ' + c.approvals_pending + ' pending');
    lines.push('Drones: ' + c.drones_online + ' online, ' + c.drone_jobs_pending + ' jobs pending');
  }

  // Attention
  if (data.attention && data.attention.length > 0) {
    lines.push('');
    lines.push('=== Needs Attention ===');
    for (var item of data.attention) {
      lines.push('[' + item.type + '] #' + item.id + ': ' + item.title + ' → ' + item.action + ' (' + item.age + ')');
    }
  }

  // Recent activity
  if (data.recent_activity && data.recent_activity.length > 0) {
    lines.push('');
    lines.push('=== Recent ===');
    for (var act of data.recent_activity) {
      lines.push(act);
    }
  }

  return lines.join('\n');
}
```

**Step 2: Commit**

```bash
git add src/tools.js
git commit -m "feat: compress MCP overview tool for slim admin payload"
```

---

### Task 9: Compress MCP list tool responses

**Files:**
- Modify: `mcp/src/tools.js` — `formatTask()`, `formatBug()`, `formatPlan()`, `formatMessage()` at lines 44-81

**Step 1: Make list formatters compact**

```js
function formatTask(t) {
  return '#' + t.id + ' [' + t.status + '] ' + t.title + (t.assignee ? ' →' + t.assignee : '') + (t.priority !== 'normal' ? ' [' + t.priority + ']' : '');
}

function formatBug(b) {
  return '#' + b.id + ' [' + b.severity + '] ' + b.title + (b.assignee ? ' →' + b.assignee : '') + ' (' + b.status + ')';
}

function formatMessage(m) {
  var tag = m.msg_type === 'request' ? '[REQ] ' : m.msg_type === 'directive' ? '[DIR] ' : '';
  var body = (m.content || '').slice(0, 200);
  if ((m.content || '').length > 200) body += '...';
  return tag + m.from_agent + '→' + (m.to_agent || 'all') + ': ' + body;
}

function formatPlan(p) {
  var steps = (p.steps || []);
  var done = steps.filter(function (s) { return s.status === 'completed'; }).length;
  return '#' + p.id + ' [' + p.status + '] ' + p.title + ' (' + done + '/' + steps.length + ' steps done)';
}
```

Remove per-step listing from `formatPlan`. Agents use `check_plans` for step details.

**Step 2: Commit**

```bash
git add src/tools.js
git commit -m "feat: compress MCP list formatters — compact one-liners"
```

---

### Task 10: Compress runner system prompts

**Files:**
- Modify: `runner/src/session.js:33-174`

**Step 1: Replace verbose tier prompts with compact bullet versions**

Replace `buildMainSystemPrompt()` (lines 33-70):

```js
function buildMainSystemPrompt(agentConfig, claudeMd) {
  return `You are ${agentConfig.id}, Main Claude for this Mycelium instance. Strategic partner to the human operator.

Hierarchy: main > admin > agent > drone. You handle vision and strategy. admin-claude handles daily ops.

Fresh instance? Detect via GET /agents. If only you exist: run onboarding interview (project name, team, first milestone), create projects/agents/plans, brief admin-claude.

Established instance: review network state, unblock stalled plans, send strategic status to operator.

Rules: Work autonomously. Escalate only irreversible dilemmas. Never message drones.

${claudeMd ? '## Context\n' + claudeMd : ''}`;
}
```

Replace `buildAdminSystemPrompt()` (lines 73-103):

```js
function buildAdminSystemPrompt(agentConfig, claudeMd) {
  return `You are ${agentConfig.id}, admin-claude. Operational workhorse — keep every agent busy, every request resolved, every plan moving.

Work loop: boot → directives first → triage unassigned bugs → check idle agents → check stalled work → send handoffs → broadcast status.

Authority: Create/assign tasks, respond to requests, triage bugs, add plan steps. NO deploys, NO external actions, NO money — escalate those.

Anti-hallucination: No action without an API call. IDs must come from the API. Verify after batch assignments. Uncertain = skip.

${claudeMd ? '## Context\n' + claudeMd : ''}`;
}
```

Replace `buildAgentSystemPrompt()` (lines 105-148):

```js
function buildAgentSystemPrompt(agentConfig, claudeMd, networkMode) {
  var mode = networkMode || {};
  var modeLine = mode.autonomous
    ? 'AUTONOMOUS MODE — all operators sleeping.' + (mode.directive ? ' Night directive: ' + mode.directive : '') + ' Full autonomy. Only queue approvals for irreversible high-risk actions.'
    : 'SUPERVISED MODE.' + (mode.availableOperators && mode.availableOperators.length ? ' Online: ' + mode.availableOperators.join(', ') + '.' : '') + ' Escalate risky decisions.';

  return `You are ${agentConfig.id}, autonomous agent on Mycelium. Runner-managed.

Boot: mycelium_boot → directives first → get_work(auto_claim=true) → execute → mark done → next item.

Rules:
- Blocked? File request via mycelium_send_request, move to next item.
- Never message drones.
- Commit frequently. Heartbeat with working_on updates.

${modeLine}

${claudeMd ? '## Context\n' + claudeMd : ''}`;
}
```

**Step 2: Commit**

```bash
git add src/session.js
git commit -m "feat: compress runner system prompts to bullet format"
```

---

### Task 11: Remove work queue from `/work/:agentId` boot call

**Files:**
- Modify: `server/routes/mycelium.js:594-635`

**Step 1: Replace full `getBootPayload()` call with targeted query**

The `/work/:agentId` route currently calls `getBootPayload()` (line 602) just to extract `work_queue`. Replace with a direct call to `buildWorkQueue()`:

```js
router.get('/work/:agentId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var agentId = req.params.agentId;
  if (!req._authIsAdmin && who !== agentId) {
    return res.status(403).json({ error: 'Can only access your own work queue' });
  }
  var agent = getAgent(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Build work queue directly — no full boot payload needed
  var pendingDirectives = db.prepare(
    "SELECT * FROM dv_messages WHERE to_agent = ? AND msg_type = 'directive' AND status IN ('sent', 'pending') ORDER BY created_at ASC"
  ).all(agentId);
  var pendingRequests = listPendingRequests(agentId);
  var myTasks = db.prepare(
    "SELECT * FROM dv_tasks WHERE assignee = ? AND status IN ('open', 'in_progress') ORDER BY priority DESC, updated_at DESC"
  ).all(agentId);
  var openBugs = listBugs({ status: 'open', limit: 20 });
  var myPlans = listPlans({ project_id: agent.project_id, limit: 20 });
  var queue = buildWorkQueue(agentId, agent.project_id, pendingDirectives, pendingRequests, myTasks, openBugs, myPlans);

  // Auto-claim top item
  if (req.query.auto_claim === 'true' && queue.length > 0) {
    var top = queue[0];
    var claimed = null;

    if (top.type === 'directive' || top.type === 'request') {
      claimed = top;
    } else if (top.type === 'plan_step' || top.type === 'plan_step_unassigned') {
      updatePlanStep(top.id, { assignee: agentId, status: 'in_progress' });
      emitEvent('work_claimed', agentId, null, agentId + ' auto-claimed plan step: ' + top.title, { plan_step_id: top.id, plan_id: top.plan_id });
      claimed = top;
      claimed.claimed = true;
    } else if (top.type === 'task') {
      updateTask(top.id, { assignee: agentId, status: 'in_progress' });
      var fullTask = getTask(top.id);
      emitEvent('work_claimed', agentId, top.project_id, agentId + ' auto-claimed task #' + top.id + ': ' + top.title, { task_id: top.id });
      claimed = { ...top, description: fullTask ? fullTask.description : '', claimed: true };
    } else if (top.type === 'bug' || top.type === 'bug_unassigned') {
      updateBug(top.id, { assignee: agentId, status: 'in_progress' });
      emitEvent('work_claimed', agentId, top.project_id, agentId + ' auto-claimed bug #' + top.id + ': ' + top.title, { bug_id: top.id });
      claimed = top;
      claimed.claimed = true;
    }

    return res.json({ ok: true, queue: queue, claimed: claimed });
  }

  res.json({ ok: true, queue: queue });
});
```

Note: This requires `buildWorkQueue` to be exported from db.js, or the direct SQL queries to be accessible. Check if `buildWorkQueue` is already exported — if not, export it.

**Step 2: Commit**

```bash
git add server/routes/mycelium.js server/db.js
git commit -m "feat: work route builds queue directly, no full boot payload"
```

---

### Task 12: Integration test and network notification

**Step 1: Verify server starts**

```bash
cd /path/to/mycelium
node -c server/db.js && node -c server/routes/mycelium.js && echo "Syntax OK"
```

**Step 2: Test slim boot locally (if server can run)**

```bash
curl -s http://localhost:3002/api/mycelium/boot/macbook-claude -H "X-Agent-Key: ..." | node -e "process.stdin.on('data',d=>console.log('Boot tokens ~' + JSON.stringify(JSON.parse(d)).length/4))"
```

**Step 3: Test verbose fallback**

```bash
curl -s "http://localhost:3002/api/mycelium/boot/macbook-claude?verbose=true" -H "X-Agent-Key: ..." | node -e "process.stdin.on('data',d=>console.log('Verbose tokens ~' + JSON.stringify(JSON.parse(d)).length/4))"
```

**Step 4: Push branch and create PR**

```bash
git push -u origin feature/macbook-claude/token-reduction
```

**Step 5: Notify network**

Send message to all agents and PR request to admin-bot.

**Step 6: Commit**

No code commit needed — this is validation.

---

## Execution Order

Tasks 1-5 are server-side (mycelium repo). Tasks 6-9 are MCP server (mcp repo). Task 10 is runner (runner repo). Task 11 ties up the work route. Task 12 validates everything.

Tasks 1+4 can run in parallel (both db.js additions). Tasks 6-9 can run in parallel (all MCP tool changes). Task 10 is independent. Task 11 depends on Task 1 (needs buildWorkQueue export).
