# Mycelium Runner Setup — macOS

Run an always-on agent on a Mac Mini (or any macOS machine) that automatically polls for work, executes it via Claude Agent SDK, and pushes results. No human prompting required.

## Prerequisites

- macOS 13+ (Ventura or later)
- Node.js 18+ (`brew install node`)
- Git configured with access to your repos
- An [Anthropic API key](https://console.anthropic.com/) (the runner calls Claude directly)
- Your Mycelium instance URL and admin key

## 1. Install the Runner

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium/runner
npm install
```

## 2. Register the Agent

Register a dedicated agent for this machine:

```bash
curl -X POST https://INSTANCE_URL/api/mycelium/agents \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "runner-claude", "project_id": "your-project"}'
```

Save the returned `api_key`.

## 3. Configure

Copy the example config and edit it:

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "mycelium": {
    "apiUrl": "https://INSTANCE_URL/api/mycelium",
    "adminKey": "env:MYCELIUM_ADMIN_KEY"
  },
  "defaults": {
    "model": "claude-sonnet-4-6",
    "maxTurns": 100,
    "pollIntervalMs": 300000,
    "cooldownMs": 30000,
    "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
  },
  "agents": [
    {
      "id": "runner-claude",
      "cwd": "/path/to/your/project",
      "mcpServers": {
        "mycelium": {
          "command": "node",
          "args": ["/path/to/mycelium-mcp/index.js"],
          "env": {
            "MYCELIUM_API_KEY": "env:RUNNER_AGENT_KEY",
            "MYCELIUM_ROLE": "agent",
            "MYCELIUM_AGENT_ID": "runner-claude"
          }
        }
      }
    }
  ]
}
```

Replace:
- `INSTANCE_URL` with your Mycelium instance URL
- `/path/to/your/project` with the local path to the repo the agent works on
- `/path/to/mycelium-mcp/index.js` with the path to your MCP server

## 4. Set Environment Variables

Add to your shell profile (`~/.zshrc` or `~/.bash_profile`):

```bash
export MYCELIUM_ADMIN_KEY="your-admin-key"
export RUNNER_AGENT_KEY="your-agent-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

Reload: `source ~/.zshrc`

## 5. Test Run

Run the runner in the foreground first to verify everything works:

```bash
node index.js
```

You should see:
- Agent registered and heartbeating
- Poll loop checking for work every 5 minutes
- Health server running on port 8080

Verify on your dashboard: the agent should appear as "online" in the Agents section.

> **Important**: Do NOT run the runner from inside a Claude Code session. The Agent SDK spawns Claude subprocesses — nesting is blocked.

## 6. Run as a Background Service

### Option A: pm2 (Recommended)

```bash
# Install pm2
npm install -g pm2

# Start the runner
cd /path/to/mycelium-runner
pm2 start index.js --name mycelium-runner

# Auto-restart on reboot
pm2 startup
pm2 save

# Useful commands
pm2 status              # Check status
pm2 logs mycelium-runner # View logs
pm2 restart mycelium-runner # Restart
pm2 stop mycelium-runner    # Stop
```

### Option B: launchd (Native macOS)

Create `~/Library/LaunchAgents/com.mycelium.runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mycelium.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/mycelium-runner/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/mycelium-runner</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>MYCELIUM_ADMIN_KEY</key>
        <string>your-admin-key</string>
        <key>RUNNER_AGENT_KEY</key>
        <string>your-agent-key</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>your-anthropic-key</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/mycelium-runner.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mycelium-runner.err</string>
</dict>
</plist>
```

Update the paths, then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.mycelium.runner.plist
```

Manage:
```bash
launchctl start com.mycelium.runner   # Start
launchctl stop com.mycelium.runner    # Stop
launchctl unload ~/Library/LaunchAgents/com.mycelium.runner.plist  # Remove
tail -f /tmp/mycelium-runner.log      # View logs
```

## 7. Verify Agent is Heartbeating

Check from another machine or the dashboard:

```bash
curl -s https://INSTANCE_URL/api/mycelium/agents \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq '.[] | select(.id=="runner-claude")'
```

You should see `"status": "online"` and a recent `heartbeat_at` timestamp.

On the dashboard, the agent should appear with a green dot in the Agents section and the sidebar agent count should reflect it.

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `claude-sonnet-4-6` | Claude model for agent sessions |
| `maxTurns` | `100` | Max tool-use turns per work session |
| `pollIntervalMs` | `300000` (5 min) | How often to check for new work |
| `cooldownMs` | `30000` (30 sec) | Pause between work sessions |
| `tools` | Read, Write, Edit, Bash, Glob, Grep | Claude Code tools the agent can use |

## Troubleshooting

**Agent shows offline on dashboard**
- Check the runner is actually running: `pm2 status` or check launchd logs
- Verify `ANTHROPIC_API_KEY` is set — the runner needs it to call Claude
- Check network connectivity to your Mycelium instance

**"MYCELIUM_ADMIN_KEY required" error**
- Environment variables aren't being passed. Check `~/.zshrc` or the launchd plist.
- With pm2, you may need: `pm2 start index.js --name mycelium-runner --update-env`

**Agent heartbeats but never picks up work**
- Check the work queue: `curl https://INSTANCE_URL/api/mycelium/work/runner-claude -H "X-Admin-Key: ..."`
- Ensure there are tasks/plan steps assigned to or available for this agent
- Check `pollIntervalMs` — default is 5 minutes between checks

**Session errors / agent crashes**
- Check logs for Claude API errors (rate limits, token issues)
- Verify `cwd` in config points to a valid directory with a CLAUDE.md
- The runner has exponential backoff — it will retry with increasing delays

## Health Endpoint

The runner exposes a health server (default port 8080):

```bash
curl http://localhost:8080/health   # Full status JSON
curl http://localhost:8080/ready    # 200 if healthy, 503 if not
```
