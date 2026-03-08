# Teams System + Table Rename — Design Doc

**Date**: 2026-03-07
**Author**: dev-claude + Greatness
**Status**: Approved

## Goal

Add a first-class Teams layer to Mycelium (teams inside orgs, with membership, work scoping, and visibility boundaries) AND remove the legacy `dv_` prefix from all 43 database tables to make the project clean and professional.

## Key Decisions

1. **Approach**: Join table model — `teams` + `team_members` tables. Projects get `team_id`. Operators/agents get `primary_team_id`.
2. **Membership**: One primary team per entity, can guest on others. Roles: `lead`, `member`, `guest`.
3. **Hierarchy**: Org → Teams → Projects → Tasks/Bugs/Plans/etc. Orgs remain the billing/instance boundary. Teams subdivide work ownership.
4. **Visibility**: Teams organize ownership AND create soft visibility boundaries. Default view is team-scoped, admins see everything.
5. **Plugins**: Stay global for v1. Per-team plugin config is on the enterprise roadmap ($120k install lever layer).
6. **Table rename**: All `dv_*` tables renamed to clean names. Mechanical find/replace + live DB migration.

## Data Model

### New Tables

**`teams`**

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | Slug, e.g. `platform` |
| org_id | TEXT | FK to organizations |
| name | TEXT | "Platform Team" |
| description | TEXT | |
| created_by | TEXT | Operator ID |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

**`team_members`**

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| team_id | TEXT | FK to teams |
| user_id | TEXT | Operator or Agent ID |
| user_type | TEXT | `operator` or `agent` |
| role | TEXT | `lead`, `member`, `guest` |
| is_primary | INTEGER | 1 = home team |
| joined_at | TIMESTAMP | |
| UNIQUE(team_id, user_id) | | |

### Existing Table Changes

- `projects` gets `team_id TEXT`
- `operators` gets `primary_team_id TEXT`
- `agents` gets `primary_team_id TEXT`

### Table Rename (43 tables)

All `dv_*` prefixes removed. Examples:
- `dv_agents` → `agents`
- `dv_organizations` → `organizations`
- `dv_projects` → `projects`
- `dv_team_settings` → `team_settings`
- Plugin tables: `dv_billing_subscriptions` → `billing_subscriptions`

All indexes renamed: `idx_dv_x` → `idx_x`.

## API Endpoints

### Team CRUD (admin only)
- `GET /teams` — list teams (`?org_id=` filter)
- `GET /teams/:id` — team detail with members
- `POST /teams` — create team
- `PUT /teams/:id` — update team
- `DELETE /teams/:id` — delete team (must be empty)

### Team Membership
- `POST /teams/:id/members` — add member
- `PUT /teams/:id/members/:userId` — update role/primary
- `DELETE /teams/:id/members/:userId` — remove member

### Team-Scoped Queries
Existing endpoints get `?team_id=` filter:
- `GET /tasks?team_id=`, `GET /bugs?team_id=`, `GET /agents?team_id=`, `GET /projects?team_id=`

## System Integration

### Auto-Dispatch
When an agent goes idle, work assignment queries only tasks/plan steps from projects where `team_id` matches the agent's primary or guest teams. No cross-team surprise assignments.

### Boot Payload
Agent boot (`GET /boot/:agentId`) adds:
- `team`: primary team object
- `guest_teams`: array of guest team objects
- `team_members`: operators and agents on same primary team
- All data (tasks, bugs, plans, messages) filtered to agent's team projects. Admins still get everything.

### Auto-Channel Creation
Creating a team auto-creates a channel: `type='team'`, `linked_type='team'`, `linked_id=team.id`, name `#team-{slug}`. All members auto-join. Deleting a team archives the channel.

### MCP Tools
- `mycelium_list_teams`, `mycelium_get_team`, `mycelium_create_team`
- `mycelium_add_team_member`, `mycelium_remove_team_member`

### Dashboard
- Team switcher in sidebar/header
- Teams management page under Manage section
- Existing pages filter by selected team
- Team badge on operator/agent cards

### Plans
Plan steps assigned to cross-team agents still work. Guest access is the formal mechanism for cross-team collaboration.

### Overview Endpoint
`GET /admin/overview` stays unfiltered. Dashboard store applies `selectedTeamId` client-side.

### Team Settings
Current `team_settings` table stays global (instance DNA). Per-team overrides on the enterprise roadmap.

## Migration Strategy

Live DB migration via startup script: `ALTER TABLE dv_x RENAME TO x` for all 43 tables. SQLite supports this natively. Idempotent (checks if table exists before renaming).

## Enterprise Roadmap (future)

- Per-team plugin config
- Per-team webhooks
- Per-team approval chains
- Per-team drone quotas
- Per-team settings overrides
