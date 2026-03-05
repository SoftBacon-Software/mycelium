# Cost Tracker

Tracks AI API token usage and costs per agent, project, and task. Provides budget alerts and spend dashboards.

Records token usage both manually (via API/MCP) and automatically from agent heartbeats. Aggregates costs into daily summaries by agent and project. When daily or weekly spend exceeds a configurable threshold percentage of budget, sends alerts to all operator inboxes.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `budget_daily` | number | 0 | Daily spend limit in USD. 0 = no limit. |
| `budget_weekly` | number | 0 | Weekly spend limit in USD. 0 = no limit. |
| `alert_threshold_pct` | number | 80 | Alert when budget usage exceeds this percentage. |
| `price_input_mtok` | number | 15 | Cost per million input tokens (USD). |
| `price_output_mtok` | number | 75 | Cost per million output tokens (USD). |
| `price_cache_read_mtok` | number | 1.50 | Cost per million cached input tokens (USD). |

## API Endpoints

All routes are prefixed with `/costs`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/costs/record` | Agent/Admin | Record token usage. Requires `input_tokens` and/or `output_tokens`. Optional: `cache_read_tokens`, `task_id`, `session_id`, `project_id`. Auto-calculates cost and checks budgets. |
| GET | `/costs/summary` | Agent/Admin | Current period summary: today's spend, week's spend, budget status, top agents. |
| GET | `/costs/by-agent` | Agent/Admin | Cost breakdown by agent. Optional `?date_from=` and `?date_to=`. |
| GET | `/costs/by-project` | Agent/Admin | Cost breakdown by project. Optional `?date_from=` and `?date_to=`. |
| GET | `/costs/trends` | Agent/Admin | Daily cost trend data. Optional `?days=` (default 14). |
| GET | `/costs/entries` | Admin | Raw cost entries. Filter by `agent_id`, `project_id`, `date_from`, `date_to`. Supports `limit` and `offset`. |
| GET | `/costs/alerts` | Agent/Admin | Recent budget alerts. Optional `?limit=`. |
| GET | `/costs/widgets/spend-today` | Agent/Admin | Widget: today's spend with trend vs yesterday. |
| GET | `/costs/widgets/budget-status` | Agent/Admin | Widget: daily budget usage percentage. |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_cost_report` | Get current period cost summary (today, week, budget status, top agents). |
| `mycelium_cost_record` | Record token usage. Requires `input_tokens` and `output_tokens`. Optional `cache_read_tokens` and `task_id`. |
| `mycelium_cost_by_agent` | Cost breakdown by agent for a date range. |
| `mycelium_cost_by_project` | Cost breakdown by project for a date range. |
| `mycelium_cost_trends` | Daily cost trend data for N days (default 14). |

## Events

**Listens to:**
- `agent_heartbeat` -- auto-records token usage if `tokens` or `token_usage` is present in heartbeat data (fields: `input`, `output`, `cache_read`)

**Emits:**
- (none directly, but triggers operator inbox alerts when budgets are exceeded)

## Database Tables

### `dv_cost_entries`
Individual token usage records.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| agent_id | TEXT | Agent that used the tokens |
| project_id | TEXT | Associated project |
| task_id | INTEGER | Associated task (nullable) |
| input_tokens | INTEGER | Input token count |
| output_tokens | INTEGER | Output token count |
| cache_read_tokens | INTEGER | Cached input token count |
| cost_usd | REAL | Calculated cost in USD |
| session_id | TEXT | Agent session identifier |
| recorded_at | TEXT | Timestamp |

### `dv_cost_daily`
Daily aggregated cost summaries (unique per date + agent + project).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| date | TEXT | Date (YYYY-MM-DD) |
| agent_id | TEXT | Agent ID |
| project_id | TEXT | Project ID |
| total_input | INTEGER | Total input tokens for the day |
| total_output | INTEGER | Total output tokens for the day |
| total_cache | INTEGER | Total cached tokens for the day |
| total_cost | REAL | Total cost in USD |
| entry_count | INTEGER | Number of entries aggregated |

### `dv_cost_alerts`
Budget alert history.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| alert_type | TEXT | `daily_budget` or `weekly_budget` |
| threshold_pct | REAL | Percentage that triggered the alert |
| current_spend | REAL | Spend at time of alert |
| budget_limit | REAL | Budget limit at time of alert |
| triggered_at | TEXT | Timestamp |
