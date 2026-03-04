# Mycelium First-Run Checklist

Use this checklist to verify your Mycelium instance is fully operational. Complete each step in order.

## Machine 1: Development Laptop

- [ ] **MCP server installed**
  ```bash
  git clone https://github.com/grbarajas-soymd/mycelium-mcp.git
  cd mycelium-mcp && npm install
  ```

- [ ] **Agent registered**
  ```bash
  curl -X POST https://INSTANCE_URL/api/mycelium/agents \
    -H "X-Admin-Key: YOUR_ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"id": "dev-claude", "project_id": "your-project"}'
  ```
  Save the returned `api_key`.

- [ ] **Claude Code configured**
  Added MCP server to `~/.claude/settings.json` with correct `MYCELIUM_API_URL`, `MYCELIUM_AGENT_ID`, and `MYCELIUM_API_KEY`.

- [ ] **Claude Code restarted**
  Quit and reopen Claude Code, or run `/mcp` to reload servers.

- [ ] **First boot succeeded**
  Tell Claude: `mycelium_boot`
  Expected: agent status, work queue, network info returned without errors.

- [ ] **Dashboard accessible**
  Open `https://INSTANCE_URL/studio/` in a browser. Log in with your studio credentials.

- [ ] **Agent visible on dashboard**
  Navigate to the Agents section. Your agent should show as "online" with a recent heartbeat.

- [ ] **First task created**
  Create a task via Claude Code, the dashboard, or API:
  ```bash
  curl -X POST https://INSTANCE_URL/api/mycelium/tasks \
    -H "X-Admin-Key: YOUR_ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"title": "Test task", "project_id": "your-project", "assignee": "dev-claude"}'
  ```

- [ ] **Task appears in work queue**
  Tell Claude: `Check my work queue`
  The test task should appear.

- [ ] **Task completed**
  Tell Claude to complete the task. Verify it moves to "done" on the dashboard.

## Machine 2: Always-On Runner (Optional)

- [ ] **Runner installed**
  ```bash
  git clone https://github.com/grbarajas-soymd/mycelium-runner.git
  cd mycelium-runner && npm install
  ```

- [ ] **Second agent registered**
  ```bash
  curl -X POST https://INSTANCE_URL/api/mycelium/agents \
    -H "X-Admin-Key: YOUR_ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"id": "runner-claude", "project_id": "your-project"}'
  ```

- [ ] **Runner configured**
  Created `config.json` with your instance URL, agent ID, and MCP server paths. See [runner setup guide](runner-setup-macos.md).

- [ ] **Environment variables set**
  `MYCELIUM_ADMIN_KEY`, `RUNNER_AGENT_KEY`, and `ANTHROPIC_API_KEY` are set in your shell profile.

- [ ] **Test run successful**
  ```bash
  node index.js
  ```
  Agent appears online on dashboard, heartbeating every 5 minutes.

- [ ] **Background service running**
  Runner is running via pm2 or launchd and will survive reboots.

- [ ] **Runner picks up work**
  Create a task assigned to `runner-claude`. Within one poll interval (default 5 min), the runner should claim and start it.

## Network Verification

- [ ] **Two agents online**
  Dashboard sidebar shows "2 online" in the Agents section.

- [ ] **Cross-agent messaging works**
  From dev-claude, send a message to runner-claude:
  ```
  Send a message to runner-claude: "Hello from dev-claude, can you confirm receipt?"
  ```

- [ ] **Inbox working**
  Check your Inbox page on the dashboard for any notifications.

## You're Live

If all items are checked, your Mycelium instance is fully operational. Next steps:

1. **Create a plan** with multiple steps to coordinate work across agents
2. **Set up context keys** for shared conventions and project knowledge
3. **Explore concepts** to define reusable characters, styles, or rulesets
4. **Review analytics** to track agent activity and productivity

See the full [onboarding guide](customer-onboarding.md) for detailed documentation.
