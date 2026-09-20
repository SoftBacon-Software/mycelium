// console.js — the Mycelium operator console (task 89, clean room).
//
// One hash router, one fetch layer, four faces (Rounds / Agents / Memory /
// Lab Alive). Plain ES module, no framework, no build step.
//
// Laws this file keeps:
// - Honesty: an unmeasured or unreachable value renders "—" with an age
//   stamp. No demo data, no placeholder numbers, ever.
// - Nothing baked in: roster, seats, lanes and lessons all come from the
//   platform (or the lab state source) at run time.
// - Apps are FACES: the console signs in as an OPERATOR (studio JWT in
//   localStorage) and fails closed — a 401 shows the sign-in well, never an
//   empty face pretending to have data. No admin key ever enters this page.
// - A lane/session that ends must not leave children behind: every timer
//   here lives under the document, nothing spawns processes.

import {
  parseStamp, fmtClock, fmtAge, ageAgo, valueOrDash,
  hueOf, wfVerdict, lessonHue, provenanceChip,
  truncate, firstLine, stripPrefix, nameHue, pick, parseLimit,
} from './lib.js';

// ------------------------------------------------------------------ config

const JWT_KEY = 'mycelium-studio-jwt';          // same key Velum stores
const STATE_URL_DEFAULT = 'http://100.80.183.95:8890/state.json';
const STATE_URL_KEY = 'mycelium_console_state_url';
const POLL_MS = 30000;                            // data faces refresh
const LAB_POLL_MS = 15000;                        // polled fallback cadence
const RAIL_BUFFER_MAX = 300;                      // lab rail line cap
const HEARTBEAT_STALE_MIN = 10;                   // presence bar, minutes

function stateUrl() {
  try { return localStorage.getItem(STATE_URL_KEY) || STATE_URL_DEFAULT; }
  catch (e) { return STATE_URL_DEFAULT; }
}

// every POST body we send is JSON — one constant, three call sites
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// -------------------------------------------------------------------- state

const S = {
  authed: false,
  user: null,
  route: 'rounds',
  platformOk: null,          // null = unknown, true/false = last api result
  agents: [], agentsAt: 0, agentsErr: null,
  workflows: [], wfAt: 0, wfErr: null,
  state: null, stateAt: 0, stateOkAt: 0, stateErr: null,
  lessons: [], lessonsAt: 0, lessonsErr: null, lessonsTotal: null,
  recall: null, recallAt: 0, recallBusy: false, recallErr: null,
  events: [], labMode: 'linking', labPaused: false, labHeldBack: 0,
  eventsSeen: 0,
  sse: null, labTimer: 0,
  railPaused: { rounds: false },
};

// ------------------------------------------------------------- dom helpers

function $(sel, root) { return (root || document).querySelector(sel); }

function h(tag, attrs) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (let i = 2; i < arguments.length; i++) appendKid(n, arguments[i]);
  return n;
}

function appendKid(n, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(k => appendKid(n, k)); return; }
  n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function micro(txt, cls) { return h('span', { class: 'micro' + (cls ? ' ' + cls : ''), text: txt }); }

function chip(txt, hue, extra) {
  const c = h('span', { class: 'chip' + (extra ? ' ' + extra : ''), 'data-hue': hue || 'dim', text: txt });
  return c;
}

// ---------------------------------------------------------------- fetch layer

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, JSON_HEADERS, opts.headers || {});
  const jwt = getJwt();
  if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
  let res;
  try {
    res = await fetch('/api/mycelium' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    setPlatform(false);
    return { ok: false, status: 0, error: 'network: ' + e.message };
  }
  if (res.status === 401) { failClosed(); return { ok: false, status: 401, error: 'not authenticated' }; }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 204s and empty bodies are legal */ }
  const ok = res.ok;
  setPlatform(ok);
  return ok ? { ok: true, status: res.status, data: data } : { ok: false, status: res.status, error: (data && data.error) || ('http ' + res.status) };
}

function getJwt() {
  try { return localStorage.getItem(JWT_KEY) || ''; } catch (e) { return ''; }
}

function setJwt(t) {
  try {
    if (t) localStorage.setItem(JWT_KEY, t);
    else localStorage.removeItem(JWT_KEY);
  } catch (e) { /* private mode: session-only sign-in */ }
}

function setPlatform(up) {
  if (S.platformOk === up) return;
  S.platformOk = up;
  const dot = $('#conn-dot'), foot = $('#foot-dot'), txt = $('#conn-text'), ftxt = $('#foot-conn');
  if (up === true) {
    dot.className = 'dot dot-ok'; foot.className = 'dot dot-ok';
    txt.textContent = 'linked · :3002'; ftxt.textContent = 'linked';
  } else if (up === false) {
    dot.className = 'dot dot-crit'; foot.className = 'dot dot-crit';
    txt.textContent = 'platform unreachable'; ftxt.textContent = 'unreachable';
  }
}

