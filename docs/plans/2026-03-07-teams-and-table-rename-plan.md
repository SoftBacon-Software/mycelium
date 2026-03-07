# Teams System + Table Rename — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all `dv_` table prefixes from the Mycelium codebase (43 tables, ~835 references) and add a first-class Teams system with membership, work scoping, and auto-channel creation.

**Architecture:** Phase 0 is a mechanical find/replace of `dv_` → `` across schema.sql, db.js, routes/mycelium.js, index.js, and all 14 plugin directories, plus a startup migration script that renames tables in the live SQLite DB. Phases 1-4 build the Teams feature on top of the clean schema.

**Tech Stack:** Node.js/Express, SQLite (better-sqlite3), React/TypeScript dashboard (Vite + Tailwind), Mycelium MCP server.

**Risk Mitigation:**
- Each task ends with a commit. If anything breaks, we can revert to the last good commit.
- After Phase 0 (table rename), verify the server starts and boots an agent before continuing.
- Save state to Mycelium context keys after each phase completes.
- Use subagents for each task to keep context fresh.

---

### Task 1: Table Rename — schema.sql

**Files:**
- Modify: `server/schema.sql` (all 672 lines)

**Step 1: Rename all 43 CREATE TABLE statements**

Find/replace `dv_` → `` in all CREATE TABLE lines. Examples:
- `CREATE TABLE IF NOT EXISTS dv_agents` → `CREATE TABLE IF NOT EXISTS agents`
- `CREATE TABLE IF NOT EXISTS dv_organizations` → `CREATE TABLE IF NOT EXISTS organizations`
- etc. for all 43 tables

**Step 2: Rename all indexes**

Find/replace index names. Pattern: `idx_dv_foo` → `idx_foo`. Also fix the few inconsistent indexes that don't have `dv_` prefix:
- `idx_task_comments_task` → `idx_task_comments_task` (already clean)
- `idx_savepoints_agent` → `idx_savepoints_agent` (already clean)
- `idx_drone_profile_assignments_drone` → `idx_drone_profile_assignments_drone` (already clean)
- `idx_instances_org` → `idx_instances_org` (already clean)
- `idx_msg_reads_agent` → `idx_msg_reads_agent` (already clean)
- `idx_team_settings_section` → `idx_team_settings_section` (already clean)

For the rest: `idx_dv_tasks_status` → `idx_tasks_status`, `idx_dv_agents_project` → `idx_agents_project`, etc.

**Step 3: Update FOREIGN KEY references**

Update all REFERENCES clauses:
- Line 157: `REFERENCES dv_plans(id)` → `REFERENCES plans(id)`
- Line 174: `REFERENCES dv_plan_steps(id)` → `REFERENCES plan_steps(id)`
- Line 175: `REFERENCES dv_plans(id)` → `REFERENCES plans(id)`
- Line 250: `REFERENCES dv_concepts(id)` → `REFERENCES concepts(id)`
- Line 259: `REFERENCES dv_tasks(id)` → `REFERENCES tasks(id)`
- Line 386: `REFERENCES dv_studio_users(id)` → `REFERENCES studio_users(id)`
- Line 408: `REFERENCES dv_approvals(id)` → `REFERENCES approvals(id)`
- Line 458: `REFERENCES dv_channels(id)` → `REFERENCES channels(id)`
- Line 487: `REFERENCES dv_channels(id)` → `REFERENCES channels(id)`
- Line 547: `REFERENCES dv_drone_profiles(id)` → `REFERENCES drone_profiles(id)`

**Step 4: Verify — count remaining `dv_` references**

Run: `grep -c "dv_" server/schema.sql`
Expected: 0

**Step 5: Commit**

```bash
git add server/schema.sql
git commit -m "refactor: remove dv_ prefix from all table/index names in schema.sql"
```

---

### Task 2: Table Rename — db.js

**Files:**
- Modify: `server/db.js` (~3400 lines, 414 `dv_` references)

**Step 1: Global find/replace `dv_` → `` in all SQL strings**

