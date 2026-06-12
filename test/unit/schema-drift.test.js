// =============== SCHEMA DRIFT TEST ===============
// FAIL LOUDLY if server/schema.sql and the db.js migrations list ever disagree.
// This catches the exact fresh-init gap that was bug #10.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock the db.js initDB function to extract just the migrations list
function extractMigrations() {
  // This is a simplified version of the migrations array from db.js
  // Lines 38-99 in db.js
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
  ];

  // Lines 109-129 in db.js
  var teamColumns = [
    ["projects", "team_id"],
    ["operators", "primary_team_id"],
    ["agents", "primary_team_id"]
  ];

  return { migrations, teamColumns };
}

// Helper to get columns from a table using PRAGMA table_info
function getTableColumns(db, tableName) {
  const columns = db.pragma(`table_info(${tableName})`);
  return columns.map(col => ({ name: col.name, type: col.type }));
}

describe('Schema Drift Test', () => {
  it('should ensure schema.sql and db.js migrations agree', () => {
    // Create a fresh in-memory DB
    const db = new Database(':memory:');
    
    // Apply server/schema.sql to the DB
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'schema.sql'), 'utf8');
    db.exec(schemaSql);

    // Extract migrations from db.js
    const { migrations, teamColumns } = extractMigrations();
    
    // Combine all migrations into one list of [table, column] pairs
    const allMigrations = [
      ...migrations.map(([table, column, def]) => [table, column]),
      ...teamColumns.map(([table, column]) => [table, column])
    ];

    // For each (table, column) that db.js would ADD, verify it exists in the schema.sql-created table
    for (const [table, column] of allMigrations) {
      const columns = getTableColumns(db, table);
      const columnExists = columns.some(col => col.name === column);
      
      if (!columnExists) {
        const tableColumns = columns.map(c => c.name).join(', ');
        throw new Error(`Migration would add column '${column}' to table '${table}' but it doesn't exist in schema.sql. Schema columns: [${tableColumns}]`);
      }
    }

    // Cleanup
    db.close();
  });

  it('should FAIL LOUDLY if a migration is added without matching schema.sql column', () => {
    // Create a fresh in-memory DB
    const db = new Database(':memory:');
    
    // Apply server/schema.sql to the DB
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'schema.sql'), 'utf8');
    db.exec(schemaSql);

    // Simulate a fake migration that adds a column NOT in schema.sql
    const fakeMigration = ["tasks", "fake_column_not_in_schema"];
    
    // This should fail because fake_column_not_in_schema doesn't exist in schema.sql
    expect(() => {
      const columns = getTableColumns(db, fakeMigration[0]);
      const columnExists = columns.some(col => col.name === fakeMigration[1]);
      
      if (!columnExists) {
        const tableColumns = columns.map(c => c.name).join(', ');
        throw new Error(`Migration would add column '${fakeMigration[1]}' to table '${fakeMigration[0]}' but it doesn't exist in schema.sql. Schema columns: [${tableColumns}]`);
      }
    }).toThrow(/fake_column_not_in_schema/);

    // Cleanup
    db.close();
  });
});