function failClosed() {
  if (!S.authed) return;
  teardownStreams();
  S.authed = false;
  setJwt('');
  $('#app').classList.add('hidden');
  $('#signin').classList.remove('hidden');
}

function teardownStreams() {
  if (S.sse) { try { S.sse.close(); } catch (e) {} S.sse = null; }
  if (S.labTimer) { clearInterval(S.labTimer); S.labTimer = 0; }
}

// -------------------------------------------------------------------- boot

async function boot() {
  $('#signin-form').addEventListener('submit', onSignIn);
  $('#reconnect-btn').addEventListener('click', reconnect);
  $('#signout-btn').addEventListener('click', () => failClosed());
  window.addEventListener('hashchange', applyRoute);
  document.querySelectorAll('.nav-item[data-route]').forEach(btn => {
    btn.addEventListener('click', () => { location.hash = '#/' + btn.dataset.route; });
  });
  document.querySelectorAll('.nav-item.soon').forEach(btn => {
    btn.addEventListener('click', () => { /* a dim row: present, not clickable */ });
  });

  buildRounds(); buildAgents(); buildMemory(); buildLab();

  if (!getJwt()) { showSignIn(); return; }
  const me = await api('/studio/me');
  if (me.ok) enter(me.data);
  else if (me.status !== 401) showSignIn(me.status === 0 ? 'platform unreachable — retry when it answers' : null);
  else showSignIn();
}

function showSignIn(errText) {
  $('#app').classList.add('hidden');
  $('#signin').classList.remove('hidden');
  const err = $('#signin-error');
  if (errText) { err.textContent = errText; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
  setTimeout(() => { try { $('#signin-user').focus(); } catch (e) {} }, 50);
}

async function onSignIn(ev) {
  ev.preventDefault();
  const btn = $('#signin-go');
  const username = $('#signin-user').value.trim();
  const password = $('#signin-pass').value;
  const err = $('#signin-error');
  err.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'SIGNING IN…';
  const jsonBody = JSON.stringify({ username: username, password: password });
  const r = await fetch('/api/mycelium/studio/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: jsonBody,
  });
  btn.disabled = false; btn.textContent = 'SIGN IN';
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) {
    err.textContent = (data && data.error) || ('sign-in failed · http ' + r.status);
    err.classList.remove('hidden');
    return;
  }
  setJwt(data.token);
  enter(data.user);
}

function enter(user) {
  S.authed = true;
  S.user = user || null;
  $('#signin').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#operator-name').textContent = (user && (user.display_name || user.username)) || '';
  setPlatform(true);
  if (!location.hash) location.hash = '#/rounds';
  applyRoute();
  refreshAgents();       // nav badge on every face
  refreshWorkflows();    // rounds + its badge
}

async function reconnect() {
  setPlatform(null);
  $('#conn-text').textContent = 'relinking…';
  const me = await api('/studio/me');
  if (!me.ok && me.status === 401) return; // failClosed already ran
  refreshAgents(); refreshWorkflows();
  refreshRoute(true);
  if (S.route === 'lab') labConnect();
}

// ------------------------------------------------------------------ router

const ROUTES = {
  rounds: { title: 'Rounds', page: 'page-rounds', nav: 'nav-rounds', pollMs: POLL_MS, refresh: refreshRounds },
  agents: { title: 'Agents', page: 'page-agents', nav: 'nav-agents', pollMs: POLL_MS, refresh: refreshAgents },
  memory: { title: 'Memory', page: 'page-memory', nav: 'nav-memory', pollMs: POLL_MS, refresh: refreshLessons },
  lab: { title: 'Lab Alive', page: 'page-lab', nav: 'nav-lab', pollMs: 0, refresh: null },
};