This is a mechanical replacement. Every occurrence of `dv_` in db.js is inside a SQL string (db.prepare() or stmt()). Replace all ~414 occurrences.

Pattern: `dv_agents` → `agents`, `dv_tasks` → `tasks`, `dv_messages` → `messages`, etc.

**Critical edge cases to verify after replace:**
- `stmt('dvGetAgent', ...)` — The stmt cache KEY contains `dv` but that's a JS string key, NOT a table name. These should be left alone OR renamed for consistency. Decision: rename them too (e.g., `dvGetAgent` → `getAgent_stmt`). Actually, leave cache keys as-is for now — they're internal identifiers, not table names, and changing them risks cache misses.
- Dynamic SET/WHERE construction (e.g., line patterns like `'UPDATE dv_agents SET ' + sets.join(', ')`) — the `dv_agents` part gets replaced, the dynamic part is column names only (safe).

**Step 2: Verify — count remaining `dv_` references in SQL strings**

Run: `grep -c "dv_" server/db.js`
Expected: Only matches in stmt cache keys (like `dvGetAgent`), comments, or non-SQL contexts. Zero matches in actual SQL table references.

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "refactor: remove dv_ prefix from all SQL queries in db.js"
```

---

### Task 3: Table Rename — routes/mycelium.js + index.js

**Files:**
- Modify: `server/routes/mycelium.js` (54 `dv_` references)
- Modify: `server/index.js` (9 `dv_` references)

**Step 1: Replace all `dv_` in routes/mycelium.js**

54 references across inline db.prepare() calls and db.pragma() calls. Same mechanical replacement.

Key locations:
- Lines 373, 463, 468, 481, 517: agent/org lookups
- Lines 681, 691: `dv_waitlist` CREATE TABLE and INSERT (inline migration)
- Lines 717-823: stats/health queries
- Lines 873: waitlist query
- Lines 928, 932: agent boot queries
- Lines 2260-2316: password reset table operations
- Lines 3207: org delete
- Lines 3887-3953: drone job updates
- Lines 4861-4971: operator/inbox lookups
- Lines 5218-5263: bug/ticket migration ALTERs

**Step 2: Replace all `dv_` in index.js**

9 references:
- Line 39: `dv_agents` in API key lookup
- Lines 68-77: `dv_context_keys` migration (pragma + ALTER TABLE)
- Line 208: `dv_agents` online count
- Line 357: `dv_password_resets` cleanup

**Step 3: Verify**

Run: `grep -c "dv_" server/routes/mycelium.js server/index.js`
Expected: 0 for both files (or only in comments/non-SQL contexts)

**Step 4: Commit**

```bash
git add server/routes/mycelium.js server/index.js
git commit -m "refactor: remove dv_ prefix from routes and index.js"
```

---

### Task 4: Table Rename — All Plugins

**Files:**
- Modify: All `.js`, `.sql`, `.json`, `.md` files in `server/plugins/` (57 files, 324 references)

**Step 1: Replace `dv_` in all plugin files**

14 plugin directories, each with schema.sql, db.js, routes.js, handlers.js, README.md, etc.

Plugin-owned tables to rename:
- billing: `dv_subscriptions` → `subscriptions`
- build-in-public: `dv_bip_drafts` → `bip_drafts`
- cost-tracker: `dv_cost_entries`, `dv_cost_daily`, `dv_cost_alerts` → drop `dv_`
- daily-digest: `dv_digest_reports`, `dv_digest_metrics` → drop `dv_`
- error-monitor: `dv_error_events` → `error_events`
- github-sync: `dv_github_events`, `dv_github_links` → drop `dv_`
- guardrails: `dv_guardrail_rules`, `dv_guardrail_violations` → drop `dv_`
- outreach: `dv_outreach_campaigns`, `dv_outreach_contacts` → drop `dv_`
- social-posting: `dv_social_accounts`, `dv_social_posts` → drop `dv_`
- steam-assets: `dv_steam_assets` → `steam_assets`
- video-pipeline: `dv_video_sessions`, `dv_video_clips` → drop `dv_`
- workflow-automations: `dv_automation_rules`, `dv_automation_log`, `dv_automation_templates` → drop `dv_`
- x-posting: `dv_x_posts` → `x_posts`
- _template: `dv_template_items` → `template_items`

Also update core table references in plugins (e.g., `dv_plugin_config` → `plugin_config` in 11 plugins).

Cross-plugin reference: x-posting/handlers.js references `dv_bip_drafts` → `bip_drafts`.

**Step 2: Verify**

Run: `grep -r "dv_" server/plugins/ --include="*.js" --include="*.sql" --include="*.json" | grep -v node_modules | grep -v README`
Expected: 0 matches (README.md mentions are documentation-only, OK to leave or update)

**Step 3: Commit**

```bash
git add server/plugins/
git commit -m "refactor: remove dv_ prefix from all plugin table names"
```

---

### Task 5: Live DB Migration Script

**Files:**
- Create: `server/migrate-table-names.js`
- Modify: `server/index.js` (add migration call on startup)

**Step 1: Create migration script**

```javascript
// server/migrate-table-names.js
// One-time migration: rename dv_* tables to clean names
// Idempotent — safe to run multiple times

