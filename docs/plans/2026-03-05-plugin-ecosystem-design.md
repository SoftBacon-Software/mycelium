# Plugin Ecosystem — Design Doc

**Date**: 2026-03-05
**Status**: Approved
**Scope**: First-party plugin suite, marketplace infrastructure, installation/interaction UI

## Overview

Build a complete plugin ecosystem for Mycelium: 8 first-party plugins, a marketplace for discovery and installation, and a full dashboard UI for configuration and interaction. Plugins must be usable entirely through the dashboard — no command line required for end users.

## 1. Marketplace Infrastructure

### Registry

A `mycelium-plugins` GitHub repo serves as the plugin registry. Contains:
- `registry.json` at repo root — index of all available plugins with metadata
- Each plugin in its own directory with standard structure (`plugin.json`, `routes.js`, `handlers.js`, etc.)

Registry entry format:
```json
{
  "name": "github-sync",
  "display_name": "GitHub Sync",
  "description": "Deep GitHub integration — PR sync, issue tracking, CI status",
  "author": "SoftBacon Software",
  "version": "1.0.0",
  "trusted": true,
  "category": "integrations",
  "tags": ["github", "pr", "ci"],
  "install_count": 0,
  "min_mycelium_version": "1.0.0",
  "repo_url": "https://github.com/SoftBacon-Software/mycelium-plugins"
}
```

### Install/Uninstall Flow

**Install** (all via dashboard):
1. Browse marketplace tab → plugin cards with name, description, author, trust badge, category, install count
2. Click "Install" → server fetches plugin from registry, writes to `server/plugins/`, runs schema migrations, registers in `dv_plugins`
3. Plugin appears in "Installed" tab as disabled
4. User configures required fields via the config form
5. User enables → server loads plugin (restart or hot-reload)

**Uninstall** (dashboard):
1. Click "Uninstall" on installed plugin → confirmation modal ("This will remove plugin data. Are you sure?")
2. Server removes plugin directory, drops plugin-specific tables, removes from `dv_plugins` and `dv_plugin_config`

**Update**:
1. Dashboard shows "Update available" badge when registry version > installed version
2. Click "Update" → server pulls new version, runs new migrations, preserves config

### Trust Model

- **Verified** badge: First-party plugins by SoftBacon Software
- **Community** badge: Third-party plugins (future)
- All plugins open source and auditable via repo link

### Server Endpoints (new)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/plugins/registry` | GET | Fetch registry index (cached, refreshed hourly) |
| `/plugins/install` | POST | Install plugin from registry by name |
| `/plugins/:name/uninstall` | DELETE | Uninstall plugin, drop tables, remove files |
| `/plugins/:name/update` | PUT | Update plugin to latest registry version |

## 2. Plugin Interaction UI

### Widget System

Plugins can declare dashboard widgets in their manifest:
```json
{
  "dashboard_widgets": [
    {
      "id": "pr-status",
      "title": "Open PRs",
      "size": "half",
      "refresh_interval": 60
    }
  ]
}
```

Widget sizes: `quarter`, `half`, `full`. Widgets render on the main dashboard in a responsive grid. Each widget is an iframe pointing to the plugin's route prefix + `/widgets/<id>`, or a standardized JSON data endpoint that the dashboard renders natively.

**Recommended approach**: JSON data endpoints. The plugin exposes `GET /<prefix>/widgets/<id>` returning structured data, and the dashboard renders it using a standard widget component library (stat card, table, chart, list). This avoids iframe complexity and keeps the UI consistent.

Widget data format:
```json
{
  "type": "stat",
  "value": 12,
  "label": "Open PRs",
  "trend": "+3 this week",
  "color": "blue"
}
```

Widget types: `stat` (single number), `table` (rows/columns), `list` (items with status), `chart` (time series — future).

### Plugin Pages

