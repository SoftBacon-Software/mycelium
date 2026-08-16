# Orderly deploys for Mycelium on jetson01 — design

**Date:** 2026-08-16 · **Status:** approved, not yet implemented
**Author:** m5Max · **Approved by:** Gilbert

## The problem

Deploying the platform to jetson01 is a hand operation with no record that can be
trusted. Five things compound:

1. **Two trees on the box, and the documented one is wrong.** The running server's
   cwd is `/home/grb/mycelium` (`systemd` unit: `WorkingDirectory=/home/grb/mycelium`,
   `ExecStart=/home/grb/mycelium/start-platform.sh`, `User=grb`, `Restart=always`).
   `~/Projects/mycelium` on the Jetson is a stale decoy. The current runbook names
   the decoy, so three separate checks on 2026-08-16 reported "the mDNS advertiser
   is absent" when it is present in the real tree.

2. **`DEPLOYED_VERSION` is stale and unenforced.** It reads
   `commit: 03d374d2`, `branch: security-backport-20260802`, `deployed: 2026-08-03`.
   But `server/lib/mdns-advertise.js` on the box is dated **2026-08-07** — files
   landed after the stamp and nothing updated it. The only record of what is
   deployed is currently false, and no mechanism would have caught that.

3. **Deploys come from whatever branch had the fix.** The deployed commit is from
   `security-backport-20260802`, not `master`. There is no trunk to deploy *from*:
   **48 of 55 local branches are unmerged into `master`.**

4. **`node_modules` is deliberately desynced.** The stamp says
   `CODE ONLY. package.json/package-lock NOT deployed (node_modules unchanged).`
   That caveat is a standing drift generator.

5. **Git is unusable on the box — for one fixable reason.** `git` 2.34.1 IS
   installed. `/home/grb/mycelium/.git` is a *file* containing
   `gitdir: /Users/grb/Projects/mycelium/.git/worktrees/mycelium-deploy`, a path
   that exists only on the Mac. Every git command therefore fails, which is why
   the runbook resorts to content-hash comparison. Fix the pointer and that whole
   class of workaround disappears.

### Measured drift (2026-08-16)

Deployed tree vs `master`, `server/` + `plugins/` JS only:

| | count | what |
|---|---|---|
| Only on Jetson | 5 | `server/lib/mdns-advertise.js` + 4 pre-refactor files (`server/db/boot.js`, `server/db/overview.js`, `server/db/workqueue.js`, `server/routes/misc.js`) |
| Only on `master` | 18 | the route godfile-split (`routes/approvals.js`, `files.js`, `orgs.js`, `spend.js`, …) |
| On both, differing | 50 | |

The box predates master's route/db godfile split. **Deploying master is a version
leap, not a patch** — which is exactly why hand-copying has been avoided, which is
why the box has drifted further. That loop is the thing to break.

### Verified preconditions (checked 2026-08-16, not assumed)

- **`git` 2.34.1 is installed on the Jetson.** The only thing broken is the `.git`
  pointer. §2 is therefore a pointer fix, not a tooling problem.
- **The deployed commit `03d374d2` is reachable** — it lives on
  `security-backport-20260802`, which is pushed to `origin` and `backup`. §2 can
  position the checkout at exactly what the box claims to be.
- **`master` does NOT contain the deployed commit** (53 commits on the backport
  branch are not in master). This is expected, not alarming: the backport line took
  master's security fixes and applied them *down* onto the old pre-decomposition
  structure the box runs ("backport … onto the decomposed line"). **`master` has
  those fixes natively** — `server/lib/security-headers.js` exists on both — so the
  version leap does not regress SSRF/IDOR/HSTS/CSP/drone hardening. This must be
  re-confirmed per-fix during §1 rather than taken from this paragraph.
- **`server/data/`, `.env` and `node_modules` are all gitignored.** Later checkouts
  will leave the 150 MB database, secrets, and installed deps alone. This is what
  makes approach A safe without a state migration.
- **One piece of unshipped work found:** `server/profiles.json` (deployment
  profiles, commit `79f0b7e`) is on the backport branch but on neither `master` nor
  the box. It is **not** a deploy blocker — nothing is running it. Whether it should
  land is a separate decision, out of scope here.

## Non-goals

- Merging the other 47 unmerged branches. Only what the box legitimately runs.
- Moving the database or `.env` out of the deploy tree (that is approach B, deferred).
- Containerizing (approach C, deferred).
- Zero-downtime deploys. A short restart is acceptable.

## Approach

**Make the Jetson a real git checkout.** Git stops being a thing we work around and
becomes the record of what is deployed. `git describe` answers "what is running";
`git status` answers "has anyone touched it" — the question nothing could answer on
2026-08-07 when the stray files landed.

Rejected: *release directories + symlink flip* (atomic, seconds-long rollback, but
requires migrating a live 150 MB `mycelium.db` and `.env` out of the tree — the
risky operation we are trying to make rare; revisit once the trunk is clean).
Rejected: *containers* (right long-term answer, wrong change this week: arm64 image
pipeline + DB volume migration + a new failure surface, all at once).

## Design

### §1 — Reconcile the trunk

