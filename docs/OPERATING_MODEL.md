# Mycelium — Operating Model (the human-facing side)

**Purpose.** How a person *operates* the squad across our two surfaces — the
**Mycelium app** (clean, public, the bright product) and **Velum** (the
granular terminal cockpit where m5Max + Gilbert work). This is the
operator-side companion to `MULTI_AGENT_AUTONOMY.md` (the agent-side
environment). One substrate, two faces: that doc shapes how the agents work;
this one shapes how the human works with them.

**North star — a review-centered experience.** The operator is the
ideas-guy-with-taste. Of everything they could do, two acts carry the value:
**expressing intent** (the idea) and **greenlighting an approach** (the
taste/selection). The whole experience is built around making those two acts
effortless and everything between them legible-on-demand. The greenlight is
load-bearing: it is the one place the operator's taste enters the agents' work.

---

## The loop

```
intent  →  squad sizes it up (triage)  →  YOU greenlight the approach  →  squad executes  →  what changed
  ▲                                              ▲                                                │
  └─────────────── operator lives here ──────────┘                                               │
                    (drop the idea, judge the plan)                                               ▼
                    everything else is machinery: visible when you lean in, silent when you don't
```

The operator lives at the bookends. Triage, routing, step assignment, and the
harness are machinery. The greenlight is the home base — so the operating
experience is, before anything else, a **review experience**.

---

## Two altitudes onto one substrate

Same mycelium plan/step/bug records underneath; two windows tuned to who's
looking. **Granularity is always available (Velum) and never forced (the
app).** This falls out for free because both surfaces are just read/write
views over the same plan object — descending from one to the other is a zoom,
not a context switch.

The *same event* (Ada finishes drafting the second-wind fix) at each altitude:

**Mycelium app — clean, default:**
```
🔴 Second-wind heals nothing in combat.
   Ada drafted an approach.        [ See it ]  [ Greenlight ]  [ Send back ]
   ▸ See it
     1. Lucy implements the heal + once-per-fight rule (with tests)
     2. Echo confirms it heals in a real fight
   ✓ Greenlit → Lucy building… Echo checking… Done.   [ What changed ]
```

**Velum cockpit — granular, behind the curtain:**
```
bug #11 → ada(triage) → plan #14 [draft]
  #14 "second-wind exec"  owner=ada  status=draft
    step1 [pending] lucy  implement (1d10+lvl, once/encounter, TDD)
    step2 [pending] echo  behavioral verify
$ velum-approve 14        # PUT /plans/14 {status:active}
  (+ transcripts, routing trace, reassign, hand-edit steps, force-route)
```

The app renders the approach as a thing to judge. Velum renders the records
and lets you move them by hand. You can always drop from the first into the
second; you never have to start in the second.

---

## The language split (keep the vocabularies separate)

Coherence comes from two vocabularies, and each surface speaks only its own.
**The app must never say "status," "step_order," or "capability."**

| Operator language (the app) | Machine-room language (Velum + platform) |
|---|---|
| the approach / the plan | `plan` (draft → active → completed) |
| **greenlight** / send back | `PUT status:active` / the review gate |
| the squad — Ada drafts, Lucy builds, Echo checks | agents + `capabilities` (`reasoning_planning`…) |
| "sizing it up" | planner triage / `buildWorkQueue` routing |
| in progress / done / what changed | `plan_steps`, `linked_pr_url`, transcripts |
| *(never appears)* | the harness / just-in-time steering |

Same nouns underneath, disclosed at different depths.

---

## The Velum cockpit (the granular altitude, made alive)

Gilbert's picture, and the target for the cockpit: **plans animating in
flight** — each active plan a live object showing which step it's on, who's
holding it, progress moving in real time — with a **pop-out into the agent
itself**: what it's doing, thinking, and writing right now. The cockpit is
where you *feel* the squad work, not just read a status line. Extends Cockpit
v0 (the squad-activity view, plan #3).

This is the deepest read of the substrate, rendered as motion instead of text.

---

## The invisible third thing — the harness

The agents' environment (the harness: just-in-time method, clean routing —
`MULTI_AGENT_AUTONOMY.md` A10) appears in **neither** operator surface. It is
purely agent-facing. Yet it is *what makes the clean experience possible*: the
better the agents' environment, the better their output, the less the operator
has to descend into Velum to correct them. A good agent environment shows up
to the operator as *rarely needing the granular controls.* Investing in the
harness makes the app cleaner for free. The operator's clean surface and the
agents' good environment are two faces of one loop, hinged at intent and
greenlight.

---

## Data backbone — what the platform must emit to feed both surfaces

The apps are only as clean as the data the platform hands them. Three feeds:

1. **The greenlight queue** — plans `awaiting approval` (status=draft),
   surfaced in the boot/overview payload the way the approval queue already is.
   This *is* the Mycelium app's home screen and the top of the Velum cockpit.
   → folded into routing **Spec #1 ④**.
2. **Plan-flight state** — per active plan: current step, assignee, progress,
   recent transitions. `getPlan`/`listPlans` already compute `progress` +
   `current_step`; the cockpit needs this as a live/streamed feed, not just a
   poll. → register track (live plan-flight events).
3. **Live agent activity** — the pop-out's "doing / thinking / writing." Today
   we have a `working_on` label (heartbeat) + post-hoc transcripts; the cockpit
   wants a *live* per-agent activity stream (current action + a tail of output).
   Velum can tail the local transcript directly; the app needs a platform
   stream. → register track (agent activity stream).

---

## Design rules (the doctrine)

- **One substrate, two altitudes.** App = judge the approach; Velum = move the
  parts. Never two systems.
- **Review-centered.** The home of the app is "what needs my greenlight."
- **Granularity available, never forced** — especially in the app.
- **The app speaks operator-language only.** Machine-room words stay in Velum.
- **The harness is invisible to the operator** and is the thing that keeps them
  at the high altitude.
- **Build the platform feeds first** so both apps render clean from day one.