function applyRoute() {
  if (!S.authed) return;
  const name = (location.hash || '#/rounds').replace(/^#\//, '') || 'rounds';
  const r = ROUTES[name] || ROUTES.rounds;
  S.route = ROUTES[name] ? name : 'rounds';
  for (const key of Object.keys(ROUTES)) {
    $('#' + ROUTES[key].page).classList.toggle('active', key === S.route);
    $('#' + ROUTES[key].nav).classList.toggle('active', key === S.route);
  }
  $('#page-title').textContent = r.title;
  buildHeadActions(S.route);
  routePolled[S.route] = Date.now(); // reset the cadence on entry
  if (S.route === 'rounds') refreshRounds();
  if (S.route === 'agents') refreshAgents();
  if (S.route === 'memory') { refreshLessons(); }
  if (S.route === 'lab') { labConnect(); }
}

let routePolled = {};

function refreshRoute(force) {
  const r = ROUTES[S.route];
  if (!r || !r.refresh) return;
  if (force) routePolled[S.route] = 0;
  r.refresh();
}

// per-face tick: only the active face polls, and never in a hidden tab
setInterval(() => {
  if (document.hidden || !S.authed) return;
  const r = ROUTES[S.route];
  if (!r || !r.pollMs || !r.refresh) return;
  const now = Date.now();
  if (now - (routePolled[S.route] || 0) < r.pollMs) return;
  routePolled[S.route] = now;
  r.refresh();
}, 1000);

function headBtn(id, label, cls, onclick) {
  return h('button', { class: 'btn ' + (cls || ''), id: id, onclick: onclick, text: label });
}

function buildHeadActions(route) {
  const box = $('#head-actions');
  clear(box);
  if (route === 'rounds') {
    box.append(headBtn('head-refresh', '↻ REFRESH', 'btn-primary', () => { refreshRounds(); }));
  } else if (route === 'agents') {
    box.append(headBtn('head-refresh', '↻ REFRESH', 'btn-primary', () => { refreshAgents(); }));
  } else if (route === 'memory') {
    box.append(headBtn('head-refresh', '↻ REFRESH', '', () => { refreshLessons(); }));
  } else if (route === 'lab') {
    box.append(headBtn('head-pause', S.labPaused ? '▶ RESUME' : '❚❚ PAUSE', 'btn-primary', toggleLabPause));
  }
}

// ------------------------------------------------------------------ badges

function setBadge(id, n, hue) {
  const b = $('#' + id);
  if (!b) return;
  if (n === null || n === undefined) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = n > 99 ? '99+' : String(n);
  b.dataset.hue = hue || 'dim';
}

function updateBadges() {
  const inflight = S.workflows.filter(w => ['pending', 'claimed', 'running'].includes(String(w.status).toLowerCase()));
  setBadge('nav-badge-rounds', inflight.length, inflight.length ? 'warn' : 'dim');
  const online = S.agents.filter(a => String(a.status).toLowerCase() === 'online').length;
  setBadge('nav-badge-agents', S.agents.length ? online : null, online ? 'ok' : 'crit');
  setBadge('nav-badge-memory', S.lessonsAt ? S.lessons.length : null, 'dim');
  setBadge('nav-badge-lab', S.eventsSeen ? S.eventsSeen : null, 'dim');
}

// ================================================================== ROUNDS

let R = {}; // rounds node refs

function buildRounds() {
  const page = $('#page-rounds');
  clear(page);

  R.stripStatus = chip('…', 'dim');
  R.stripSeats = h('span', { class: 'cmd-value big mono', text: '—' });
  R.stripLanes = h('span', { class: 'cmd-value big mono', text: '—' });
  R.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  R.stateChip = h('span', { class: 'hidden' });

  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('STATUS'), R.stripStatus),
    h('div', { class: 'cmd-cell' }, micro('SEATS'), R.stripSeats),
    h('div', { class: 'cmd-cell' }, micro('LANES IN FLIGHT'), R.stripLanes),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), R.stripFresh),
    R.stateChip,
    h('span', { class: 'spacer' }),
  ));

  R.seatRow = h('div', { class: 'stat-row' });
  page.append(R.seatRow);

  R.boxRow = h('div', { class: 'stat-row' });
  page.append(
    h('div', { class: 'well' },
      h('div', { class: 'well-title' }, 'THE BOX — LEDGER', micro('budget · resident · headroom')),
      R.boxRow),
  );

  R.inflight = h('ul', { class: 'narration' });
  R.outcomes = h('ul', { class: 'narration' });
  R.rail = h('ul', { class: 'rail-body' });
  R.railCount = h('span', { class: 'rail-count', text: '0' });
  R.railNote = h('div', { class: 'empty-line', text: '—' });

  page.append(h('div', { class: 'split' },
    h('div', { class: 'col-a' },
      h('div', { class: 'well' },
        h('div', { class: 'well-title' }, 'LANES IN FLIGHT', micro('pending · claimed · running')),
        R.inflight,
        h('div', { class: 'well', style: 'margin:12px 0 0; background:none; border-style:dashed;' },
          h('div', { class: 'well-title' }, 'LAST OUTCOMES', micro('newest first')),
          R.outcomes))),
    h('div', { class: 'col-b' },
      h('div', { class: 'well rail' },
        h('div', { class: 'rail-head' },
          h('span', { class: 'rail-title', text: 'RUNNER LOG' }),
          R.railCount,
          h('span', { class: 'rail-mode', text: 'polled' }),
          h('span', { class: 'rail-btns' },
            h('button', { class: 'rail-btn', text: 'PAUSE', onclick: (e) => toggleRailPause(e.target) }),
            h('button', { class: 'rail-btn', text: 'CLR', onclick: (e) => { clear(R.rail); R.railCount.textContent = '0'; } })),
        ),
        R.rail,
        h('div', { style: 'padding: 6px 14px 10px;' }, R.railNote))),
  ));
}

