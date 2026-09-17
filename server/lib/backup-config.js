// =============== MYCELIUM — SQLite backup config resolution ===============
// Task 186 §1 (AUDIT-lab-clockwork-2026-09-12): the in-place backup ran on
// hardcoded 6h × 10 retention — 4.8 GB on an 8 GB board that also carries the
// Mac-side off-box set. D6 (Gilbert: "go") = defaults drop to 1/day × 3, with
// two override layers. This module is the single place resolution lives, and
// it returns WHICH layer won so the boot log never resolves silently.

function pickPositiveInt(raw) {
  var v = parseInt(raw, 10);
  return (Number.isFinite(v) && v >= 1) ? v : null;
}

// opts: { env, getConfig } — getConfig(key) reads instance_config (or any
// store; tests stub it). Precedence per key: env > instance_config > default.
// The deploy env is the override layer (12-factor); instance_config tunes a
// deployed box when env is unset; invalid values fall through, never NaN.
export function resolveBackupSettings(opts) {
  var env = opts.env || {};
  var getConfig = opts.getConfig || function () { return null; };

  function resolve(envKey, configKey, fallback) {
    var v = pickPositiveInt(env[envKey]);
    if (v !== null) return { value: v, source: 'env' };
    v = pickPositiveInt(getConfig(configKey));
    if (v !== null) return { value: v, source: 'instance_config' };
    return { value: fallback, source: 'default' };
  }

  var interval = resolve('BACKUP_INTERVAL_HOURS', 'backup_interval_hours', 24);
  var retention = resolve('MAX_BACKUPS', 'max_backups', 3);

  return {
    intervalHours: interval.value,
    maxBackups: retention.value,
    sources: { intervalHours: interval.source, maxBackups: retention.source },
  };
}
