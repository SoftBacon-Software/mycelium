# Jetson Orderly Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand `cp -a` deploys to jetson01 with a real git checkout on the box plus a versioned deploy script that refuses drift, verifies behaviour, and auto-rolls-back.

**Architecture:** The Jetson's `/home/grb/mycelium` becomes a genuine git repository (today its `.git` is a file pointing at a Mac-only path, which is the sole reason git "doesn't work" there). Deployable units are annotated tags reachable from `master`. Decision rules that must never silently pass — is this a valid tag, is the tree clean, should we roll back — live in a pure ESM module under vitest; the orchestration that must talk to ssh/systemd lives in shell.

**Tech Stack:** Node 25 (ESM, `"type": "module"`), vitest, bash, Python 3.10 (on the Jetson, for the sqlite backup — there is no `sqlite3` CLI there), systemd, avahi/mDNS.

## Global Constraints

- **The deploy tree is `/home/grb/mycelium`.** NOT `~/Projects/mycelium` — that is a stale decoy tree on the Jetson. Every path in this plan is the real one.
- **Address the box by name: `jetson01.local`.** Never an IP.
- **Node on the Jetson is nvm-managed and NOT on PATH**, even in a login shell. Use the absolute path `/home/grb/.nvm/versions/node/v25.9.0/bin/node` (and `.../bin/npm`).
- **Never put backticks in a `git commit -m` message.** Use `git commit -F <file>`. Backticks inside a double-quoted bash string are command substitution; this previously uninstalled 46 packages from a live venv.
- **zsh does not word-split unquoted `$(...)`.** Pass file lists to `tar` with `-T <filelist>`.
- **`export COPYFILE_DISABLE=1`** before any `tar` on macOS, or AppleDouble `._` files ride along and break `*.js` globs.
- **Copy files to the box as `grb`.** Only `systemctl` needs sudo; sudo password comes from the Mac keychain: `security find-generic-password -s velum-sudo-jetson01 -w` piped to `sudo -S -p ""`.
- **Verify behaviour, not exit codes.** "Service is active" is not proof of a working deploy.
- **The real database is `/home/grb/mycelium/server/data/mycelium.db`** (~150 MB). The repo-root `mycelium.db` is a 0-byte decoy.
- **Service unit facts:** `User=grb`, `WorkingDirectory=/home/grb/mycelium`, `ExecStart=/home/grb/mycelium/start-platform.sh`, `Restart=always`, `RestartSec=5`.

---

### Task 1: Land the mDNS advertiser on master

The advertiser is deployed code on the box but exists on no mainline branch. Until master contains it, any deploy from master silently removes DISCOVER — the deploy-or-join handshake that makes this an agent platform rather than a chat client.

**Files:**
- Modify: `master` branch (merge of `feature/m5max/mdns-advertiser`, commit `8923882`)
- Adds: `server/lib/mdns-advertise.js`, wiring in `server/index.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a `master` containing `server/lib/mdns-advertise.js`; Task 2 tags it.

- [ ] **Step 1: Confirm the advertiser is genuinely absent from master and present on the branch**

```bash
cd ~/Projects/mycelium
git cat-file -e master:server/lib/mdns-advertise.js 2>/dev/null && echo "ON MASTER" || echo "absent from master"
git cat-file -e feature/m5max/mdns-advertiser:server/lib/mdns-advertise.js && echo "on branch"
```

Expected: `absent from master` and `on branch`.

- [ ] **Step 2: Diff the branch's advertiser against the file actually running on the box**

The box's copy is the ground truth for what works. If they differ, the branch is not what is deployed and that must be understood before merging.

```bash
cd ~/Projects/mycelium
git show feature/m5max/mdns-advertiser:server/lib/mdns-advertise.js | shasum -a 256
ssh jetson01.local 'sha256sum ~/mycelium/server/lib/mdns-advertise.js'
```

Expected: identical hashes. If they differ, stop and diff the contents before proceeding — do not merge a version that was never run.

- [ ] **Step 3: Merge the advertiser branch into master**

```bash
cd ~/Projects/mycelium
git checkout master
git merge --no-ff feature/m5max/mdns-advertiser
```

If conflicts appear, resolve them by reading both sides. Do not re-implement the advertiser; it exists and was reviewed.

- [ ] **Step 4: Prove the four Jetson-only legacy files are superseded, not orphaned**

A deploy will delete `server/db/boot.js`, `server/db/overview.js`, `server/db/workqueue.js`, and `server/routes/misc.js` from the box. Prove master carries their functionality in the split files rather than assuming it.

```bash
cd ~/Projects/mycelium
for f in server/db/boot.js server/db/overview.js server/db/workqueue.js server/routes/misc.js; do
  echo "=== $f ==="
  ssh jetson01.local "grep -oE '^(export )?(async )?function [a-zA-Z_]+|^module.exports' ~/mycelium/$f 2>/dev/null" | head -20
