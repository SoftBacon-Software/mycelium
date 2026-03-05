# Workflow Automations

Event-driven automation rules -- when X happens, do Y.

Create rules that trigger on platform events and execute actions like creating tasks, sending messages, filing bugs, assigning agents, firing webhooks, or sending inbox notifications. Supports conditions, rate limiting, dry-run mode, and built-in templates.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_actions_per_minute` | number | `30` | Rate limit for automation actions per minute. 0 = no limit. |
| `dry_run` | boolean | `false` | Log triggers without executing actions |

## API Endpoints

All routes are under `/api/mycelium/automations`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/rules` | agent/admin | List rules. Filter: `?enabled=`, `?trigger_event=`, `?project_id=` |
| POST | `/rules` | admin | Create rule. Body: `name`, `trigger_event`, `conditions`, `actions`, `project_id` |
| GET | `/rules/:id` | agent/admin | Get a single rule |
| PUT | `/rules/:id` | admin | Update a rule |
| DELETE | `/rules/:id` | admin | Delete a rule |
| POST | `/rules/:id/test` | admin | Test rule against sample event data without executing. Body: `event_data` |
| POST | `/rules/:id/trigger` | admin | Manually trigger a rule. Body: `event_data` |
| GET | `/log` | agent/admin | Execution log. Filter: `?rule_id=`, `?status=`, `?limit=` |
| GET | `/stats` | agent/admin | Execution statistics (by status, by rule, last 24h) |
| GET | `/templates` | agent/admin | List built-in templates. Filter: `?category=` |
| POST | `/rules/from-template/:templateId` | admin | Create rule from template. Override with body: `name`, `conditions`, `actions`, `project_id` |
| GET | `/widgets/activity` | agent/admin | Dashboard widget: triggers last 24h, top rules, recent log |

## Condition Fields

Rules match events using a `conditions` JSON object:

- **`project_id`** -- Match events from a specific project
- **`agent_id`** -- Match events from a specific agent
- **`field_equals`** -- Object of `{ field: value }` pairs that must match in `event.data`
- **`field_contains`** -- Object of `{ field: substring }` pairs for substring matching
- **`field_exists`** -- Array of field names that must exist in `event.data`

## Action Types

Rules define an `actions` array. Each action has a `type`:

| Type | Fields | Description |
|------|--------|-------------|
| `create_task` | `title`, `description`, `project_id`, `assignee` | Create a new task |
| `send_message` | `to`, `content`, `project_id` | Send a message to an agent |
| `file_bug` | `title`, `description`, `project_id`, `severity` | File a bug report |
| `assign_agent` | `agent_id` | Assign an agent to the triggering task |
| `send_webhook` | `url` | POST event data to a webhook URL |
| `inbox_notify` | `title`, `summary`, `priority` | Send inbox notification to all operators |

Action string fields support template variables: `{{agent}}`, `{{event_type}}`, `{{project}}`, `{{summary}}`, and any key from `event.data`.

## Built-in Templates

- **Auto-assign critical bugs** (category: bugs) -- Assign critical bugs to an agent + notify
- **Notify on plan completion** (category: plans) -- Inbox notification when a plan step completes
- **Webhook on deploy** (category: integrations) -- Fire webhook when a deploy approval is executed
- **Create review task on PR** (category: github) -- Auto-create review task for new PRs

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_automation_list` | List automation rules. Filter by `trigger_event` or `enabled` status. |
| `mycelium_automation_trigger` | Manually trigger a rule with provided `event_data` |
| `mycelium_automation_log` | View recent execution log. Filter by `rule_id`, `limit`. |
| `mycelium_automation_stats` | Execution statistics: counts by status, top rules, last 24h |

## Events

**Listens to:** `*` (all events, except those starting with `automation_`)

**Emits:**
- `automation_triggered` -- When a rule fires (includes `rule_id`, `rule_name`, action count, dry_run flag)
- `automation_rule_created` -- When a rule is created
- `automation_rule_deleted` -- When a rule is deleted

## Database Tables

**`dv_automation_rules`** -- Rule definitions (name, trigger_event, conditions JSON, actions JSON, project_id, enabled, run_count, last_run).

**`dv_automation_log`** -- Execution log (rule_id, trigger_event, matched, actions_taken JSON, event_data JSON, status, error, dry_run).

**`dv_automation_templates`** -- Built-in templates (name, trigger_event, conditions, actions, category). Seeded with 4 default templates.