var TABLE_RENAMES = [
  ['dv_agents', 'agents'],
  ['dv_organizations', 'organizations'],
  ['dv_projects', 'projects'],
  ['dv_tasks', 'tasks'],
  ['dv_context', 'context'],
  ['dv_assets', 'assets'],
  ['dv_events', 'events'],
  ['dv_messages', 'messages'],
  ['dv_context_keys', 'context_keys'],
  ['dv_bugs', 'bugs'],
  ['dv_plans', 'plans'],
  ['dv_plan_steps', 'plan_steps'],
  ['dv_plan_step_comments', 'plan_step_comments'],
  ['dv_studio_users', 'studio_users'],
  ['dv_password_resets', 'password_resets'],
  ['dv_webhooks', 'webhooks'],
  ['dv_drone_jobs', 'drone_jobs'],
  ['dv_concepts', 'concepts'],
  ['dv_project_concepts', 'project_concepts'],
  ['dv_task_comments', 'task_comments'],
  ['dv_support_tickets', 'support_tickets'],
  ['dv_plugins', 'plugins'],
  ['dv_plugin_migrations', 'plugin_migrations'],
  ['dv_approvals', 'approvals'],
  ['dv_operators', 'operators'],
  ['dv_instance_config', 'instance_config'],
  ['dv_approval_votes', 'approval_votes'],
  ['dv_webhook_deliveries', 'webhook_deliveries'],
  ['dv_channels', 'channels'],
  ['dv_channel_members', 'channel_members'],
  ['dv_agent_savepoints', 'agent_savepoints'],
  ['dv_channel_reads', 'channel_reads'],
  ['dv_operator_inbox', 'operator_inbox'],
  ['dv_feedback', 'feedback'],
  ['dv_drone_profiles', 'drone_profiles'],
  ['dv_drone_profile_assignments', 'drone_profile_assignments'],
  ['dv_job_templates', 'job_templates'],
  ['dv_plugin_config', 'plugin_config'],
  ['dv_runner_spawns', 'runner_spawns'],
  ['dv_node_profiles', 'node_profiles'],
  ['dv_customer_instances', 'customer_instances'],
  ['dv_message_reads', 'message_reads'],
  ['dv_team_settings', 'team_settings'],
];