done
```

For each exported symbol listed, find it on master:

```bash
cd ~/Projects/mycelium
git grep -n "<symbol>" master -- server | head -3
```

Expected: every symbol resolves somewhere on master. Record the mapping in the commit message. **If any symbol has no home on master, stop** — that is unshipped work and merging past it loses it.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: PASS. Record the exact pass/fail/skip counts; this is the baseline Task 9 compares against.

- [ ] **Step 6: Commit the supersession evidence**

Write the symbol mapping from Step 4 to a file and commit it, so the deletion in Task 9 is justified in the record rather than in someone's memory.

```bash
cd ~/Projects/mycelium
# write docs/runbooks/jetson-legacy-file-supersession.md with the Step 4 mapping
git add docs/runbooks/jetson-legacy-file-supersession.md
git commit -F /tmp/supersession-msg.txt
```

---

### Task 2: Tag master as the first deployable

**Files:**
- Modify: `master` (annotated tag only)

**Interfaces:**
- Consumes: master containing the advertiser (Task 1)
- Produces: annotated tag `deploy-2026-08-16` — the value `assertDeployableTag()` in Task 3 will accept, and the target Task 9 ships.

- [ ] **Step 1: Create the annotated tag**

```bash
cd ~/Projects/mycelium
git tag -a deploy-2026-08-16 -m "First orderly deployable: master + mDNS advertiser"
```

- [ ] **Step 2: Verify it is annotated and reachable from master**

```bash
cd ~/Projects/mycelium
git cat-file -t deploy-2026-08-16        # expect: tag  (NOT commit)
git merge-base --is-ancestor deploy-2026-08-16 master && echo REACHABLE
```

Expected: `tag` and `REACHABLE`. A lightweight tag is a `commit` object and must be rejected — that is what Task 3 tests.

- [ ] **Step 3: Push master and the tag**

```bash
cd ~/Projects/mycelium
git push origin master
git push origin deploy-2026-08-16
```

---

### Task 3: Deploy guard rules (pure, unit-tested)

The rules that must never silently pass. Kept pure so they are testable without a Jetson.

**Files:**
- Create: `scripts/lib/deploy-guards.js`
- Test: `test/unit/deploy-guards.test.js`

**Interfaces:**
- Consumes: nothing at runtime (pure functions)
- Produces:
  - `assertDeployableTag({ objectType, isAncestorOfMaster, name })` → `void`, throws `Error` on violation
  - `parseDriftVerdict(porcelainOutput)` → `{ clean: boolean, entries: string[] }`
  - `renderDeployedVersion({ tag, commit, subject, deployedAt, from })` → `string`
  - `decideRollback(verifications)` → `{ rollback: boolean, failed: string[] }` where `verifications` is `Array<{ name: string, ok: boolean }>`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/deploy-guards.test.js`:

```javascript
import { describe, test, expect } from 'vitest'
import {
  assertDeployableTag,
  parseDriftVerdict,
  renderDeployedVersion,
  decideRollback,
} from '../../scripts/lib/deploy-guards.js'

// These guards exist because jetson01 was deployed by hand from whatever branch
// held the fix, and DEPLOYED_VERSION went stale without anyone noticing (stamped
// 08-03 while files dated 08-07 sat on the box). Each rule below is one way that
// happened, turned into a refusal.

describe('assertDeployableTag', () => {
  test('accepts an annotated tag reachable from master', () => {
    expect(() => assertDeployableTag({
      objectType: 'tag', isAncestorOfMaster: true, name: 'deploy-2026-08-16',
    })).not.toThrow()
  })

  test('rejects a lightweight tag (a commit object, no provenance)', () => {
    expect(() => assertDeployableTag({
      objectType: 'commit', isAncestorOfMaster: true, name: 'quickfix',
    })).toThrow(/annotated/)
  })

  test('rejects a tag not reachable from master — the branch-deploy habit', () => {
    expect(() => assertDeployableTag({
      objectType: 'tag', isAncestorOfMaster: false, name: 'security-backport-20260802',
    })).toThrow(/master/)
  })

  test('rejects an empty target', () => {
    expect(() => assertDeployableTag({
      objectType: 'tag', isAncestorOfMaster: true, name: '',
    })).toThrow(/name/)
  })
})

describe('parseDriftVerdict', () => {
  test('empty porcelain output is clean', () => {
    expect(parseDriftVerdict('')).toEqual({ clean: true, entries: [] })
  })

  test('whitespace-only output is clean', () => {
    expect(parseDriftVerdict('\n  \n')).toEqual({ clean: true, entries: [] })
  })

  test('an untracked file is drift — this is the 08-07 case', () => {
    const v = parseDriftVerdict('?? server/lib/mdns-advertise.js\n')
    expect(v.clean).toBe(false)
    expect(v.entries).toEqual(['?? server/lib/mdns-advertise.js'])
  })

  test('modified and untracked entries are all reported', () => {
    const v = parseDriftVerdict(' M server/index.js\n?? server/lib/x.js\n')
    expect(v.clean).toBe(false)
    expect(v.entries).toHaveLength(2)
  })
})

describe('decideRollback', () => {
  test('all green does not roll back', () => {
    expect(decideRollback([{ name: 'health', ok: true }, { name: 'mdns', ok: true }]))
      .toEqual({ rollback: false, failed: [] })
  })

  test('any red rolls back and names what failed', () => {
    const d = decideRollback([
      { name: 'health', ok: true },
      { name: 'mdns', ok: false },
      { name: 'smoke-leg-7', ok: false },
    ])
    expect(d.rollback).toBe(true)
    expect(d.failed).toEqual(['mdns', 'smoke-leg-7'])
  })

  test('an empty verification list rolls back — verifying nothing is not passing', () => {
    expect(decideRollback([]).rollback).toBe(true)
  })
})

describe('renderDeployedVersion', () => {
  test('renders every provenance field from git facts', () => {
    const out = renderDeployedVersion({
      tag: 'deploy-2026-08-16',
      commit: 'abc1234',
      subject: 'First orderly deployable',
      deployedAt: '2026-08-16T20:00:00Z',
      from: 'Gilberts-MacBook-Pro',
    })
    expect(out).toMatch(/tag:\s+deploy-2026-08-16/)
    expect(out).toMatch(/commit:\s+abc1234/)
    expect(out).toMatch(/deployed:\s+2026-08-16T20:00:00Z/)
    expect(out).toMatch(/generated from git/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deploy-guards.test.js`
