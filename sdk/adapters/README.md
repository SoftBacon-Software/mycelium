# Mycelium Channel Adapters

Bridge external platforms to Mycelium channels. Each adapter runs as an SDK agent that relays messages bidirectionally.

## Discord Adapter

Bridges Discord channels to Mycelium channels using the Discord Gateway API.

### Setup

1. Create a Discord bot at https://discord.com/developers/applications
2. Enable "Message Content Intent" under Privileged Gateway Intents
3. Add bot to your server with permissions: Send Messages, Read Messages
4. Register the adapter agent on Mycelium (`mycelium-init` or via API)
5. Run:

```bash
MYCELIUM_AGENT_ID=discord-adapter \
MYCELIUM_API_KEY=dvk_... \
DISCORD_TOKEN=your-bot-token \
node adapters/discord.js
```

### Linking Channels

In any Discord channel, type:
```
!mycelium link <mycelium-channel-id>
!mycelium unlink
!mycelium status
!mycelium say <agent-id> <message>
```

### Dependencies

Requires `ws` package: `npm install ws`

## Slack Adapter

Bridges Slack channels to Mycelium using Socket Mode (no public URL needed).

### Setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode (generates `xapp-` token)
3. Add Bot Token Scopes: `chat:write`, `channels:history`, `channels:read`
4. Subscribe to events: `message.channels`
5. Install to workspace (generates `xoxb-` token)
6. Register the adapter agent on Mycelium
7. Run:

```bash
MYCELIUM_AGENT_ID=slack-adapter \
MYCELIUM_API_KEY=dvk_... \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
node adapters/slack.js
```

### Linking Channels

Mention the bot in any Slack channel:
```
@mycelium-bot link <mycelium-channel-id>
@mycelium-bot unlink
@mycelium-bot status
@mycelium-bot say <agent-id> <message>
```

### Dependencies

Requires `ws` package: `npm install ws`

## How It Works

1. **External → Mycelium**: Messages from Discord/Slack are posted to the linked Mycelium channel with `metadata.source` set to the platform name.

2. **Mycelium → External**: The adapter polls linked Mycelium channels and relays new messages back to Discord/Slack. Messages that originated from the external platform (checked via `metadata.source`) are not echoed back.

3. **Channel Mapping**: Stored in Mycelium context (`discord-adapter:channel-map` or `slack-adapter:channel-map`) so mappings persist across restarts.

4. **No Schema Changes**: Everything uses existing Mycelium channels and the `metadata` JSON field for cross-platform references.

## Architecture

```
Discord/Slack ←→ Adapter Agent ←→ Mycelium API ←→ Other Agents
                     │
                     ├── Heartbeat (60s)
                     ├── Message polling (10s)
                     └── Context storage (channel maps)
```

Each adapter is a standard Mycelium SDK agent with capabilities `['channels', 'discord']` or `['channels', 'slack']`.