// Plugin tables (created by plugin schema.sql files)
var PLUGIN_TABLE_RENAMES = [
  ['dv_subscriptions', 'subscriptions'],
  ['dv_bip_drafts', 'bip_drafts'],
  ['dv_cost_entries', 'cost_entries'],
  ['dv_cost_daily', 'cost_daily'],
  ['dv_cost_alerts', 'cost_alerts'],
  ['dv_digest_reports', 'digest_reports'],
  ['dv_digest_metrics', 'digest_metrics'],
  ['dv_error_events', 'error_events'],
  ['dv_github_events', 'github_events'],
  ['dv_github_links', 'github_links'],
  ['dv_guardrail_rules', 'guardrail_rules'],
  ['dv_guardrail_violations', 'guardrail_violations'],
  ['dv_outreach_campaigns', 'outreach_campaigns'],
  ['dv_outreach_contacts', 'outreach_contacts'],
  ['dv_social_accounts', 'social_accounts'],
  ['dv_social_posts', 'social_posts'],
  ['dv_steam_assets', 'steam_assets'],
  ['dv_video_sessions', 'video_sessions'],
  ['dv_video_clips', 'video_clips'],
  ['dv_automation_rules', 'automation_rules'],
  ['dv_automation_log', 'automation_log'],
  ['dv_automation_templates', 'automation_templates'],
  ['dv_x_posts', 'x_posts'],
  ['dv_template_items', 'template_items'],
];

export default function migrateTableNames(db) {
  var allRenames = TABLE_RENAMES.concat(PLUGIN_TABLE_RENAMES);
  var existingTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(function(r) { return r.name; });

  var renamed = 0;
  for (var [oldName, newName] of allRenames) {
    if (existingTables.includes(oldName) && !existingTables.includes(newName)) {
      db.prepare('ALTER TABLE "' + oldName + '" RENAME TO "' + newName + '"').run();
      renamed++;
      console.log('[migration] Renamed', oldName, '→', newName);
    }
  }
  if (renamed > 0) {
    console.log('[migration] Table rename complete:', renamed, 'tables renamed');
  }
}
```

**Step 2: Wire migration into server startup**

In `server/index.js`, after the database is opened but before schema.sql is run, call the migration:

```javascript
import migrateTableNames from './migrate-table-names.js';
// ... after db is opened ...
migrateTableNames(db);
// ... then run schema.sql (CREATE TABLE IF NOT EXISTS will be no-ops for renamed tables)
```

**Step 3: Verify locally**

Run: `node server/index.js`
Expected: Server starts, migration logs show renamed tables (or "0 tables renamed" if already clean), all endpoints respond.

**Step 4: Commit**

```bash
git add server/migrate-table-names.js server/index.js
git commit -m "feat: add startup migration to rename dv_ tables to clean names"
```

---

### Task 6: Verify Phase 0 — Server Health Check

**Files:** None (verification only)

**Step 1: Start the server locally**

Run: `cd D:/mycelium && node server/index.js`
Expected: Server starts on port 3002, no errors.

**Step 2: Test boot endpoint**

Run: `curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "http://localhost:3002/api/mycelium/admin/overview" | python -m json.tool | head -20`
Expected: JSON response with agents, tasks, etc.

**Step 3: Test agent boot**

Run: `curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" -H "X-Acting-As: dev-claude" "http://localhost:3002/api/mycelium/boot/dev-claude" | python -m json.tool | head -20`
Expected: Boot payload with tasks, messages, etc.

**Step 4: Save Phase 0 state to Mycelium**

Use `mycelium_set_context` to save:
- namespace: `dev-claude`
- key: `table-rename-phase0`
- data: `{"status": "complete", "tables_renamed": 43, "verified": true}`

**Step 5: Push and deploy**

```bash
git push origin master
cd D:/mycelium && railway up
```

Verify production: `curl -s https://mycelium.fyi/api/mycelium/admin/overview -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" | python -m json.tool | head -5`

---

### Task 7: Teams Schema + DB Functions

**Files:**
- Modify: `server/schema.sql` (add teams + team_members tables, add columns to existing tables)
- Modify: `server/db.js` (add team CRUD + membership functions)

**Step 1: Add teams tables to schema.sql**

At end of schema.sql, add:

```sql
-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_type TEXT NOT NULL DEFAULT 'operator',
  role TEXT NOT NULL DEFAULT 'member',
  is_primary INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_primary ON team_members(is_primary) WHERE is_primary = 1;
```