function toggleRailPause(btn) {
  S.railPaused.rounds = !S.railPaused.rounds;
  btn.classList.toggle('on', S.railPaused.rounds);
  btn.textContent = S.railPaused.rounds ? 'RESUME' : 'PAUSE';
}

function statWell(label, num, note, hue, small) {
  return h('div', { class: 'stat-well', 'data-hue': hue || 'dim' },
    micro(label),
    h('div', { class: 'stat-num' + (small ? ' small' : ''), text: num }),
    note ? h('div', { class: 'stat-note', text: note }) : null);
}

async function refreshRounds() {
  if (document.hidden) return;
  fetchState().then(() => { if (S.route === 'rounds' && S.state) renderRounds(); });
  const w = await api('/workflows?limit=50&order=desc');
  if (w.ok) {
    S.workflows = (w.data && w.data.items) || [];
    S.wfAt = Date.now(); S.wfErr = null;
  } else {
    S.wfErr = w.error; if (w.status !== 0) S.wfAt = S.wfAt || 0;
  }
  renderRounds();
  updateBadges();
}

async function fetchState() {
  S.stateAt = Date.now();
  try {
    const res = await fetch(stateUrl(), { mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    S.state = await res.json();
    S.stateOkAt = Date.now();
    S.stateErr = null;
  } catch (e) {
    S.stateErr = 'state source refused (' + e.message + ')' +
      ' — expected when the page is not served from an allowed platform origin';
  }
}

function inflightList() {
  return S.workflows.filter(w => ['pending', 'claimed', 'running'].includes(String(w.status).toLowerCase()));
}

function renderRounds() {
  const now = Date.now();
  const inflight = inflightList();

  // command strip
  const platformUp = S.platformOk !== false && S.wfErr === null;
  R.stripStatus.textContent = platformUp ? 'ALIVE' : 'OFFLINE';
  R.stripStatus.dataset.hue = platformUp ? 'ok' : 'crit';
  const seatsKnown = stateEngines();
  R.stripSeats.textContent = seatsKnown ? String(seatsKnown.length) : '—';
  R.stripLanes.textContent = platformUp ? String(inflight.length) : '—';
  R.stripFresh.textContent = ageAgo(S.wfAt, now);

  // the state-source chip: honest about refusals, quiet when fine
  if (S.stateErr) {
    R.stateChip.className = 'chip unreach-chip';
    R.stateChip.dataset.hue = 'warn';
    R.stateChip.textContent = 'STATE UNREACHABLE';
    R.stateChip.title = S.stateErr + ' · last ok: ' + (S.stateOkAt ? new Date(S.stateOkAt).toLocaleTimeString() : 'never');
  } else {
    R.stateChip.className = 'hidden';
  }

  // seat tiles from the state source (nothing baked in)
  clear(R.seatRow);
  if (S.state && seatsKnown && seatsKnown.length) {
    for (const it of seatsKnown.slice(0, 6)) {
      R.seatRow.append(statWell(it.k || 'seat', String(it.v || '—'), it.note ? truncate(it.note, 46) : null, hueOf(it.status)));
    }
    if (seatsKnown.length > 6) {
      R.seatRow.append(statWell('more seats', '+' + (seatsKnown.length - 6), 'capped view — source holds more', 'dim', true));
    }
  } else {
    const lastOk = S.stateOkAt ? 'last ok ' + ageAgo(S.stateOkAt, now) : 'never answered';
    R.seatRow.append(statWell('SEATS', '—', lastOk, S.stateErr ? 'warn' : 'dim', true));
  }

  // the box ledger
  clear(R.boxRow);
  const boxItems = stateSection('box');
  if (boxItems && boxItems.length) {
    for (const it of boxItems.slice(0, 4)) {
      R.boxRow.append(statWell(it.k || 'reading', String(it.v || '—').split('\n')[0], null, hueOf(it.status), true));
    }
  } else {
    R.boxRow.append(statWell('THE BOX', '—', S.stateErr ? 'state source unreachable' : 'no reading yet', 'dim', true));
  }

  // lanes in flight
  clear(R.inflight);
  if (!platformUp) {
    R.inflight.append(h('li', { class: 'empty-line', text: 'platform unreachable — ' + (S.wfErr || 'no data') }));
  } else if (!inflight.length) {
    R.inflight.append(h('li', { class: 'empty-line', text: 'no lanes in flight — the lab is between rounds' }));
  } else {
    for (const wf of inflight.slice(0, 9)) narrRow(R.inflight, wfColor(wf), 'wf#' + wf.id + ' · ' + truncate(wf.name || '', 64),
      String(wf.claimed_by || wf.requested_by || ''), wfAge(wf, now));
    if (inflight.length > 9) R.inflight.append(h('li', { class: 'cap-note', text: '+' + (inflight.length - 9) + ' more in flight' }));
  }

  // last outcomes
  clear(R.outcomes);
  const done = S.workflows.filter(w => !['pending', 'claimed', 'running'].includes(String(w.status).toLowerCase()));
  if (platformUp && done.length) {
    for (const wf of done.slice(0, 8)) {
      const v = wfVerdict(wf);
      narrRow(R.outcomes, v.hue, 'wf#' + wf.id + ' · ' + truncate(wf.name || '', 58), v.word, wfAge(wf, now));
    }
  } else if (platformUp) {
    R.outcomes.append(h('li', { class: 'empty-line', text: 'no outcomes yet in this window' }));
  } else {
    R.outcomes.append(h('li', { class: 'empty-line', text: '—' }));
  }

  // runner log rail (polled from /workflows)
  if (!S.railPaused.rounds && platformUp) {
    clear(R.rail);
    const lines = S.workflows.slice(0, 40);
    for (const wf of lines) {
      const v = wfVerdict(wf);
      R.rail.append(h('li', { class: 'rail-line' },
        h('span', { class: 't', text: clockOf(wf.started_at || wf.created_at) }),
        ' ',
        h('span', { class: 'src', 'data-hue': v.hue === 'dim' ? 'accent' : v.hue, text: 'WF#' + wf.id }),
        ' · ' + String(wf.status || '?') + ' · ' + truncate(wf.name || '', 70)));
    }
    R.railCount.textContent = String(lines.length);
    R.railNote.textContent = S.wfAt ? 'polled from /workflows · ' + ageAgo(S.wfAt, now) : 'polled from /workflows';
  }
}

function narrRow(list, hue, text, who, stamp) {
  list.append(h('li', { class: 'narr-row' },
    h('span', { class: 'narr-dot', 'data-hue': hue }),
    h('span', { class: 'narr-text' }, text, who ? h('span', { class: 'who', text: '  · ' + who }) : null),
    h('span', { class: 'narr-stamp', text: stamp || '' })));
}

function wfColor(wf) {
  const s = String(wf.status || '').toLowerCase();
  if (s === 'pending') return 'warn';
  if (s === 'running') return 'ok';
  return 'info';
}

function wfAge(wf, now) {
  const t = parseStamp(wf.started_at || wf.created_at);
  return t ? fmtAge(t, now) + (['pending'].includes(String(wf.status).toLowerCase()) ? ' queued' : ' in') : '';
}

function clockOf(stamp) {
  const t = parseStamp(stamp);
  return t ? fmtClock(t) : '--:--:--';
}

function stateSection(id) {
  if (!S.state || !Array.isArray(S.state.sections)) return null;
  return S.state.sections.find(s => s.id === id) || null;
}

function stateEngines() {
  const sec = stateSection('engines');
  return sec && Array.isArray(sec.items) ? sec.items : null;
}

// ================================================================== AGENTS

let A = {};

function buildAgents() {
  const page = $('#page-agents');
  clear(page);
  A.stripStatus = chip('…', 'dim');
  A.stripCount = h('span', { class: 'cmd-value big mono', text: '—' });
  A.stripOnline = h('span', { class: 'cmd-value big mono', text: '—' });
  A.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('STATUS'), A.stripStatus),
    h('div', { class: 'cmd-cell' }, micro('ROSTER'), A.stripCount),
    h('div', { class: 'cmd-cell' }, micro('PRESENT'), A.stripOnline),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), A.stripFresh),
    h('span', { class: 'spacer' })));
  A.grid = h('div', { class: 'agent-grid' });
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'THE ROSTER', micro('from /agents · presence is heartbeat truth')),
    A.grid,
    h('div', { class: 'cap-note', id: 'agents-cap', text: '' })));
}

