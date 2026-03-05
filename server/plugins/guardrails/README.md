# Guardrails

Automated quality checks and rule enforcement for agent actions.

Define rules that trigger on platform events and either **warn** or **block** when conditions are violated. Every violation is logged, and operators are notified via inbox. Admins can override blocked violations.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enforcement_mode` | select | `warn` | Default enforcement for new rules (`warn` or `block`) |
| `notify_on_violation` | boolean | `true` | Send inbox notification to all operators on every violation |

## API Endpoints

All routes are under `/api/mycelium/guardrails`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/rules` | agent/admin | List rules. Filter: `?enabled=`, `?trigger_event=`, `?project_id=` |
| POST | `/rules` | admin | Create a rule. Body: `name`, `trigger_event`, `conditions`, `enforcement`, `project_id` |
| GET | `/rules/:id` | agent/admin | Get a single rule |
| PUT | `/rules/:id` | admin | Update a rule |
| DELETE | `/rules/:id` | admin | Delete a rule |
| GET | `/violations` | agent/admin | List violations. Filter: `?rule_id=`, `?agent_id=`, `?project_id=`, `?limit=`, `?offset=` |
| GET | `/violations/:id` | agent/admin | Get a single violation |
| POST | `/violations/:id/override` | admin | Override a violation (gated: `guardrails_override`) |
| GET | `/stats` | agent/admin | Violation statistics (by enforcement, by rule, last 24h, top violators) |
| POST | `/check` | agent/admin | Dry-run: check an event against all active rules without logging. Body: `event_type`, `data`, `agent`, `project_id` |
| GET | `/widgets/violations` | agent/admin | Dashboard widget: violation count last 24h |

## Rule Condition Types

Rules use a `conditions` JSON object with a `type` field:

- **`require_field`** -- Check that `data[field]` exists. Fields: `field`, `message`.
- **`max_value`** -- Check that `data[field]` does not exceed `max`. Fields: `field`, `max`, `message`.
- **`require_approval`** -- Check that `data.approval_id` exists. Fields: `action_type`, `message`.
- **`block_agent`** -- Block a specific agent. Fields: `agent_id`, `message`.
- **`custom`** -- Evaluate a JS expression. Fields: `expression`, `message`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_guardrails_rules` | List active guardrail rules. Filter by `trigger_event` or `project_id` |
| `mycelium_guardrails_check` | Pre-flight check: test an event against rules without logging violations |
| `mycelium_guardrails_violations` | List recent violations. Filter by `agent_id`, `limit` |
| `mycelium_guardrails_stats` | Violation statistics: counts by enforcement, by rule, last 24h, top violators |

## Events

**Listens to:** `*` (all events, except those starting with `guardrail_`)

**Emits:**
- `guardrail_violation` -- On any rule violation (warn or block)
- `guardrail_blocked` -- On block-enforcement violations only

## Database Tables

**`dv_guardrail_rules`** -- Rule definitions (name, trigger_event, conditions JSON, enforcement, project_id, enabled).

**`dv_guardrail_violations`** -- Violation log (rule_id, trigger_event, agent_id, project_id, enforcement, event_data JSON, violation_detail, overridden flag).
