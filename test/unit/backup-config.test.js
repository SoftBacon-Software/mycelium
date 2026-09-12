import { describe, test, expect } from 'vitest'

// Task 186 §1 (AUDIT-lab-clockwork-2026-09-12): the in-place SQLite backup was
// hardcoded — every 6h, keep 10 — 4.8 GB on an 8 GB board that ALSO holds the
// Mac-side 13 GB off-box set. D6 (Gilbert: "go") = defaults drop to 1/day × 3,
// overridable from env (deploy layer) and instance_config (admin layer).
//
// resolveBackupSettings is the single place that resolution lives, so the boot
// log can name WHICH layer won (no silent precedence).

import { resolveBackupSettings } from '../../server/lib/backup-config.js'

describe('backup config resolution (task 186 §1)', () => {
  test('defaults are the D6 shape: every 24h, keep 3', () => {
    var r = resolveBackupSettings({ env: {}, getConfig: () => null })
    expect(r.intervalHours).toBe(24)
    expect(r.maxBackups).toBe(3)
    expect(r.sources.intervalHours).toBe('default')
    expect(r.sources.maxBackups).toBe('default')
  })

  test('env overrides the default', () => {
    var r = resolveBackupSettings({ env: { BACKUP_INTERVAL_HOURS: '6', MAX_BACKUPS: '10' }, getConfig: () => null })
    expect(r.intervalHours).toBe(6)
    expect(r.maxBackups).toBe(10)
    expect(r.sources.intervalHours).toBe('env')
    expect(r.sources.maxBackups).toBe('env')
  })

  test('instance_config applies when env is unset (admin tuning without a redeploy)', () => {
    var r = resolveBackupSettings({
      env: {},
      getConfig: (key) => (key === 'backup_interval_hours' ? '12' : null),
    })
    expect(r.intervalHours).toBe(12)
    expect(r.sources.intervalHours).toBe('instance_config')
  })

  test('env wins over instance_config when both are set (deploy layer is the override)', () => {
    var r = resolveBackupSettings({
      env: { BACKUP_INTERVAL_HOURS: '6' },
      getConfig: (key) => (key === 'backup_interval_hours' ? '12' : null),
    })
    expect(r.intervalHours).toBe(6)
    expect(r.sources.intervalHours).toBe('env')
  })

  test('invalid values fall through to the next layer, never NaN the timer', () => {
    var r = resolveBackupSettings({
      env: { BACKUP_INTERVAL_HOURS: 'banana', MAX_BACKUPS: '0' },
      getConfig: (key) => (key === 'max_backups' ? '-2' : null),
    })
    expect(r.intervalHours).toBe(24)
    expect(r.sources.intervalHours).toBe('default')
    expect(r.maxBackups).toBe(3)
    expect(r.sources.maxBackups).toBe('default')
  })

  test('each key resolves independently', () => {
    var r = resolveBackupSettings({
      env: { MAX_BACKUPS: '7' },
      getConfig: (key) => (key === 'backup_interval_hours' ? '48' : null),
    })
    expect(r.intervalHours).toBe(48)
    expect(r.sources.intervalHours).toBe('instance_config')
    expect(r.maxBackups).toBe(7)
    expect(r.sources.maxBackups).toBe('env')
  })
})