Plugins can declare full pages in the sidebar:
```json
{
  "pages": [
    {
      "path": "/github",
      "title": "GitHub",
      "icon": "Github",
      "nav_section": "observe"
    }
  ]
}
```

Plugin pages load at `/studio/plugins/<name>/<path>`. The plugin serves its page HTML/data from its route prefix, and the dashboard wraps it in the standard layout (sidebar, header). Two rendering modes:

1. **Data mode** (recommended): Plugin exposes JSON API endpoints, dashboard renders using shared components (tables, forms, cards, lists). Plugin declares its page layout in a `pages.json` schema.
2. **Custom mode**: Plugin serves full HTML at its route, embedded in an iframe within the dashboard layout. For complex UIs that need custom rendering.

### Config UI

Already built. The dynamic form system renders fields based on `config_schema` in `plugin.json`. Supports: string, secret, boolean, number, select, url, text. Secrets are masked on read.

## 3. First-Party Plugins

### Tier 1 — Ship First

#### 3.1 `github-sync` — Deep GitHub Integration

**Purpose**: Bidirectional GitHub sync. Inbound webhooks create tasks/bugs, outbound updates post to PRs/issues.

**Features**:
- Webhook receiver for: push, pull_request, issues, issue_comment, check_suite, workflow_run
- PR events → update linked Mycelium tasks, post status to agent channels
- Issue events → auto-create Mycelium bugs with labels/assignee mapping
- CI status → surface in dashboard widget and agent context
- Dashboard page: repo health, PR velocity, agent commit stats, CI status grid
- Agent MCP tools for querying/linking

**Config**: `github_token` (secret), `webhook_secret` (secret), `repos` (multi-select URL list), `auto_create_bugs` (boolean), `ci_notifications` (boolean)

**MCP Tools**: `mycelium_github_pr_status`, `mycelium_github_link_issue`, `mycelium_github_repo_health`

**Dashboard Widget**: "Open PRs" stat card, "CI Status" traffic light
**Dashboard Page**: `/github` — repo list, PR board, CI runs, commit activity

**Events consumed**: `task_completed` (to update linked PRs), `bug_filed` (to create GitHub issues)
**Events emitted**: `github_pr_opened`, `github_pr_merged`, `github_ci_failed`, `github_issue_created`

#### 3.2 `daily-digest` — Automated Reporting

**Purpose**: Generate daily/weekly summaries of swarm activity. Replace "read 200 messages to know what happened."

**Features**:
- Auto-generates digest at configured time: tasks completed, PRs merged, bugs fixed, plans advanced, agent utilization
- Digest routes to operator inbox as a structured notification
- Optional delivery to Slack webhook or email (SMTP)
- Trend tracking: velocity over time, agent productivity, project progress percentages
- Dashboard page: digest history, preview next digest, trend charts
- Configurable per-project or global

**Config**: `schedule` (select: daily/weekly), `delivery` (multi-select: inbox/slack/email), `timezone` (string), `slack_webhook` (secret, conditional), `email_recipients` (string, conditional), `smtp_host` (string, conditional), `smtp_credentials` (secret, conditional)

**MCP Tools**: `mycelium_digest_preview`, `mycelium_digest_send`, `mycelium_digest_trends`

**Dashboard Widget**: "Today's Velocity" stat card (tasks done, PRs merged)
**Dashboard Page**: `/digest` — digest history, trend charts, delivery settings

**Events consumed**: `task_completed`, `bug_fixed`, `plan_step_completed`, `agent_heartbeat`, `pr_merged` (from github-sync if installed)

#### 3.3 `guardrails` — Automated Quality Checks

**Purpose**: Pre-action validation rules. Prevent agents from merging without tests, deploying without approval, etc.

**Features**:
- Rule engine with configurable conditions and actions
- Pre-action hooks: intercept approval requests, task completions, PR merges
- Built-in rule types: require_tests, require_review, no_force_push, require_approval_for_deploy, max_file_changes
- Custom rules via JSON expression syntax
- Enforcement modes: block (hard stop) or warn (alert operator, allow action)
- Violation log with full context (who, what, when, which rule)
- Dashboard page: rule editor, violation log, rule effectiveness stats