**Step 2: Add columns to existing tables**

Add inline migration in index.js (same pattern as existing migrations):

```javascript
// Team columns migration
var projectCols = db.pragma('table_info(projects)').map(c => c.name);
if (!projectCols.includes('team_id')) {
  db.prepare('ALTER TABLE projects ADD COLUMN team_id TEXT').run();
  console.log('[migration] Added team_id to projects');
}
var operatorCols = db.pragma('table_info(operators)').map(c => c.name);
if (!operatorCols.includes('primary_team_id')) {
  db.prepare('ALTER TABLE operators ADD COLUMN primary_team_id TEXT').run();
  console.log('[migration] Added primary_team_id to operators');
}
var agentCols = db.pragma('table_info(agents)').map(c => c.name);
if (!agentCols.includes('primary_team_id')) {
  db.prepare('ALTER TABLE agents ADD COLUMN primary_team_id TEXT').run();
  console.log('[migration] Added primary_team_id to agents');
}
```

**Step 3: Add DB functions to db.js**

After the team_settings functions, add:

```javascript
// ── Teams ──

function createTeam(id, orgId, name, description, createdBy) {
  db.prepare(
    'INSERT INTO teams (id, org_id, name, description, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, orgId, name, description || '', createdBy || '');
  return getTeam(id);
}

function getTeam(id) {
  var team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (team) {
    team.members = db.prepare(
      'SELECT * FROM team_members WHERE team_id = ? ORDER BY role, joined_at'
    ).all(id);
  }
  return team;
}

function listTeams(orgId) {
  var sql = orgId
    ? 'SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count FROM teams t WHERE t.org_id = ? ORDER BY t.name'
    : 'SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count FROM teams t ORDER BY t.name';
  return orgId ? db.prepare(sql).all(orgId) : db.prepare(sql).all();
}

function updateTeam(id, fields) {
  var sets = [];
  var values = [];
  for (var [k, v] of Object.entries(fields)) {
    if (['name', 'description', 'org_id'].includes(k)) {
      sets.push(k + ' = ?');
      values.push(v);
    }
  }
  if (sets.length === 0) return getTeam(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare('UPDATE teams SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  return getTeam(id);
}

function deleteTeam(id) {
  var memberCount = db.prepare('SELECT COUNT(*) as c FROM team_members WHERE team_id = ?').get(id).c;
  if (memberCount > 0) throw new Error('Team has members — remove them first');
  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
}

function addTeamMember(teamId, userId, userType, role, isPrimary) {
  // If setting as primary, clear any existing primary for this user
  if (isPrimary) {
    db.prepare('UPDATE team_members SET is_primary = 0 WHERE user_id = ? AND is_primary = 1').run(userId);
  }
  db.prepare(
    'INSERT INTO team_members (team_id, user_id, user_type, role, is_primary) VALUES (?, ?, ?, ?, ?)'
  ).run(teamId, userId, userType || 'operator', role || 'member', isPrimary ? 1 : 0);

  // Update denormalized primary_team_id
  if (isPrimary) {
    var table = userType === 'agent' ? 'agents' : 'operators';
    db.prepare('UPDATE ' + table + ' SET primary_team_id = ? WHERE id = ?').run(teamId, userId);
  }
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
}

function updateTeamMember(teamId, userId, fields) {
  var sets = [];
  var values = [];
  if (fields.role) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.is_primary !== undefined) {
    if (fields.is_primary) {
      // Clear existing primary
      db.prepare('UPDATE team_members SET is_primary = 0 WHERE user_id = ? AND is_primary = 1').run(userId);
    }
    sets.push('is_primary = ?');
    values.push(fields.is_primary ? 1 : 0);
  }
  if (sets.length === 0) return;
  values.push(teamId, userId);
  db.prepare('UPDATE team_members SET ' + sets.join(', ') + ' WHERE team_id = ? AND user_id = ?').run(...values);

  // Update denormalized primary_team_id
  if (fields.is_primary) {
    var member = db.prepare('SELECT user_type FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
    if (member) {
      var table = member.user_type === 'agent' ? 'agents' : 'operators';
      db.prepare('UPDATE ' + table + ' SET primary_team_id = ? WHERE id = ?').run(teamId, userId);
    }
  }
}

function removeTeamMember(teamId, userId) {
  var member = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  if (!member) return;
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);

  // Clear denormalized primary_team_id if this was the primary
  if (member.is_primary) {
    var table = member.user_type === 'agent' ? 'agents' : 'operators';
    db.prepare('UPDATE ' + table + ' SET primary_team_id = NULL WHERE id = ?').run(userId);
  }
}

function getTeamsForUser(userId) {
  return db.prepare(
    'SELECT t.*, tm.role, tm.is_primary FROM teams t JOIN team_members tm ON t.id = tm.team_id WHERE tm.user_id = ? ORDER BY tm.is_primary DESC, t.name'
  ).all(userId);
}

function getTeamProjects(teamId) {
  return db.prepare('SELECT * FROM projects WHERE team_id = ?').all(teamId);
}
```

