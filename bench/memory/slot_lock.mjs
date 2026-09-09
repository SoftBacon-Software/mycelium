// bench/memory/slot_lock.mjs — the 3090 slot lock.
//
// One benchmark run uses ONE served slot at a time (writes are sequential per
// arm, answers sequential per question). On 2026-09-09 three Mem0 smokes died
// at the arm's 30-minute bound because a single extraction call waited behind
// ANOTHER client's long generation on the box's one slot (600 s read timeout ×
// 3 client retries = 1800 s). A run therefore refuses to start when every
// served slot is already held by a live run — the lock dir is per user and
// outside any worktree, so a lane's smoke in its own checkout sees the
// director's run and vice versa. A dead holder (pid gone) is swept, never
// counted. `--no-slot-lock` on run.mjs is the escape hatch, stamped in the
// regime.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCK_DIR = path.join(os.homedir(), '.cache', 'mycelium-bench', 'slot-locks');

/** True when `pid` is alive (EPERM = alive but not ours). */
export function pidAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** GET <box>/props → total_slots; null when the box does not answer sanely. */
export async function probeTotalSlots(boxUrl, { fetchFn = fetch, timeoutMs = 6000 } = {}) {
  try {
    const res = await fetchFn(`${boxUrl.replace(/\/+$/, '')}/props`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json();
    return Number.isInteger(j.total_slots) && j.total_slots > 0 ? j.total_slots : null;
  } catch {
    return null;
  }
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Live holders in `dir`; stale files (dead pid, unreadable) are removed. */
export function readHolders(dir, { isAlive = pidAlive } = {}) {
  if (!fs.existsSync(dir)) return [];
  const holders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^slot-\d+\.lock$/.test(name)) continue;
    const file = path.join(dir, name);
    const rec = readRecord(file);
    if (rec && Number.isInteger(rec.pid) && isAlive(rec.pid)) {
      holders.push({ ...rec, file });
    } else {
      try { fs.unlinkSync(file); } catch { /* raced with its owner's release */ }
    }
  }
  return holders.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

/**
 * Take one slot or throw. Returns { file, pid, total_slots, holders_before, release() }.
 * `totalSlots` is what the box serves (probeTotalSlots); the caller decides the
 * fallback when the box does not answer.
 */
export function acquireSlotLock({
  dir = DEFAULT_LOCK_DIR,
  totalSlots,
  pid = process.pid,
  label = '',
  isAlive = pidAlive,
  now = () => new Date(),
} = {}) {
  if (!Number.isInteger(totalSlots) || totalSlots < 1) throw new Error(`slot lock: totalSlots must be a positive integer (got ${totalSlots})`);
  fs.mkdirSync(dir, { recursive: true });
  const holders = readHolders(dir, { isAlive });
  if (holders.length >= totalSlots) {
    const who = holders.map((h) => `pid ${h.pid} (${h.label || 'unlabelled'}, since ${h.started_at})`).join('; ');
    throw new Error(
      `3090 slots busy: ${holders.length}/${totalSlots} held — ${who}. ` +
        'A benchmark run never shares a slot with another client (a call queued behind a long generation is how the ' +
        `Mem0 smokes died); wait for the holders to finish, or run with --no-slot-lock deliberately. Lock dir: ${dir}`,
    );
  }
  const file = path.join(dir, `slot-${pid}.lock`);
  fs.writeFileSync(file, JSON.stringify({ pid, label, started_at: now().toISOString() }), { flag: 'wx' });
  return {
    file,
    pid,
    total_slots: totalSlots,
    holders_before: holders.length,
    release() {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
  };
}