async function refreshAgents() {
  if (document.hidden) return;
  const r = await api('/agents');
  if (r.ok && Array.isArray(r.data)) {
    S.agents = r.data;
    S.agentsAt = Date.now();
    S.agentsErr = null;
  } else {
    S.agentsErr = r.error || ('http ' + r.status);
  }
  renderAgents();
  updateBadges();
}

function renderAgents() {
  const now = Date.now();
  const up = S.platformOk !== false && S.agentsErr === null;
  A.stripStatus.textContent = up ? 'ROSTER OK' : 'UNREACHABLE';
  A.stripStatus.dataset.hue = up ? 'ok' : 'crit';
  A.stripCount.textContent = up ? String(S.agents.length) : '—';
  const online = S.agents.filter(a => String(a.status).toLowerCase() === 'online');
  A.stripOnline.textContent = up ? String(online.length) : '—';
  A.stripFresh.textContent = ageAgo(S.agentsAt, now);

  clear(A.grid);
  if (!up) {
    A.grid.append(h('div', { class: 'empty-line', text: 'roster unreachable — ' + (S.agentsErr || 'no data') + ' · retrying on cadence' }));
    return;
  }
  if (!S.agents.length) {
    A.grid.append(h('div', { class: 'empty-line', text: 'no agents registered on this platform yet' }));
    return;
  }
  for (const a of S.agents) {
    const status = String(a.status || 'offline').toLowerCase();
    const hb = parseStamp(a.last_heartbeat);
    const age = hb ? ageAgo(hb, now) : null;
    A.grid.append(h('div', { class: 'agent-card' },
      h('div', { class: 'a-name' },
        h('span', { class: 'dot dot-' + (status === 'online' ? 'ok' : 'dim'), style: 'width:8px;height:8px;' }),
        h('span', { text: a.name || a.id }),
        chip(status, hueOf(status))),
      h('div', { class: 'a-rows' },
        micro('ROLE'), h('span', { class: 'v', text: a.role || a.agent_type || '—' }),
        micro('BRAIN'), h('span', { class: 'v', text: a.llm_model || a.runtime || '—' }),
        micro('SEAT'), h('span', { class: 'v', text: a.llm_backend || '—' }),
        micro('HEARTBEAT'), h('span', { class: 'v', text: age ? age + ' · ' + clockOf(a.last_heartbeat) : '—' }))));
  }
  $('#agents-cap').textContent = S.agents.length > 24 ? 'showing ' + Math.min(24, S.agents.length) + ' of ' + S.agents.length : '';
  // cap the grid at 24 cards for density; the count stays honest above
  const cards = A.grid.querySelectorAll('.agent-card');
  for (let i = 24; i < cards.length; i++) cards[i].remove();
}

