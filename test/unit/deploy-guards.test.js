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
    })).toThrow(/annotated/i)
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

  test('a filename with shell metacharacters is data, not code', () => {
    // The porcelain output is passed through the environment precisely so a
    // filename like this cannot be executed. Parsing it must not choke either.
    const v = parseDriftVerdict('?? server/`whoami`.js\n?? server/${HOME}.js\n')
    expect(v.clean).toBe(false)
    expect(v.entries).toHaveLength(2)
  })

  test('null/undefined input is treated as clean, not a crash', () => {
    expect(parseDriftVerdict(null)).toEqual({ clean: true, entries: [] })
    expect(parseDriftVerdict(undefined)).toEqual({ clean: true, entries: [] })
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

  test('a non-array rolls back rather than passing by accident', () => {
    expect(decideRollback(undefined).rollback).toBe(true)
    expect(decideRollback(null).rollback).toBe(true)
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

  test('says git wins, so the file is never mistaken for the source of truth', () => {
    const out = renderDeployedVersion({
      tag: 't', commit: 'c', subject: 's', deployedAt: 'd', from: 'f',
    })
    expect(out).toMatch(/git is the truth/)
    expect(out).toMatch(/do not hand-edit/)
  })
})