Export all new functions.

**Step 4: Commit**

```bash
git add server/schema.sql server/db.js server/index.js
git commit -m "feat: add teams schema, DB functions, and column migrations"
```

---

### Task 8: Teams API Routes

**Files:**
- Modify: `server/routes/mycelium.js` (add team endpoints)

**Step 1: Import new DB functions**

Add to the destructured imports from db.js:
`createTeam, getTeam, listTeams, updateTeam, deleteTeam, addTeamMember, updateTeamMember, removeTeamMember, getTeamsForUser, getTeamProjects`

**Step 2: Add team CRUD routes**

After the team-settings routes section, add:

```javascript
// ── Teams ──

// GET /teams — list teams
router.get('/teams', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json({ teams: listTeams(req.query.org_id || null) });
});

// GET /teams/:id — team detail with members
router.get('/teams/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var team = getTeam(req.params.id);
  if (!team) return apiError(res, 404, 'Team not found');
  team.projects = getTeamProjects(req.params.id);
  res.json(team);
});

// POST /teams — create team (admin only)
router.post('/teams', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { id, org_id, name, description } = req.body;
  if (!id || !org_id || !name) return apiError(res, 400, 'id, org_id, and name required');
  try {
    var team = createTeam(id, org_id, name, description, req.operatorId || '');
    // Auto-create team channel
    try {
      var channelSlug = 'team-' + id;
      createChannel({ name: '#' + channelSlug, slug: channelSlug, type: 'team', linked_type: 'team', linked_id: id, description: 'Team channel for ' + name, created_by: req.operatorId || '__system__' });
    } catch (chErr) { console.log('[teams] Auto-channel creation failed:', chErr.message); }
    res.json(team);
  } catch (err) {
    return apiError(res, 400, err.message);
  }
});

// PUT /teams/:id — update team (admin only)
router.put('/teams/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var team = updateTeam(req.params.id, req.body);
  if (!team) return apiError(res, 404, 'Team not found');
  res.json(team);
});

// DELETE /teams/:id — delete team (admin only)
router.delete('/teams/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  try {
    deleteTeam(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    return apiError(res, 400, err.message);
  }
});

// POST /teams/:id/members — add member
router.post('/teams/:id/members', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var { user_id, user_type, role, is_primary } = req.body;
  if (!user_id) return apiError(res, 400, 'user_id required');
  try {
    var member = addTeamMember(req.params.id, user_id, user_type, role, is_primary);
    // Auto-join team channel
    try {
      var channelSlug = 'team-' + req.params.id;
      var ch = getChannelBySlug(channelSlug);
      if (ch) addChannelMember(ch.id, user_id, user_type || 'operator', 'member');
    } catch (_) {}
    res.json(member);
  } catch (err) {
    return apiError(res, 400, err.message);
  }
});

// PUT /teams/:id/members/:userId — update member role/primary
router.put('/teams/:id/members/:userId', function (req, res) {
  if (!checkAdmin(req, res)) return;
  updateTeamMember(req.params.id, req.params.userId, req.body);
  res.json({ ok: true });
});

// DELETE /teams/:id/members/:userId — remove member
router.delete('/teams/:id/members/:userId', function (req, res) {
  if (!checkAdmin(req, res)) return;
  removeTeamMember(req.params.id, req.params.userId);
  res.json({ ok: true });
});

// GET /teams/:id/projects — team's projects
router.get('/teams/:id/projects', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json({ projects: getTeamProjects(req.params.id) });
});
```

