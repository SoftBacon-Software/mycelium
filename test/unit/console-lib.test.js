// console-lib.test.js — the console's pure helpers (public/console/lib.js).
// The honesty rule is code: these pin the "—" paths, the hue mapping and the
// provenance chips so a refactor can't quietly start inventing values.
import { describe, it, expect } from 'vitest';
import {
  parseStamp, fmtAge, ageAgo, valueOrDash, hueOf, wfVerdict, lessonHue,
  provenanceChip, truncate, firstLine, stripPrefix, nameHue, pick, parseLimit,
  stateSectionItems, countHue, receiptShape, deltaChip, barPct, chatHue,
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

describe('task 90 — stateSectionItems / countHue', () => {
  const state = {
    sections: [
      { id: 'engines', items: [{ k: 'oMLX :8780', status: 'ok' }, { k: 'ds4 :8000', status: 'ok' }, { k: 'mlx-serve', status: 'warn' }] },
      { id: 'box', items: [{ k: 'disk free', status: 'ok' }] },
    ],
  };
  it('reads a section by id, null when absent (the caller renders —)', () => {
    expect(stateSectionItems(state, 'engines')).toHaveLength(3);
    expect(stateSectionItems(state, 'nope')).toBeNull();
    expect(stateSectionItems(null, 'engines')).toBeNull();
    expect(stateSectionItems({}, 'engines')).toBeNull();
  });
  it('countHue counts only the given bucket, null on absent input', () => {
    expect(countHue(stateSectionItems(state, 'engines'), 'ok')).toBe(2);
    expect(countHue(stateSectionItems(state, 'engines'), 'warn')).toBe(1);
    expect(countHue(null, 'ok')).toBeNull();
  });
});

describe('task 90 — receiptShape names what a feed is missing, invents nothing', () => {
  it('a complete feed normalizes: hero, pairs with delta chips, nights', () => {
    const s = receiptShape({
      generated_at: '2026-09-20 02:00:00',
      on: 0.62, off: 0.5,
      pairs: [{ task_class: 'repair', on: 0.8, off: 0.6, verdict: 'PASS' }],
      nights: [{ date: '2026-09-19', on: 0.62, off: 0.5 }],
    });
    expect(s.ok).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.hero).toEqual({ on: 0.62, off: 0.5 });
    expect(s.pairs[0].delta).toEqual({ word: '+0.2pp', hue: 'ok' });
    expect(s.nights[0].date).toBe('2026-09-19');
  });
  it('an envelope-wrapped feed is unwrapped once', () => {
    const s = receiptShape({ receipt: { on: 1, off: 0, pairs: [], nights: [] } });
    expect(s.hero).toEqual({ on: 1, off: 0 });
  });
  it('a non-object or empty object names its missing fields', () => {
    expect(receiptShape(null).ok).toBe(false);
    expect(receiptShape('nope').missing).toEqual(['not a json object']);
    const s = receiptShape({});
    expect(s.ok).toBe(false);
    expect(s.missing).toEqual(['on (ON pass rate)', 'off (OFF pass rate)', 'pairs (per-pair table)', 'nights (nightly strip)']);
  });
  it('numeric strings are read, junk is a dash row', () => {
    const s = receiptShape({ on: '0.7', off: 'x', pairs: [{ name: 'plan' }], nights: [] });
    expect(s.hero.on).toBe(0.7);
    expect(s.hero.off).toBeNull();
    expect(s.pairs[0].delta).toEqual({ word: '—', hue: 'dim' });
  });
});

describe('task 90 — deltaChip / barPct / chatHue', () => {
  it('deltaChip is arithmetic: up green, down red, flat dim, absent a dash', () => {
    expect(deltaChip(0.8, 0.6)).toEqual({ word: '+0.2pp', hue: 'ok' });
    expect(deltaChip(0.5, 0.58)).toEqual({ word: '-0.08pp', hue: 'crit' });
    expect(deltaChip(0.5, 0.5)).toEqual({ word: '±0', hue: 'dim' });
    expect(deltaChip(null, 0.5).word).toBe('—');
  });
  it('barPct clamps and reads rates, absent → 0', () => {
    expect(barPct(0.62)).toBe(62);
    expect(barPct(62)).toBe(62);
    expect(barPct(140)).toBe(100);
    expect(barPct(-1)).toBe(0);
    expect(barPct(null)).toBe(0);
  });
  it('chatHue: urgent first, then type, else the sender rail hue', () => {
    expect(chatHue({ priority: 'urgent' })).toBe('crit');
    expect(chatHue({ msg_type: 'directive' })).toBe('warn');
    expect(chatHue({ msg_type: 'request' })).toBe('info');
    expect(chatHue({ from_agent: 'kira' })).toBe(nameHue('kira'));
    expect(chatHue({})).toBe(nameHue(undefined));
  });
});
