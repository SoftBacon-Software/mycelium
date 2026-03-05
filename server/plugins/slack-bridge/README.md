# Slack Bridge

Bidirectional Slack integration for Mycelium.

Forwards platform events to Slack channels, receives Slack messages and slash commands, and syncs Mycelium channels with Slack channels. Optionally forwards to Discord via webhook.

## Configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `bot_token` | secret | Yes | Slack bot token (`xoxb-...`) |
| `signing_secret` | secret | Yes | Slack signing secret for request verification |
| `default_channel` | string | No | Slack channel ID for general agent updates (e.g. `C0123456789`) |
| `event_filters` | text | No | Comma-separated event types to forward (e.g. `task_completed,bug_filed`). Empty = all events. |
| `discord_webhook` | secret | No | Discord webhook URL to also forward events to Discord |

## API Endpoints

All routes are under `/api/mycelium/slack`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/events` | Slack signature | Slack Events API endpoint. Handles URL verification and message events. |
| POST | `/commands` | Slack signature | Slack slash command handler. Subcommands: `status`, `tasks`, `assign <agent> <description>` |
| GET | `/channels` | agent/admin | List channel mappings |
| POST | `/channels` | admin | Create channel mapping. Body: `mycelium_channel_id`, `slack_channel_id`, `direction` (`both`/`to_slack`/`to_mycelium`) |
| PUT | `/channels/:id` | admin | Update a channel mapping |
| DELETE | `/channels/:id` | admin | Remove a channel mapping |
| GET | `/messages` | agent/admin | Message log. Filter: `?direction=`, `?slack_channel=`, `?limit=` |
| POST | `/test` | admin | Send test message to default Slack channel |
| GET | `/widgets/status` | agent/admin | Dashboard widget: active channel maps, messages forwarded today |

## Slash Commands

Register `/mycelium` as a slash command in your Slack app, pointing to `https://yourhost/api/mycelium/slack/commands`.

- `/mycelium status` -- Show active agent statuses
- `/mycelium tasks` -- Show open tasks (up to 15)
- `/mycelium assign <agent-id> <description>` -- Create a task and assign it to an agent

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_slack_send` | Send a message to a Slack channel. Requires `channel` (ID) and `message`. |
| `mycelium_slack_channels` | List all Slack-to-Mycelium channel mappings |
| `mycelium_slack_test` | Send a test message to the default Slack channel |

## Events

**Listens to:**
- `*` (all events) -- Forwards matching events to the default Slack channel (filtered by `event_filters` config) and optionally to Discord
- `channel_message` -- Bridges Mycelium channel messages to mapped Slack channels (skips messages originating from Slack to prevent loops)

**Emits:**
- `slack_message_received` -- When a Slack message is forwarded to a Mycelium channel
- `slack_channel_mapped` -- When a channel mapping is created
- `slack_channel_unmapped` -- When a channel mapping is removed

## Database Tables

**`dv_slack_channel_map`** -- Channel mappings (mycelium_channel_id, slack_channel_id, direction, enabled).

**`dv_slack_messages`** -- Message log for audit (direction, mycelium_msg_id, slack_ts, slack_channel, content, agent_id).
