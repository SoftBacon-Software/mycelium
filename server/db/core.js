// =============== MYCELIUM — DB core: connection, schema, shared helpers ===============
// Extracted from server/db.js (Wave 0 of the decomposition). Bottom of the
// module DAG: imports no sibling db/* module. Owns the live `db` binding
// (assigned only inside initDBConnection), the prepared-statement cache, the
// generic UPDATE builder, and the connection/migration/schema/instance-config
// seeding. Entity modules and the barrel import { db, stmt, buildUpdate, getDB }
// from here — ESM live bindings mean the initDBConnection reassignment
// propagates, so callers read bare `db` verbatim. Nobody but initDBConnection
// may assign `db`.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import migrateTableNames from '../migrate-table-names.js';

// Repointed to server/ (the parent of server/db/) so the verbatim __dirname
// references below — path.join(__dirname, 'schema.sql') and the default data
// dir — resolve to the same paths they did when this code lived in server/db.js.
var __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
export var DB_PATH = path.join(DATA_DIR, 'mycelium.db');

export var db;

// Composed initDB lives in the barrel (server/db.js): it calls initDBConnection()
// then the three entity seeds + the log line. Splitting here keeps the module
// graph a strict DAG — core never imports the entity modules that own the seeds.
export function initDBConnection() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Migration: rename game -> project_id columns BEFORE schema (which references project_id)
  migrateGameToProjectId();

  // Migration: rename dv_* tables to clean names BEFORE schema.sql runs
  migrateTableNames(db);

  // Upgrade bridges (idempotent). These run BEFORE schema.exec so that an OLD
  // production DB — whose legacy CREATE TABLE bodies predate these columns — has
  // the columns added before schema.sql's CREATE INDEX statements reference them.
  //
  // On a FRESH DB the target tables don't exist yet, so each guarded ALTER simply
  // no-ops (caught below); schema.sql then creates fully-formed tables because it
  // is now the canonical source of truth and already declares every one of these
  // columns. Net result: fresh init == live schema, and old DBs still upgrade.
  var migrations = [
    ["tasks", "blocked_by", "TEXT NOT NULL DEFAULT '[]'"],
    ["tasks", "blocks", "TEXT NOT NULL DEFAULT '[]'"],
    ["tasks", "needs_approval", "INTEGER NOT NULL DEFAULT 0"],
    ["tasks", "approved_by", "TEXT"],
    ["tasks", "approved_at", "TEXT"],
    ["tasks", "linked_asset_id", "INTEGER"],
    ["tasks", "request_id", "INTEGER"],
    ["tasks", "branch", "TEXT"],
    ["tasks", "pr_url", "TEXT"],
    ["tasks", "repo", "TEXT"],
    ["messages", "msg_type", "TEXT NOT NULL DEFAULT 'message'"],
    ["messages", "status", "TEXT NOT NULL DEFAULT 'sent'"],
    ["messages", "resolved_at", "TEXT"],
    ["messages", "resolved_by", "TEXT"],
    ["agents", "avatar_url", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "role", "TEXT NOT NULL DEFAULT 'agent'"],
    ["agents", "operator_id", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "project", "TEXT NOT NULL DEFAULT ''"],
    ["approvals", "risk_tier", "TEXT NOT NULL DEFAULT 'medium'"],
    ["approvals", "required_approvals", "INTEGER NOT NULL DEFAULT 1"],
    ["approvals", "current_approvals", "INTEGER NOT NULL DEFAULT 0"],
    ["assets", "file_path", "TEXT NOT NULL DEFAULT ''"],
    ["assets", "download_url", "TEXT NOT NULL DEFAULT ''"],
    ["assets", "requested_by", "TEXT NOT NULL DEFAULT ''"],
    ["assets", "assigned_to", "TEXT NOT NULL DEFAULT ''"],
    ["messages", "channel_id", "INTEGER"],
    ["drone_jobs", "workspace_repo", "TEXT"],
    ["drone_jobs", "workspace_branch", "TEXT NOT NULL DEFAULT 'main'"],
    ["assets", "drone_job_id", "INTEGER"],
    ["assets", "prompt", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "llm_backend", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "llm_model", "TEXT NOT NULL DEFAULT ''"],
    ["agents", "agent_type", "TEXT NOT NULL DEFAULT 'agent'"],
    ["projects", "org_id", "TEXT NOT NULL DEFAULT ''"],
    ["projects", "type", "TEXT NOT NULL DEFAULT 'software'"],
    ["projects", "status", "TEXT NOT NULL DEFAULT 'active'"],
    ["operators", "availability", "TEXT NOT NULL DEFAULT 'available'"],
    ["operators", "last_seen_at", "TEXT"],
    ["operators", "away_message", "TEXT NOT NULL DEFAULT ''"],
    // Step #197 — message priority tiers (urgent/normal/fyi)
    ["messages", "priority", "TEXT NOT NULL DEFAULT 'normal'"],
    // Plan #30 — dynamic bug categories per project
    ["projects", "bug_categories", "TEXT NOT NULL DEFAULT '[]'"],
    // Operator presence tracking — who's currently in the dashboard
    ["studio_users", "last_seen", "TEXT"],
    // Drone profiles — link jobs to required profiles
    ["drone_jobs", "profile_id", "TEXT"],
    // Drone system overhaul — smart job routing
    ["agents", "system_diagnostics", "TEXT NOT NULL DEFAULT '{}'"],
    ["drone_jobs", "job_type", "TEXT"],
    // Support ticket tiered routing
    // Plan #62 — multi-runtime agent support
    ["agents", "runtime", "TEXT NOT NULL DEFAULT ''"],
    // Smart Memory — access tracking for context keys
    ["context_keys", "access_count", "INTEGER NOT NULL DEFAULT 0"],
    ["context_keys", "last_accessed_at", "TEXT"],
    // F1 (red-team) — project-scope context keys. Nullable: NULL = shared/global
    // (legacy behavior preserved by checkProjectScope's no-project bypass).
    // Existing rows backfill to NULL (shared); new agent writes stamp their project.
    ["context_keys", "project_id", "TEXT"],
    ["context_history", "project_id", "TEXT"],
    // Squad-loop repo resolution — a project's local checkout root so agents
    // working its tasks resolve relative paths in the right repo (not the
    // agent's CWD). Any squad sets this per project.
    ["projects", "repo_path", "TEXT NOT NULL DEFAULT ''"],
    // Bounded self-heal: how many auto-retries a plan step has spent (retry policy).
    ["plan_steps", "attempt_count", "INTEGER NOT NULL DEFAULT 0"],
  ];

  for (var [table, col, def] of migrations) {
    try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def); } catch (e) { /* already exists */ }
  }

  // Team columns upgrade bridge (idempotent). Same contract as the loop above:
  // on an OLD DB these add team_id / primary_team_id before schema.exec indexes
  // them; on a FRESH DB the tables don't exist yet so each block no-ops. Wrapped
  // in try/catch so a missing table can never crash init.
  try {
    var projectCols = db.pragma('table_info(projects)').map(function(c) { return c.name; });
    if (projectCols.length && !projectCols.includes('team_id')) {
      db.prepare('ALTER TABLE projects ADD COLUMN team_id TEXT').run();
      console.log('[migration] Added team_id to projects');
    }
  } catch (e) { /* table missing on fresh init or column exists — skip */ }
  try {
    var operatorCols = db.pragma('table_info(operators)').map(function(c) { return c.name; });
    if (operatorCols.length && !operatorCols.includes('primary_team_id')) {
      db.prepare('ALTER TABLE operators ADD COLUMN primary_team_id TEXT').run();
      console.log('[migration] Added primary_team_id to operators');
    }
  } catch (e) { /* table missing on fresh init or column exists — skip */ }
  try {
    var agentCols = db.pragma('table_info(agents)').map(function(c) { return c.name; });
    if (agentCols.length && !agentCols.includes('primary_team_id')) {
      db.prepare('ALTER TABLE agents ADD COLUMN primary_team_id TEXT').run();
      console.log('[migration] Added primary_team_id to agents');
    }
  } catch (e) { /* table missing on fresh init or column exists — skip */ }

  // Run platform schema AFTER the upgrade bridges. schema.sql is the canonical
  // source of truth: every CREATE TABLE declares all columns the app needs, and
  // its CREATE INDEX statements can safely reference columns the bridges above
  // just ensured exist on old DBs. CREATE TABLE IF NOT EXISTS is a no-op for any
  // table that already exists (old DB); on a fresh DB it creates everything whole.
  var schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Indexes on columns that historically came from ALTER migrations.
  // schema.sql now also declares these, so these are redundant on a fresh DB but
  // remain here (IF NOT EXISTS) to cover OLD DBs upgraded via the bridges above.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_blocked ON tasks(blocked_by)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_approval ON tasks(needs_approval)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(msg_type)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority)'); } catch (e) {}

  // Bug #43: drop dead columns from messages (is_stale, rerouted_from, rerouted_at)
  // These were added in a prior branch but never used. SQLite 3.35+ supports DROP COLUMN.
  var deadCols = ['is_stale', 'rerouted_from', 'rerouted_at'];
  for (var dc of deadCols) {
    try { db.exec('ALTER TABLE messages DROP COLUMN ' + dc); } catch (e) { /* doesn't exist or older SQLite — skip */ }
  }

  // Seed instance config defaults (if table is empty — fresh instance)
  var cfgCount = db.prepare('SELECT COUNT(*) as c FROM instance_config').get();
  if (cfgCount.c === 0) {
    var riskTiers = JSON.stringify({
      plan_create: 'low', context_change: 'low',
      deploy: 'medium', git_push: 'medium', delete: 'medium',
      external_comm: 'high',
      money_action: 'critical', delete_agent: 'critical', instance_config: 'critical'
    });
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('instance_mode', 'developer', 'system');
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_agent_id', '', 'system');
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('admin_status', 'coordinator', 'system');
    db.prepare("INSERT INTO instance_config (key, value, updated_by) VALUES (?, ?, ?)").run('risk_tiers', riskTiers, 'system');
    console.log('Seeded instance_config with defaults (set admin_agent_id via dashboard or API)');
  }
}

