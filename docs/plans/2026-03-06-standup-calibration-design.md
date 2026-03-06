# Stand Up — Agent Calibration System

**Date**: 2026-03-06
**Author**: dev-claude + Greatness
**Status**: Approved
**Project**: Mycelium (platform feature)

## Problem

Agents drift. They use deprecated tools, forget conventions, lose identity across reboots, burn paid APIs without permission, and corrupt their own CLAUDE.md files. Customers deploying Mycelium need confidence that their agents stay calibrated without babysitting.

Currently:
- Rules live in scattered CLAUDE.md files that agents can accidentally corrupt
- No enforcement — concepts exist but agents only read them if they choose to
- No visibility — operator can't see which agents are drifted at a glance
- No automatic correction — drift is only caught when something breaks
- Session continuity is fragile — agents lose identity and context across reboots

## Vision

When any agent boots — ours or a customer's — it should feel like talking to the same person. The system knows who it is, what it was doing, what happened while it was away, and what rules it must follow. If it drifts, the system catches it and steers it back before damage is done.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Rule authority | Layered (platform defaults + customer overrides) | Sane defaults out of the box, full customization for customers |
| Drift detection | Config + Behavioral | Catch both technical misconfiguration and rule violations |
| Drift response | Auto-correct + notify | Directive for critical drift, context key for informational |
| Profile storage | New DB table `dv_node_profiles` | Server-enforced, agent-tamper-proof, dashboard-editable |
| CLAUDE.md handling | Compare, don't sync | Agents keep personality. System checks convention anchors. |
| Frequency | Every boot + every 6 hours via heartbeat | Catches drift early without being noisy |

## Data Model

### New table: `dv_node_profiles`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | Profile ID (e.g., `default-agent`, `default-drone`, `greatness-claude`) |
| `node_type` | TEXT | `agent`, `drone`, `admin` |
| `layer` | TEXT | `platform` (immutable), `customer` (instance-level), `agent` (per-agent override) |
| `parent_id` | TEXT | Inherits from this profile |
| `rules` | TEXT (JSON) | Behavioral rules with severity |
| `required_concepts` | TEXT (JSON) | Concept IDs agent must read on boot |
| `mcp_config` | TEXT (JSON) | Expected MCP server config |
| `tool_whitelist` | TEXT (JSON) | Allowed tools |
| `repo_list` | TEXT (JSON) | Expected repos/paths |
| `md_checkpoints` | TEXT (JSON) | Key phrases that MUST appear in agent's CLAUDE.md |
| `md_blocklist` | TEXT (JSON) | Phrases that must NOT appear |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

### Inheritance chain

```
platform/default-agent → customer/default-agent → agent/greatness-claude
```

Rules merge down the chain. Customer adds rules, overrides severity. Agent-level adds project-specific rules. Platform `critical` rules can't be downgraded.

### md_checkpoints and md_blocklist

Instead of syncing CLAUDE.md files, we define convention anchors:

**Must have** (checkpoints): `"mycelium_boot"`, `"No guessing"`, `"generate_painterly.py"` (for WS agents)

**Must not have** (blocklist): `"studio_boot"`, `"generate_sprites.py"`, `"Pixel Arena"`, `"dioverse-mcp"`

If an agent's CLAUDE.md is missing a checkpoint or contains a blocklisted phrase, that's drift.

## Boot-Time Calibration Flow

When `GET /boot/:agentId` is called:

1. **Resolve profile chain**: Load `platform/default-{agent_type}` → `customer/default-{agent_type}` → `agent/{agentId}`. Merge rules, concatenate checkpoints/blocklists, overlay MCP config.

2. **Check config parity**: Compare resolved profile's `mcp_config` against agent's last heartbeat diagnostics. Flag mismatches.

3. **Check CLAUDE.md anchors**: Compare agent's last `md_report` (from heartbeat) against profile's checkpoints and blocklist. Flag missing/forbidden phrases.

4. **Build "since last session" diff**: Enhance existing `computeSavepointDiff()` to include: new messages count, task status changes, plan step updates, new concepts linked to agent's project.

5. **Generate calibration block** in boot payload:

```json
{
  "calibration": {
    "status": "drifted",
    "drift_items": [
      {"type": "md_blocklist", "found": "studio_boot", "fix": "Replace with mycelium_boot", "severity": "high"},
      {"type": "md_missing", "expected": "generate_painterly.py", "severity": "medium"},
      {"type": "config", "field": "MYCELIUM_AGENT_ID", "expected": "macbook-claude", "actual": "missing", "severity": "high"}
    ],
    "required_concepts": [8, 9],
    "profile_version": "1.1",
    "last_standup": "2026-03-06T18:00:00Z"
  },
  "since_last_session": {
    "new_messages": 4,
    "task_changes": [{"id": 47, "old_status": "in_progress", "new_status": "completed"}],
    "plan_step_changes": 2,
    "new_concepts": [9],
    "new_bugs": 1
  }
}
```

