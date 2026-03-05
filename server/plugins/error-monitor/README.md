# Error Monitor

Receives error alerts from Sentry, Bugsnag, and Datadog via webhooks. Auto-files Mycelium bugs with stack traces and deduplication.

Provides webhook endpoints for each supported error tracking service. Errors are deduplicated by a provider-specific key and occurrence counts are tracked. When an error meets the auto-file threshold, a Mycelium bug is created automatically with the stack trace, linked to the error, and routed to operator inbox. Errors are auto-resolved when their linked bugs are fixed.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | select | (required) | Error tracking service: `sentry`, `bugsnag`, or `datadog`. |
| `webhook_secret` | secret | (none) | Secret for verifying webhook signatures. |
| `auto_assign` | boolean | false | Auto-assign bugs to the most recently active agent. |
| `auto_file_threshold` | number | 1 | Minimum error occurrences before auto-filing a bug. 0 = file immediately. |
| `default_project` | string | (none) | Mycelium project ID for new bugs. |
| `default_severity` | select | normal | Default bug severity: `low`, `normal`, `high`, `critical`. |

## API Endpoints

All routes are prefixed with `/errors`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/errors/webhook/sentry` | None | Sentry webhook receiver. Extracts issue ID, title, and metadata. |
| POST | `/errors/webhook/bugsnag` | None | Bugsnag webhook receiver. Extracts exception class, message, and stack trace. |
| POST | `/errors/webhook/datadog` | None | Datadog webhook receiver. Extracts alert ID, title, and text. |
| GET | `/errors/events` | Agent/Admin | List error events. Filter by `?provider=` and `?status=` (open/muted/resolved). Supports `limit` and `offset`. |
| GET | `/errors/events/:id` | Agent/Admin | Get a single error event with full payload. |
| PUT | `/errors/events/:id` | Agent/Admin | Update error: set `status` (open/muted/resolved) or link `bug_id`. |
| POST | `/errors/events/:id/file-bug` | Admin | Manually file a Mycelium bug from an error event. |
| GET | `/errors/stats` | Agent/Admin | Error counts by provider, by status, last 24h count, and top errors by occurrences. |
| GET | `/errors/widgets/error-count` | Agent/Admin | Widget: error count in last 24 hours. |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_errors_recent` | List recent errors. Filter by `provider`, `status` (default: open), and `limit`. |
| `mycelium_errors_stats` | Error statistics: counts by provider, by status, last 24h, top errors. |
| `mycelium_errors_mute` | Mute a noisy error by `error_id`. Muted errors still track occurrences but won't auto-file bugs. |
| `mycelium_errors_file_bug` | Manually file a Mycelium bug from an error by `error_id`. |

## Events

**Listens to:**
- `bug_fixed` -- auto-resolves any open error events linked to the fixed bug

**Emits:**
- `error_received` -- when a webhook is processed (includes `is_new` and `occurrences`)
- `error_bug_filed` -- when a bug is auto-filed from an error

## Database Tables

### `dv_error_events`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| provider | TEXT | Error service: `sentry`, `bugsnag`, or `datadog` |
| error_key | TEXT | Deduplication key (e.g. `sentry:12345`) |
| title | TEXT | Error title / exception class |
| message | TEXT | Error message |
| stack_trace | TEXT | Stack trace (if available) |
| url | TEXT | Link to error in the provider's UI |
| occurrences | INTEGER | Number of times this error has been seen |
| first_seen | TEXT | First occurrence timestamp |
| last_seen | TEXT | Most recent occurrence timestamp |
| payload | TEXT (JSON) | Full webhook payload |
| bug_id | INTEGER | Linked Mycelium bug ID (nullable) |
| status | TEXT | `open`, `muted`, or `resolved` |
| created_at | TEXT | Creation timestamp |
| updated_at | TEXT | Last update timestamp |