// ================================================================== MEMORY

let M = {};

function buildMemory() {
  const page = $('#page-memory');
  clear(page);
  M.stripCount = h('span', { class: 'cmd-value big mono', text: '—' });
  M.stripShown = h('span', { class: 'cmd-value big mono', text: '—' });
  M.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('LESSONS'), M.stripCount),
    h('div', { class: 'cmd-cell' }, micro('SHOWN'), M.stripShown),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), M.stripFresh),
    h('span', { class: 'spacer' })));

  M.query = h('input', { class: 'input mono', type: 'text', placeholder: 'recall by meaning — the platform embeds and ranks', id: 'memory-query' });
  M.go = h('button', { class: 'btn btn-primary', id: 'memory-search-btn', text: 'RECALL', onclick: () => doRecall() });
  M.results = h('ul', { class: 'ledger', id: 'recall-results' });
  M.recallMeta = h('div', { class: 'cap-note', id: 'recall-meta', text: 'provenance chips: director / inferred / ? — a row without provenance renders “?”' });
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'RECALL', micro('POST /memory/search')),
    h('div', { style: 'display:flex; gap:10px;' }, M.query, M.go),
    h('div', { style: 'height:14px;' }),
    M.results,
    M.recallMeta));

  M.ledger = h('ul', { class: 'ledger', id: 'lessons-ledger' });
  M.capNote = h('div', { class: 'cap-note', id: 'lessons-cap', text: '' });
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'LESSONS — THE LEDGER', micro('GET /memory/lessons · newest first')),
    M.ledger,
    M.capNote));
}

async function refreshLessons() {
  if (document.hidden) return;
  const r = await api('/memory/lessons?limit=50');
  if (r.ok) {
    S.lessons = (r.data && r.data.results) || [];
    S.lessonsTotal = (r.data && r.data.count) || S.lessons.length;
    S.lessonsAt = Date.now();
    S.lessonsErr = null;
  } else {
    S.lessonsErr = r.error || ('http ' + r.status);
  }
  renderMemory();
  updateBadges();
}

function renderMemory() {
  const now = Date.now();
  const up = S.platformOk !== false && S.lessonsErr === null;
  M.stripCount.textContent = up ? String(S.lessons.length) : '—';
  M.stripShown.textContent = up ? String(Math.min(S.lessons.length, 30)) : '—';
  M.stripFresh.textContent = ageAgo(S.lessonsAt, now);

  clear(M.ledger);
  if (!up) {
    M.ledger.append(h('li', { class: 'empty-line', text: 'lessons unreachable — ' + (S.lessonsErr || 'no data') }));
    M.capNote.textContent = '';
    return;
  }
  if (!S.lessons.length) {
    M.ledger.append(h('li', { class: 'empty-line', text: 'no lessons written yet — the harness writes them after each verdict' }));
    return;
  }
  for (const l of S.lessons.slice(0, 30)) {
    const m = l.metadata || {};
    const line = truncate(firstLine(stripPrefix(l.content_text || '')), 150);
    M.ledger.append(h('li', { class: 'ledger-row', 'data-hue': lessonHue(l) },
      h('div', { class: 'ledger-main', text: line || '(empty lesson body)' }),
      h('div', { class: 'ledger-meta' },
        m.lane ? h('span', { text: String(m.lane) }) : null,
        m.repo ? h('span', { text: String(m.repo) }) : null,
        m.actor ? h('span', { text: 'actor ' + String(m.actor) }) : null,
        m.task_class ? chip(String(m.task_class), 'dim') : null,
        m.outcome ? chip(String(m.outcome), lessonHue(l)) : null,
        h('span', { class: 'grow' }),
        h('span', { text: clockOf(l.created_at) }))));
  }
  M.capNote.textContent = S.lessons.length > 30 ? 'showing 30 of ' + S.lessons.length + ' recent — the store holds more' : '';
}

