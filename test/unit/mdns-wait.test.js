import { test, expect, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 2026-08-26: after a restore, jetson-verify.sh browsed mDNS seconds after
// `systemctl start`. Avahi had not re-advertised yet, so a single 8s browse
// window reported mdns=FAIL and the script printed "RESTORE FAILED — INTERVENE"
// over a restore that had in fact succeeded (/health ok, service active, git at
// the rollback point; the same verify was all-green a minute later). A false
// alarm on the restore path is how the real alarm gets ignored.
//
// mdns-wait.sh is the fix: condition-based waiting with a bounded deadline.
// "Still settling" = an Add record appears on a LATER browse attempt inside the
// deadline. "Advertiser dead" = the deadline expires with no Add record ever.
// The stub below stands in for dns-sd; the dead-advertiser test proves the wait
// can still go red, because a check that cannot fail is not a check.

const SCRIPT = join(process.cwd(), 'scripts/lib/mdns-wait.sh')
const SERVICE = '_mycelium._tcp'
let dir, stub

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mdns-wait-'))
  stub = join(dir, 'dns-sd-stub')
  // The stub always prints the browse header — which CONTAINS the service name.
  // That is the trap the real check already dodges: a match on the header means
  // the gate greps its own input and can never fail.
  writeFileSync(stub, `#!/usr/bin/env bash
t=8; service=""
while [ $# -gt 0 ]; do
  case "$1" in
    -t) t="$2"; shift 2 ;;
    -B) service="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "Browsing for \${service}.local"
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${dir}/count"
case "$STUB_MODE" in
  up)
    echo "11:22:33.444  Add        2   6 local.   \${service}.      mycelium jetson01"
    ;;
  dead)
    sleep "$t"
    ;;
  settling)
    if [ "$n" -ge 2 ]; then
      echo "11:22:33.444  Add        2   6 local.   \${service}.      mycelium jetson01"
    else
      sleep "$t"
    fi
    ;;
esac
exit 0
`)
  chmodSync(stub, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(mode, extraEnv = {}) {
  return execFileSync('bash', [SCRIPT, SERVICE], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      DNS_SD_BIN: stub,
      STUB_MODE: mode,
      MDNS_DEADLINE_S: '2',
      MDNS_BROWSE_T: '1',
      ...extraEnv,
    },
  })
}

test('an advertiser that is already up passes on the first browse', () => {
  // A single browse attempt (count=1) with MDNS_DEADLINE_S=2 proves no waiting
  // happened: had the wait burned even one deadline it would have thrown. No
  // wall-clock assertion — under a loaded machine spawn time alone flakes it.
  run('up')
  expect(readFileSync(join(dir, 'count'), 'utf8').trim()).toBe('1')
})

test('a dead advertiser still fails — after the bounded deadline, not before', () => {
  // The stub prints the header (with the service name in it) every attempt and
  // never an Add record. The wait must spend the whole deadline trying, then
  // give up: tolerant of settling, not blind to absence.
  const started = Date.now()
  expect(() => run('dead')).toThrow()
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(1900)   // waited out the 2s deadline
  expect(elapsed).toBeLessThan(8000)             // and stayed bounded
})

test('an advertiser that appears on a later attempt — the post-restart settling window — passes', () => {
  run('settling', { MDNS_DEADLINE_S: '10' })
  const calls = Number(readFileSync(join(dir, 'count'), 'utf8').trim())
  expect(calls).toBeGreaterThanOrEqual(2)        // it actually re-browsed
})

test('the settling diagnostic goes to stderr, never stdout — the name=ok contract stays parseable', () => {
  // deploy-jetson.sh parses jetson-verify.sh stdout line-by-line on "=".
  // mdns-wait.sh must keep stdout silent so the caller owns the contract.
  const out = run('settling', { MDNS_DEADLINE_S: '10' })
  expect(out).toBe('')
})

test('a missing service argument is refused', () => {
  expect(() => execFileSync('bash', [SCRIPT], {
    encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, DNS_SD_BIN: stub, STUB_MODE: 'up' },
  })).toThrow()
})