Expected: FAIL — cannot resolve `../../scripts/lib/deploy-guards.js`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/deploy-guards.js`:

```javascript
// Decision rules for deploying Mycelium to jetson01.
//
// Kept pure and separate from scripts/deploy-jetson.sh so each rule is testable
// without a Jetson. Every rule here is a past failure turned into a refusal:
// deploys came from whatever branch held the fix, and DEPLOYED_VERSION was a
// hand-written file that went stale without anyone noticing.

export function assertDeployableTag({ objectType, isAncestorOfMaster, name }) {
  if (!name) {
    throw new Error('deploy target: name is required')
  }
  if (objectType !== 'tag') {
    throw new Error(
      `deploy target ${name}: must be an ANNOTATED tag (git cat-file -t said ` +
      `"${objectType}"). A lightweight tag carries no tagger, date or message, ` +
      'so it cannot record who shipped what.'
    )
  }
  if (!isAncestorOfMaster) {
    throw new Error(
      `deploy target ${name}: not reachable from master. Deploying from a side ` +
      'branch is how the box ended up on security-backport-20260802 while master ' +
      'moved on without it.'
    )
  }
}

export function parseDriftVerdict(porcelainOutput) {
  const entries = (porcelainOutput || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  return { clean: entries.length === 0, entries }
}

export function decideRollback(verifications) {
  // An empty list means nothing was checked. Verifying nothing is not passing —
  // "service is active" was the old standard and it hid a stale deploy for days.
  if (!Array.isArray(verifications) || verifications.length === 0) {
    return { rollback: true, failed: ['no-verifications-ran'] }
  }
  const failed = verifications.filter((v) => !v.ok).map((v) => v.name)
  return { rollback: failed.length > 0, failed }
}

export function renderDeployedVersion({ tag, commit, subject, deployedAt, from }) {
  return [
    `tag:      ${tag}`,
    `commit:   ${commit}`,
    `subject:  ${subject}`,
    `deployed: ${deployedAt}`,
    `from:     ${from}`,
    '',
    '# generated from git by scripts/deploy-jetson.sh — do not hand-edit.',
    '# git is the truth; this file is a convenience. If they disagree, git wins.',
    '',
  ].join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deploy-guards.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mycelium
git add scripts/lib/deploy-guards.js test/unit/deploy-guards.test.js
git commit -F /tmp/guards-msg.txt
```

---

### Task 4: Hot database backup that proves itself

Runs **on the Jetson**. There is no `sqlite3` CLI there, and the DB is live with a WAL, so a file copy is not a backup. A backup nobody opened is not a backup.

**Files:**
- Create: `scripts/lib/jetson-db-backup.py`
- Test: `test/unit/jetson-db-backup.test.js` (drives the script against temp DBs)

**Interfaces:**
- Consumes: nothing
- Produces: CLI `python3 scripts/lib/jetson-db-backup.py <src.db> <dest.db>` → exit 0 with a JSON summary `{"tables": N, "rows": {...}, "integrity": "ok"}` on stdout; non-zero exit with a message on stderr if the copy fails integrity.

- [ ] **Step 1: Write the failing test**

Create `test/unit/jetson-db-backup.test.js`:

```javascript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// jetson01 has no sqlite3 CLI and a live WAL, so backups go through Python's
// sqlite3.Connection.backup(). The rule that matters: the script must OPEN the
// result and integrity-check it. A copy that was never opened has hidden a
// corrupt backup before.

const SCRIPT = join(process.cwd(), 'scripts/lib/jetson-db-backup.py')
let dir

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jetson-backup-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('backs up a live database and reports row counts', () => {
  const src = join(dir, 'src.db')
  const db = new Database(src)
  db.exec('CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT)')
  db.exec("INSERT INTO agents (name) VALUES ('lucy'), ('echo'), ('ada')")
  db.close()

  const dest = join(dir, 'dest.db')
  const out = execFileSync('python3', [SCRIPT, src, dest], { encoding: 'utf8' })
  const summary = JSON.parse(out)

  expect(summary.integrity).toBe('ok')
  expect(summary.rows.agents).toBe(3)
})

test('fails loudly when the destination cannot be verified', () => {
  const src = join(dir, 'missing.db')
  const dest = join(dir, 'dest2.db')
  expect(() => execFileSync('python3', [SCRIPT, src, dest], { encoding: 'utf8' }))
    .toThrow()
})

test('a corrupted result fails integrity — the check can actually go red', () => {
  const src = join(dir, 'src3.db')
  const db = new Database(src)
  db.exec('CREATE TABLE t (x INTEGER)')
  db.exec('INSERT INTO t VALUES (1)')
  db.close()

  const dest = join(dir, 'dest3.db')
  execFileSync('python3', [SCRIPT, src, dest], { encoding: 'utf8' })

  // Corrupt the verified copy, then re-verify it: proves the check is real.
  const buf = readFileSync(dest)
  buf.fill(0, 100, 400)
  writeFileSync(dest, buf)

  expect(() => execFileSync('python3', [SCRIPT, '--verify-only', dest], { encoding: 'utf8' }))
    .toThrow()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/jetson-db-backup.test.js`
Expected: FAIL — script does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/jetson-db-backup.py`:

```python
#!/usr/bin/env python3
"""Hot, WAL-consistent backup of the Mycelium database, verified by opening it.

Runs on jetson01, which has no sqlite3 CLI. The source is live and has a WAL, so
a file copy is not a backup -- this uses sqlite3.Connection.backup() against a
read-only URI. It then OPENS the result and integrity-checks it, because a copy
nobody opened has hidden a corrupt backup before.

    python3 jetson-db-backup.py <src.db> <dest.db>
    python3 jetson-db-backup.py --verify-only <db>

Exits non-zero, loudly, on any failure. Prints a JSON summary on success.
"""
import json
import sqlite3
import sys
from pathlib import Path


def verify(path):
    """Open a database and prove it is sound. Returns (integrity, row_counts)."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise SystemExit(f"FAIL: integrity_check on {path}: {integrity}")
        rows = {}
        tables = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for (name,) in tables:
            rows[name] = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        return integrity, rows
    finally:
        con.close()


def main(argv):
    if len(argv) == 3 and argv[1] == "--verify-only":
        integrity, rows = verify(argv[2])
        print(json.dumps({"integrity": integrity, "tables": len(rows), "rows": rows}))
        return 0

    if len(argv) != 3:
        raise SystemExit(__doc__)

    src, dest = Path(argv[1]), Path(argv[2])
    if not src.exists():
        raise SystemExit(f"FAIL: source database does not exist: {src}")
    if src.stat().st_size == 0:
        raise SystemExit(
            f"FAIL: source {src} is 0 bytes. The repo-root mycelium.db is a decoy; "
            "the real database is server/data/mycelium.db."
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(str(dest))
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()

    integrity, rows = verify(dest)
    print(json.dumps({
        "integrity": integrity,
        "tables": len(rows),
        "rows": rows,
        "src_bytes": src.stat().st_size,
        "dest_bytes": dest.stat().st_size,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/jetson-db-backup.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mycelium
git add scripts/lib/jetson-db-backup.py test/unit/jetson-db-backup.test.js
git commit -F /tmp/backup-msg.txt
```

---

### Task 5: Behavioural verification script

**Files:**
- Create: `scripts/lib/jetson-verify.sh`

**Interfaces:**
- Consumes: nothing
- Produces: CLI `bash scripts/lib/jetson-verify.sh` → prints one `name=ok` / `name=FAIL` line per check and exits non-zero if any failed. Checks: `health`, `mdns`, `smoke-leg-3`, `smoke-leg-4`, `smoke-leg-7`.

- [ ] **Step 1: Write the script**

Create `scripts/lib/jetson-verify.sh`:

```bash
#!/usr/bin/env bash
# Behavioural verification of a jetson01 deploy, run FROM THE MAC.
#
# "systemctl is-active" is not proof. Each check below is a capability that has
# broken silently before. mdns is here because DISCOVER -- the deploy-or-join
# handshake -- dies invisibly if the advertiser is lost, and the platform still
# looks perfectly healthy.
set -uo pipefail

SUBSTRATE="${SUBSTRATE_URL:-http://jetson01.local:3002}"
SMOKE="${SMOKE_SCRIPT:-$HOME/Projects/mycelium-agent/scripts/smoke_mycelium_agent.sh}"
rc=0

report() { # name ok|FAIL
  echo "$1=$2"
  [ "$2" = "ok" ] || rc=1
}

# 1. health
if curl -sS --max-time 10 "$SUBSTRATE/health" | grep -q '"status"'; then
  report health ok
else
  report health FAIL
fi

# 2. mDNS advertiser — the capability that dies quietly
if dns-sd -t 8 -B _mycelium._tcp local 2>/dev/null | grep -q "_mycelium._tcp"; then
  report mdns ok
else
  report mdns FAIL
fi

# 3/4/7. contract smoke legs (substrate, coordination, discover)
if [ -x "$SMOKE" ] || [ -f "$SMOKE" ]; then
  for leg in 3 4 7; do
    if bash "$SMOKE" "$leg" 2>&1 | grep -q "^PASS"; then
      report "smoke-leg-$leg" ok
    else
      report "smoke-leg-$leg" FAIL
    fi
  done
else
  report smoke-script-present FAIL
fi

exit $rc
```

- [ ] **Step 2: Make it executable and run it against the CURRENT box**

```bash
cd ~/Projects/mycelium
chmod +x scripts/lib/jetson-verify.sh
bash scripts/lib/jetson-verify.sh; echo "EXIT=$?"
```

Expected: all five lines `=ok`, `EXIT=0`. This is the pre-deploy baseline. If anything is already red, fix that before deploying anything.

- [ ] **Step 3: Prove the mdns check can go red (a gate you cannot break is not a gate)**

```bash
# Temporarily point the browse at a service type nobody advertises.
sed 's/_mycelium\._tcp/_nosuchsvc._tcp/' scripts/lib/jetson-verify.sh > /tmp/verify-broken.sh
bash /tmp/verify-broken.sh 2>&1 | grep mdns
```

Expected: `mdns=FAIL`. Delete `/tmp/verify-broken.sh` afterward.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/mycelium
git add scripts/lib/jetson-verify.sh
git commit -F /tmp/verify-msg.txt
```

---

### Task 6: The deploy orchestrator

**Files:**
- Create: `scripts/deploy-jetson.sh`

**Interfaces:**
- Consumes: `deploy-guards.js` (Task 3), `jetson-db-backup.py` (Task 4), `jetson-verify.sh` (Task 5)
- Produces: CLI `bash scripts/deploy-jetson.sh <tag> [--dry-run]`

- [ ] **Step 1: Write the script**

Create `scripts/deploy-jetson.sh`:

```bash
#!/usr/bin/env bash
# Deploy a tagged Mycelium release to jetson01. See
# docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md
set -euo pipefail

TAG="${1:?usage: deploy-jetson.sh <annotated-tag> [--dry-run]}"
DRY="${2:-}"
BOX=jetson01.local
TREE=/home/grb/mycelium                       # NOT ~/Projects/mycelium (decoy)
NODE=/home/grb/.nvm/versions/node/v25.9.0/bin/node
NPM=/home/grb/.nvm/versions/node/v25.9.0/bin/npm
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

say() { printf '\n=== %s ===\n' "$*"; }

# --- 1. guard the target -----------------------------------------------------
say "guard: $TAG"
OBJ_TYPE="$(git cat-file -t "$TAG" 2>/dev/null || echo none)"
if git merge-base --is-ancestor "$TAG" master 2>/dev/null; then ANC=true; else ANC=false; fi
node --input-type=module -e "
  import { assertDeployableTag } from '${HERE}/lib/deploy-guards.js'
  assertDeployableTag({ objectType: '${OBJ_TYPE}', isAncestorOfMaster: ${ANC}, name: '${TAG}' })
  console.log('guard ok: ${TAG}')
"

# --- 2. refuse a dirty box ---------------------------------------------------
say "drift check"
PORCELAIN="$(ssh "$BOX" "cd $TREE && git status --porcelain" 2>/dev/null || true)"
# Passed through the environment, never interpolated into the JS source: a
# filename containing a backtick or ${...} would otherwise be executed rather
# than parsed. Same class as the commit-message incident in Global Constraints.
PORCELAIN="$PORCELAIN" node --input-type=module -e "
  import { parseDriftVerdict } from '${HERE}/lib/deploy-guards.js'
  const v = parseDriftVerdict(process.env.PORCELAIN || '')
  if (!v.clean) {
    console.error('REFUSING: the box has uncommitted drift:')
    for (const e of v.entries) console.error('  ' + e)
    console.error('Resolve it deliberately — that drift is somebody\\'s undeployed work.')
    process.exit(1)
  }
  console.log('tree clean')
"

# --- 3. record the rollback point + back up the DB ---------------------------
say "backup"
PREV="$(ssh "$BOX" "cd $TREE && git rev-parse HEAD")"
echo "rollback point: $PREV"
# Ship the backup script rather than calling it inside $TREE: at the FIRST deploy
# the box is still at a commit that predates it, so an in-tree path would fail
# exactly when the backup matters most. /tmp is always current.
scp -q "$HERE/lib/jetson-db-backup.py" "$BOX:/tmp/jetson-db-backup.py"
ssh "$BOX" "mkdir -p /home/grb/backups && python3 /tmp/jetson-db-backup.py \
  $TREE/server/data/mycelium.db /home/grb/backups/mycelium-$STAMP.db"
ssh "$BOX" "cd /home/grb && tar czf backups/node_modules-$STAMP.tgz -C $TREE node_modules" || true

if [ "$DRY" = "--dry-run" ]; then
  echo "DRY RUN: stopping before any change. Guards passed, backup taken."
  exit 0
fi

# --- 4. stop, ship, deps, start ---------------------------------------------
# Stop first: Restart=always would otherwise relaunch into a half-updated tree.
say "deploy"
SUDO="$(security find-generic-password -s velum-sudo-jetson01 -w)"
ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl stop mycelium.service"
ssh "$BOX" "cd $TREE && git fetch --tags origin && git checkout -f '$TAG'"
if ! ssh "$BOX" "cd $TREE && git diff --quiet '$PREV' HEAD -- package-lock.json"; then
  echo "lockfile changed — npm ci"
  ssh "$BOX" "cd $TREE && $NPM ci --omit=dev"
fi
ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl start mycelium.service"
sleep 10

# --- 5. verify behaviour, roll back on any red -------------------------------
say "verify"
VERIFY_OUT="$(bash "$HERE/lib/jetson-verify.sh" || true)"
echo "$VERIFY_OUT"
JSON="$(echo "$VERIFY_OUT" | awk -F= 'BEGIN{printf "["} {printf "%s{\"name\":\"%s\",\"ok\":%s}", (NR>1?",":""), $1, ($2=="ok"?"true":"false")} END{printf "]"}')"
if ! node --input-type=module -e "
  import { decideRollback } from '${HERE}/lib/deploy-guards.js'
  const d = decideRollback(${JSON})
  if (d.rollback) { console.error('VERIFICATION RED: ' + d.failed.join(', ')); process.exit(1) }
  console.log('all checks green')
"; then
  say "ROLLING BACK to $PREV"
  ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl stop mycelium.service"
  ssh "$BOX" "cd $TREE && git checkout -f '$PREV'"
  ssh "$BOX" "cd $TREE && $NPM ci --omit=dev" || true
  ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl start mycelium.service"
  sleep 10
  bash "$HERE/lib/jetson-verify.sh" && echo "rollback verified green" || echo "ROLLBACK ALSO RED — INTERVENE"
  exit 1
fi

# --- 6. stamp from git -------------------------------------------------------
say "stamp"
COMMIT="$(git rev-parse --short "$TAG^{commit}")"
SUBJECT="$(git log -1 --format=%s "$TAG^{commit}")"
node --input-type=module -e "
  import { renderDeployedVersion } from '${HERE}/lib/deploy-guards.js'
  process.stdout.write(renderDeployedVersion({
    tag: '${TAG}', commit: '${COMMIT}', subject: \`${SUBJECT}\`,
    deployedAt: '$(date -u +%Y-%m-%dT%H:%M:%SZ)', from: '$(hostname -s)',
  }))
" | ssh "$BOX" "cat > $TREE/DEPLOYED_VERSION"

say "deployed $TAG ($COMMIT)"
```

- [ ] **Step 2: Make it executable and shell-check it**

```bash
cd ~/Projects/mycelium
chmod +x scripts/deploy-jetson.sh
bash -n scripts/deploy-jetson.sh && echo "syntax OK"
```

- [ ] **Step 3: Prove the tag guard refuses a bad target (before it can do harm)**

```bash
cd ~/Projects/mycelium
git tag lightweight-test master           # a lightweight tag
bash scripts/deploy-jetson.sh lightweight-test --dry-run; echo "EXIT=$?"
git tag -d lightweight-test
```

Expected: refuses with a message containing "annotated", `EXIT=1`. **It must not reach the backup step.**

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/mycelium
git add scripts/deploy-jetson.sh
git commit -F /tmp/deploy-msg.txt
```

---

### Task 7: Convert the box to a real checkout (no code change)

The step that kills the disease. **No file contents change and the service is never restarted.**

**Files:**
- Modify (on the Jetson): `/home/grb/mycelium/.git` (broken pointer → real repository)

**Interfaces:**
- Consumes: nothing
- Produces: a Jetson tree where `git status` and `git describe` work; the captured drift record for Task 11's runbook.

- [ ] **Step 1: Baseline — capture behaviour before touching anything**

```bash
cd ~/Projects/mycelium
bash scripts/lib/jetson-verify.sh | tee /tmp/pre-convert-verify.txt
```

Expected: all `=ok`. Do not proceed if not.

- [ ] **Step 2: Rollback tarball of the tree (code only, no node_modules/data)**

```bash
export COPYFILE_DISABLE=1
ssh jetson01.local 'cd /home/grb/mycelium && \
  find . -type f -not -path "./node_modules/*" -not -path "./server/data/*" -not -path "./.git*" > /tmp/tree-files.txt && \
  tar czf /home/grb/backups/pre-convert-$(date -u +%Y%m%dT%H%M%SZ).tgz -T /tmp/tree-files.txt'
```

- [ ] **Step 3: Verified DB backup**

```bash
scp scripts/lib/jetson-db-backup.py jetson01.local:/tmp/
ssh jetson01.local 'mkdir -p /home/grb/backups && python3 /tmp/jetson-db-backup.py \
  /home/grb/mycelium/server/data/mycelium.db \
  /home/grb/backups/pre-convert.db'
```

Expected: JSON with `"integrity": "ok"` and non-zero row counts. **Read the numbers.** If `tables` is 0, stop.

- [ ] **Step 4: Ship the repository as a bundle (the repo is private; a bundle needs no auth)**

```bash
cd ~/Projects/mycelium
git bundle create /tmp/mycelium.bundle --all
scp /tmp/mycelium.bundle jetson01.local:/tmp/
```

- [ ] **Step 5: Convert the pointer non-destructively**

`git reset --mixed` moves HEAD and the index but leaves every working-tree file untouched — so this reveals drift without changing a byte of running code.

```bash
ssh jetson01.local 'set -e
  cd /home/grb/mycelium
  mv .git .git.broken-pointer.bak
  git init -q
  git remote add origin /tmp/mycelium.bundle
  git fetch -q origin
  git reset --mixed 03d374d2
  echo "--- DRIFT (the truth, first time) ---"
  git status --porcelain | head -40
'
```

- [ ] **Step 6: Capture the drift record**

```bash
ssh jetson01.local 'cd /home/grb/mycelium && git status --porcelain' | tee /tmp/jetson-drift-2026-08-16.txt
wc -l /tmp/jetson-drift-2026-08-16.txt
```

Expected: `server/lib/mdns-advertise.js` appears (the 08-07 arrival), plus whatever else was hand-landed. **This file is the answer to "what actually shipped since 08-03" and belongs in Task 11's runbook.**

- [ ] **Step 7: Confirm state paths are ignored so future checkouts leave them alone**

```bash
ssh jetson01.local 'cd /home/grb/mycelium && for p in server/data .env node_modules; do
  printf "%-14s " "$p"; git check-ignore -q "$p" && echo ignored || echo "NOT IGNORED — STOP"; done'
```

Expected: all three `ignored`.

- [ ] **Step 8: Confirm nothing changed behaviourally**

```bash
cd ~/Projects/mycelium
bash scripts/lib/jetson-verify.sh | tee /tmp/post-convert-verify.txt
diff /tmp/pre-convert-verify.txt /tmp/post-convert-verify.txt && echo "IDENTICAL — no behavioural change"
```

Expected: identical, all `=ok`. The service was never restarted.

- [ ] **Step 9: Point the origin at the real remote and re-fetch**

```bash
ssh jetson01.local 'cd /home/grb/mycelium && \
  git remote set-url origin https://github.com/SoftBacon-Software/mycelium.git && \
  git remote -v'
```

Note: pushing is never needed from the box; fetching a private repo needs credentials. If the box cannot authenticate, keep the bundle workflow and re-ship a bundle per deploy — record whichever applies in Task 11.

---

### Task 8: Prove the rollback by breaking it on purpose

A gate you cannot break is not a gate. Do this **before** trusting the machinery with the version leap.

**Files:** none (operational)

**Interfaces:**
- Consumes: Tasks 6, 7
- Produces: evidence that auto-rollback restores a working box.

- [ ] **Step 1: Create a tag that will fail verification**

Branch from master, break the mDNS advertiser's registration on purpose, tag it.

```bash
cd ~/Projects/mycelium
git checkout -b test/deploy-rollback-proof master
```

Find the exported entry point and make it a no-op, so the platform starts
perfectly healthy but never registers the service — the precise shape of the
silent failure this whole design exists to catch:

```bash
cd ~/Projects/mycelium
grep -n "^export\|^async function\|^function" server/lib/mdns-advertise.js | head
```

Insert `return null` as the first statement of the exported start function, e.g.:

```javascript
export async function startAdvertiser(opts) {
  return null   // ROLLBACK PROOF ONLY — never merge. Advertises nothing.
  // ... original body unchanged below ...
}
```

Then commit and tag:

```bash
cd ~/Projects/mycelium
git add server/lib/mdns-advertise.js
git commit -F /tmp/rollback-proof-msg.txt
git tag -a deploy-rollback-proof -m "Deliberately broken advertiser: proves auto-rollback"
git push origin deploy-rollback-proof
```

Note: this tag is intentionally NOT reachable from master. To exercise the *rollback* path rather than the *guard* path, temporarily merge it to master, or run with the guard satisfied — pick one and record which.

- [ ] **Step 2: Deploy it and watch it fail and roll back**

```bash
cd ~/Projects/mycelium
bash scripts/deploy-jetson.sh deploy-rollback-proof; echo "EXIT=$?"
```

Expected: `mdns=FAIL`, `VERIFICATION RED: mdns`, then `ROLLING BACK`, then `rollback verified green`, `EXIT=1`.

- [ ] **Step 3: Confirm the box is genuinely healthy afterward**

```bash
cd ~/Projects/mycelium
bash scripts/lib/jetson-verify.sh; echo "EXIT=$?"
ssh jetson01.local 'cd /home/grb/mycelium && git describe --tags && git status --porcelain | wc -l'
```

Expected: all `=ok`, `EXIT=0`, tree clean, and the commit back at the pre-test one.

- [ ] **Step 4: Delete the proof tag and branch**

```bash
cd ~/Projects/mycelium
git push origin :refs/tags/deploy-rollback-proof
git tag -d deploy-rollback-proof
git branch -D test/deploy-rollback-proof
```

---

### Task 9: Ship the version leap

18 files arrive, 50 change, 5 are deleted. All-or-nothing: the box runs the pre-decomposition structure and master runs the split, so there is no meaningful partial state.

**Files:** none (operational)

**Interfaces:**
- Consumes: Tasks 2, 6, 7, 8
- Produces: jetson01 running `deploy-2026-08-16`.

- [ ] **Step 1: Dry run first**

```bash
cd ~/Projects/mycelium
bash scripts/deploy-jetson.sh deploy-2026-08-16 --dry-run; echo "EXIT=$?"
```

Expected: guard ok, tree clean, backup taken with real row counts, `EXIT=0`.

- [ ] **Step 2: Check whether the leap needs a schema migration**

```bash
cd ~/Projects/mycelium
git diff --stat 03d374d2 deploy-2026-08-16 -- server/db/migrations server/db/schema.sql 2>/dev/null | tail -5
git log --oneline 03d374d2..deploy-2026-08-16 -- server/db/migrations 2>/dev/null | head -10
```

If migrations are involved, confirm the pre-deploy DB backup restores the **pre-migration** state, not just the code — a rollback that restores code but leaves a migrated database is not a rollback. Record the finding either way.

- [ ] **Step 3: Deploy**

```bash
cd ~/Projects/mycelium
bash scripts/deploy-jetson.sh deploy-2026-08-16; echo "EXIT=$?"
```

Expected: all five verifications green, `DEPLOYED_VERSION` regenerated, `EXIT=0`. On any red it rolls back automatically — read the failure and stop.

- [ ] **Step 4: Confirm provenance is now self-describing**

```bash
ssh jetson01.local 'cd /home/grb/mycelium && git describe --tags && git status --porcelain | wc -l && cat DEPLOYED_VERSION'
```

Expected: `deploy-2026-08-16`, `0` drift lines, and a stamp whose tag matches `git describe`. The stamp and git agreeing is the whole point.

- [ ] **Step 5: Re-run the full contract smoke**

```bash
cd ~/Projects/mycelium-agent
for L in 1 2 3 4 5 6 7; do bash scripts/smoke_mycelium_agent.sh $L 2>&1 | grep -E "PASS|FAIL"; done
```

Expected: 7/7 PASS, matching the 2026-08-16 baseline.

---

### Task 10: Make future drift loud

**Files:**
- Modify: `~/Projects/jarvis/squad/lab_check.py` (add `check_jetson_deploy_drift`)

**Interfaces:**
- Consumes: Task 7 (the box is a real checkout)
- Produces: an hourly check that goes red when the box drifts or falls behind its expected tag.

- [ ] **Step 1: Read the existing check pattern**

```bash
grep -n "^def check_" ~/Projects/jarvis/squad/lab_check.py | head -10
sed -n "/def check_omlx_prefill_guard/,/^def /p" ~/Projects/jarvis/squad/lab_check.py | head -40
```

Follow whatever shape the neighbouring checks use for returning status.

- [ ] **Step 2: Add the check**

```python
def check_jetson_deploy_drift():
    """The box must match a known tag and carry no uncommitted drift.

    Nothing noticed when files landed on jetson01 on 2026-08-07 while
    DEPLOYED_VERSION still read 08-03. Now git answers, and this asks.
    """
    tree = "/home/grb/mycelium"
    expected = os.environ.get("JETSON_EXPECTED_TAG", "deploy-2026-08-16")
    cmd = [
        "ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", "jetson01.local",
        f"cd {tree} && git status --porcelain | wc -l && git describe --tags 2>/dev/null",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return ("FAIL", "jetson01 unreachable (ssh timeout)")
    if out.returncode != 0:
        return ("FAIL", f"ssh failed: {out.stderr.strip()[:120]}")

    lines = [l.strip() for l in out.stdout.splitlines() if l.strip()]
    if len(lines) < 2:
        return ("FAIL", f"could not read git state (got: {lines})")
    drift_count, described = lines[0], lines[1]

    if drift_count != "0":
        return ("FAIL", f"{drift_count} uncommitted change(s) in {tree} — deploy drift")
    if not described.startswith(expected):
        return ("FAIL", f"box is at '{described}', expected '{expected}'")
    return ("PASS", f"{described}, tree clean")
```

Register it alongside the other checks, following whatever registration shape Step 1 revealed.

- [ ] **Step 3: Prove it can go red**

```bash
ssh jetson01.local 'touch /home/grb/mycelium/DRIFT_CANARY'
python3 ~/Projects/jarvis/squad/lab_check.py 2>&1 | grep -i jetson
ssh jetson01.local 'rm /home/grb/mycelium/DRIFT_CANARY'
python3 ~/Projects/jarvis/squad/lab_check.py 2>&1 | grep -i jetson
```

Expected: FAIL with the canary present, PASS once removed. A check that cannot fail is not a check.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/jarvis
git add squad/lab_check.py
git commit -F /tmp/labcheck-msg.txt
```

---

### Task 11: Replace the runbook and retire the wrong path

**Files:**
- Create: `docs/runbooks/jetson-deploy.md`
- Update: memory `reference_jetson_deploy_runbook`

**Interfaces:**
- Consumes: everything above
- Produces: a runbook that names the right tree.

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/jetson-deploy.md` covering: the tree is `/home/grb/mycelium` (and `~/Projects/mycelium` on the box is a decoy — this cost three wrong conclusions on 2026-08-16); deploy with `bash scripts/deploy-jetson.sh <annotated-tag>`; git is the record, `DEPLOYED_VERSION` is a convenience; rollback is automatic on red and manual via `git checkout <prev> && systemctl restart`; the drift captured in Task 7 Step 6; whether the box fetches from GitHub or needs a bundle (from Task 7 Step 9).

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/mycelium
git add docs/runbooks/jetson-deploy.md
git commit -F /tmp/runbook-msg.txt
```

- [ ] **Step 3: Correct the memory**

Rewrite `~/.claude/projects/-Users-grb-Projects/memory/reference_jetson_deploy_runbook.md`: the deploy tree is `/home/grb/mycelium`; git DOES work there now; "verify by content hash" is superseded by `git status`; keep the DB-decoy, keychain-sudo, `COPYFILE_DISABLE` and `tar -T` traps, which remain true.

- [ ] **Step 4: Merge the branch to master and push**

```bash
cd ~/Projects/mycelium
git checkout master
git merge --no-ff deploy/m5max/jetson-orderly-deploy
npm test
git push origin master
```

Expected: tests pass before pushing.
