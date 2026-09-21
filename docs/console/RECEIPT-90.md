# RECEIPT — task 90: clean-room operator console (six faces + tour + density)

Lane K-kira, 2026-09-20. Same branch `console/clean-room-shell`, same
worktree `~/Projects/_wt/mycelium-console`, continuing directly on task
89's landing (PR #188, DRAFT — this task adds commits, it does not
merge). The clean-room law was held for the whole task: the dashboard
source was **never opened by the lane**; inputs were the presentation
spec, the 87 reference screenshots, `DATA-LAYER.md`, and our own repos.
`tools/cleanroom_check.py` is the tool that reads the forbidden paths,
and it is the gate.

## What landed

Six new faces in `public/console/` (still plain HTML/CSS/JS, no build
step), the first-run guided tour, and the density toggle:

| Face | Data source | State |
|---|---|---|
| **Receipt** | `receiptUrl()` → the director's `<host>:8890/receipts/` (localStorage override `mycelium_console_receipt_url`) | renders; feed **not wired** server-side — honest NOT WIRED state, see findings |
| **Chat** | `GET /messages?limit=60`; composer → `POST /messages` as the signed-in operator | LIVE (verified end-to-end on the scratch platform) |
| **Logs** | own polled `/events` buffer (200, oldest-first) independent of the Lab rail | LIVE (pause/clear/copy; source-hue-coded) |
| **Maintainer** | `GET /workflows` + `GET /projects` | LIVE (findings dtable + gate-output rail + repos table) |
| **Engines** | `stateSectionItems(state, 'engines')` from the rounds state source ONLY — the browser never probes LAN ports | renders; source CSP-blocked from :3002 — honest STATE UNREACHABLE, see findings |
| **About** | live `GET /health` (version · commit · uptime) | LIVE |

Supporting changes: `lib.js` +9 exported pure helpers (`stateSectionItems`,
`countHue`, `receiptShape`/`normalizePairs`/`normalizeNights`, `deltaChip`,
`barPct`, `chatHue`), 9 new vitest cases (console-lib 20 → **29**),
CSS for narration rows / chips / bars / tour layer / density, seeder +
screenshot + composite tools extended to the six faces.

**Tour** — 10 steps (one per face), spotlight hole + arrowed tooltip +
dot pagination, ←/→/Esc keys, auto-starts on first run
(`mycelium_console_tour_done`), re-runnable from the "?" pill, honors
Reduce Motion. **Density** — header toggle, Compact (default) /
Comfortable, persisted in `mycelium_console_density`.

## Bugs found and fixed during 90's own verification

