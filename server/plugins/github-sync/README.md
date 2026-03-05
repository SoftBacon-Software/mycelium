# GitHub Sync

Bidirectional sync between GitHub and Mycelium. Receives webhooks for PRs, issues, CI status, and pushes. Links GitHub entities to Mycelium tasks and bugs.

Processes GitHub webhook events with HMAC signature verification. Auto-creates Mycelium bugs from GitHub issues, sends CI failure notifications to operator inbox, and tracks entity links between GitHub PRs/issues and Mycelium tasks/bugs. When a linked task or bug is completed in Mycelium, emits outbound sync events.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `webhook_secret` | secret | (required) | GitHub webhook secret for HMAC-SHA256 signature verification. |
| `default_project` | string | (none) | Mycelium project ID for new items created from GitHub events. |
| `auto_create_bugs` | boolean | true | Auto-create Mycelium bugs from new GitHub issues. |
| `ci_notifications` | boolean | true | Send CI/workflow failure notifications to operator inbox. |

## API Endpoints

All routes are prefixed with `/github`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/github/webhook` | Signature | GitHub webhook receiver. Verifies `X-Hub-Signature-256` header. Handles: `pull_request`, `issues`, `check_suite`, `workflow_run`, `push`, `issue_comment`. |
| GET | `/github/events` | Agent/Admin | List webhook events. Filter by `?event_type=`, `?repo=`, `?processed=`. Supports `limit` and `offset`. |
| GET | `/github/events/:id` | Agent/Admin | Get a single event with full payload. |
| GET | `/github/links` | Agent/Admin | List entity links. Filter by `?repo=`, `?github_type=` (pr/issue/check), `?mycelium_type=` (task/bug). |
| POST | `/github/links` | Agent/Admin | Create a link. Body: `github_repo`, `github_number`, `github_type` (pr/issue/check), `mycelium_type` (task/bug), `mycelium_id`. |
| DELETE | `/github/links/:id` | Agent/Admin | Delete a link. |
| GET | `/github/stats` | Agent/Admin | Sync stats: event counts by type, link counts by type, unprocessed event count. |
| GET | `/github/widgets/pr-status` | Agent/Admin | Widget: open PRs and recent merges derived from webhook events. |
| GET | `/github/widgets/ci-status` | Agent/Admin | Widget: recent CI/workflow runs with latest pass and latest failure. |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_github_events` | List recent GitHub webhook events. Filter by `event_type`, `repo`, `limit`. |
| `mycelium_github_links` | List entity links between GitHub and Mycelium. Filter by `repo` and `github_type`. |
| `mycelium_github_link` | Create a link between a GitHub PR/issue and a Mycelium task/bug. Requires `github_repo`, `github_number`, `github_type`, `mycelium_type`, `mycelium_id`. |
| `mycelium_github_stats` | Sync statistics: event counts, link counts, unprocessed events. |

## Events

**Listens to:**
- `task_completed` -- emits `github_sync_outbound` if the task is linked to a GitHub entity
- `bug_fixed` -- emits `github_sync_outbound` if the bug is linked to a GitHub entity

**Emits:**
- `github_pr_opened` -- new PR opened
- `github_pr_merged` -- PR merged
- `github_pr_closed` -- PR closed without merging
- `github_issue_synced` -- GitHub issue auto-created as Mycelium bug
- `github_issue_labeled` -- issue labels changed
- `github_ci_failed` -- check suite failed
- `github_workflow_failed` -- workflow run failed
- `github_push` -- push event received
- `github_comment` -- new issue/PR comment
- `github_link_created` -- manual entity link created
- `github_sync_outbound` -- Mycelium task/bug completed that is linked to GitHub

## Database Tables

### `dv_github_events`
Log of all received GitHub webhook events.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| event_type | TEXT | GitHub event type (e.g. `push`, `pull_request`, `issues`) |
| action | TEXT | Event action (e.g. `opened`, `closed`, `completed`) |
| repo | TEXT | Repository full name (`owner/repo`) |
| payload | TEXT (JSON) | Full webhook payload |
| processed | INTEGER | 0 = pending, 1 = processed |
| created_at | TEXT | Timestamp |

### `dv_github_links`
Entity links between GitHub and Mycelium.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| github_type | TEXT | `pr`, `issue`, or `check` |
| github_repo | TEXT | Repository full name (`owner/repo`) |
| github_number | INTEGER | PR or issue number |
| mycelium_type | TEXT | `task` or `bug` |
| mycelium_id | INTEGER | Mycelium task or bug ID |
| synced_at | TEXT | Link creation timestamp |
