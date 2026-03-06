# Mycelium MCP Server — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone MCP server that wraps the Studio API, giving Claude agents native tools with auto-heartbeat and protocol enforcement.

**Architecture:** Node.js MCP server using `@modelcontextprotocol/sdk` with stdio transport. Two modes: admin (full access for Greatness) and agent (scoped, auto-heartbeat). ~17 smart tools + 1 raw escape hatch. Talks to `mycelium.fyi/api/mycelium/` over HTTPS.

**Tech Stack:** Node.js, `@modelcontextprotocol/sdk`, `zod`, native `fetch`

---

### Task 1: Project Setup

**Files:**
- Create: `D:/mycelium-mcp/package.json`
- Create: `D:/mycelium-mcp/index.js`

**Step 1: Initialize project**

```bash
cd D:/mycelium-mcp
npm init -y
```

Set `"type": "module"` in package.json, add name/description.

**Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk zod
```

**Step 3: Create entry point skeleton**

`index.js` — imports McpServer, StdioServerTransport, reads env vars, creates server, connects transport.

**Step 4: Commit**

```bash
git init && git add -A && git commit -m "chore: project setup with MCP SDK"
```

---

### Task 2: API Client (`src/api.js`)

**Files:**
- Create: `D:/mycelium-mcp/src/api.js`

HTTP client wrapping native fetch. Exports `apiGet(path)`, `apiPost(path, body)`, `apiPut(path, body)`, `apiDelete(path)`. Reads `MYCELIUM_API_URL` and `MYCELIUM_API_KEY` + `MYCELIUM_ROLE` from env. Sets `X-Admin-Key` or `X-Agent-Key` header accordingly.

---

### Task 3: State Manager (`src/state.js`)

**Files:**
- Create: `D:/mycelium-mcp/src/state.js`

Session state: `agentId`, `role`, `workingOn`, `booted`, `heartbeatTimer`. Exports `startHeartbeat()`, `stopHeartbeat()`, `setWorkingOn(text)`, `getState()`. In agent mode, heartbeat fires every 5 min via `POST /agents/heartbeat`.

---

### Task 4: Session Tools

**Tools:** `studio_boot`, `studio_overview`

- `studio_boot`: Agent mode → GET /boot/:agentId + start heartbeat. Admin mode → GET /admin/overview.
- `studio_overview`: GET /admin/overview, formatted summary.

---

### Task 5: Task Tools

**Tools:** `studio_get_work`, `studio_claim_task`, `studio_complete_task`, `studio_create_task`

- `studio_get_work`: Boot data → prioritize plan steps > tasks > bugs
- `studio_claim_task(id)`: PUT /tasks/:id assign + in_progress + auto working_on
- `studio_complete_task(id, notes?)`: PUT /tasks/:id done + advance working_on
- `studio_create_task(title, desc, game, ...)`: POST /tasks

---

### Task 6: Communication Tools

**Tools:** `studio_send_message`, `studio_send_request`, `studio_respond_to_request`, `studio_read_messages`

---

### Task 7: Plans, Context, Bugs Tools

**Tools:** `studio_check_plans`, `studio_update_step`, `studio_get_context`, `studio_set_context`, `studio_list_bugs`, `studio_claim_bug`, `studio_fix_bug`

---

### Task 8: Raw API Tool

**Tool:** `studio_api(method, path, body?)`

Escape hatch for any endpoint not covered by smart tools.

---

### Task 9: Configure & Test

Register in Claude Code settings.json. Test all tools. Verify auto-heartbeat. Use Plan #2 as test case.

---

### Task 10: Agent Testing (hijack-claude)

Hijack-claude installs, configures agent mode, tests full workflow.