1. **The tour never fired on 89's code: `enter()` called
   `refreshWorkflows()`, which does not exist** — a ReferenceError that
   killed `enter()` before `maybeFirstRunTour()` could run. Found with a
   CDP probe capturing `Runtime.exceptionThrown` (screenshots alone had
   shown a healthy-looking page; a page-level gate must be probed with
   the browser's own exception stream). Fixed to `refreshRounds()`;
   probe then confirmed the tour layer mounts.
2. **89's backfill race (open item in RECEIPT-89) — fixed by
   merge-don't-clear.** `backfillLab()` now merges the fetched window
   with live SSE rows already in the buffer (id-deduped; newer live rows
   keep their place), and `renderRailFromEvents()` is the single render
   path for backfill + live. The old `(replay)` suffix survives only as
   a dead guard — both remaining `labLine` call sites pass `live=true`.
3. **`toggleRailPause` was hard-wired to the rounds rail** — the
   Maintainer rail's PAUSE would have flipped the Lab flag. Now takes
   the rail key (`S.railPaused[route]`).
4. **Receipt strip carried a static `NOT WIRED` chip** that would have
   stayed stale if the feed went live; replaced with the live-updated
   feed chip. `wfAge` also re-worded: terminal workflows read
   `done in <age>`, pending reads `<age> queued`.
5. **Two inherited docs-gate reds at branch HEAD (from 89's landing,
   not this task's tree):** the ops-detail gate flagged the private-IP
   literal at `RECEIPT-89.md:103` (now `<host>:8890` in prose — the
   fact is unchanged), and the reachability gate flagged
   `console/RECEIPT-89.md` as unlinked (README now has an "Operator
   console" section linking both receipts). The grading tests were
   never touched; both gates green after the fixes.
6. **The screenshot harness itself had a race:** per-route
   localStorage writes happened *after* the reload that fired the tour,
   so the first 1600px pass carried the tour tooltip on every face.
   Fixed by planting JWT + tour flag + density together *before*
   navigation; third pass clean.

## Honesty states (what renders when a source is missing)

- `/receipts/` answers 404 today → the Receipt face renders
  "— receipt feed not wired — <url> answers nothing yet. Nothing is
  estimated here" with hero wells at "—", per-pair "no pairs shown",
  nightly strip "none are wired yet".
- The rounds state source (and with it the Engines face) is
  CSP-blocked from :3002 → STATE UNREACHABLE chip + last-ok age, never
  invented seats.
- Every unmeasured value renders `—`. No demo data anywhere; the shots
  come from real replayed rows (below).

## Gates

| Gate | Result |
|---|---|
| `npm test` (full vitest suite) | **rc 0** — 0 fail, incl. 29 console-lib tests |
| `node --check` console.js + lib.js + tools | rc 0 |
| `cleanroom_check.py` | **0** |
| Screenshots | 20 route shots (10 faces × 1600×1000 + 1280×800) + sign-in + tour-step2 + comfortable-memory, each inspected and >50KB |
| Composites | 10 (`compare-90-<face>.png`, reference LEFT / ours RIGHT, honest-mapping note in the tool docstring: receipt has no reference page — war-room is the stat-well grammar carrier) |

## Fixture disclosure (honesty about the shots)

Same discipline as 89: a **scratch platform** booted from this worktree
(`PORT=3002`, `DATA_DIR=/tmp/k90-scratch-db`, its own ADMIN_KEY/
JWT_SECRET, `MYCELIUM_NO_MDNS=1`), seeded by
`tools/console-fixture-seed.py` by replaying **real rows from the live
lab platform** through the platform's own write APIs. New in 90:
messages replay as their **real senders** via `X-Acting-As`
(`from_agent` is server-derived, never client-supplied — directives are
skipped so the scratch instance doesn't page operator inboxes), plus
one composer POST through the exact operator-studio-token authority the
console itself uses (200), and 10 real projects. The live platform was
never written to. The scratch instance was stopped and the port
verified free before this receipt was committed.

## Findings for the director (out of lane scope, need decisions)

1. **The receipt feed does not exist server-side** — `GET
   <host>:8890/receipts/` 404s. The face is built and renders its
   honest empty state; wiring the feed (even a static json) is what
   makes the hero ON-vs-OFF pair live.
2. **The CSP finding from RECEIPT-89 is still open and now affects
   three faces** (Rounds state half, Engines, Receipt): the platform
   sends `default-src 'self'` with no `connect-src`, so a page served
   from :3002 cannot fetch `<host>:8890/*` even though :8890's CORS
   allowlists us. Same two options: a same-origin proxy route, or an
   explicit `connect-src`. Both are platform changes, not made here.
3. **`state.json` has no 3090/GLM seat rows** — even unblocked, the
   Engines face can only render what the state source says ("a seat is
   whatever the state source says it is"); the 3090 coder seat and the
   GLM proxy lanes would need rows added source-side.
4. **Deployment-specific defaults:** `STATE_URL_DEFAULT` /
   `RECEIPT_URL_DEFAULT` in `console.js` carry the lab's tailnet host
   (a private address, in product code). Both are overridable via
   localStorage (`mycelium_console_state_url` /
   `mycelium_console_receipt_url`); a config seam or empty default is
   the cleaner long-term shape — left as-is for pattern consistency
   with 89's landed state URL, flagged here for the call.
5. **License line correction:** the brief said the About face should
   cite "(MIT)"; the repo's `LICENSE` is **Apache-2.0**, and that is
   what the About face says.