// Migration: rename game -> project_id columns for enterprise-ready schema
function migrateGameToProjectId() {
  var tables = [
    ['agents', 'game', 'project_id'],
    ['tasks', 'game', 'project_id'],
    ['context', 'game', 'project_id'],
    ['assets', 'game', 'project_id'],
    ['events', 'game', 'project_id'],
    ['messages', 'game', 'project_id'],
    ['bugs', 'game', 'project_id'],
    ['plans', 'game', 'project_id'],
    ['approvals', 'project', 'project_id'],
  ];
  for (var [table, oldCol, newCol] of tables) {
    try {
      var info = db.prepare("PRAGMA table_info(" + table + ")").all();
      var hasOld = info.some(function(c) { return c.name === oldCol; });
      var hasNew = info.some(function(c) { return c.name === newCol; });
      if (hasOld && !hasNew) {
        db.prepare("ALTER TABLE " + table + " RENAME COLUMN " + oldCol + " TO " + newCol).run();
        console.log('[migration] Renamed ' + table + '.' + oldCol + ' -> ' + newCol);
      }
    } catch (e) {
      console.error('[migration] Error renaming ' + table + '.' + oldCol + ':', e.message);
    }
  }
  // Rename games table to projects
  try {
    var gamesTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'").all();
    if (gamesTables.length > 0) {
      db.prepare("ALTER TABLE games RENAME TO projects").run();
      console.log('[migration] Renamed table games -> projects');
    }
  } catch (e) {
    console.error('[migration] Error renaming games:', e.message);
  }
}

// Prepared statement cache
var _stmts = {};
export function stmt(key, sql) {
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

// Generic update helper — DRYs the repeated if/push/push pattern across update functions.
// Returns true if a row was updated, false if no allowed fields were present.
// Options:
//   updatedAt: true  — prepend "updated_at = datetime('now')" to SET clause
//   extraSets: []    — additional raw SET fragments (e.g. "version = version + 1")
//   where: string    — override the WHERE column (default 'id')
export function buildUpdate(table, id, fields, allowed, opts) {
  var o = opts || {};
  var sets = [];
  var values = [];
  for (var j = 0; j < allowed.length; j++) {
    var key = allowed[j];
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  if (!sets.length) return false;
  // Append auto-managed columns only when there are real field changes
  if (o.updatedAt) sets.push("updated_at = datetime('now')");
  if (o.extraSets) { for (var i = 0; i < o.extraSets.length; i++) sets.push(o.extraSets[i]); }
  var whereCol = o.where || 'id';
  values.push(id);
  db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE ' + whereCol + ' = ?').run(...values);
  return true;
}

export function getDB() { return db; }