**Step 3: Add ?team_id filter to existing endpoints**

For GET /tasks, GET /bugs, GET /projects, GET /agents — add optional `team_id` query param that filters results to projects owned by that team.

**Step 4: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat: add teams API routes with CRUD, membership, and auto-channel"
```

---

### Task 9: Boot Payload + Auto-Dispatch Scoping

**Files:**
- Modify: `server/db.js` (update getSlimBootPayload and work-pull functions)

**Step 1: Add team context to boot payload**

In `getSlimBootPayload(agentId)`, after fetching agent data, add:

```javascript
// Team context
var agentTeams = getTeamsForUser(agentId);
var primaryTeam = agentTeams.find(function(t) { return t.is_primary; }) || null;
var guestTeams = agentTeams.filter(function(t) { return !t.is_primary; });
var teamMembers = primaryTeam
  ? db.prepare('SELECT tm.user_id, tm.user_type, tm.role FROM team_members tm WHERE tm.team_id = ?').all(primaryTeam.id)
  : [];
```

Add to the return object: `team: primaryTeam, guest_teams: guestTeams, team_members: teamMembers`

**Step 2: Scope auto-dispatch to team projects**

In the work-pull / auto-dispatch logic, when querying for unassigned tasks and plan steps, add a WHERE clause:

```javascript
// Get agent's team project IDs
var agentTeamIds = getTeamsForUser(agentId).map(function(t) { return t.id; });
var teamProjectIds = agentTeamIds.length > 0
  ? db.prepare('SELECT id FROM projects WHERE team_id IN (' + agentTeamIds.map(() => '?').join(',') + ')').all(...agentTeamIds).map(function(p) { return p.id; })
  : [];

// Filter tasks to team projects (or all if no team)
if (teamProjectIds.length > 0) {
  // Add: AND project_id IN (?, ?, ...)
}
```

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat: add team context to boot payload and scope auto-dispatch"
```

---

### Task 10: Dashboard — Types, API, Team Switcher

**Files:**
- Modify: `studio-react/src/api/types.ts` (add Team types)
- Modify: `studio-react/src/api/endpoints.ts` (add team API functions)
- Modify: `studio-react/src/stores/dashboardStore.ts` (add selectedTeamId)
- Modify: `studio-react/src/layouts/SideNav.tsx` (add team switcher)
- Create: `studio-react/src/pages/TeamsPage.tsx` (teams management)
- Modify: `studio-react/src/App.tsx` (add teams route)

**Step 1: Add types**

In types.ts:
```typescript
export interface Team {
  id: string;
  org_id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  members?: TeamMember[];
  projects?: Project[];
  member_count?: number;
}

export interface TeamMember {
  id: number;
  team_id: string;
  user_id: string;
  user_type: 'operator' | 'agent';
  role: 'lead' | 'member' | 'guest';
  is_primary: number;
  joined_at: string;
}
```

**Step 2: Add API functions**

