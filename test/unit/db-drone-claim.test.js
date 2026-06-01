import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the REAL db.js drone work-claim functions against a fresh temp DB.
// This is the safety-critical scheduling core: claimDroneJob runs inside
// db.transaction and the UPDATE ... WHERE status='pending' guard is what
// stops two drones double-claiming a job. releaseStaleClaimedJobs (Bug #137)
// auto-fails jobs stuck >1h. db.js reads DATA_DIR at module-eval time, so set
// it before the dynamic import. pool:'forks' isolates this file's module
// state. initDB() writes only to the temp DATA_DIR — never the live
// mycelium.db.

let tmpDataDir
let db
let raw // getDB() handle, used ONLY to backdate started_at for stale tests

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-drone-claim-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
  raw = db.getDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// Backdate a claimed job's started_at by `hours` so the stale-timeout path
// (started_at < datetime('now','-1 hour')) is exercised deterministically
// without sleeping. Touches only this row's started_at.
function backdateStartedAt(jobId, hours) {
  raw
    .prepare(
      "UPDATE drone_jobs SET started_at = datetime('now', ?) WHERE id = ?"
    )
    .run('-' + hours + ' hours', jobId)
}

describe('claimDroneJob — capability matching', () => {
  test('claims a pending job whose requires[] are all in the drone capabilities', () => {
    const id = db.createDroneJob(
      'cpu render',
      'echo hi',
      {},
      ['cpu'],
      'm5Max',
      0
    )
    expect(db.getDroneJob(id).status).toBe('pending')

    const claimed = db.claimDroneJob('drone-cpu-1', ['cpu'])
    expect(claimed).toBeTruthy()
    expect(claimed.id).toBe(id)
    // The claim actually mutated the row (not just a stale read).
    const fresh = db.getDroneJob(id)
    expect(fresh.status).toBe('claimed')
    expect(fresh.drone_id).toBe('drone-cpu-1')
    expect(fresh.started_at).toBeTruthy()
  })

  test('a gpu job is NOT claimable by a cpu-only drone', () => {
    const gpuJob = db.createDroneJob(
      'gpu train',
      '',
      {},
      ['gpu'],
      'm5Max',
      0
    )

    // cpu-only drone must not get the gpu job; with nothing else claimable it
    // returns null and the job stays pending for a capable drone.
    const claimed = db.claimDroneJob('drone-cpu-2', ['cpu'])
    expect(claimed).toBeNull()
    expect(db.getDroneJob(gpuJob).status).toBe('pending')

    // A drone advertising gpu (superset caps) claims it.
    const gpuClaim = db.claimDroneJob('drone-gpu-1', ['cpu', 'gpu'])
    expect(gpuClaim).toBeTruthy()
    expect(gpuClaim.id).toBe(gpuJob)
    expect(db.getDroneJob(gpuJob).status).toBe('claimed')
  })

  test('a multi-requirement job needs ALL caps present (partial match is skipped)', () => {
    const job = db.createDroneJob(
      'needs gpu+cuda',
      '',
      {},
      ['gpu', 'cuda'],
      'm5Max',
      0
    )

    // Drone has gpu but not cuda → must NOT claim.
    expect(db.claimDroneJob('drone-partial', ['cpu', 'gpu'])).toBeNull()
    expect(db.getDroneJob(job).status).toBe('pending')

    // Drone with both caps claims it.
    const claimed = db.claimDroneJob('drone-full', ['gpu', 'cuda'])
    expect(claimed.id).toBe(job)
  })

  test('empty / no-capability drone returns null when only a cpu job is queued', () => {
    const job = db.createDroneJob('cpu only', '', {}, ['cpu'], 'm5Max', 0)
    expect(db.claimDroneJob('drone-nocaps', [])).toBeNull()
    expect(db.getDroneJob(job).status).toBe('pending')
    // Cleanup-claim so this job doesn't bleed into ordering tests' expectations.
    db.claimDroneJob('drone-cleanup', ['cpu'])
  })

  test('empty queue returns null', () => {
    // Drain any stragglers first.
    let guard = 0
    while (db.claimDroneJob('drone-drain', ['cpu', 'gpu', 'cuda']) && guard < 100) {
      guard++
    }
    // Now the pending queue is empty → null regardless of caps.
    expect(db.claimDroneJob('drone-empty', ['cpu', 'gpu'])).toBeNull()
  })
})

