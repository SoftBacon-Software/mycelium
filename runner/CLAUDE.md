# CLAUDE.md — Mycelium Runner

## What This Is

Autonomous agent runner for the Mycelium platform. Polls Mycelium for work, spawns Claude Agent SDK sessions to execute it, keeps agents productive 24/7 without human prompting.

## Critical Rules

- **No guessing**: If info isn't in context, say "I don't know" or use a tool to fetch it.
- **No silent failures**: Report failures immediately. Never pretend something worked.
- **Evidence-based**: Verify files exist before editing. Read before writing.
- **Honest failure**: Failing is OK. Never force "success" by modifying tests or deleting checks.

## Commands

```bash
npm install                         # Install dependencies
node index.js                       # Run with config.json
node index.js config.railway.json   # Run with Railway config
LOG_LEVEL=debug node index.js       # Debug logging
```

**IMPORTANT**: Must NOT be run from inside a Claude Code session (Agent SDK spawns claude subprocesses — nesting is blocked). Run from a normal terminal.

## Layout

```
index.js              # Entry point — loads config, starts orchestrator + health server
src/
  orchestrator.js     # Manages per-agent poll loops and session lifecycle
  session.js          # Agent SDK session wrapper — builds prompts, spawns sessions
  api.js              # Mycelium API HTTP client (check work, heartbeat)
  config.js           # Config loading — file, RUNNER_CONFIG env, or individual env vars
  workspace.js        # Git workspace manager — clone/pull repos for containers
  health.js           # Health HTTP server (GET /health, /ready)
  logger.js           # Structured logging with levels
config.json           # Local config (gitignored — has secrets)
config.example.json   # Template config
config.railway.json   # Railway deployment config (uses env: refs)
Dockerfile            # Container with Node.js + Claude Code CLI + git
package.json          # mycelium-runner v1.0.0
```

## Architecture

- **Orchestrator** manages N agents, each with its own poll loop
- **Poll loop**: check work queue -> if work exists -> spawn Agent SDK session -> push commits -> cooldown -> repeat
- **Sessions**: Claude Agent SDK (`query()`) with MCP tools, file access, system prompt from CLAUDE.md
- **Workspace**: For containerized environments, clones repos from GitHub on startup, pulls before sessions
- **Health**: HTTP server on PORT (default 8080) with `/health` (JSON status) and `/ready` (200/503)
- **Error handling**: exponential backoff on consecutive errors, max 10min
- **Graceful shutdown**: SIGINT/SIGTERM -> set agents offline -> wait for active sessions -> exit

## Deployment

### Local (this PC)

```bash
cd D:/mycelium-runner
node index.js                # foreground
# or background:
nohup node index.js > runner.log 2>&1 &
```

### Railway

1. Create new Railway project
2. Set env vars:
   - `MYCELIUM_ADMIN_KEY` = admin key
   - `ANTHROPIC_API_KEY` = Anthropic API key
   - `GITHUB_TOKEN` = GitHub PAT (for cloning private repos)
   - `PORT` = 8080 (Railway sets this)
3. Deploy: `railway up`
4. Health check: `GET /health` returns agent status JSON

### Docker

```bash
docker build -t mycelium-runner .
docker run -d \
  -e MYCELIUM_ADMIN_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -e GITHUB_TOKEN=... \
  -p 8080:8080 \
  mycelium-runner node index.js config.railway.json
```

## Configuration

Three ways to provide config (checked in order):
1. `RUNNER_CONFIG` env var (full JSON string)
2. `MYCELIUM_API_URL` + `MYCELIUM_ADMIN_KEY` + `RUNNER_AGENTS` env vars
3. Config file (default: `config.json`, or pass path as first arg)

Secrets in config files can use `"env:VAR_NAME"` to read from environment.

### Agent Config

| Field | Default | Description |
|-------|---------|-------------|
| `id` | required | Mycelium agent ID |
| `cwd` | from repos | Working directory for file operations |
| `repos` | none | Git repos to clone (for containers) |
| `model` | claude-sonnet-4-6 | Claude model to use |
| `maxTurns` | 100 | Max agent turns per session |
| `pollIntervalMs` | 300000 (5min) | How often to check for work |
| `cooldownMs` | 30000 (30s) | Wait between sessions |
| `tools` | Read,Write,Edit,Bash,Glob,Grep | Allowed tools |
| `mcpServers` | {} | MCP server configs |

### Repo Config (for containers)

```json
{
  "repos": [
    {
      "name": "king-city",
      "url": "https://github.com/SoftBacon-Software/king-city.git",
      "branch": "main",
      "path": "/workspace/king-city"
    }
  ]
}
```

