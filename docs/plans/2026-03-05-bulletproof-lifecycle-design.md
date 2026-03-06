# Bulletproof Agent Lifecycle

**Date**: 2026-03-05
**Status**: Approved
**Author**: macbook-claude

## Problem

Agents lose state across sessions. The server infrastructure (savepoints, diffs, state snapshots) is solid, but the MCP client doesn't use it well:

1. Fixed 5-min heartbeat means up to 5 min of state lost on compaction or crash
2. Boot shows savepoint data but doesn't give structured resume instructions
3. Shutdown doesn't send a final comprehensive snapshot
4. No way to distinguish clean shutdown from crash on next boot

## Design

All changes are MCP client-side (`mcp/src/state.js` and `mcp/src/tools.js`). No server changes. No new endpoints. No new tools.

### 1. Adaptive Heartbeat

Swap fixed 5-min `setInterval` for activity-aware timer:

- **Idle** (no `claimedItem`): every 5 min
- **Active** (has `claimedItem` or `currentStep`): every 90 seconds
- Track `lastToolCall` timestamp — if a tool was called in the last 5 min, consider the session active

Every auto-heartbeat sends the full `getAutoSnapshot()` which already captures `claimedItem`, `currentStep`, and `progressNotes`.

### 2. Boot Auto-Resume

When savepoint shows unfinished work, format a structured resume block:

```
=== RESUME SESSION ===
You were: <working_on>
State: <claimed_item, current_step, progress notes from snapshot>
Changes while away: <summary from savepoint diff>
Action: Continue where you left off. Check messages first if any pending.
```

If previous session didn't end cleanly (no `session_end` flag):

```
=== RESUME SESSION (previous session did not shut down cleanly) ===
```

Falls back to current "Last session: X" display if no structured state in snapshot.

### 3. Richer Auto-Snapshot

Add to `getAutoSnapshot()`:
- `lastToolCall`: timestamp of last MCP tool invocation
- Track in `registerDual` wrapper — 1 line change

### 4. Graceful Shutdown

On SIGINT/SIGTERM:
1. Send final heartbeat with full `getAutoSnapshot()` + `session_end: true` flag
2. Then send offline heartbeat (existing behavior)

The `session_end` flag lets boot detect clean vs crash shutdown.

### 5. Agent Protocol Update

Update concept #4 with:
- **On boot**: Read RESUME section. Verify work is still needed (check task/step status). Continue if so.
- **During work**: Add progress notes at meaningful checkpoints. These survive compaction via auto-heartbeat.
- **Before completion**: Persist outcomes to network before marking done.

## Changes

| File | Change | Lines |
|------|--------|-------|
| `mcp/src/state.js` | Adaptive heartbeat timer | ~15 |
| `mcp/src/state.js` | `lastToolCall` tracking | ~5 |
| `mcp/src/state.js` | Final snapshot on shutdown | ~5 |
| `mcp/src/tools.js` | `lastToolCall` in registerDual | ~1 |
| `mcp/src/tools.js` | Structured RESUME in boot | ~30 |
| Concept #4 | Resume/checkpoint behavioral rules | Config |

## Verification

1. Start MCP, claim a task — confirm heartbeat switches to 90s
2. Kill MCP (SIGTERM) — confirm final snapshot sent with `session_end`
3. Restart MCP, boot — confirm structured RESUME block appears
4. Kill MCP (kill -9) — restart — confirm "did not shut down cleanly" message
5. Idle with no work — confirm heartbeat stays at 5 min
