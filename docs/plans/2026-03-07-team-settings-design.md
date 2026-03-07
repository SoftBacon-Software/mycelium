# Team Settings — "Team DNA"

**Date**: 2026-03-07
**Status**: Approved
**Author**: dev-claude + Greatness

## Problem

Mycelium has the building blocks for team configuration scattered across 4 systems:
- **Node Profiles** — rules, md_checkpoints, blocklist (raw JSON, no UI)
- **Concepts** — shared knowledge (characters, styles, rulesets)
- **Context Keys** — arbitrary KV storage
- **Calibration** — drift detection against profiles

No unified UI exists for a customer admin to configure their team's DNA. Everything requires raw JSON or API calls.

## Solution

A **Team Settings** page (`/studio/team-settings`) that lets customer admins configure coding standards, deployment workflow, brand guidelines, agent guardrails, and team rules through a clean UI. Settings sync to node profiles so agents automatically inherit the team's DNA on boot.

## Target User

Customer admins managing their Mycelium instance. This is a product feature, not internal tooling.

## Data Layer

### New table: `dv_team_settings`

```sql
CREATE TABLE IF NOT EXISTS dv_team_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,          -- JSON
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(section, key)
);
```

Sections: `coding_standards`, `deploy_workflow`, `brand`, `guardrails`, `team_rules`

### Hybrid approach

- **`dv_team_settings`** stores human-facing configuration (coding standards, brand voice, deploy workflow)
- **Node profiles** (`dv_node_profiles`) store agent-facing calibration (rules, tool_whitelist, blocklist)
- **Sync function** `syncTeamSettingsToProfile()` pushes relevant team settings into the `customer-agent` profile on every write

## API Endpoints

```
GET    /team-settings                    → all settings grouped by section
GET    /team-settings/:section           → one section
PUT    /team-settings/:section/:key      → upsert (triggers profile sync)
DELETE /team-settings/:section/:key      → remove (triggers profile sync)
POST   /team-settings/sync              → force re-sync to profiles
```

Auth: admin or operator with `admin` role.

## Sections

### 1. Coding Standards
- **languages**: tag chips (TypeScript, Python, GDScript, etc.)
- **linter**: text + config (ESLint, Ruff, etc.)
- **formatter**: text (Prettier, Black, etc.)
- **test_framework**: text (Jest, pytest, etc.)
- **style_notes**: free text ("use functional components", "no classes")

Syncs to: `md_checkpoints` (language/tool names), custom `coding_standards` rule in profile

### 2. Deployment Workflow
- **stages**: ordered list (dev → staging → QA → prod)
- **pr_requirements**: checkboxes (require reviews, require CI pass)
- **deploy_method**: dropdown (Railway, Vercel, manual)
- **environments**: key-value pairs per stage

Syncs to: custom `deploy_workflow` rule in profile

### 3. Brand & Design
- **voice**: free text (brand voice description)
- **design_system**: URL or description
- **colors**: key-value (primary, secondary, accent, bg)
- **typography**: font names
- **assets**: references/URLs

Syncs to: auto-creates `brand` type concept, `md_checkpoints` for key terms

### 4. Agent Guardrails
- **tool_whitelist**: checkbox list from available MCP tools
- **repo_list**: GitHub repo list
- **md_checkpoints**: required CLAUDE.md anchors
- **md_blocklist**: forbidden terms
- **custom_rules**: severity + description pairs

Syncs to: directly maps to profile `tool_whitelist`, `repo_list`, `md_checkpoints`, `md_blocklist`, `rules`

### 5. Team Rules
- **communication_style**: dropdown (formal/casual/technical)
- **timezone**: text
- **working_hours**: text
- **approval_requirements**: which actions need human sign-off
- **custom**: free-form key-value pairs

Syncs to: custom `team_rules` rule in profile, approval gate configuration

## UI Design

- Route: `/studio/team-settings`
- Tab bar across 5 sections
- Each section is a form with labeled fields
- Save button per section with toast notification
- SideNav: new item in **Manage** section, `Settings2` Lucide icon

## Profile Sync Flow

```
Customer edits settings → saves to dv_team_settings
  → syncTeamSettingsToProfile()
    → reads all team settings for section
    → updates customer-agent node profile fields
  → next agent boot: resolveProfileChain() merges platform + customer
  → agent gets team DNA in calibration block
  → drift detection catches non-compliance
```

## Files to Modify

### Server
- `server/schema.sql` — add `dv_team_settings` table
- `server/db.js` — CRUD functions + `syncTeamSettingsToProfile()`
- `server/routes/mycelium.js` — 5 new endpoints

### Dashboard
- `studio-react/src/pages/TeamSettingsPage.tsx` — new page (5 tab sections)
- `studio-react/src/api/types.ts` — `TeamSetting` interface
- `studio-react/src/api/endpoints.ts` — fetch/update functions
- `studio-react/src/layouts/SideNav.tsx` — add nav item
- `studio-react/src/App.tsx` — lazy import + route

## Verification

1. Create team settings via UI → verify stored in `dv_team_settings`
2. Check `customer-agent` profile updated with synced values
3. Boot an agent → verify calibration block includes team settings
4. Edit guardrails → verify `md_checkpoints` / `md_blocklist` propagate
5. Agent with non-compliant CLAUDE.md → drift detection triggers
