# P1.4 follow-up — the author re-sends its revokes on the next hello (#206)

Lane F-mycelium, task 272 · 2026-10-08 · branch
`lane/F-mycelium-272-revoke-resend-on-hello` (cut from origin/master `88507e70`) ·
worktree `~/Projects/_wt/f-mycelium-272-revoke-resend` · PR closes #206 (filed by
director review B of #205).

One deliverable: an author-side keep for revokes a holder answered `unknown`
to, re-sent signed on the next hello — so a copy that arrives LATER from a
third holder no longer lands after the author ordered it forgotten.

---

## The shape (four files + the bounds)

| file | what |
|---|---|
| `server/plugins/federation/schema.sql` | `fed_revoke_outbox` — `(agent_id, row_id)` PK, home_network, reason, revoked_at, signature; index on `revoked_at` |
| `server/plugins/federation/store.js` | `REVOKE_RESEND_MAX_AGE_DAYS = 90` + `REVOKE_RESEND_MAX_PER_HELLO = 16` (the bounds, ONE place); `recordOutboxRevoke` (upsert) and `outstandingRevokes` (fresh, ordered, capped, rebuilt byte-exact) |
| `server/plugins/federation/routes.js` | `POST /federation/outbox` (agent-signed envelope; same gates as the revoke door) · `GET /federation/outbox` (admin; what to carry) · hello carries `outstanding_revokes` and judges each entry: verifyRevoke → must name the knocking agent → passport on file → home match → the existing `revokeRows` |
| `server/plugins/federation/client.js` | `hello(transport, { revokes })` carries the array; `recordRevoke(transport, rowId, reason)` — the shipped-client surface |

Judging never acts for a third party: a hello refuses revokes its visitor did
not author (`not-the-visitor`). `unknown`/`foreign` still write nothing — the
M1 trade-off (a holder never bans content it cannot evidence) is intact and
pinned.

**The dead-limiter insight:** an in-handler re-send bucket behind hello's own
30/min route limiter could never fire (hello trips first at the same request
count). The re-send leg rides helloLimiter + the 16-per-hello cap; only the
outbox RECORD door gets its own limiter (30/min, the revoke door's cadence —
one message per forgotten row).

## Gates (from the worktree, real exit codes)

| gate | result |
|---|---|
| `npx vitest run` | **rc=0** — **2092 passed \| 1 skipped (2093)** across 186 files |
| `npm run lint` | **rc=0** — 0 errors, **335 warnings** (ceiling 338; count unchanged from master — zero new warnings) |
| RED receipt | the new test file against a detached `origin/master` worktree: **4 of 5 fail** (only the pre-existing plain-hello behavior passes) — the tests exercise the new behavior |
| docs-inventory | the new file makes 186 test files; README.md / CONTRIBUTING.md / CLAUDE.md counts updated to match |

New pins: `test/unit/trust-layer-p1-4-revoke-resend.test.js` — THE LOOP (revoke
unseen → `unknown`/no ban → author keeps it → late copy from a third holder
IMPORTS (the gap) → next hello carries the outbox → copy falls, standing ban,
re-import `revoked`, re-write **410**, recall empty) · FORGED (tampered
`row_ids` → `revoke-sig`; stranger-signed → `not-the-visitor`; nothing deleted
or banned) · BOUND (91-day entry kept in the table but never carried; carried
entries re-verify byte-exact via `verifyRevoke`) · M1 KEPT (ghost → `unknown`,
other-author's row → `foreign`, both survive untouched) · plain hello
unchanged (no `revokes` key). Plus the outbox limiter proof in
`test/unit/trust-layer-rate-limits.test.js` (`POST /federation/outbox` holds
30/min, driven through the shipped `recordRevoke`).

## Live check — two real spawned servers (fresh DATA_DIR, killed on exit)

`node docs/specs/2026-10-08-federation-revoke-resend/live-check.mjs` →
**rc=0, 15/15 PASS** (full transcript in this session's log; runner log
`/tmp/p14r-live-H.log` / `/tmp/p14r-live-D.log`):

- holder H on :3971, author home D on :3972 — both `node server/index.js`,
  fresh tmp DATA_DIRs, `MYCELIUM_RATE_LIMIT=off`;
- the shipped client drove hello/recordRevoke/writeMemory over real HTTP;
- the sequence proven live: direct revoke at H → `{"revoked":0,
  "unknown":["c1445a3e…"]}` · record on D → 200 · late copy from a third
  holder → **`imported`** (the gap) · D's outbox lists it (count=1) · the
  next hello → `{"received":1,"applied":1,…,"revoked":1}` (the copy fell) ·
  re-import → `revoked` · live grant + re-write → **410** · recall empty ·
  plain hello unchanged;
- teardown proved: both children exited **code=0 on their own** after
  SIGTERM (`[shutdown] DB closed`), ports 3971/3972 freed, zero
  `server/index.js` processes left.

## Docs

- `spec/federation-v0/README.md` — new **§2.8 REVOKE** (the message, the
  holder's evidence gates, the M1 line, the #206 keep + catch-up, the
  bounds) — also pays #205's spec debt (the revoke door had no section);
  §4 route table gains `POST /federation/revoke`, `POST/GET
  /federation/outbox`; the in-flight levers paragraph names the author's
  revoke as the third lever.
- `CHANGELOG.md` [Unreleased] Added — the entry.
- Test-file counts 185 → 186 in README.md / CONTRIBUTING.md / CLAUDE.md
  (docs-inventory-accuracy gate).