6. **Write standup context key**: Auto-write `{agentId}/standup` with calibration results. Agent reads it on boot — persistent, queryable, doesn't clutter messages.

7. **Critical drift → directive**: If critical-severity drift detected, server sends a blocking directive. Agent must fix before getting work. Non-critical drift is informational.

## CLAUDE.md Comparison

Agents report their CLAUDE.md state on heartbeat (not the full file):

```json
{
  "md_report": {
    "hash": "sha256:abc123...",
    "anchors_present": ["mycelium_boot", "No guessing", "generate_painterly.py"],
    "anchors_missing": [],
    "blocklist_found": [],
    "last_modified": "2026-03-06T14:30:00Z",
    "line_count": 167
  }
}
```

Agent computes this locally by reading its CLAUDE.md and checking against profile checkpoints/blocklist. Server stores it, compares across agents, surfaces in dashboard.

**Cross-agent comparison**: Dashboard shows a matrix — all agents vs all checkpoints. Green = present, red = missing, yellow = blocklist found.

**When drift is detected**: Server writes specific fix instructions to `{agentId}/standup` context key. For high-severity drift, also sends directive. Agent edits its own CLAUDE.md — preserves personality while fixing conventions.

## Periodic Refresh (6-Hour Cycle)

Every heartbeat, server checks `last_standup` timestamp. If >6 hours:

1. Re-resolve agent's profile chain (in case customer updated rules)
2. Compare against latest `md_report` from heartbeat
3. Update `{agentId}/standup` context key with fresh calibration
4. If new drift detected, emit `standup_drift` event (webhook-able)
5. Update `last_standup` timestamp

Lightweight — piggybacks on existing 5-minute heartbeat. No extra API call.

## Dashboard UI

### New page: "Node Health"

**Layout**:
- **Top**: Summary cards — X agents aligned, Y drifted, Z critical
- **Table**: One row per agent. Columns: name, node type, profile, calibration status, last standup, drift count, last boot
- **Click into agent**: Full drift report — every checkpoint, config field, behavioral flag with status
- **Profile editor**: Pick profile → see inherited rules from platform + customer layer → add/edit/remove rules, checkpoints, blocklist, MCP config, tool whitelist
- **Comparison view**: Side-by-side CLAUDE.md anchor matrix across all agents

### Profile management
- Platform defaults: read-only (shipped with Mycelium)
- Customer defaults: editable in dashboard
- Per-agent overrides: editable in dashboard
- Changes trigger immediate re-calibration on next heartbeat

## Customer Experience

1. Platform defaults pre-loaded on deploy (`default-agent`, `default-drone`, `default-admin`)
2. Customer registers first agent — inherits platform defaults automatically
3. Dashboard prompts: "Customize your agent profile?" — add project rules, set MCP config, define checkpoints
4. Agent boots, gets calibration block, knows exactly what's expected
5. If agent drifts, dashboard shows it. Customer clicks "send correction" → directive fires

No CLAUDE.md knowledge required from customers. Profile system defines expectations. CLAUDE.md comparison is a power-user bonus.

## Macbook-Claude Feedback (Incorporated)

From macbook's experience report:
- **"Since your last session" summary** → Added to boot payload as `since_last_session` block
- **Stale savepoints causing retry loops** → Calibration catches behavioral drift (repeated failures)
- **Concept #9 not read early enough** → `required_concepts` in profile, pushed at boot time
- **Preferred format: context key** → Calibration results written to `{agentId}/standup` context key

## Implementation Scope

### Server (D:/mycelium/)
- New `dv_node_profiles` table + migration
- Profile CRUD API endpoints
- Profile resolution logic (inheritance chain)
- Boot endpoint enhancement (calibration block + since_last_session)
- Heartbeat enhancement (md_report ingestion, 6-hour refresh)
- Standup context key auto-writer

### Dashboard (D:/mycelium/)
- Node Health page (summary cards, agent table, drift details)
- Profile editor (layered view, checkpoints/blocklist editor)
- CLAUDE.md comparison matrix

### MCP (D:/mycelium-mcp/)
- New tools: `mycelium_report_md`, `mycelium_get_profile`, `mycelium_list_profiles`
- Enhanced `mycelium_boot` to surface calibration block
- Enhanced `mycelium_heartbeat` to accept md_report

### Agents (all repos)
- CLAUDE.md files updated to remove deprecated references
- Boot protocol updated: read calibration block, fix drift if flagged
- Heartbeat updated: compute and report md_report

## Success Criteria

1. Any agent reboot feels like talking to the same person (identity + context preserved)
2. Deprecated tools/naming caught within one boot cycle
3. Dashboard shows calibration status for all agents at a glance
4. Customer can define agent behavior via dashboard without touching CLAUDE.md
5. Critical drift blocks agent from working until fixed
6. Agents can have different personalities but share conventions