**Config**: `enforcement_mode` (select: block/warn), `global_rules` (JSON via UI editor)

**MCP Tools**: `mycelium_guardrails_check` (pre-flight check), `mycelium_guardrails_status` (current rules)

**Dashboard Widget**: "Rule Violations (24h)" stat card
**Dashboard Page**: `/guardrails` — rule list with toggles, violation log, add/edit rule form

**Events consumed**: `task_completed`, `approval_requested`, `*` (wildcard for custom rules)
**Events emitted**: `guardrail_violation`, `guardrail_blocked`

### Tier 2 — High Value

#### 3.4 `slack-bridge` — Slack/Discord Integration

**Purpose**: Bridge Mycelium channels and agent activity to Slack/Discord.

**Features**:
- Bidirectional message sync: Mycelium channels ↔ Slack channels
- Agent status updates posted to a dedicated Slack channel
- Slack slash commands: `/mycelium status`, `/mycelium assign @agent "task"`, `/mycelium approve <id>`
- Event filtering: choose which Mycelium events forward to Slack
- Discord support via webhook (outbound only initially, bidirectional later)

**Config**: `slack_bot_token` (secret), `slack_signing_secret` (secret), `channel_map` (JSON — Mycelium channel ID → Slack channel ID), `event_filters` (multi-select), `discord_webhook` (secret, optional)

**MCP Tools**: `mycelium_slack_send`, `mycelium_slack_channels`

**Dashboard Page**: `/slack` — channel mapping UI, event filter toggles, message log

**Events consumed**: `message_sent`, `task_completed`, `bug_filed`, `agent_status_changed`

#### 3.5 `project-tracker-sync` — Linear/Jira Sync

**Purpose**: Bidirectional sync between Mycelium tasks and external project trackers.

**Features**:
- Provider support: Linear (v1), Jira Cloud (v1)
- Task sync: create in Mycelium → creates in Linear/Jira (and vice versa via webhook)
- Status mapping: configurable status-to-status map (e.g., Mycelium "in_progress" → Linear "In Progress")
- Comment sync: comments propagate both directions
- Assignment sync: Mycelium agent → Linear user mapping
- Conflict resolution: last-write-wins with audit log
- Dashboard page: sync status, mapping config, conflict log

**Config**: `provider` (select: linear/jira), `api_key` (secret), `project_map` (JSON — Mycelium project → external project), `status_map` (JSON), `sync_direction` (select: bidirectional/outbound/inbound)

**MCP Tools**: `mycelium_tracker_sync`, `mycelium_tracker_link`, `mycelium_tracker_status`

**Dashboard Page**: `/tracker` — provider setup, project mapping, sync log, conflict resolution

**Events consumed**: `task_created`, `task_updated`, `task_completed`
**Events emitted**: `tracker_synced`, `tracker_conflict`

#### 3.6 `error-monitor` — Error Tracking Integration

**Purpose**: Auto-file bugs from Sentry/Bugsnag/Datadog error alerts.

**Features**:
- Webhook receiver for Sentry, Bugsnag, Datadog alerts
- Auto-creates Mycelium bugs with: stack trace, error count, affected users, link to error dashboard
- Git blame integration: identify which agent's commit introduced the error, auto-assign bug to that agent
- Deduplication: group similar errors, update existing bug instead of creating duplicates
- Severity mapping: error tracking severity → Mycelium bug severity
- Dashboard page: error feed, auto-filed bugs, agent error leaderboard

**Config**: `provider` (select: sentry/bugsnag/datadog), `webhook_secret` (secret), `auto_assign` (boolean), `auto_file_threshold` (number — minimum occurrences before auto-filing), `severity_map` (JSON)

**MCP Tools**: `mycelium_errors_recent`, `mycelium_errors_link`, `mycelium_errors_stats`