- Land `8923882` (`server/lib/mdns-advertise.js` + wiring) onto `master`. It is
  reviewed code and it is what the box actually runs; master is missing something
  real. Do **not** re-implement it.
- **Prove** the other four Jetson-only files are legacy superseded by master's
  split, not orphaned work: for each, show master contains the functionality
  elsewhere. A deploy will delete them, so this must be evidence, not assumption.
- Tag `master` with an annotated tag once it contains everything the box
  legitimately runs.

### §2 — Convert the box to a real checkout, changing no code

The step that kills the disease. **No file contents change.**

1. Rollback tarball of the current tree (`COPYFILE_DISABLE=1`; use `tar -T <filelist>`
   — zsh does not word-split unquoted `$(...)`, which once sent 15 filenames to
   `tar` as one).
2. DB backup via Python `sqlite3.Connection.backup()` against a `file:...?mode=ro`
   URI (hot, WAL-consistent; there is no `sqlite3` CLI on the box). Then
   `PRAGMA integrity_check` **the result** and print row counts. A backup you did
   not open is not a backup. The real DB is `server/data/mycelium.db` (~150 MB);
   the repo-root `mycelium.db` is a 0-byte decoy.
3. Replace the broken `.git` pointer with a real repository positioned at the
   commit the box claims (`03d374d2`), non-destructively — the working tree is not
   touched, so `git status` then reports the true drift for the first time.
4. Record that drift as the answer to "what actually shipped on 08-07".
5. Confirm `server/data/`, `.env`, and `node_modules` are gitignored so later
   checkouts leave state alone.

**Verification for §2:** the service is never restarted, `/health` is unchanged
throughout, and `git status` output is captured as the drift record.

### §3 — Deploy as a repo script, not a memory

`scripts/deploy-jetson.sh`, versioned alongside the code. Every step fails loud.

1. **Preflight** — box reachable by name (`jetson01.local`, not an IP); working
   tree **clean**, else refuse. That check *is* the drift detector.
2. **Refuse anything but an annotated tag reachable from `master`.** No branches,
   no bare commits.
3. **Backup** — DB (as §2) + record the current commit as the rollback point.
4. **Ship** — `git fetch --tags && git checkout <tag>`.
5. **Dependencies** — `npm ci` when `package-lock.json` changed, retiring the
   "CODE ONLY" caveat. Note `node` is nvm-managed and **not on PATH for
   non-interactive SSH**; use the absolute path or source nvm explicitly.
6. **Restart** — `systemctl restart mycelium.service`; sudo password from the Mac
   keychain (`security find-generic-password -s velum-sudo-jetson01 -w` piped to
   `sudo -S -p ""`). Copy files as `grb` so nothing lands root-owned.
7. **Verify behaviour, not exit codes** — "service is active" is not proof:
   - `/health` returns ok;
   - `dns-sd -B _mycelium._tcp` shows the `jetson01` advertiser (the capability
     that silently dies if the advertiser is lost);
   - smoke legs 3 (substrate), 4 (coordination) and 7 (discover) pass from the Mac.
8. **Auto-rollback** on any verification failure: `git checkout <previous>`,
   restart, re-verify, and report the failure loudly.
9. **Stamp** — regenerate `DEPLOYED_VERSION` *from git*. Human convenience only;
   git is now the truth.

### §4 — Make future drift loud

A `lab_check` probe asserting the box's `git describe` matches the expected tag and
the working tree is clean. Nothing today would notice a repeat of 08-07.

Also retire the wrong path from `reference_jetson_deploy_runbook`: the deploy tree
is `/home/grb/mycelium`.

### §5 — Prove the rollback by breaking it on purpose

A gate you cannot break is not a gate. Before trusting the machinery with the
version leap, deploy a tag engineered to fail verification and confirm it rolls
back cleanly and reports red.

## Sequencing (load-bearing)

**§2 and the version leap are separate deploys.**

1. §1 reconcile trunk → tag
2. §2 convert to checkout at *current* code (no-op deploy)
3. §5 prove rollback works
4. **Then** ship the 18-new / 50-changed / 5-removed leap as the first real deploy

Bundling the mechanism change with the content leap means a failure cannot be
attributed to either. Do not combine them.

## Risks

- **The version leap is large.** 50 changed files including `server/db.js` and the
  route split; `npm ci` may change runtime behaviour after months of a frozen
  `node_modules`. Mitigated by: rollback proven first (§5), DB backed up and opened,
  behavioural verification, auto-rollback.
- **`Restart=always` fights a half-finished deploy.** A crash mid-checkout restarts
  into a partial tree. Mitigated by stop → deploy → start ordering rather than
  deploying under a live service.
- **The advertiser could be lost in the leap** if §1 is skipped — that is the exact
  failure this work exists to prevent, and why §1 is first.
- **The deployed line and `master` are different structures, not different
  versions.** The box runs pre-decomposition `server/db/boot.js` /
  `server/routes/misc.js`; master runs the split. Nothing about the leap is
  incremental, so partial success is not a meaningful state — it either lands whole
  and verifies, or it rolls back whole.
- **Schema migrations** may be required across a jump this size. Unknown until §1;
  if the leap needs a migration, it is gated behind the verified DB backup and the
  rollback must be proven to restore the pre-migration DB, not just the code.
