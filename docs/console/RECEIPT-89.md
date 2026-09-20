# RECEIPT — task 89: clean-room operator console (shell + four faces)

Lane K-kira, 2026-09-20. Branch `console/clean-room-shell`, worktree
`~/Projects/_wt/mycelium-console`. Design inputs were the measured
presentation spec + reference screenshots + `DATA-LAYER.md` +
`GLOSSARY-the-line.md` only. The dashboard source itself was **never
opened by the lane** — `tools/cleanroom_check.py` is the tool that
reads the forbidden paths, and it is the gate.

## What landed

Written fresh into `public/console/` (plain HTML/CSS/JS, no framework,
no build step):

| File | Lines | What it is |
|---|---|---|
| `index.html` | 117 | fail-closed sign-in layer + shell (sidebar, pagehead, four face roots) |
| `console.css` | 768 | the look: ground #071017 + 50px grid, 240px sidebar, wells, command strips, stat wells with hue top-rules, chips, terminal rails, ledger edges |
| `console.js` | 929 | hash router, one fetch layer (operator JWT only), four faces, per-face poll cadence, SSE + poll fallback |
| `lib.js` | 149 | pure helpers incl. the honesty render (`valueOrDash`), hue mapping, provenance chips — the vitest-covered core |
| `fonts/` | 2 + binaries | Inter + JetBrains Mono self-hosted (OFL files included) |

Support: `test/unit/console-lib.test.js` (20 tests), `tools/cleanroom_check.py`
(the gate), `tools/console-fixture-seed.py`, `tools/console-screenshots.mjs`,
`tools/console-composites.py`. Doc test-count references updated
(README/CLAUDE/CONTRIBUTING: 162 → 163 test files).

## Clean-room gate

```
python3 tools/cleanroom_check.py <T3MP3ST> <T3MP3ST-ui> <velum-web/docs/index.html>
→ 0   (exit 0)
```
Exact stripped-line matches (≥40 chars) between `public/console/**` and
every forbidden path: **0**.

## Gates (exit codes, not greps)

| Gate | Result |
|---|---|
| `npm test` (full vitest suite) | **rc 0** — 0 fail (1617+ tests, now incl. 20 console-lib tests) |
| `node --check` console.js + lib.js | rc 0 |
| `cleanroom_check.py` | **0** (rc 0) |
| screenshots > 50KB each | 9/9 (62 KB – 563 KB) + 4 composites |

## Faces — live vs soon

- **Rounds** — LIVE: command strip (STATUS/SEATS/LANES/REFRESHED), seat
  wells from the rounds state source, THE BOX ledger, LANES IN FLIGHT +
  LAST OUTCOMES narration from `GET /workflows`, RUNNER LOG rail.
- **Agents** — LIVE: roster cards from `GET /agents` (presence-derived
  status, BRAIN/SEAT/HEARTBEAT rows).
- **Memory** — LIVE: lessons ledger (`GET /memory/lessons`, outcome/rc
  edge hues, provenance metadata) + RECALL well (`POST /memory/search`,
  provenance chips director/inferred/?).
- **Lab Alive** — LIVE: `GET /events/stream` (SSE, token-authed) with
  id-dedupe against the `/events` backfill; automatic poll fallback that
  labels itself **POLLED** in the rail header.
- Receipt / Dispatch / Settings / About — present in nav as dim SOON rows
  (no dead clicks; sign-out works).

## Routes used (verified live against the scratch platform, all 200)

`POST /studio/login` · `GET /studio/me` · `GET /agents` ·
`GET /workflows?limit=…` · `GET /memory/lessons?limit=…` ·
`POST /memory/search` · `GET /events?limit=…` · `GET /events/stream?token=…`

## Compare shots (reference LEFT, ours RIGHT — inspected, not assumed)

- `compare-89-rounds.png` vs warroom: idiom matches — sidebar anatomy,
  strip cells, narration rows, terminal rail with PAUSE/CLR, hue-as-status.
  Ours is sparser below the fold (no hero well); honest "—" + STATE
  UNREACHABLE chip where the state source is blocked (see finding below).
- `compare-89-agents.png` vs operators: card grid + presence dots + mono
  spec rows match; ours carries live roster truth (4 online) vs their
  fictional formations.
- `compare-89-memory.png` vs selfimprove: ledger rows with colored edges +
  outcome chips match the narration idiom; recall well is ours (their page
  has no analog).
- `compare-89-lab.png` vs terminal: rail anatomy matches (caps title,
  count, PAUSE/CLR, HH:MM:SS SOURCE · message); ours is a live event feed,
  not a shell — no input line by design.
- `shots/89-signin-1600.png` — the fail-closed well (no JWT → sign-in,
  no data rendered).

## Fixture disclosure (honesty about the shots)

The screenshots were taken against a **scratch platform instance** booted
from this worktree (`PORT=3002`, `DATA_DIR=/tmp/k89-scratch-db`, its own
ADMIN_KEY/JWT_SECRET, `MYCELIUM_NO_MDNS=1` — the Mac's own mDNS advertisement
was suppressed after the first boot advertised itself on the LAN). The
scratch db was seeded by `tools/console-fixture-seed.py`, which replays
**real rows fetched from the live lab platform** through the platform's own
write APIs: 4 really-online agents (register + heartbeat), 6 real
workflows (fire → claim → terminal status), 8 lessons verbatim with
provenance, 25 events. Nothing is baked into the page; operator credentials
in the seeder are fixture-only. The live platform was never written to.

## Finding for the director (out of brief scope, needs a decision)

**CSP blocks the rounds state source.** `server/lib/security-headers.js`
sends `default-src 'self'` with no `connect-src`, so a page served from
`:3002` cannot fetch `http://<host>:8890/state.json` even though the
:8890 server's CORS allowlists us. The console renders this honestly
(STATE UNREACHABLE chip, "—" seats, last-ok age), but the Rounds face's
state half needs one of: (a) a same-origin proxy route on the platform,
or (b) an explicit `connect-src` addition. Both are platform changes and
were not made in this task.

## Second wrinkle found while verifying

`GET /events/stream` replays the last 20 events on connect; the console's
own `/events` backfill (60) overlaps that window. First screenshot pass
showed every event twice; fixed by id-dedupe in the SSE handler (the poll
path already deduped). Known minor ordering wrinkle: a live SSE row that
arrives while the backfill fetch is in flight can be cleared from view by
the backfill's re-render (still counted, lost from the rail) — acceptable
at connect time, worth a re-look in task 90.
