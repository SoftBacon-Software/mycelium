# Core hardening drive — June 30 / July 1, 2026

A full external audit of the core router (`server/routes/mycelium.js`), the
semantic-memory plugin, and the SDK, followed by a fix drive. The pipeline:
an external model (GLM-5.2) audited each surface and emitted coded findings;
the local squad (Ada plan → Lucy code → Echo verify) implemented fixes inside
fired workflows under server-side gates; every diff got a frontier byte-review
plus a clean-worktree test run before landing. Findings were coded
C (critical) / H (high) / M (medium).

## What landed where

| Codes | Finding | PR |
|---|---|---|
| — | Squad batch: residency plugin, workflow fixes, SDK stop-hang, SM correctness, host-header | #142 |
| SM P0#1 | `embedding_api_key` echoed back on PUT /memory/config | #143 |
| SDK 2×H+M | Overlapping heartbeats, orphaned tasks, missing fetch timeout | #144 |
| SM P1×3 | searchVector collapse, task-completion content loss, N+1 hoist | #145 |
| SM design | Scoped drone embed auth, sqlite-vec cleanup | #146 |
| C1, H3, C4 | Directive auth bypass (privilege from `req.body.from`), pre-auth file upload | #147 |
| H8, M4 | Project scope on rerun/approvals, transactional done-cascade | #148 |
| C3, H1 | bcrypt-fallback DoS bound, wrong-tool escapeHtml on project_id | #149 |
| M1 | checkGuardrails wired into 8 uncovered write routes | #150 |
| C2, H7, M7, H2 | Registry SHA pin, unref'd cleanup timers, health-patrol SSE broadcast, liveness-write debounce | this PR |

## Deferred by design (documented, not changed)

### M2 — SSE `data` field is double-stringified (intentional)

`emitEvent`'s live broadcast sends `data: {...,"data":"{\"…\"}"}` — the inner
`data` field is a JSON **string**, not an object. This is the wire contract,
not a bug: the on-connect replay path reads events straight from the DB, where
`createEvent` stores `data` as a JSON string, so live broadcasts re-stringify
to match. Every SSE consumer receives `data` as a string on **both** paths and
parses it itself. Removing the inner stringify would fork the live vs replay
wire format and break existing clients. An inline note now guards the site in
`emitEvent`.

### M5 — bare `parseInt(...)` vs the `parseIntParam(...)` helper (cosmetic drift)

The router defines a safe `parseIntParam` helper near the top of the file, but
~39 bare `parseInt(` calls remain (a subset of them parse request params). No
exploitable path was found on the checked routes — a `NaN` id falls through to
not-found. This is convention drift, not a vulnerability. Convention going
forward: new code uses `parseIntParam` for anything request-derived; sweep the
remainder opportunistically when those lines are touched anyway.

## Receipts

Every fix in the table above landed with tests (unit suite grown along the
drive; 235 tests / 34 files green at close). Fix implementation was local-squad
work inside gated workflows; the frontier model's role was judgment: audit
adjudication, byte-review of each diff, and the one-way-door checks (e.g.
verifying the pinned registry commit exists upstream and resolves before C2
landed).
