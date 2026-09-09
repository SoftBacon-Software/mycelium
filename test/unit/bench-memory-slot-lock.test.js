import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSlotLock, readHolders, pidAlive, probeTotalSlots } from '../../bench/memory/slot_lock.mjs';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-lock-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const alive = new Set();
const isAlive = (pid) => alive.has(pid);

describe('slot lock — one benchmark run per served slot', () => {
  beforeEach(() => alive.clear());

  it('takes a free slot and writes a holder record the next caller can read', () => {
    alive.add(100);
    const h = acquireSlotLock({ dir, totalSlots: 1, pid: 100, label: 'run-a mem0', isAlive, now: () => new Date('2026-09-09T18:00:00Z') });
    expect(h.holders_before).toBe(0);
    expect(fs.existsSync(h.file)).toBe(true);
    const holders = readHolders(dir, { isAlive });
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ pid: 100, label: 'run-a mem0', started_at: '2026-09-09T18:00:00.000Z' });
  });

  it('refuses when every served slot is held by a LIVE run, naming the holders', () => {
    alive.add(100);
    acquireSlotLock({ dir, totalSlots: 1, pid: 100, label: 'director mem0', isAlive });
    alive.add(200);
    expect(() => acquireSlotLock({ dir, totalSlots: 1, pid: 200, label: 'lane smoke', isAlive })).toThrow(/1\/1 held — pid 100 \(director mem0/);
    expect(fs.existsSync(path.join(dir, 'slot-200.lock'))).toBe(false);
  });

  it('a two-slot window admits two runs and refuses the third', () => {
    alive.add(1); alive.add(2); alive.add(3);
    acquireSlotLock({ dir, totalSlots: 2, pid: 1, label: 'mem0', isAlive });
    const second = acquireSlotLock({ dir, totalSlots: 2, pid: 2, label: 'mycelium-extract', isAlive });
    expect(second.holders_before).toBe(1);
    expect(() => acquireSlotLock({ dir, totalSlots: 2, pid: 3, label: 'lane', isAlive })).toThrow(/2\/2 held/);
  });

  it('a dead holder is swept, not counted', () => {
    alive.add(100);
    acquireSlotLock({ dir, totalSlots: 1, pid: 100, label: 'died mid-run', isAlive });
    alive.delete(100); // the process is gone, its lock file is not
    alive.add(200);
    const h = acquireSlotLock({ dir, totalSlots: 1, pid: 200, label: 'next', isAlive });
    expect(h.holders_before).toBe(0);
    expect(fs.existsSync(path.join(dir, 'slot-100.lock'))).toBe(false);
  });

  it('release frees the slot; a garbage lock file is swept', () => {
    alive.add(100); alive.add(200);
    const h = acquireSlotLock({ dir, totalSlots: 1, pid: 100, isAlive });
    h.release();
    fs.writeFileSync(path.join(dir, 'slot-999.lock'), 'not json');
    expect(() => acquireSlotLock({ dir, totalSlots: 1, pid: 200, isAlive })).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'slot-999.lock'))).toBe(false);
  });

  it('rejects a nonsensical slot count instead of admitting everyone', () => {
    expect(() => acquireSlotLock({ dir, totalSlots: 0, pid: 1, isAlive })).toThrow(/positive integer/);
    expect(() => acquireSlotLock({ dir, totalSlots: undefined, pid: 1, isAlive })).toThrow(/positive integer/);
  });

  it('pidAlive: ESRCH is dead, EPERM is alive', () => {
    expect(pidAlive(1, () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; })).toBe(false);
    expect(pidAlive(1, () => { const e = new Error('x'); e.code = 'EPERM'; throw e; })).toBe(true);
    expect(pidAlive(1, () => undefined)).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('probeTotalSlots reads total_slots from /props and is null when the box does not answer', async () => {
    const calls = [];
    const fetchOk = async (url) => { calls.push(url); return { ok: true, json: async () => ({ total_slots: 2 }) }; };
    expect(await probeTotalSlots('http://box:11434/', { fetchFn: fetchOk })).toBe(2);
    expect(calls[0]).toBe('http://box:11434/props');
    expect(await probeTotalSlots('http://box:11434', { fetchFn: async () => ({ ok: false }) })).toBe(null);
    expect(await probeTotalSlots('http://box:11434', { fetchFn: async () => { throw new Error('ECONNREFUSED'); } })).toBe(null);
    expect(await probeTotalSlots('http://box:11434', { fetchFn: async () => ({ ok: true, json: async () => ({}) }) })).toBe(null);
  });
});