describe('claimDroneJob — priority / created_at ordering', () => {
  test('higher priority is claimed before lower priority', () => {
    const low = db.createDroneJob('low pri', '', {}, ['cpu'], 'm5Max', 1)
    const high = db.createDroneJob('high pri', '', {}, ['cpu'], 'm5Max', 9)

    // Even though `low` was created first, priority DESC wins.
    const first = db.claimDroneJob('drone-pri', ['cpu'])
    expect(first.id).toBe(high)

    const second = db.claimDroneJob('drone-pri', ['cpu'])
    expect(second.id).toBe(low)
  })

  test('same priority → earliest created_at (FIFO) is claimed first', () => {
    const a = db.createDroneJob('first', '', {}, ['cpu'], 'm5Max', 5)
    const b = db.createDroneJob('second', '', {}, ['cpu'], 'm5Max', 5)
    // AUTOINCREMENT id is monotonic, so a < b. ORDER BY created_at ASC with id
    // as the natural tiebreak means `a` (lower id, created first) wins.
    const first = db.claimDroneJob('drone-fifo', ['cpu'])
    expect(first.id).toBe(a)
    const second = db.claimDroneJob('drone-fifo', ['cpu'])
    expect(second.id).toBe(b)
  })
})

describe('claimDroneJob — profile setup gate', () => {
  test('job needing an UN-assigned profile is skipped', () => {
    db.createDroneProfile('prof-unassigned', 'Unassigned Profile')
    const job = db.createDroneJob(
      'profiled job',
      '',
      {},
      ['cpu'],
      'm5Max',
      0,
      null,
      'main',
      'prof-unassigned'
    )

    // Drone has the capability but no assignment for the profile → skip.
    expect(db.claimDroneJob('drone-no-assign', ['cpu'])).toBeNull()
    expect(db.getDroneJob(job).status).toBe('pending')
  })

  test('job needing an assigned-but-NOT-setup profile is skipped; claimable once setup_done', () => {
    db.createDroneProfile('prof-setup', 'Setup Profile')
    const job = db.createDroneJob(
      'needs setup',
      '',
      {},
      ['cpu'],
      'm5Max',
      0,
      null,
      'main',
      'prof-setup'
    )

    // Assigned but setup_done = 0 → skip.
    db.assignDroneProfile('drone-setup-1', 'prof-setup')
    expect(db.claimDroneJob('drone-setup-1', ['cpu'])).toBeNull()
    expect(db.getDroneJob(job).status).toBe('pending')

    // Once setup is marked done, the SAME drone can claim it.
    db.markProfileSetupDone('drone-setup-1', 'prof-setup', 'checksum-abc')
    const claimed = db.claimDroneJob('drone-setup-1', ['cpu'])
    expect(claimed).toBeTruthy()
    expect(claimed.id).toBe(job)
    expect(db.getDroneJob(job).status).toBe('claimed')
  })

  test('profile gating is per-drone: drone B with setup_done can claim a profiled job drone A could not', () => {
    db.createDroneProfile('prof-perdrone', 'Per-Drone Profile')
    const job = db.createDroneJob(
      'per-drone profiled',
      '',
      {},
      ['cpu'],
      'm5Max',
      0,
      null,
      'main',
      'prof-perdrone'
    )

    // Drone A assigned but not set up → cannot claim.
    db.assignDroneProfile('drone-A', 'prof-perdrone')
    expect(db.claimDroneJob('drone-A', ['cpu'])).toBeNull()
    expect(db.getDroneJob(job).status).toBe('pending')

    // Drone B assigned AND set up → claims it.
    db.assignDroneProfile('drone-B', 'prof-perdrone')
    db.markProfileSetupDone('drone-B', 'prof-perdrone', 'sum')
    const claimed = db.claimDroneJob('drone-B', ['cpu'])
    expect(claimed.id).toBe(job)
    expect(db.getDroneJob(job).drone_id).toBe('drone-B')
  })
})

describe('claimDroneJob — double-claim guard (UPDATE ... WHERE status=pending)', () => {
  test('a second drone cannot re-claim an already-claimed job', () => {
    const job = db.createDroneJob('contended', '', {}, ['cpu'], 'm5Max', 7)

    const firstClaim = db.claimDroneJob('drone-winner', ['cpu'])
    expect(firstClaim.id).toBe(job)
    expect(db.getDroneJob(job).drone_id).toBe('drone-winner')

    // The job is no longer pending; a second claimer with no other work gets null.
    const secondClaim = db.claimDroneJob('drone-loser', ['cpu'])
    expect(secondClaim).toBeNull()

    // Ownership is unchanged — the loser did not steal the job.
    expect(db.getDroneJob(job).drone_id).toBe('drone-winner')
    expect(db.getDroneJob(job).status).toBe('claimed')
  })

  test('with one pending job, two sequential claimers split work (winner gets it, loser gets null)', () => {
    const only = db.createDroneJob('single', '', {}, ['cpu'], 'm5Max', 3)

    const claimA = db.claimDroneJob('drone-x', ['cpu'])
    const claimB = db.claimDroneJob('drone-y', ['cpu'])

    // Exactly one of them got the job; the other got null. No double-execution.
    const got = [claimA, claimB].filter((c) => c && c.id === only)
    expect(got.length).toBe(1)
    const nulls = [claimA, claimB].filter((c) => c === null)
    expect(nulls.length).toBe(1)
  })
})

