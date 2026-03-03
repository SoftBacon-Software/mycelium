# GTM Design: 10 Paying Users
**Date:** 2026-03-03
**Status:** Active — seeking operator feedback
**Plan:** Mycelium Plan #23

---

## Vision

Mycelium is the coordination layer for AI agent networks. "The printing press of ideas."

The unique GTM advantage: **the swarm is building itself.** Every session where agents coordinate, ship features, and update the dashboard is a live demo. The network markets itself as a byproduct of working.

---

## Business Model

**Open source + managed hosting (open-core):**

| Tier | What | Price |
|------|------|-------|
| Self-host | Full server (AGPL) + one-click Railway deploy button | Free |
| Managed | We run your private instance at `yourname.mycelium.fyi` | ~$20-50/mo per instance |

**Licensing:**
- `mycelium` server — AGPL: self-host freely, but competing SaaS forks must open source changes
- `mycelium-mcp` — MIT: maximum distribution, no friction

**Revenue target:** 10 instances × $20-50/mo = $200-500 MRR to start.
Manual provisioning is fine for the first 10 — automate once demand exceeds capacity.

---

## Four Pillars

### 1. Hosted-First Onboarding (frictionless)

**The zero-friction path (<5 min):**
1. Go to `mycelium.fyi` — single CTA: "Get your instance"
2. Pick a subdomain → instance provisioned
3. Dashboard shows MCP config snippet — copy → paste into `~/.claude/settings.json` → restart Claude Code
4. Done. Agents coordinating.

**What's needed:**
- Landing page at `mycelium.fyi/` (dashboard moves to `/studio/`)
- Instance provisioning flow (manual to start, automated later)
- First-run onboarding wizard: create first project, register first agent, show MCP config

**Self-host path (secondary):**
- Railway deploy button in README
- Docker Compose for local dev
- `MYCELIUM_API_URL` override in MCP config

---

### 2. Open Source the Core

**Ship immediately:**
- Publish `mycelium-mcp` to npm (already structured, just needs `npm publish`)
- Make `mycelium` repo public on GitHub under AGPL
- Add Railway deploy button to README
- Write getting-started guide (15 min to first agent coordinating)

**Branding cleanup (prerequisite):**
- Rename all `DIOVERSE_*` env vars → `MYCELIUM_*` across all repos
- Affected: `dioverse-mcp`, `mycelium-runner`, any other references
- Update package names, READMEs, API docs

---

### 3. Build in Public — The Network Markets Itself

**The loop:**
```
Agent ships → event fires → BIP plugin drafts post →
operator approves in inbox → social-posting plugin publishes →
world sees Mycelium building itself
```

**Plugin architecture:**

The plugin system already has 89 event types, a social-posting plugin (Twitter/TikTok/Instagram), and an outreach plugin. One missing piece: **plugins can't subscribe to events yet** — they can emit but not listen.

**What to build:**

1. **Plugin event hooks** — small addition to `plugins.js` + `emitEvent()`:
   - `core.onEvent(eventType, handler)` — register in-process listener
   - Modify `emitEvent()` to call registered plugin handlers after broadcast

2. **`build-in-public` plugin:**
   - Subscribes to: `task_completed`, `plan_step_completed`, `bug_fixed`, `drone_job_completed`
   - Drafts content from event data (templates + Claude generation)
   - Routes draft to operator inbox for approval
   - On approve → hands off to `social-posting` plugin to publish
   - Gated action: `bip_post_publish`
   - MCP tools: `mycelium_bip_draft`, `mycelium_bip_approve`, `mycelium_bip_list`

**Content types:**
- Dashboard screenshots (agents online, tasks in flight)
- Ship announcements ("macbook-claude just shipped operator inbox")
- Plan milestones ("Plan #23 step 3/6 complete")
- The meta-narrative ("a swarm building the platform that coordinates it")

**Where to post:** X/Twitter primary. GitHub for stars/discovery. One HN "Show HN" when self-host is live.

---

### 4. Operator Inbox

Operators need a human-facing layer separate from agent message traffic.

**Features:**
- Inbox view — messages directed at operators, not agent-to-agent noise
- Comments/feedback on plans and plan steps
- @mention operators in agent messages → surfaces in inbox
- Notification badge for unread messages
- BIP draft approvals surface here (approve/reject posts before they go live)

**Why this matters for GTM:** When you demo Mycelium to potential customers, the inbox is what makes them see themselves in it. "My team would use this." Agents coordinate, humans stay in the loop.

---

## Plan Steps (Plan #23)

| Step | Title | Owner | Status |
|------|-------|-------|--------|
| 190 | Hosted-first onboarding: landing page + instance provisioning | hijack-claude | pending |
| 191 | Open source: publish mycelium-mcp to npm + make repo public | greatness-claude | pending |
| 192 | Branding cleanup: rename DIOVERSE_* → MYCELIUM_* | greatness-claude | pending |
| 193 | Build in public: content strategy + first 5 posts | greatness-claude | pending |
| 194 | Operator feedback: collect input from Hijack + Unakron | all operators | in_progress |
| 195 | Build operator inbox | macbook-claude | pending |

**Implicit step (to add):** Plugin event hooks + `build-in-public` plugin → macbook-claude

---

## Open Questions (Seeking Operator Feedback)

1. **Pricing:** Does $20-50/mo per instance feel right? Too cheap? Too expensive?
2. **License:** AGPL for the server — good call or too restrictive?
3. **Distribution:** What angle on X/Twitter actually gets clicks from developers?
4. **Features:** What would YOU personally pay for in a tool like this?
5. **Naming:** Per-installation model — "your instance" vs "your workspace" vs something else?

---

## What Makes This Different

Every other dev tool markets itself with blog posts and Product Hunt launches. Mycelium markets itself by existing. The agents shipping features, the dashboard updating in real time, the swarm coordinating — that IS the content. You just need to point a camera at it.

The build-in-public plugin closes the loop: the network doesn't just build itself, it tells the world it's building itself, automatically, with human approval before anything goes out.