async function doRecall() {
  if (S.recallBusy) return;
  const q = M.query.value.trim();
  const errNote = () => { M.recallMeta.textContent = 'recall failed — ' + (S.recallErr || 'no data'); };
  if (!q) { M.recallMeta.textContent = 'type a query first — recall searches meaning, not keywords only'; return; }
  S.recallBusy = true;
  M.go.disabled = true;
  M.go.textContent = '…';
  const r = await api('/memory/search', { method: 'POST', body: { query: q, limit: 10 } });
  S.recallBusy = false;
  M.go.disabled = false;
  M.go.textContent = 'RECALL';
  if (!r.ok) {
    S.recall = null; S.recallErr = r.error;
    clear(M.results);
    errNote();
    return;
  }
  S.recall = (r.data && r.data.results) || [];
  S.recallErr = null;
  S.recallAt = Date.now();
  renderRecall(r.data);
}

function renderRecall(envelope) {
  clear(M.results);
  if (!S.recall.length) {
    M.results.append(h('li', { class: 'empty-line', text: 'nothing recalled for that query — an honest zero' }));
    M.recallMeta.textContent = envelope && envelope.index
      ? '0 rows · index ' + envelope.index.total + ' rows, ' + envelope.index.coverage_pct + '% embedded · mode ' + envelope.mode
      : '0 rows';
    return;
  }
  for (const row of S.recall) {
    const prov = provenanceChip(row);
    const m = row.metadata || {};
    M.results.append(h('li', { class: 'ledger-row', 'data-hue': prov.hue },
      h('div', { class: 'ledger-main', text: truncate(firstLine(row.content_text || ''), 160) }),
      h('div', { class: 'ledger-meta' },
        chip(prov.word, prov.hue),
        chip(String(row.source_type || '?'), 'dim'),
        m.namespace ? h('span', { text: 'ns ' + String(m.namespace) }) : null,
        m.title ? h('span', { text: truncate(String(m.title), 60) }) : null,
        h('span', { class: 'grow' }),
        row.score !== undefined ? h('span', { text: 'score ' + Number(row.score).toFixed(1) }) : null,
        h('span', { text: clockOf(row.created_at) }))));
  }
  M.recallMeta.textContent = (S.recall.length + ' rows · mode ' + (envelope && envelope.mode || 'hybrid') +
    (envelope && envelope.embed_fail_reason ? ' · degraded: ' + envelope.embed_fail_reason : ''));
}

// ================================================================ LAB ALIVE

let L = {};

function buildLab() {
  const page = $('#page-lab');
  clear(page);
  L.stripMode = chip('LINKING', 'dim');
  L.stripCount = h('span', { class: 'cmd-value big mono', text: '—' });
  L.stripSince = h('span', { class: 'cmd-value', text: fmtClock(Date.now()) });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('STREAM'), L.stripMode),
    h('div', { class: 'cmd-cell' }, micro('EVENTS SEEN'), L.stripCount),
    h('div', { class: 'cmd-cell' }, micro('WATCHING SINCE'), L.stripSince),
    h('span', { class: 'spacer' })));

  L.rail = h('ul', { class: 'rail-body tall' });
  L.count = h('span', { class: 'rail-count', text: '0' });
  L.mode = h('span', { class: 'rail-mode', text: 'linking' });
  L.pauseBtn = h('button', { class: 'rail-btn', text: 'PAUSE', onclick: toggleLabPause });
  page.append(h('div', { class: 'well rail' },
    h('div', { class: 'rail-head' },
      h('span', { class: 'rail-title', 'data-hue': 'accent', text: 'LAB ALIVE — SYSTEM EVENTS' }),
      L.count,
      L.mode,
      h('span', { class: 'rail-btns' },
        L.pauseBtn,
        h('button', { class: 'rail-btn', text: 'CLR', onclick: clearLab }))),
    L.rail,
    h('div', { style: 'padding:6px 14px 10px;' },
      h('div', { class: 'cap-note', id: 'lab-note', text: 'the platform’s event stream — every hop the lab makes, as it happens' }))));
}

