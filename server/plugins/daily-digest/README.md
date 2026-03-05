# Daily Digest

Auto-generates daily and weekly summaries of swarm activity and delivers them to operator inbox and optional Slack.

Gathers completed tasks, fixed bugs, advanced plan steps, message counts, and per-agent breakdowns for a time period. Stores reports and records time-series metrics for trend tracking. Supports manual generation and scheduled delivery.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schedule` | select | daily | How often to generate digests (`daily` or `weekly`). |
| `timezone` | string | UTC | IANA timezone for digest generation (e.g. `America/Chicago`). |
| `digest_hour` | number | 8 | Hour of day (0-23) to generate the digest. |
| `slack_webhook` | secret | (none) | Optional Slack incoming webhook URL for digest delivery. |
| `include_agent_stats` | boolean | true | Include per-agent task/bug/step breakdown in digest. |

## API Endpoints

All routes are prefixed with `/digest`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/digest/reports` | Agent/Admin | List past digest reports. Filter by `?type=` (daily/weekly). Supports `limit` and `offset`. |
| GET | `/digest/reports/:id` | Agent/Admin | Get a single digest report with full content. |
| POST | `/digest/generate` | Admin | Manually generate a digest. Body: `{ "type": "daily" }` or `"weekly"`. Creates report, records metrics, delivers to inbox and Slack. |
| GET | `/digest/preview` | Admin | Preview what the next digest would contain without saving. Query: `?type=daily` or `weekly`. |
| POST | `/digest/deliver/:id` | Admin | Re-deliver an existing report to inbox and Slack. |
| GET | `/digest/trends` | Agent/Admin | Trend data for a metric. Query: `?metric=` (tasks_completed, bugs_fixed, plan_steps_completed, messages_sent) and `?periods=` (default 14). |
| GET | `/digest/widgets/velocity` | Agent/Admin | Widget: today's task and bug completion counts. |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_digest_preview` | Preview current period's digest without saving. Optional `type` (daily/weekly). |
| `mycelium_digest_generate` | Generate and deliver a digest now. Requires `type` (daily/weekly). |
| `mycelium_digest_trends` | Get trend data for a metric over recent periods. Requires `metric`, optional `periods`. |
| `mycelium_digest_reports` | List past digest reports. Optional `type` filter and `limit`. |

## Events

**Listens to:**
- `task_completed` -- increments `tasks_completed` metric for the agent and total
- `bug_fixed` -- increments `bugs_fixed` metric for the agent and total
- `plan_step_completed` -- increments `plan_steps_completed` metric for the agent and total

**Emits:**
- `digest_generated` -- when a digest report is created

## Database Tables

### `dv_digest_reports`
Stored digest reports.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| period_start | TEXT | ISO date start of the reporting period |
| period_end | TEXT | ISO date end of the reporting period |
| digest_type | TEXT | `daily` or `weekly` |
| content | TEXT (JSON) | Full digest data (tasks, bugs, steps, agent stats) |
| summary | TEXT | Human-readable summary text |
| delivered_to | TEXT (JSON) | Array of delivery targets (e.g. `["inbox", "slack"]`) |
| created_at | TEXT | Creation timestamp |

### `dv_digest_metrics`
Time-series metric snapshots for trend tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| metric_type | TEXT | Metric name (e.g. `tasks_completed`, `bugs_fixed`) |
| metric_key | TEXT | Agent ID or `total` |
| value | REAL | Metric value |
| period | TEXT | Date string for the period |
| recorded_at | TEXT | Timestamp |