describe('releaseStaleClaimedJobs — Bug #137 (>1h auto-fail)', () => {
  test('a job claimed >1h ago is auto-failed; a freshly-claimed job is left alone', () => {
    const stale = db.createDroneJob('stale work', '', {}, ['cpu'], 'm5Max', 0)
    const fresh = db.createDroneJob('fresh work', '', {}, ['cpu'], 'm5Max', 0)

    // Claim both (high priority drained first; both are cpu, same pri → FIFO).
    const c1 = db.claimDroneJob('drone-stale', ['cpu'])
    const c2 = db.claimDroneJob('drone-stale', ['cpu'])
    const claimedIds = [c1.id, c2.id]
    expect(claimedIds).toContain(stale)
    expect(claimedIds).toContain(fresh)

    // Backdate ONLY the stale job's claim to 2 hours ago.
    backdateStartedAt(stale, 2)

    const released = db.releaseStaleClaimedJobs('drone-stale')
    const releasedIds = released.map((j) => j.id)
    expect(releasedIds).toEqual([stale])

    // Stale job auto-failed with completed_at + error set.
    const staleRow = db.getDroneJob(stale)
    expect(staleRow.status).toBe('failed')
    expect(staleRow.completed_at).toBeTruthy()
    expect(staleRow.error).toMatch(/stale_timeout/)

    // Fresh job (claimed seconds ago) is untouched.
    const freshRow = db.getDroneJob(fresh)
    expect(freshRow.status).toBe('claimed')
    expect(freshRow.error).toBeNull()
  })

  test('droneId-scoped release only fails that drone\'s stale jobs', () => {
    const jobA = db.createDroneJob('drone-a stale', '', {}, ['cpu'], 'm5Max', 0)
    const jobB = db.createDroneJob('drone-b stale', '', {}, ['cpu'], 'm5Max', 0)

    db.claimDroneJob('drone-aaa', ['cpu']) // claims jobA (lower id, FIFO)
    db.claimDroneJob('drone-bbb', ['cpu']) // claims jobB

    // Both are stale.
    backdateStartedAt(jobA, 3)
    backdateStartedAt(jobB, 3)

    // Scope to drone-aaa only.
    const released = db.releaseStaleClaimedJobs('drone-aaa')
    expect(released.map((j) => j.id)).toEqual([jobA])

    expect(db.getDroneJob(jobA).status).toBe('failed')
    // drone-bbb's job is still claimed — it was out of scope.
    expect(db.getDroneJob(jobB).status).toBe('claimed')

    // Now an unscoped sweep catches the remaining stale job.
    const releasedAll = db.releaseStaleClaimedJobs()
    expect(releasedAll.map((j) => j.id)).toContain(jobB)
    expect(db.getDroneJob(jobB).status).toBe('failed')
  })

  test('release with no stale jobs is a no-op returning an empty list', () => {
    // Fresh claim, not backdated.
    db.createDroneJob('not stale', '', {}, ['cpu'], 'm5Max', 0)
    db.claimDroneJob('drone-recent', ['cpu'])

    const released = db.releaseStaleClaimedJobs('drone-recent')
    expect(released).toEqual([])
  })

  test('a job claimed just UNDER 1h ago is NOT released (boundary)', () => {
    const job = db.createDroneJob('boundary', '', {}, ['cpu'], 'm5Max', 0)
    db.claimDroneJob('drone-boundary', ['cpu'])

    // 59 minutes ago — still inside the 1h window, must survive.
    raw
      .prepare(
        "UPDATE drone_jobs SET started_at = datetime('now', '-59 minutes') WHERE id = ?"
      )
      .run(job)

    const released = db.releaseStaleClaimedJobs('drone-boundary')
    expect(released).toEqual([])
    expect(db.getDroneJob(job).status).toBe('claimed')
  })
})