function labConnect() {
  if (!S.authed) return;
  teardownStreams();
  L.stripMode.textContent = 'LINKING';
  L.stripMode.dataset.hue = 'dim';
  backfillLab();
  const jwt = getJwt();
  try {
    S.sse = new EventSource('/api/mycelium/events/stream' + (jwt ? '?token=' + encodeURIComponent(jwt) : ''));
  } catch (e) {
    labPoll();
    return;
  }
  S.sse.onopen = () => { S.labMode = 'sse'; renderLabMode(); };
  S.sse.onmessage = (ev) => {
    let row = null;
    try { row = JSON.parse(ev.data); } catch (e) { return; }
    // the endpoint replays the last 20 on connect — the same rows backfill
    // just rendered; dedupe by id the way the poll path does
    if (S.events.some(e => String(e.id) === String(row.id))) return;
    S.eventsSeen++;
    labLine(row, true);
    renderLabMode();
    updateBadges();
  };
  S.sse.onerror = () => {
    if (S.sse) { try { S.sse.close(); } catch (e) {} S.sse = null; }
    labPoll();
  };
}

async function backfillLab() {
  const r = await api('/events?limit=100');
  if (!r.ok || !Array.isArray(r.data)) {
    labPoll();
    return;
  }
  const rows = r.data.slice(0, 60).reverse(); // oldest of the window first
  clear(L.rail);
  S.events = [];
  for (const row of rows) labLine(row, false);
  renderLabCount();
}

function labPoll() {
  if (S.labTimer) return;
  S.labMode = 'polled';
  renderLabMode();
  S.labTimer = setInterval(async () => {
    if (document.hidden || !S.authed) return;
    const r = await api('/events?limit=20');
    if (r.ok && Array.isArray(r.data)) {
      for (const row of r.data.slice().reverse()) {
        if (S.events.length && String(row.id) === String(S.events[S.events.length - 1].id)) continue;
        if (S.events.some(e => String(e.id) === String(row.id))) continue;
        S.eventsSeen++;
        labLine(row, true);
      }
      renderLabCount();
      updateBadges();
      setPlatform(true);
    } else if (r.status === 0) setPlatform(false);
  }, LAB_POLL_MS);
}

function renderLabMode() {
  const m = S.labMode;
  L.mode.textContent = m;
  L.stripMode.textContent = S.labPaused ? 'PAUSED' : m.toUpperCase();
  L.stripMode.dataset.hue = S.labPaused ? 'warn' : (m === 'sse' ? 'ok' : m === 'polled' ? 'info' : 'dim');
  L.pauseBtn.classList.toggle('on', S.labPaused);
  L.pauseBtn.textContent = S.labPaused ? 'RESUME' : 'PAUSE';
  const head = $('#head-pause');
  if (head) head.textContent = S.labPaused ? '▶ RESUME' : '❚❚ PAUSE';
}

function renderLabCount() {
  L.count.textContent = String(S.events.length);
  L.stripCount.textContent = String(S.eventsSeen);
}

function labLine(row, live) {
  if (S.labPaused) { S.labHeldBack++; renderHeldBack(); return; }
  S.events.push(row);
  if (S.events.length > RAIL_BUFFER_MAX) S.events.shift();
  const hue = /heartbeat/i.test(String(row.type)) ? 'dim' : nameHue(row.agent);
  L.rail.append(h('li', { class: 'rail-line' },
    h('span', { class: 't', text: clockOf(row.created_at || Date.now()) }),
    ' ',
    h('span', { class: 'src', 'data-hue': hue, text: String(row.agent || '?').slice(0, 18) }),
    ' · ' + truncate(String(row.summary || row.type || ''), 150) + (live ? '' : ' · (replay)')));
  while (L.rail.children.length > RAIL_BUFFER_MAX) L.rail.removeChild(L.rail.firstChild);
  renderLabCount();
  if (S.route === 'lab') L.rail.scrollTop = L.rail.scrollHeight;
}

function renderHeldBack() {
  let note = $('#lab-note');
  if (note) note.textContent = 'paused — ' + S.labHeldBack + ' event' + (S.labHeldBack === 1 ? '' : 's') + ' held back; resume to let them in';
}

function toggleLabPause() {
  S.labPaused = !S.labPaused;
  if (!S.labPaused && S.labHeldBack) {
    const gap = h('li', { class: 'rail-line' },
      h('span', { class: 't', text: '--:--:--' }),
      ' ',
      h('span', { class: 'src', 'data-hue': 'warn', text: 'pause' }),
      ' · ' + S.labHeldBack + ' event' + (S.labHeldBack === 1 ? '' : 's') + ' passed while paused — the record kept them');
    L.rail.append(gap);
    S.labHeldBack = 0;
  }
  renderHeldBack();
  renderLabMode();
}

function clearLab() {
  clear(L.rail);
  S.events = [];
  S.labHeldBack = 0;
  renderHeldBack();
  renderLabCount();
}

// ------------------------------------------------------------------- start

boot();
