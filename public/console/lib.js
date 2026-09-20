// lib.js — pure helpers for the Mycelium operator console (task 89).
// No DOM here: this module is imported by console.js AND by the vitest suite
// (test/unit/console-lib.test.js). Everything the machine said or counted
// flows through these formatters, so the honesty rule lives in one place.

// ---- time ----------------------------------------------------------------

/** Parse a platform timestamp ("2026-09-20 19:53:32" or ISO) to epoch ms, or null. */
export function parseStamp(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number' && isFinite(s)) return s < 1e12 ? s * 1000 : s;
  var t = Date.parse(String(s).replace(' ', 'T') + (/[zZ+]/.test(String(s)) ? '' : 'Z'));
  return isFinite(t) ? t : null;
}

/** HH:MM:SS in local time — the terminal-rail clock format. */
export function fmtClock(ms) {
  var d = new Date(ms);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** Human age for an age stamp: "just now", "4m", "2h", "3d" — or null when unparseable. */
export function fmtAge(ms, now) {
  var t = typeof ms === 'number' ? ms : parseStamp(ms);
  if (t === null) return null;
  var s = Math.max(0, Math.floor(((now || Date.now()) - t) / 1000));
  if (s < 15) return 'just now';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/** Age with the "ago" suffix — but fresh reads bare "just now", absent reads "—". */
export function ageAgo(ms, now) {
  var a = fmtAge(ms, now);
  if (!a) return '—';
  return a === 'just now' ? a : a + ' ago';
}

/** The honesty render: a value plus how stale it is. Unmeasured → "—". */
export function valueOrDash(v, fetchedAt, now) {
  if (v === null || v === undefined || v === '') return { text: '—', stale: true };
  var age = fmtAge(fetchedAt, now);
  return { text: String(v), stale: false, age: age || null };
}

// ---- status semantics (color is status only) ------------------------------
// hue buckets: ok (green) · info (blue) · warn (amber) · crit (red) · dim

var STATUS_HUE = {
  ok: 'ok', online: 'ok', present: 'ok', up: 'ok', live: 'ok', pass: 'ok',
  completed: 'ok', verified: 'ok', connected: 'ok', healthy: 'ok', warm: 'ok',
  claimed: 'info', running: 'info', pending_review: 'info', sse: 'info',
  starting: 'info', warmup: 'info',
  warn: 'warn', stale: 'warn', paused: 'warn', degraded: 'warn',
  cancelling: 'warn', unreachable: 'warn', cold: 'warn', hold: 'warn',
  crit: 'crit', fail: 'crit', failed: 'crit', error: 'crit', offline: 'crit',
  down: 'crit', cancelled: 'crit', burned: 'crit', unreachable_net: 'crit'
};

/** Map any platform status word to a hue bucket; unknown → 'dim' (never guessed). */
export function hueOf(status) {
  if (status === null || status === undefined || status === '') return 'dim';
  return STATUS_HUE[String(status).toLowerCase()] || 'dim';
}

/** Workflow row → chip word. The platform's status IS the verdict carrier here. */
export function wfVerdict(wf) {
  var s = String((wf && wf.status) || '').toLowerCase();
  if (s === 'completed') return { word: 'PASS', hue: 'ok' };
  if (s === 'failed') return { word: 'FAIL', hue: 'crit' };
  if (s === 'cancelled') return { word: 'STOP', hue: 'crit' };
  if (s === 'pending' || s === 'claimed' || s === 'running') return { word: s.toUpperCase(), hue: s === 'pending' ? 'warn' : 'info' };
  return { word: (s || '—').toUpperCase(), hue: 'dim' };
}

/** Lesson row → edge hue, from its recorded outcome (hue is semantic only). */
export function lessonHue(lesson) {
  var m = (lesson && lesson.metadata) || {};
  var out = String(m.outcome || '').toLowerCase();
  if (out.indexOf('pass') === 0 || out === 'positive') return 'ok';
  if (out.indexOf('fail') === 0 || out === 'negative') return 'crit';
  var rc = String(m.rc || '');
  if (rc === '0') return 'ok';
  if (rc !== '' && rc !== 'None' && rc !== 'null') return 'crit';
  return 'info';
}

/** Recall row → provenance chip. Missing provenance is "?" — never invented. */
export function provenanceChip(row) {
  var m = (row && row.metadata) || {};
  var a = m.authority || m.origin || m.provenance;
  if (a && /director/i.test(String(a))) return { word: 'director', hue: 'ok' };
  if (a && /infer/i.test(String(a))) return { word: 'inferred', hue: 'warn' };
  if (a) return { word: String(a), hue: 'info' };
  return { word: '?', hue: 'dim' };
}

// ---- text shaping ----------------------------------------------------------

/** Truncate for rail/narration rows; ellipsis is part of the string, honest length kept. */
export function truncate(s, n) {
  s = String(s === null || s === undefined ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** First line of a multi-line lesson body — the ledger row shows one line. */
export function firstLine(s) {
  s = String(s === null || s === undefined ? '' : s);
  var i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/** Strip leading "[lane K-kira] [for Gilbert]"-style wrappers and "LESSON ". */
export function stripPrefix(s) {
  return String(s || '')
    .replace(/^(\[(lane|for gilbert)[^\]]*\]\s*)+/i, '')
    .replace(/^lesson:\s*/i, '');
}

/** Deterministic hue bucket for an agent name (source coloring in rails). */
export function nameHue(name) {
  var s = String(name || '');
  var buckets = ['ok', 'info', 'warn', 'accent'];
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return buckets[h % buckets.length];
}

/** Safely read a nested field; absent → fallback (the "—" path). */
export function pick(obj, path, fallback) {
  var cur = obj;
  var parts = String(path).split('.');
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[parts[i]];
  }
  return cur === undefined || cur === null || cur === '' ? fallback : cur;
}

/** Clamp/parse a positive int query param; NaN → d. */
export function parseLimit(v, d) {
  var n = parseInt(v, 10);
  if (!isFinite(n) || n <= 0) return d;
  return Math.min(n, 500);
}