**Dashboard Widget**: "Errors (24h)" stat card with severity breakdown
**Dashboard Page**: `/errors` — error feed, auto-filed bugs, configuration

**Events emitted**: `error_received`, `error_bug_filed`

### Tier 3 — Differentiators

#### 3.7 `cost-tracker` — API Spend Visibility

**Purpose**: Track and visualize AI API costs per agent, project, and task.

**Features**:
- Token usage tracking from agent heartbeat metadata (agents report tokens_used per session)
- Cost calculation using configurable per-model pricing
- Breakdowns: by agent, by project, by task, by time period
- Budget alerts: configurable thresholds, routes warnings to operator inbox
- Cost-per-task metrics: how much did each completed task cost in API spend
- Dashboard page: spend charts, agent cost ranking, budget status, historical trends

**Config**: `pricing` (JSON — model → cost-per-token), `budget_daily` (number), `budget_weekly` (number), `alert_threshold_pct` (number — percentage of budget to trigger alert), `track_external` (boolean — track non-Anthropic API costs if reported)

**MCP Tools**: `mycelium_cost_report`, `mycelium_cost_by_agent`, `mycelium_cost_by_project`

**Dashboard Widget**: "Spend Today" stat card with trend, "Budget Status" progress bar
**Dashboard Page**: `/costs` — spend charts, agent rankings, budget config, export CSV

**Events consumed**: `agent_heartbeat` (extract token counts), `task_completed` (attribute cost to task)
**Events emitted**: `budget_alert`, `cost_report_generated`

#### 3.8 `workflow-automations` — Event-Driven Automation Rules

**Purpose**: "When X happens, do Y" — like Zapier for the swarm.

**Features**:
- Visual rule builder in dashboard (not code, not command line)
- Trigger: any Mycelium event (task_completed, bug_filed, agent_idle, etc.)
- Conditions: filter by project, agent, severity, status, custom fields
- Actions: create task, assign agent, send message, file bug, request approval, send webhook, update context
- Rule templates: pre-built common automations (e.g., "auto-assign critical bugs to senior agent", "notify on plan completion", "create deploy approval when all tests pass")
- Execution log: see every rule trigger, condition evaluation, action taken
- Enable/disable individual rules

**Config**: `rules` (JSON, managed via UI builder), `max_actions_per_minute` (number — rate limit), `dry_run` (boolean — log but don't execute)

**MCP Tools**: `mycelium_automation_list`, `mycelium_automation_trigger` (manual trigger), `mycelium_automation_log`

**Dashboard Page**: `/automations` — rule list, visual rule builder, execution log, template gallery

**Events consumed**: `*` (wildcard — evaluates all events against rules)
**Events emitted**: `automation_triggered`, `automation_action_taken`

## 4. Work Distribution

### Phase 0: Marketplace Infrastructure
- Server: registry fetch, install/uninstall/update endpoints
- Dashboard: marketplace tab build-out (browse, install, uninstall, update badges)
- Widget system: JSON data endpoint contract, widget renderer component
- Plugin page system: sidebar injection, page routing, layout wrapper

### Phase 1: Tier 1 Plugins (parallel)
- `github-sync` — macbook-claude
- `daily-digest` — macbook-claude
- `guardrails` — greatness-claude

### Phase 2: Tier 2 Plugins (parallel)
- `slack-bridge` — greatness-claude
- `project-tracker-sync` — greatness-claude
- `error-monitor` — macbook-claude

### Phase 3: Tier 3 Plugins (parallel)
- `cost-tracker` — macbook-claude
- `workflow-automations` — greatness-claude

## 5. Success Criteria

- All 8 plugins installable and configurable entirely via dashboard UI
- Marketplace tab shows available plugins with install/update/uninstall
- Each plugin has at least one dashboard widget and one full page
- Plugin config changes take effect without command-line intervention
- Zero command-line interaction required for end-user plugin management
