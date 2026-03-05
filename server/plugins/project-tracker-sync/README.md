# Project Tracker Sync

Bidirectional task sync with Linear and Jira.

Syncs Mycelium tasks with external project trackers. Inbound webhooks create/update Mycelium tasks from external issues. Outbound hooks push new and updated tasks to the external tracker. Includes configurable status mapping and a sync log for audit.

## Configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `provider` | select | Yes | External tracker: `linear` or `jira` |
| `api_key` | secret | Yes | Linear API key or Jira API token |
| `jira_domain` | string | No | Jira domain (e.g. `myteam.atlassian.net`). Jira only. |
| `jira_email` | string | No | Email for Jira API auth. Jira only. |
| `sync_direction` | select | No | `bidirectional` (default), `outbound`, or `inbound` |
| `default_project` | string | No | Mycelium project ID for inbound items |
| `external_project` | string | No | Linear team ID or Jira project key for outbound creates |

## API Endpoints

All routes are under `/api/mycelium/tracker`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/webhook` | none | Inbound webhook from Linear or Jira. Handles issue create/update/remove. |
| GET | `/links` | agent/admin | List sync links. Filter: `?provider=`, `?sync_status=`, `?limit=`, `?offset=` |
| POST | `/links` | admin | Manually link a Mycelium task to an external issue. Body: `external_id`, `external_key`, `mycelium_id`, `mycelium_type` |
| DELETE | `/links/:id` | admin | Remove a sync link |
| POST | `/sync/:id` | admin | Force re-sync a linked item (fetches current state from external tracker) |
| GET | `/status-map` | agent/admin | Get status mappings. Filter: `?provider=` |
| POST | `/status-map` | admin | Create status mapping. Body: `provider`, `mycelium_status`, `external_status` |
| DELETE | `/status-map/:id` | admin | Remove a status mapping |
| GET | `/log` | agent/admin | Sync log. Filter: `?provider=`, `?direction=`, `?status=`, `?limit=` |
| GET | `/stats` | agent/admin | Sync statistics (link counts, last sync time, conflict count) |
| GET | `/widgets/sync-status` | agent/admin | Dashboard widget: linked items, last sync, conflicts |

## Default Status Mappings

**Linear:** open=Todo, in_progress=In Progress, review=In Review, done=Done, cancelled=Canceled

**Jira:** open=To Do, in_progress=In Progress, review=In Review, done=Done

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_tracker_links` | List sync links between Mycelium tasks and external issues |
| `mycelium_tracker_link` | Manually link a Mycelium task to an external issue |
| `mycelium_tracker_sync` | Force re-sync a linked item from the external tracker |
| `mycelium_tracker_status` | Get sync status and stats |

## Events

**Listens to:**
- `task_created` -- Creates corresponding issue in external tracker (outbound)
- `task_updated` -- Syncs status changes to external tracker (outbound)

**Emits:**
- `task_created` -- When inbound webhook creates a Mycelium task
- `tracker_link_created` -- When a manual link is created

## Database Tables

**`dv_tracker_links`** -- Sync links (provider, external_id, external_key, mycelium_type, mycelium_id, sync_status, last_synced, conflict_data).

**`dv_tracker_sync_log`** -- Audit log (provider, direction, action, mycelium_id, external_id, status, detail).

**`dv_tracker_status_map`** -- Status mappings between Mycelium and external tracker statuses.
