# God-file decomposition — safe, systematic, Round-gated

**Target:** `server/routes/mycelium.js` — 6,852 lines, **284 routes across 42 domains**,
all already `asyncHandler`-wrapped. (`server/db.js`, 4,449 lines, is a *separate later
campaign* using this same method — out of scope here.)

**Goal:** turn one 6,852-line god file into a thin ~200-line mounting file + ~42 domain
modules of 50–300 lines, **without changing the behavior of a single route.**

---

## The invariant that makes this safe

Decomposition is *only* moving handlers between files. The thing that must never change
is the **route contract**: every `METHOD /api/mycelium/<path>` and its middleware chain.

`test/refactor/route-manifest.mjs` captures that contract by walking the real mounted
`router.stack` (ground truth, not a regex). Snapshot committed at
`test/refactor/route-manifest.snapshot` (284 routes: 125 GET / 74 POST / 52 PUT / 33 DELETE).

```
node test/refactor/route-manifest.mjs --check   # exit 1 if any route is lost / re-pathed / added
```

A route silently dropped, re-pathed, or duplicated by a bad move **fails the gate
mechanically** — that is the #1 decomposition risk, and it can no longer pass unseen.
(Auth/behavior preservation is carried by the 43 existing tests — `auth-roles`,
`directive-and-upload-auth`, `guardrails-route-coverage`, etc. — plus the Round, since
`asyncHandler` hides per-route middleware names from the manifest.)

## The method: strangler-fig by domain

Per domain, **one PR**:

1. Move the domain's handlers **verbatim** into `server/routes/<domain>.js`, exporting
   `register(router, deps)` (or a sub-router mounted at the domain prefix).
2. The god file `import`s + mounts the module. Net route table: identical.
3. **Extract ≠ refactor.** No logic change in a move PR — not even a rename. Improving a
   handler is a *separate, later* PR, gated separately. This is the load-bearing rule:
   it keeps every diff a pure move the manifest + a move-only `git diff` can prove.

Shared helpers (`asyncHandler`, `checkGuardrails`, `parseIntParam`, `apiError`, guards,
db access — the ~360 lines of top-of-file functions) are extracted **first** into
`server/routes/_shared.js` (or passed via `deps`), before any domain that needs them.

## The gate per extraction (the Round dogfood)

An extraction lands only if **all** hold:
- `route-manifest.mjs --check` → byte-identical (no route changed)
- full test suite green (`npm test`, 43 files)
- `git diff` is **move-only** (extracted lines leave the god file and reappear unchanged)
- a **Round** passes — the adversarial "did anything actually change?" audit that caught
  the hollow-guard the squad's own checks missed on mycelium-mcp

One domain = one PR = independently revertible. A failed Round reverts *that* domain only.

## Order (risk ascending)

1. `_shared.js` (the helpers everything imports)
2. **Pilot + small self-contained domains:** `/bugs` (6), `/feedback` (4), `/concepts` (7),
   `/events` (3), `/skills` (6) — build the harness + confidence
3. **Mid:** `/tasks` (14), `/plans` (11), `/channels` (13), `/context` (13), `/inbox` (8)
4. **Cross-cutting last:** `/agents` (18), `/admin` (18), `/drones` (32), `/plugins` (14)

## Execution

m5Max builds the safety net (done: extractor + snapshot) and lands the **pilot** (`/bugs`)
as the reference cycle. That cycle becomes the template the **squad** replicates across the
remaining ~41 domains via the repo-maintainer front door — each extraction Round-gated.
This is the maintainer loop dogfooding on our own platform.

**Safe because:** the manifest catches route-contract changes mechanically · extract-≠-refactor
keeps every diff a provable move · one-domain-per-PR bounds blast radius to one domain ·
the Round adds the adversarial audit on top of the tests.
