// console-lib.test.js — the console's pure helpers (public/console/lib.js).
// The honesty rule is code: these pin the "—" paths, the hue mapping and the
// provenance chips so a refactor can't quietly start inventing values.
import { describe, it, expect } from 'vitest';
import {
  parseStamp, fmtAge, ageAgo, valueOrDash, hueOf, wfVerdict, lessonHue,
  provenanceChip, truncate, firstLine, stripPrefix, nameHue, pick, parseLimit,
} from '../../public/console/lib.js';

const NOW = Date.parse('2026-09-20T20:00:00Z');

describe('parseStamp', () => {
  it('reads platform "YYYY-MM-DD HH:MM:SS" as UTC', () => {
    expect(parseStamp('2026-09-20 20:00:00')).toBe(NOW);
  });
  it('reads ISO strings and epoch numbers', () => {
    expect(parseStamp('2026-09-20T20:00:00Z')).toBe(NOW);
    expect(parseStamp(1789934400)).toBe(NOW); // seconds → ms
  });
  it('garbage and empties are null, never invented', () => {
    expect(parseStamp('')).toBeNull();
    expect(parseStamp('not a time')).toBeNull();
    expect(parseStamp(null)).toBeNull();
  });
});

describe('fmtAge', () => {
  it('renders the human ladder', () => {
    expect(fmtAge(NOW - 5e3, NOW)).toBe('just now');
    expect(fmtAge(NOW - 40e3, NOW)).toBe('40s');
    expect(fmtAge(NOW - 4 * 60e3, NOW)).toBe('4m');
    expect(fmtAge(NOW - 2 * 3600e3, NOW)).toBe('2h');
    expect(fmtAge(NOW - 3 * 86400e3, NOW)).toBe('3d');
  });
  it('unparseable input → null (the caller renders "—")', () => {
    expect(fmtAge('garbage', NOW)).toBeNull();
  });
});

describe('ageAgo', () => {
  it('suffixes ago but reads bare just now, and renders — when absent', () => {
    expect(ageAgo(NOW - 5e3, NOW)).toBe('just now');
    expect(ageAgo(NOW - 4 * 60e3, NOW)).toBe('4m ago');
    expect(ageAgo(null, NOW)).toBe('—');
    expect(ageAgo('garbage', NOW)).toBe('—');
  });
});

describe('valueOrDash — the honesty render', () => {
  it('present values carry their age', () => {
    const v = valueOrDash('4/3 up', NOW - 60e3, NOW);
    expect(v.text).toBe('4/3 up');
    expect(v.stale).toBe(false);
    expect(v.age).toBe('1m');
  });
  it('absent values are a dash, flagged stale', () => {
    for (const absent of [null, undefined, '']) {
      const v = valueOrDash(absent, NOW, NOW);
      expect(v.text).toBe('—');
      expect(v.stale).toBe(true);
    }
  });
});

describe('hueOf — color is status only', () => {
  it('maps the platform vocabulary', () => {
    expect(hueOf('ok')).toBe('ok');
    expect(hueOf('online')).toBe('ok');
    expect(hueOf('completed')).toBe('ok');
    expect(hueOf('claimed')).toBe('info');
    expect(hueOf('unreachable')).toBe('warn');
    expect(hueOf('failed')).toBe('crit');
    expect(hueOf('down')).toBe('crit');
  });
  it('unknown words are dim, never guessed', () => {
    expect(hueOf('quantum-flux')).toBe('dim');
    expect(hueOf('')).toBe('dim');
    expect(hueOf(null)).toBe('dim');
  });
});

describe('wfVerdict', () => {
  it('terminal statuses carry a verdict word', () => {
    expect(wfVerdict({ status: 'completed' })).toEqual({ word: 'PASS', hue: 'ok' });
    expect(wfVerdict({ status: 'failed' })).toEqual({ word: 'FAIL', hue: 'crit' });
    expect(wfVerdict({ status: 'cancelled' })).toEqual({ word: 'STOP', hue: 'crit' });
  });
  it('in-flight statuses stay lowercase-honest and hue-coded', () => {
    expect(wfVerdict({ status: 'pending' })).toEqual({ word: 'PENDING', hue: 'warn' });
    expect(wfVerdict({ status: 'claimed' })).toEqual({ word: 'CLAIMED', hue: 'info' });
  });
  it('absent status renders a dash, not a guess', () => {
    expect(wfVerdict({}).word).toBe('—');
  });
});

describe('lessonHue / provenanceChip', () => {
  it('lessons hue by recorded outcome, then by rc', () => {
    expect(lessonHue({ metadata: { outcome: 'PASS' } })).toBe('ok');
    expect(lessonHue({ metadata: { outcome: 'FAIL' } })).toBe('crit');
    expect(lessonHue({ metadata: { rc: '0' } })).toBe('ok');
    expect(lessonHue({ metadata: { rc: '1' } })).toBe('crit');
    expect(lessonHue({ metadata: {} })).toBe('info');
  });
  it('provenance chips: director / inferred / the honest "?"', () => {
    expect(provenanceChip({ metadata: { authority: 'director' } }).word).toBe('director');
    expect(provenanceChip({ metadata: { origin: 'inferred-0.6' } }).word).toBe('inferred');
    expect(provenanceChip({ metadata: {} }).word).toBe('?');
    expect(provenanceChip({}).word).toBe('?');
  });
});

describe('text shaping', () => {
  it('truncate keeps the ellipsis inside the budget', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
  });
  it('firstLine cuts the body, stripPrefix drops the lane wrapper', () => {
    expect(firstLine('one\ntwo')).toBe('one');
    expect(stripPrefix('[lane K-kira] [for Gilbert] task 89 DONE')).toBe('task 89 DONE');
    expect(stripPrefix('LESSON: a gate must be red first')).toBe('a gate must be red first');
  });
  it('nameHue is deterministic for rails', () => {
    expect(nameHue('kira')).toBe(nameHue('kira'));
    expect(['ok', 'info', 'warn', 'accent']).toContain(nameHue('jarvis'));
  });
});

describe('pick / parseLimit', () => {
  it('pick falls back on absent paths', () => {
    expect(pick({ a: { b: 1 } }, 'a.b', '—')).toBe(1);
    expect(pick({ a: {} }, 'a.b', '—')).toBe('—');
    expect(pick(null, 'a.b', '—')).toBe('—');
  });
  it('parseLimit clamps garbage to the default', () => {
    expect(parseLimit('7', 50)).toBe(7);
    expect(parseLimit('x', 50)).toBe(50);
    expect(parseLimit('-3', 50)).toBe(50);
  });
});
