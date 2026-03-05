# Angel Investing Outreach — Design Doc

**Date:** 2026-03-05
**Author:** dev-claude + Greatness
**Status:** Approved

## Overview

$100K-$250K pre-seed angel round for Mycelium. Funds: infrastructure (Railway scaling, GPU compute) + GTM (content, conferences, first 10 paying customers). Cold outreach to AI-focused angels. The core differentiator: the network markets itself.

## The Self-Marketing Flywheel

Three layers, each feeding the next.

### Layer 1 — Dashboard as Live Demo

The landing page at mycelium.fyi is not a static marketing page. It shows the product working.

- Real-time agent activity ticker: task completions, PR merges, plan progress
- Aggregate stats: agents online, tasks completed, plans shipped, projects active
- Any visitor — investor, customer, curious dev — sees the swarm in action
- One link replaces a pitch deck

### Layer 2 — Agent-Generated Content

The build-in-public plugin (already built, Plan #23 Step 196) auto-drafts social posts from real events. Extend it:

- Weekly digest auto-generated: "This week on the Mycelium network: X tasks shipped, Y bugs fixed, Z plans advanced"
- Investor update emails drafted by agents, approved by operator, sent automatically
- The content pipeline is a Mycelium task — agents do the work, operators approve

### Layer 3 — Customer Network Effects

Every customer instance adds to the network story.

- Anonymized aggregate stats reported back to hub (opt-in)
- Landing page shows: "X agents across Y teams coordinated Z tasks this month"
- Numbers grow with every customer, making the next pitch stronger
- Customer success stories auto-surface from real data

**The flywheel:** More customers → more aggregate activity → more compelling demo → more content → more investors/customers → repeat.

## The Pitch

### One-Liner (for cold DMs)

> My AI agents market the platform they're built on. Mycelium is the coordination layer for AI agent teams — and the network sells itself.

### 30-Second Narrative

AI agents today are solo and stateless. They forget everything between sessions. They can't coordinate. Mycelium gives them persistent identity, shared task queues, and inter-agent messaging. The result: autonomous dev teams that ship code, generate art, and manage projects while you sleep.

We have 6 agents running 4 projects, a beta customer (Flatiron Automation), and a self-marketing flywheel where the platform's own agents generate the content that attracts the next customer.

### Why Now

- Claude, GPT, Gemini all shipping agent capabilities in 2026 — none solve coordination
- Every dev team running multiple agents will need this infrastructure
- First-mover in multi-agent coordination for dev teams
- Competitors serve different markets: Relay (ops teams), Nova Act (browser automation), Trace (enterprise routing)

### Why This Team

- Solo founder building with the product itself — 6 AI agents coordinating on Mycelium, shipping real code
- Live product at mycelium.fyi with dashboard, API, MCP integration, drone GPU system
- Beta customer onboarded (Flatiron Automation)
- The product is its own best proof: agents coordinate to build the platform that coordinates agents

### The Ask

$100K-$250K pre-seed on a post-money SAFE (standard YC SAFE). Valuation cap TBD.

Funds allocation:
- **Infrastructure (60%):** Railway scaling for customer instances, GPU compute for drone fleet, CI/CD, monitoring
- **GTM (30%):** Content production, conference attendance (AI Engineer, Cerebral Valley), community building
- **Legal/Admin (10%):** SAFE paperwork, incorporation cleanup, IP assignment

### Moat

- **Network effects:** Every customer adds agents to the aggregate stats, making the demo stronger
- **Self-marketing:** Build-in-public plugin generates content from real activity at zero marginal cost
- **Protocol lock-in:** MCP integration means agents configure once, stay forever
- **Data gravity:** Context stores, plans, and agent memory accumulate value over time — switching cost increases with usage

## Outreach Channels

### Channel 1 — X/Twitter Build-in-Public (start immediately)

- Post the 5 drafted content pieces (see `gtm/content_strategy_v1` context key) over 2 weeks
- Tag AI investor accounts in replies/QRTs (not spam-tag in main posts)
- Dashboard screenshot + "my agents did this while I slept" format
- Pin a thread: the Mycelium origin story + live dashboard link
- Goal: profile becomes the pitch deck — when you cold DM, they click through and see the story

Targets to engage with (not spam):
- @jason (Calacanis / LAUNCH)
- @garrytan (YC)
- @swaborsky (Latent Space / AI Engineer)
- @shaborsky (AI Grant)
- AI dev tool founders who might angel invest

### Channel 2 — Targeted Cold DMs (50 AI angels)

Source list from:
- Crunchbase: recent "AI infrastructure" / "AI developer tools" seed deals — find the angels on those cap tables
- AngelList: AI syndicate members and leads
- X/Twitter: bios containing "angel investor" + "AI" — surprisingly effective filter
- Cerebral Valley attendee lists (public from past events)

DM template:
```
[Dashboard screenshot showing agents coordinating]

Quick context: I built a coordination layer for AI agent teams.
6 agents run 4 projects on it right now — tasks, plans, messaging,
the works. Beta customer onboarded.

The meta: the platform's own agents generate the marketing content
that attracts the next customer.

Raising a small pre-seed ($100-250K SAFE). Worth 15 min to show
you agents coordinating live?

mycelium.fyi
```

Follow-up (day 3): Link to the 1-page memo.
Follow-up (day 7): Link to a specific content post showing agents at work.

### Channel 3 — AI Communities

- **Cerebral Valley** Discord + events (SF AI builder community)
- **Claude Discord / Anthropic developer community** — natural home, product is built on Claude
- **AI Engineer Summit** — Swyx's conference, exact target market
- **Latent Space podcast** community — devs and investors overlap heavily
- **Hacker News** — "Show HN: Mycelium" when ready for the open-source server moment (coordinate with open-source strategy)

### Channel 4 — Warm Intro Manufacturing

Start from existing network and expand:
- **Kurtis (Flatiron Automation)** — beta customer. Ask: "Who do you know investing in AI tools?"
- **Unakron** — security/hardware network, potential defense-adjacent AI investor connections
- **Hijack** — UI/design community, potential creative-tool investor connections
- **Anthropic DevRel** — building a showcase product on Claude, worth reaching out for ecosystem visibility
- Every meeting ends with: "Who else should I talk to?"

## Materials to Create

### 1. One-Page Pitch Memo

Not a deck. A Google Doc / Notion page. Angels read docs over coffee, not slide decks.

Sections:
- Problem (3 sentences)
- Solution (3 sentences + screenshot)
- Traction (agents, tasks, customer, pipeline)
- Market (every dev team using AI agents needs coordination)
- Moat (network effects, self-marketing, protocol lock-in, data gravity)
- Team (solo founder + AI workforce — the team IS the product)
- Ask ($100-250K SAFE, use of funds)

### 2. Live Demo Script (5 minutes)

1. Open mycelium.fyi dashboard — show agents online, heartbeats pulsing
2. Show a plan with steps assigned across agents — "this is how they coordinate"
3. Show an agent claiming a task in real-time (or trigger one)
4. Show the message thread — agents talking to each other
5. Show the build-in-public plugin drafting a social post from a task completion
6. Close: "This is 6 agents running 4 projects. Imagine 600 agents running 400 projects. That's what the funding scales."

### 3. SAFE Agreement

Standard YC post-money SAFE. Use Clerky or YC's template directly.
- Valuation cap: TBD (research comparable pre-seed AI infra deals)
- No discount, no pro-rata at this stage
- Keep it simple — one page, no negotiation surface area

### 4. Public Dashboard View

Stripped-down read-only view of the Mycelium dashboard for investor link-sharing:
- Agent status cards (online/offline, working_on)
- Activity feed (recent task completions, messages, plan progress)
- Aggregate stats
- No admin controls, no sensitive data
- URL: `mycelium.fyi/showcase` or `mycelium.fyi/live`

### 5. Metrics Snapshot

Update weekly during fundraise:
- Agents active: 6 (4 Claude agents + 2 drones)
- Tasks completed: (pull from API)
- Plans shipped: (pull from API)
- Projects active: 4 (Mycelium, Project A, Project B, Studio Tools)
- Beta customers: 1 (Flatiron Automation)
- MRR: $0 (pre-revenue, pricing set at $20-50/mo/instance)
- Pipeline: (track interested investors)

## The Meta Play — Fundraise as a Mycelium Project

Create a `fundraise` project on the Mycelium board. The fundraise itself runs on the product:

- **Tasks:** "Draft pitch memo," "Build angel list batch 1," "Send DMs batch 1," "Follow up week 1," "Prep Kurtis intro ask"
- **Plans:** "Angel Round v1" with steps for each outreach batch
- **Agents help:** Draft content, research investors, prepare meeting briefs, generate weekly fundraise status updates
- **Screenshot the fundraise board in meetings** — ultimate meta proof: "I'm using the product to coordinate the fundraise for the product"

This is not a gimmick. It's the most powerful demo possible: the product coordinating its own growth.

## Timeline

| Week | Actions |
|------|---------|
| 1 | Create fundraise project on Mycelium. Set up SAFE (Clerky/YC template). Build angel target list (50 names). Post first 2 content pieces on X. Build public dashboard view. Write 1-page memo. |
| 2 | Post remaining 3 content pieces. Send first 20 cold DMs. Prep live demo script. Ask Kurtis for intros. |
| 3-4 | Follow up on DMs. Take meetings (live demo format). Send second batch of 20 DMs. Iterate pitch based on feedback. |
| 5-6 | Close interested angels. Wire funds. Post "we raised" content (ultimate build-in-public moment). |

## Success Metrics

- 50 cold DMs sent
- 10+ meetings taken
- 3-5 angels committed
- $100K+ closed on SAFE
- Fundraise project on Mycelium board with full activity history (reusable for future rounds)

## Open Questions

- Valuation cap: need to research comparable pre-seed AI infra / dev tool deals (2025-2026)
- Entity structure: is SoftBacon Software a C-Corp? Angels need Delaware C-Corp for SAFEs.
- Do we want a lead angel or accept all checks equally?
- Conference budget: AI Engineer Summit 2026 dates/cost?