In endpoints.ts:
```typescript
export async function fetchTeams(orgId?: string): Promise<Team[]> {
  var params = orgId ? '?org_id=' + orgId : '';
  var res = await api('/teams' + params);
  return res.teams;
}
export async function fetchTeam(id: string): Promise<Team> { return api('/teams/' + id); }
export async function createTeam(data: Partial<Team>): Promise<Team> { return api('/teams', { method: 'POST', body: JSON.stringify(data) }); }
export async function updateTeam(id: string, data: Partial<Team>): Promise<Team> { return api('/teams/' + id, { method: 'PUT', body: JSON.stringify(data) }); }
export async function deleteTeam(id: string): Promise<void> { return api('/teams/' + id, { method: 'DELETE' }); }
export async function addTeamMember(teamId: string, data: { user_id: string; user_type: string; role: string; is_primary?: boolean }): Promise<TeamMember> { return api('/teams/' + teamId + '/members', { method: 'POST', body: JSON.stringify(data) }); }
export async function updateTeamMember(teamId: string, userId: string, data: { role?: string; is_primary?: boolean }): Promise<void> { return api('/teams/' + teamId + '/members/' + userId, { method: 'PUT', body: JSON.stringify(data) }); }
export async function removeTeamMember(teamId: string, userId: string): Promise<void> { return api('/teams/' + teamId + '/members/' + userId, { method: 'DELETE' }); }
```

**Step 3: Add selectedTeamId to dashboard store**

**Step 4: Build TeamsPage.tsx**

Team management page: list teams as cards, click to expand members/projects. Add/remove members. Create new team form.

**Step 5: Add team switcher to SideNav**

Small dropdown at top of nav showing current team filter. Options: "All Teams" + each team the user belongs to.

**Step 6: Wire into App.tsx**

Add route and nav entry.

**Step 7: Build and verify**

Run: `cd D:/mycelium/studio-react && npm run build`
Expected: Clean build, no TypeScript errors.

**Step 8: Commit**

```bash
git add studio-react/
git commit -m "feat: add teams dashboard page, team switcher, and API integration"
```

---

### Task 11: MCP Tools + Seed Dioverse Teams

**Files:**
- Modify: `D:/mycelium-mcp/src/tools.js` (add team MCP tools)
- No file changes for seeding (API calls only)

**Step 1: Add MCP tools**

Add to tools.js:
- `mycelium_list_teams` — GET /teams
- `mycelium_get_team` — GET /teams/:id
- `mycelium_create_team` — POST /teams
- `mycelium_add_team_member` — POST /teams/:id/members
- `mycelium_remove_team_member` — DELETE /teams/:id/members/:userId

**Step 2: Seed Dioverse teams via API**

Using curl or MCP tools, create:

```
Team: platform (org: softbacon)
  Members: Greatness (lead, primary), dev-claude (agent, primary), macbook-claude (agent, primary), admin-bot (agent, primary), greatness-claude (agent, primary)
  Projects: mycelium

Team: willing-sacrifice (org: softbacon)
  Members: Greatness (lead, primary for WS work)
  Projects: willing-sacrifice, willing-sacrifice-2

Team: king-city (org: softbacon)
  Members: Hijack (lead, primary), hijack-claude (agent, primary)
  Projects: dioverse (KC lives here)

Team: operations (org: softbacon)
  Members: Unakron (lead, primary), Greatness (member, guest)
  Projects: (none — drones/infra)
```

**Step 3: Commit MCP changes**

```bash
cd D:/mycelium-mcp && git add src/tools.js && git commit -m "feat: add team MCP tools"
```

**Step 4: Save final state**

Use `mycelium_set_context`:
- namespace: `dev-claude`
- key: `teams-feature-complete`
- data: `{"status": "complete", "tables_renamed": 43, "teams_created": 4, "verified": true}`

---

### Task 12: Deploy + Verify Production

**Step 1: Push to GitHub**

```bash
cd D:/mycelium && git push origin master
```

**Step 2: Deploy to Railway**

```bash
cd D:/mycelium && railway up
```

**Step 3: Verify migration ran**

Check Railway logs for `[migration] Renamed dv_agents → agents` etc.

**Step 4: Verify API**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "https://mycelium.fyi/api/mycelium/teams" | python -m json.tool
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" "https://mycelium.fyi/api/mycelium/admin/overview" | python -m json.tool | head -20
```

**Step 5: Notify the network**

Broadcast to all agents: "Table rename complete. All dv_ prefixes removed. Teams system live. Check your boot payload for team context."
