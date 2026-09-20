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
  stateSectionItems, countHue, receiptShape, deltaChip, barPct, chatHue,
} from './lib.js';

// ------------------------------------------------------------------ config

const JWT_KEY = 'mycelium-studio-jwt';          // same key Velum stores
const STATE_URL_DEFAULT = 'http://100.80.183.95:8890/state.json';
const STATE_URL_KEY = 'mycelium_console_state_url';
const RECEIPT_URL_DEFAULT = 'http://100.80.183.95:8890/receipts/';
const RECEIPT_URL_KEY = 'mycelium_console_receipt_url';
const DENSITY_KEY = 'mycelium_console_density'; // 'compact' (default) | 'comfortable'
const TOUR_KEY = 'mycelium_console_tour_done';  // first-run auto-start flag
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
  railPaused: { rounds: false, maintainer: false },
  // task 90 faces
  receipt: null, receiptRaw: null, receiptAt: 0, receiptErr: null,
  msgs: [], msgsAt: 0, msgsErr: null, chatBusy: false, chatNote: null,
  logs: [], logsAt: 0, logsErr: null, logsPaused: false, logsHeldBack: 0,
  projects: [], projectsAt: 0, projectsErr: null,
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
  $('#tour-btn').addEventListener('click', () => startTour(true));
  $('#density-btn').addEventListener('click', toggleDensity);
  window.addEventListener('hashchange', applyRoute);
  document.querySelectorAll('.nav-item[data-route]').forEach(btn => {
    btn.addEventListener('click', () => { location.hash = '#/' + btn.dataset.route; });
  });
  document.querySelectorAll('.nav-item.soon').forEach(btn => {
    btn.addEventListener('click', () => { /* a dim row: present, not clickable */ });
  });

  buildRounds(); buildReceipt(); buildChat(); buildAgents(); buildMemory(); buildLab();
  buildLogs(); buildMaintainer(); buildEngines(); buildAbout();
  applyDensity();

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
  refreshRounds();       // rounds + its badge
  fetchState().then(updateBadges);   // engines badge + rounds seats
  maybeFirstRunTour();
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
  receipt: { title: 'Receipt', page: 'page-receipt', nav: 'nav-receipt', pollMs: POLL_MS, refresh: refreshReceipt },
  chat: { title: 'Chat', page: 'page-chat', nav: 'nav-chat', pollMs: POLL_MS, refresh: refreshChat },
  agents: { title: 'Agents', page: 'page-agents', nav: 'nav-agents', pollMs: POLL_MS, refresh: refreshAgents },
  memory: { title: 'Memory', page: 'page-memory', nav: 'nav-memory', pollMs: POLL_MS, refresh: refreshLessons },
  lab: { title: 'Lab Alive', page: 'page-lab', nav: 'nav-lab', pollMs: 0, refresh: null },
  logs: { title: 'Logs', page: 'page-logs', nav: 'nav-logs', pollMs: LAB_POLL_MS, refresh: refreshLogs },
  maintainer: { title: 'Maintainer', page: 'page-maintainer', nav: 'nav-maintainer', pollMs: POLL_MS, refresh: refreshMaintainer },
  engines: { title: 'Engines', page: 'page-engines', nav: 'nav-engines', pollMs: POLL_MS, refresh: refreshEngines },
  about: { title: 'About', page: 'page-about', nav: 'nav-about', pollMs: 0, refresh: null },
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
  if (S.route === 'receipt') refreshReceipt();
  if (S.route === 'chat') refreshChat();
  if (S.route === 'agents') refreshAgents();
  if (S.route === 'memory') { refreshLessons(); }
  if (S.route === 'lab') { labConnect(); }
  if (S.route === 'logs') refreshLogs();
  if (S.route === 'maintainer') refreshMaintainer();
  if (S.route === 'engines') refreshEngines();
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
  } else if (route === 'receipt') {
    box.append(headBtn('head-refresh', '↻ REFRESH', '', () => { refreshReceipt(); }));
  } else if (route === 'chat') {
    box.append(headBtn('head-refresh', '↻ REFRESH', '', () => { refreshChat(); }));
  } else if (route === 'agents') {
    box.append(headBtn('head-refresh', '↻ REFRESH', 'btn-primary', () => { refreshAgents(); }));
  } else if (route === 'memory') {
    box.append(headBtn('head-refresh', '↻ REFRESH', '', () => { refreshLessons(); }));
  } else if (route === 'lab') {
    box.append(headBtn('head-pause', S.labPaused ? '▶ RESUME' : '❚❚ PAUSE', 'btn-primary', toggleLabPause));
  } else if (route === 'logs') {
    box.append(headBtn('head-pause', S.logsPaused ? '▶ RESUME' : '❚❚ PAUSE', 'btn-primary', toggleLogsPause));
  } else if (route === 'maintainer') {
    box.append(headBtn('head-refresh', '↻ REFRESH', 'btn-primary', () => { refreshMaintainer(); }));
  } else if (route === 'engines') {
    box.append(headBtn('head-refresh', '↻ REFRESH', 'btn-primary', () => { refreshEngines(); }));
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
  setBadge('nav-badge-chat', S.msgsAt ? S.msgs.length : null, 'dim');
  setBadge('nav-badge-logs', S.logsAt ? S.logs.length : null, 'dim');
  const done = S.workflows.filter(w => !['pending', 'claimed', 'running'].includes(String(w.status).toLowerCase())).length;
  setBadge('nav-badge-maintainer', S.workflows.length ? done : null, 'dim');
  const eng = stateSectionItems(S.state, 'engines');
  const up = countHue(eng, 'ok');
  setBadge('nav-badge-engines', eng ? (up + '/' + eng.length) : null, eng ? (up === eng.length ? 'ok' : 'warn') : 'dim');
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

function toggleRailPause(btn, route) {
  const r = route || 'rounds';
  S.railPaused[r] = !S.railPaused[r];
  btn.classList.toggle('on', S.railPaused[r]);
  btn.textContent = S.railPaused[r] ? 'RESUME' : 'PAUSE';
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
  if (!t) return '';
  const s = String(wf.status || '').toLowerCase();
  const age = fmtAge(t, now);
  if (s === 'pending') return age + ' queued';
  if (['completed', 'failed', 'cancelled'].includes(s)) return 'done in ' + age;
  return age + ' in';
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
  // Merge, don't clear: a live SSE row that arrived while this fetch was in
  // flight must survive the backfill render (the task-89 wrinkle). Fetched
  // rows are the older window; anything already in the buffer that the fetch
  // did NOT return is newer live rows — they keep their place after it.
  const rows = r.data.slice(0, 60).reverse(); // oldest of the window first
  const fetchedIds = new Set(rows.map(row => String(row.id)));
  const liveOlderFirst = S.events.filter(e => !fetchedIds.has(String(e.id)));
  S.events = rows.concat(liveOlderFirst).slice(-RAIL_BUFFER_MAX);
  renderRailFromEvents();
  renderLabCount();
  updateBadges();
}

/** Rebuild the lab rail from the buffer — one render path for backfill + live. */
function renderRailFromEvents() {
  clear(L.rail);
  for (const row of S.events) {
    const hue = /heartbeat/i.test(String(row.type)) ? 'dim' : nameHue(row.agent);
    L.rail.append(h('li', { class: 'rail-line' },
      h('span', { class: 't', text: clockOf(row.created_at || Date.now()) }),
      ' ',
      h('span', { class: 'src', 'data-hue': hue, text: String(row.agent || '?').slice(0, 18) }),
      ' · ' + truncate(String(row.summary || row.type || ''), 150)));
  }
  while (L.rail.children.length > RAIL_BUFFER_MAX) L.rail.removeChild(L.rail.firstChild);
  if (S.route === 'lab') L.rail.scrollTop = L.rail.scrollHeight;
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

// ================================================================= RECEIPT

let RC = {};

function buildReceipt() {
  const page = $('#page-receipt');
  clear(page);
  RC.heroOn = h('div', { class: 'stat-num', text: '—' });
  RC.heroOff = h('div', { class: 'stat-num', text: '—' });
  RC.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  RC.feedChip = h('span', { class: 'hidden' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('RECEIPT'), RC.feedChip),
    h('div', { class: 'cmd-cell' }, micro('ON-OFF DELTA'), h('span', { class: 'cmd-value big mono', text: '—' })),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), RC.stripFresh),
    RC.feedChip,
    h('span', { class: 'spacer' })));

  RC.heroOnWell = h('div', { class: 'stat-well', 'data-hue': 'ok' }, micro('WITH YESTERDAY’S LESSONS — ON'), RC.heroOn,
    h('div', { class: 'stat-note', text: 'repeat-task pass rate, lessons on' }));
  RC.heroOffWell = h('div', { class: 'stat-well' }, micro('WITHOUT — OFF'), RC.heroOff,
    h('div', { class: 'stat-note', text: 'the control arm' }));
  RC.heroRow = h('div', { class: 'stat-row' }, RC.heroOnWell, RC.heroOffWell);
  RC.heroNote = h('div', { class: 'empty-line', text: '' });
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'THE HERO PAIR', micro('THE RECEIPT — measured, never estimated')),
    RC.heroRow, RC.heroNote));

  RC.pairBody = h('div', {});
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'PER-PAIR — LEADER + SPECIALIST BY TASK CLASS', micro('verdict chips: feed-stated, else the arithmetic delta')),
    RC.pairBody));

  RC.nights = h('div', { class: 'nights' });
  RC.nightsNote = h('div', { class: 'cap-note', text: '' });
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'THE NIGHTLY STRIP', micro('bars + chips — no charts')),
    RC.nights, RC.nightsNote));
}

function receiptUrl() {
  try { return localStorage.getItem(RECEIPT_URL_KEY) || RECEIPT_URL_DEFAULT; }
  catch (e) { return RECEIPT_URL_DEFAULT; }
}

async function refreshReceipt() {
  if (document.hidden) return;
  S.receiptAt = Date.now();
  let json = null;
  try {
    const res = await fetch(receiptUrl(), { mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    json = await res.json();
    S.receiptErr = null;
  } catch (e) {
    json = null;
    S.receiptErr = 'receipt feed not wired (' + e.message + ')';
  }
  S.receiptRaw = json;
  renderReceipt();
  updateBadges();
}

function renderReceipt() {
  const now = Date.now();
  RC.stripFresh.textContent = ageAgo(S.receiptAt, now);

  // the honest headline: the feed the brief names is not there yet
  if (S.receiptErr || S.receiptRaw === null) {
    RC.feedChip.className = 'chip unreach-chip';
    RC.feedChip.dataset.hue = 'warn';
    RC.feedChip.textContent = 'RECEIPT FEED NOT WIRED';
    RC.feedChip.title = receiptUrl() + ' refused — the director exposes it read-only; last tried ' +
      new Date(S.receiptAt).toLocaleTimeString();
    RC.heroOn.textContent = '—'; RC.heroOff.textContent = '—';
    RC.heroOnWell.dataset.hue = 'dim';
    RC.heroNote.textContent = '—  receipt feed not wired — ' + receiptUrl() +
      ' answers nothing yet. Nothing is estimated here; the face renders the moment the feed exists.';
    clear(RC.pairBody);
    RC.pairBody.append(h('div', { class: 'empty-line', text: 'no pairs shown — the feed carries none' }));
    clear(RC.nights);
    RC.nightsNote.textContent = 'the strip draws from the feed’s nights; none are wired yet';
    return;
  }

  const shape = receiptShape(S.receiptRaw);
  if (!shape.ok) {
    RC.feedChip.className = 'chip unreach-chip';
    RC.feedChip.dataset.hue = 'warn';
    RC.feedChip.textContent = 'SHAPE UNREADABLE';
    RC.feedChip.title = 'the feed answered but is missing: ' + shape.missing.join('; ');
    RC.heroNote.textContent = 'the receipt feed answered, but the face cannot read it yet. Missing fields: ' +
      shape.missing.join(' · ') + '. Named, not guessed — the director reshapes the feed or the face learns it.';
    RC.heroOn.textContent = '—'; RC.heroOff.textContent = '—';
    clear(RC.pairBody);
    RC.pairBody.append(h('div', { class: 'empty-line', text: 'pairs unreadable — ' + shape.missing.join('; ') }));
    clear(RC.nights);
    RC.nightsNote.textContent = 'nights unreadable';
    return;
  }

  RC.feedChip.className = 'chip';
  RC.feedChip.dataset.hue = 'ok';
  RC.feedChip.textContent = 'FEED LIVE';
  RC.heroOn.textContent = shape.hero.on === null ? '—' : String(shape.hero.on);
  RC.heroOff.textContent = shape.hero.off === null ? '—' : String(shape.hero.off);
  RC.heroOnWell.dataset.hue = shape.hero.on === null ? 'dim' : 'ok';
  const heroDelta = deltaChip(shape.hero.on, shape.hero.off);
  RC.heroNote.textContent = 'hero delta ' + heroDelta.word +
    (shape.at ? ' · feed stamped ' + String(shape.at) : '');

  clear(RC.pairBody);
  if (!shape.pairs.length) {
    RC.pairBody.append(h('div', { class: 'empty-line', text: 'the feed carries no pairs' }));
  } else {
    const tbl = h('table', { class: 'dtable' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'PAIR' }), h('th', { text: 'ON' }), h('th', { text: 'OFF' }),
        h('th', { text: 'VERDICT' }))));
    const tb = h('tbody', {});
    for (const p of shape.pairs.slice(0, 14)) {
      tb.append(h('tr', {},
        h('td', { class: 'subj', text: p.name }),
        h('td', { class: 'num', text: p.on === null ? '—' : String(p.on) }),
        h('td', { class: 'num', text: p.off === null ? '—' : String(p.off) }),
        h('td', {}, p.verdict ? chip(String(p.verdict), hueOf(String(p.verdict))) : chip(p.delta.word, p.delta.hue))));
    }
    tbl.append(tb);
    RC.pairBody.append(tbl);
    if (shape.pairs.length > 14) RC.pairBody.append(h('div', { class: 'cap-note', text: '+' + (shape.pairs.length - 14) + ' more pairs in the feed' }));
  }

  clear(RC.nights);
  if (!shape.nights.length) {
    RC.nights.append(h('div', { class: 'empty-line', text: 'the feed carries no nights' }));
  } else {
    for (const n of shape.nights.slice(-14)) {
      const pct = barPct(n.on);
      RC.nights.append(h('div', { class: 'night' },
        h('div', { class: 'night-bar-track' },
          h('div', { class: 'night-bar', 'data-hue': pct >= 60 ? 'ok' : pct > 0 ? 'warn' : 'dim', style: 'height:' + pct + '%;' })),
        chip(pct ? pct + '%' : '—', pct >= 60 ? 'ok' : pct > 0 ? 'warn' : 'dim'),
        h('div', { class: 'night-date', text: n.date })));
    }
  }
  RC.nightsNote.textContent = 'bar = ON pass rate for that night · chip = the same, as the strip reads it' +
    (shape.nights.length > 14 ? ' · showing the last 14 of ' + shape.nights.length : '');
}

// ==================================================================== CHAT

let CH = {};

function buildChat() {
  const page = $('#page-chat');
  clear(page);
  CH.stripMode = chip('…', 'dim');
  CH.stripCount = h('span', { class: 'cmd-value big mono', text: '—' });
  CH.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('CHANNEL'), CH.stripMode),
    h('div', { class: 'cmd-cell' }, micro('MESSAGES IN WINDOW'), CH.stripCount),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), CH.stripFresh),
    h('span', { class: 'spacer' })));

  CH.feed = h('ul', { class: 'chat-feed' });
  CH.note = h('div', { class: 'cap-note chat-note', text: 'no bubbles: the channel reads as narration — glyph · sentence · mono stamp, newest first' });
  CH.composerInput = h('input', {
    class: 'input mono', type: 'text', id: 'chat-input',
    placeholder: 'post to the channel as yourself — an operator session, never a pseudo-agent',
  });
  CH.send = h('button', { class: 'btn btn-primary', id: 'chat-send', text: 'SEND', onclick: () => sendChat() });
  CH.composerNote = h('div', { class: 'cap-note chat-note', text: '' });
  page.append(h('div', { class: 'well chat-wrap' },
    h('div', { class: 'well-title' }, 'THE CHANNEL', micro('GET /messages · POST /messages as the operator')),
    CH.feed,
    CH.note,
    h('div', { class: 'chat-composer' }, CH.composerInput, CH.send),
    CH.composerNote));
  CH.composerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
}

async function refreshChat() {
  if (document.hidden) return;
  const r = await api('/messages?limit=60');
  if (r.ok && Array.isArray(r.data)) {
    S.msgs = r.data;
    S.msgsAt = Date.now();
    S.msgsErr = null;
    CH.stripMode.textContent = 'LINKED';
    CH.stripMode.dataset.hue = 'ok';
  } else {
    S.msgsErr = r.error || ('http ' + r.status);
    CH.stripMode.textContent = 'UNREACHABLE';
    CH.stripMode.dataset.hue = 'crit';
  }
  renderChat();
  updateBadges();
}

function renderChat() {
  const now = Date.now();
  CH.stripCount.textContent = S.msgsErr ? '—' : String(S.msgs.length);
  CH.stripFresh.textContent = ageAgo(S.msgsAt, now);
  clear(CH.feed);
  if (S.msgsErr) {
    CH.feed.append(h('li', { class: 'empty-line', text: 'channel unreachable — ' + S.msgsErr }));
    return;
  }
  if (!S.msgs.length) {
    CH.feed.append(h('li', { class: 'empty-line', text: 'no messages in the window — the channel is quiet' }));
    return;
  }
  for (const m of S.msgs.slice(0, 60)) {
    const from = String(m.from_agent || '?');
    const to = m.to_agent ? String(m.to_agent) : null;
    const hue = chatHue(m);
    CH.feed.append(h('li', { class: 'chat-row' },
      h('span', { class: 'chat-glyph', 'data-hue': hue, text: from.slice(0, 2) }),
      h('span', { class: 'chat-main' },
        h('span', { class: 'from', text: from }, to ? h('span', { class: 'to', text: ' → ' + to }) : null),
        '  ',
        h('span', { class: 'chat-body', text: truncate(firstLine(stripPrefix(m.content || '')), 110) })),
      h('span', { class: 'chat-stamp', text: clockOf(m.created_at) })));
  }
  CH.note.textContent = 'showing ' + Math.min(60, S.msgs.length) + ' · newest first · system-to-system telemetry is filtered by the platform itself';
}

async function sendChat() {
  if (S.chatBusy) return;
  const text = CH.composerInput.value.trim();
  if (!text) { CH.composerNote.textContent = 'nothing to send — type a line first'; return; }
  S.chatBusy = true;
  CH.send.disabled = true;
  CH.send.textContent = '…';
  const r = await api('/messages', { method: 'POST', body: { content: text } });
  S.chatBusy = false;
  CH.send.disabled = false;
  CH.send.textContent = 'SEND';
  if (!r.ok) {
    CH.composerNote.textContent = 'post refused — ' + (r.error || 'http ' + r.status) + ' · nothing was sent';
    return;
  }
  CH.composerInput.value = '';
  CH.composerNote.textContent = 'posted as you (the operator session) · ' + fmtClock(Date.now());
  refreshChat();
}

// ==================================================================== LOGS

let LG = {};

function buildLogs() {
  const page = $('#page-logs');
  clear(page);
  LG.stripMode = chip('POLLED', 'info');
  LG.stripCount = h('span', { class: 'cmd-value big mono', text: '—' });
  LG.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('STREAM'), LG.stripMode),
    h('div', { class: 'cmd-cell' }, micro('LINES'), LG.stripCount),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), LG.stripFresh),
    h('span', { class: 'spacer' })));

  LG.rail = h('ul', { class: 'rail-body tall', style: 'max-height: calc(100vh - var(--head-h) - 190px);' });
  LG.count = h('span', { class: 'rail-count', text: '0' });
  LG.pauseBtn = h('button', { class: 'rail-btn', text: 'PAUSE', onclick: toggleLogsPause });
  LG.copyBtn = h('button', { class: 'rail-btn', text: 'COPY', onclick: copyLogs });
  page.append(h('div', { class: 'well rail' },
    h('div', { class: 'rail-head' },
      h('span', { class: 'rail-title', 'data-hue': 'accent', text: 'LAB LOG — EVENTS, FULL PAGE' }),
      LG.count,
      h('span', { class: 'rail-mode', text: 'polled every 15s' }),
      h('span', { class: 'rail-btns' }, LG.pauseBtn, h('button', { class: 'rail-btn', text: 'CLR', onclick: clearLogs }), LG.copyBtn)),
    LG.rail,
    h('div', { style: 'padding:6px 14px 10px;' },
      h('div', { class: 'cap-note', id: 'logs-note', text: 'the platform event log, source hue-coded · the same stream Lab Alive streams live, read here at poll cadence' }))));
}

async function refreshLogs() {
  if (document.hidden) return;
  const r = await api('/events?limit=200');
  if (r.ok && Array.isArray(r.data)) {
    S.logsAt = Date.now();
    S.logsErr = null;
    const rows = r.data.slice(0, 200).reverse(); // oldest first
    if (S.logsPaused) {
      S.logsHeldBack += rows.filter(row => !S.logs.some(e => String(e.id) === String(row.id))).length;
      renderLogsNote();
      return;
    }
    S.logs = rows.slice(-RAIL_BUFFER_MAX);
    renderLogs();
  } else {
    S.logsErr = r.error || ('http ' + r.status);
    renderLogs();
  }
  updateBadges();
}

function renderLogs() {
  const now = Date.now();
  LG.stripCount.textContent = S.logsErr ? '—' : String(S.logs.length);
  LG.stripFresh.textContent = ageAgo(S.logsAt, now);
  LG.count.textContent = String(S.logs.length);
  clear(LG.rail);
  if (S.logsErr) {
    LG.rail.append(h('li', { class: 'rail-line' },
      h('span', { class: 'src', 'data-hue': 'crit', text: 'logs' }),
      ' · unreachable — ' + S.logsErr));
    return;
  }
  if (!S.logs.length) {
    LG.rail.append(h('li', { class: 'rail-line' },
      h('span', { class: 'src', 'data-hue': 'dim', text: 'logs' }),
      ' · no events in the window'));
    return;
  }
  for (const row of S.logs) logsLine(row);
  if (S.route === 'logs') LG.rail.scrollTop = LG.rail.scrollHeight;
}

function logsLine(row) {
  const hue = /heartbeat/i.test(String(row.type)) ? 'dim' : nameHue(row.agent);
  LG.rail.append(h('li', { class: 'rail-line' },
    h('span', { class: 't', text: clockOf(row.created_at) }),
    ' ',
    h('span', { class: 'src', 'data-hue': hue, text: String(row.agent || '?').slice(0, 18) }),
    ' · ' + truncate(String(row.summary || row.type || ''), 190)));
  while (LG.rail.children.length > RAIL_BUFFER_MAX) LG.rail.removeChild(LG.rail.firstChild);
}

function renderLogsNote() {
  const note = $('#logs-note');
  if (note) note.textContent = 'paused — ' + S.logsHeldBack + ' line' + (S.logsHeldBack === 1 ? '' : 's') +
    ' passed while paused; resume to let them in. The record kept them.';
}

function toggleLogsPause() {
  S.logsPaused = !S.logsPaused;
  LG.pauseBtn.classList.toggle('on', S.logsPaused);
  LG.pauseBtn.textContent = S.logsPaused ? 'RESUME' : 'PAUSE';
  const head = $('#head-pause');
  if (head) head.textContent = S.logsPaused ? '▶ RESUME' : '❚❚ PAUSE';
  LG.stripMode.textContent = S.logsPaused ? 'PAUSED' : 'POLLED';
  LG.stripMode.dataset.hue = S.logsPaused ? 'warn' : 'info';
  if (!S.logsPaused) {
    if (S.logsHeldBack) {
      LG.rail.append(h('li', { class: 'rail-line' },
        h('span', { class: 't', text: '--:--:--' }),
        ' ',
        h('span', { class: 'src', 'data-hue': 'warn', text: 'pause' }),
        ' · ' + S.logsHeldBack + ' line' + (S.logsHeldBack === 1 ? '' : 's') + ' passed while paused — the record kept them'));
      S.logsHeldBack = 0;
    }
    renderLogsNote();
    refreshLogs();
  } else {
    renderLogsNote();
  }
}

function clearLogs() {
  clear(LG.rail);
  S.logs = [];
  S.logsHeldBack = 0;
  LG.count.textContent = '0';
  LG.stripCount.textContent = '0';
  renderLogsNote();
}

async function copyLogs() {
  const lines = S.logs.map(row =>
    fmtClock(parseStamp(row.created_at) || Date.now()) + ' ' + String(row.agent || '?') + ' · ' + String(row.summary || row.type || ''));
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    LG.copyBtn.textContent = 'COPIED';
    setTimeout(() => { LG.copyBtn.textContent = 'COPY'; }, 1500);
  } catch (e) {
    LG.copyBtn.textContent = 'DENIED';
    setTimeout(() => { LG.copyBtn.textContent = 'COPY'; }, 1500);
  }
}

// ============================================================== MAINTAINER

let MT = {};

function buildMaintainer() {
  const page = $('#page-maintainer');
  clear(page);
  MT.stripStatus = chip('…', 'dim');
  MT.stripRepos = h('span', { class: 'cmd-value big mono', text: '—' });
  MT.stripDone = h('span', { class: 'cmd-value big mono', text: '—' });
  MT.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('EVIDENCE'), MT.stripStatus),
    h('div', { class: 'cmd-cell' }, micro('ADOPTED REPOS'), MT.stripRepos),
    h('div', { class: 'cmd-cell' }, micro('GATED RUNS IN WINDOW'), MT.stripDone),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), MT.stripFresh),
    h('span', { class: 'spacer' })));

  MT.findings = h('div', {});
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'FINDINGS — GATED RUNS', micro('GET /workflows · the gate verdict is the evidence')),
    MT.findings));

  MT.rail = h('ul', { class: 'rail-body' });
  MT.railCount = h('span', { class: 'rail-count', text: '0' });
  page.append(h('div', { class: 'well rail' },
    h('div', { class: 'rail-head' },
      h('span', { class: 'rail-title', 'data-hue': 'ok', text: 'GATE OUTPUT' }),
      MT.railCount,
      h('span', { class: 'rail-mode', text: 'polled' }),
      h('span', { class: 'rail-btns' },
        h('button', { class: 'rail-btn', text: 'PAUSE', onclick: (e) => toggleRailPause(e.target, 'maintainer') }),
        h('button', { class: 'rail-btn', text: 'CLR', onclick: (e) => { clear(MT.rail); MT.railCount.textContent = '0'; } }))),
    MT.rail,
    h('div', { style: 'padding:6px 14px 10px;' },
      h('div', { class: 'cap-note', text: 'verified = a real gate produced it — provenance is the point, per the honesty rule' }))));

  MT.repos = h('div', {});
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'ADOPTED REPOS', micro('GET /projects')),
    MT.repos));
}

async function refreshMaintainer() {
  if (document.hidden) return;
  fetchState().then(() => { if (S.route === 'maintainer') renderMaintainerRepos(); });
  const w = await api('/workflows?limit=50&order=desc');
  if (w.ok) {
    S.workflows = (w.data && w.data.items) || [];
    S.wfAt = Date.now();
    S.wfErr = null;
  } else {
    S.wfErr = w.error;
  }
  const p = await api('/projects');
  if (p.ok && Array.isArray(p.data)) {
    S.projects = p.data;
    S.projectsAt = Date.now();
    S.projectsErr = null;
  } else {
    S.projectsErr = p.error || ('http ' + p.status);
  }
  renderMaintainer();
  updateBadges();
}

function renderMaintainer() {
  const now = Date.now();
  const up = S.platformOk !== false && S.wfErr === null;
  const done = S.workflows.filter(w => !['pending', 'claimed', 'running'].includes(String(w.status).toLowerCase()));
  MT.stripStatus.textContent = up ? 'EVIDENCE OK' : 'UNREACHABLE';
  MT.stripStatus.dataset.hue = up ? 'ok' : 'crit';
  MT.stripRepos.textContent = S.projectsErr ? '—' : String(S.projects.length);
  MT.stripDone.textContent = up ? String(done.length) : '—';
  MT.stripFresh.textContent = ageAgo(S.wfAt, now);

  clear(MT.findings);
  if (!up) {
    MT.findings.append(h('div', { class: 'empty-line', text: 'workflows unreachable — ' + (S.wfErr || 'no data') }));
  } else if (!S.workflows.length) {
    MT.findings.append(h('div', { class: 'empty-line', text: 'no gated runs in the window — nothing to file' }));
  } else {
    const tbl = h('table', { class: 'dtable' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'SUBJECT' }), h('th', { text: 'GATE' }), h('th', { text: 'PROVENANCE' }), h('th', { text: 'AGE' }))));
    const tb = h('tbody', {});
    for (const wf of S.workflows.slice(0, 12)) {
      const v = wfVerdict(wf);
      const who = String(wf.claimed_by || wf.requested_by || '—');
      tb.append(h('tr', {},
        h('td', { class: 'subj', text: truncate(wf.name || ('wf#' + wf.id), 58) }),
        h('td', {}, chip(v.word, v.hue)),
        h('td', { class: 'dim-cell', text: 'runner ' + who + ' · wf#' + wf.id }),
        h('td', { class: 'dim-cell', text: wfAge(wf, now) })));
    }
    tbl.append(tb);
    MT.findings.append(tbl);
    if (S.workflows.length > 12) MT.findings.append(h('div', { class: 'cap-note', text: '+' + (S.workflows.length - 12) + ' more in the window' }));
  }

  if (!S.railPaused.maintainer && up) {
    clear(MT.rail);
    for (const wf of S.workflows.slice(0, 30)) {
      const v = wfVerdict(wf);
      MT.rail.append(h('li', { class: 'rail-line' },
        h('span', { class: 't', text: clockOf(wf.started_at || wf.created_at) }),
        ' ',
        h('span', { class: 'src', 'data-hue': v.hue === 'dim' ? 'accent' : v.hue, text: 'WF#' + wf.id }),
        ' · ' + v.word + ' · ' + truncate(wf.name || '', 80)));
    }
    MT.railCount.textContent = String(Math.min(30, S.workflows.length));
  }

  renderMaintainerRepos();
}

function renderMaintainerRepos() {
  clear(MT.repos);
  if (S.projectsErr) {
    MT.repos.append(h('div', { class: 'empty-line', text: 'projects unreachable — ' + S.projectsErr }));
    return;
  }
  if (!S.projects.length) {
    MT.repos.append(h('div', { class: 'empty-line', text: 'no projects registered on this platform yet' }));
    return;
  }
  const tbl = h('table', { class: 'dtable' },
    h('thead', {}, h('tr', {},
      h('th', { text: 'REPO' }), h('th', { text: 'TYPE' }), h('th', { text: 'STATUS' }), h('th', { text: 'PATH' }))));
  const tb = h('tbody', {});
  for (const p of S.projects.slice(0, 12)) {
    tb.append(h('tr', {},
      h('td', { class: 'subj', text: truncate(p.name || p.id, 40) }),
      h('td', { class: 'dim-cell', text: String(p.type || '—') }),
      h('td', {}, chip(String(p.status || '—'), hueOf(p.status))),
      h('td', { class: 'dim-cell', text: truncate(String(p.repo_path || p.repo_url || '—'), 46) })));
  }
  tbl.append(tb);
  MT.repos.append(tbl);
}

// ================================================================= ENGINES

let EN = {};

function buildEngines() {
  const page = $('#page-engines');
  clear(page);
  EN.stripStatus = chip('…', 'dim');
  EN.stripUp = h('span', { class: 'cmd-value big mono', text: '—' });
  EN.stripFresh = h('span', { class: 'cmd-value', text: '—' });
  EN.stateChip = h('span', { class: 'hidden' });
  page.append(h('div', { class: 'cmd-strip' },
    h('div', { class: 'cmd-cell' }, micro('SEATS'), EN.stripStatus),
    h('div', { class: 'cmd-cell' }, micro('UP / TOTAL'), EN.stripUp),
    h('div', { class: 'cmd-cell' }, micro('REFRESHED'), EN.stripFresh),
    EN.stateChip,
    h('span', { class: 'spacer' })));

  EN.seatRow = h('div', { class: 'stat-row' });
  page.append(h('div', { class: 'well' },
    h('div', { class: 'well-title' }, 'THE SEATS', micro('the director’s state source only — the browser probes no LAN port')),
    EN.seatRow,
    h('div', { class: 'cap-note', text: 'a seat is whatever the state source says it is — oMLX, ds4, the 3090, the GLM proxy appear when the source carries them' })));
}

async function refreshEngines() {
  if (document.hidden) return;
  await fetchState();
  renderEngines();
  updateBadges();
}

function renderEngines() {
  const now = Date.now();
  const items = stateSectionItems(S.state, 'engines');
  const up = countHue(items, 'ok');
  EN.stripUp.textContent = items ? (up + ' / ' + items.length) : '—';
  EN.stripFresh.textContent = ageAgo(S.stateOkAt || S.stateAt, now);

  if (S.stateErr) {
    EN.stripStatus.textContent = 'STATE UNREACHABLE';
    EN.stripStatus.dataset.hue = 'warn';
    EN.stateChip.className = 'chip unreach-chip';
    EN.stateChip.dataset.hue = 'warn';
    EN.stateChip.textContent = 'STATE SOURCE BLOCKED';
    EN.stateChip.title = S.stateErr + ' · last ok: ' + (S.stateOkAt ? new Date(S.stateOkAt).toLocaleTimeString() : 'never');
  } else {
    EN.stripStatus.textContent = items ? 'SEATS READ' : 'NO SECTION';
    EN.stripStatus.dataset.hue = items ? 'ok' : 'dim';
    EN.stateChip.className = 'hidden';
  }

  clear(EN.seatRow);
  if (items && items.length) {
    for (const it of items) {
      EN.seatRow.append(statWell(it.k || 'seat', String(it.v || '—'), it.note ? truncate(it.note, 64) : null, hueOf(it.status)));
    }
  } else {
    const lastOk = S.stateOkAt ? 'last ok ' + ageAgo(S.stateOkAt, now) : 'never answered';
    EN.seatRow.append(statWell('SEATS', '—', S.stateErr ? 'state source unreachable — the face stays honest until it answers' : lastOk,
      S.stateErr ? 'warn' : 'dim', true));
  }
}

// =================================================================== ABOUT

function buildAbout() {
  const page = $('#page-about');
  clear(page);
  const about = h('div', { class: 'well', style: 'max-width: 720px;' },
    h('div', { style: 'font-size: 40px; line-height: 1; margin-bottom: 10px;', text: '🍄' }),
    h('div', { class: 'signin-word', style: 'font-size: 22px;', text: 'Mycelium' }),
    h('div', { class: 'hint', style: 'margin: 2px 0 14px;', text: 'operator console · clean-room build, task 90' }),
    h('div', { class: 'a-rows', style: 'display:grid; grid-template-columns: auto 1fr; gap: 6px 14px; align-items: baseline;' },
      micro('CONSOLE'), h('span', { class: 'v mono', style: 'font-size: 12px;', text: 'c0.1 · plain HTML/CSS/JS, no build step' }),
      micro('PLATFORM'), h('span', { class: 'v mono', id: 'about-platform', style: 'font-size: 12px;', text: '—' }),
      micro('LICENSE'), h('span', { class: 'v', style: 'font-size: 12px;', text: 'this console is Mycelium’s own code, Apache-2.0' })),
    h('div', { style: 'height: 14px;' }),
    h('p', { class: 'hint', style: 'margin: 0; line-height: 1.6;' },
      'NOTICE — this console is Mycelium’s own code. The command-console presentation it follows is a ',
      h('span', { class: 'mono', text: 'design study' }),
      ', documented in ', h('span', { class: 'mono', text: 'SPEC-t3mp3st-presentation.md' }),
      ' (jarvis/runs/fable-specs/); no dashboard source was opened while building it — ',
      h('span', { class: 'mono', text: 'tools/cleanroom_check.py' }), ' is the gate, and it must read 0.'),
    h('p', { class: 'hint', style: 'margin: 12px 0 0; line-height: 1.6;' },
      'The honesty rule is the interface: an unmeasured value renders “—”, an unreachable source says why, and nothing is ever estimated.'));
  page.append(about);
  refreshAbout();
}

async function refreshAbout() {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    const el = $('#about-platform');
    if (el) el.textContent = 'v' + (j.version || '?') + ' · ' + String(j.commit_sha || '').slice(0, 7) +
      ' · up ' + fmtAge(Date.now() - (j.uptime_seconds || 0) * 1000, Date.now());
  } catch (e) {
    const el = $('#about-platform');
    if (el) el.textContent = '— health unreadable (' + e.message + ')';
  }
}

// ================================================================= DENSITY

function applyDensity() {
  let d = 'compact';
  try { d = localStorage.getItem(DENSITY_KEY) === 'comfortable' ? 'comfortable' : 'compact'; } catch (e) { /* default */ }
  document.body.dataset.density = d;
  const btn = $('#density-btn');
  if (btn) {
    btn.textContent = d === 'comfortable' ? 'COMFORTABLE' : 'COMPACT';
    btn.classList.toggle('on', d === 'comfortable');
    btn.title = 'density: ' + d + ' — click for ' + (d === 'comfortable' ? 'compact' : 'comfortable');
  }
}

function toggleDensity() {
  const next = document.body.dataset.density === 'comfortable' ? 'compact' : 'comfortable';
  try { localStorage.setItem(DENSITY_KEY, next); } catch (e) { /* session-only */ }
  applyDensity();
}

// ==================================================================== TOUR

const TOUR_STEPS = [
  { nav: 'nav-rounds', title: 'Rounds', body: 'The lab working: command strip, seat wells, the box ledger, lanes in flight and last outcomes, the runner log.', src: 'GET /workflows + the state source' },
  { nav: 'nav-receipt', title: 'Receipt', body: 'THE number: repeat-task pass rate with yesterday’s lessons ON vs OFF — hero pair, per-pair table, the nightly strip. Until the feed is wired it says so, honestly.', src: 'the director’s receipt feed' },
  { nav: 'nav-chat', title: 'Chat', body: 'The platform’s message channel as narration — no bubbles. The composer posts as you: an operator session, never a pseudo-agent.', src: 'GET/POST /messages' },
  { nav: 'nav-agents', title: 'Agents', body: 'The roster as presence truth: who is online, on which brain and seat, heartbeat age.', src: 'GET /agents' },
  { nav: 'nav-memory', title: 'Memory', body: 'Lessons as a ledger with outcome edges; recall by meaning with provenance chips.', src: 'GET /memory/lessons · POST /memory/search' },
  { nav: 'nav-lab', title: 'Lab Alive', body: 'The event stream as it happens — SSE when it can, poll fallback that labels itself.', src: 'GET /events/stream' },
  { nav: 'nav-logs', title: 'Logs', body: 'The same event log full page, source hue-coded, with pause, clear and copy.', src: 'GET /events, polled' },
  { nav: 'nav-maintainer', title: 'Maintainer', body: 'The evidence vault: gated runs as findings with gate chips, provenance lines, gate output in a terminal rail, adopted repos.', src: 'GET /workflows · GET /projects' },
  { nav: 'nav-engines', title: 'Engines', body: 'The seats as wells — read only from the director’s state source; the browser never probes a LAN port.', src: 'state.json, engines section' },
  { nav: 'nav-about', title: 'About', body: 'The version, the license, and the notice that the presentation is a documented design study.', src: 'GET /health' },
];

let tour = null;

function maybeFirstRunTour() {
  let done = false;
  try { done = localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { /* fresh profile */ }
  if (!done) startTour(false);
}

function startTour(fromButton) {
  stopTour();
  const layer = h('div', { class: 'tour-layer' });
  const hole = h('div', { class: 'tour-hole' });
  const arrow = h('div', { class: 'tour-arrow' });
  const tip = h('div', { class: 'tour-tip' });
  layer.append(hole);
  document.body.append(layer, hole, arrow, tip);
  tour = { layer, hole, arrow, tip, step: 0, dots: [], fromButton: !!fromButton };
  document.addEventListener('keydown', tourKeys, true);
  window.addEventListener('resize', tourPlace);
  tourShow(0);
}

function tourShow(i) {
  if (!tour) return;
  tour.step = i;
  const def = TOUR_STEPS[i];
  const nav = $('#' + def.nav);
  if (!nav) { tourNext(); return; }
  nav.scrollIntoView({ block: 'nearest' });
  const r = nav.getBoundingClientRect();
  tour.hole.style.top = (r.top - 5) + 'px';
  tour.hole.style.left = (r.left - 5) + 'px';
  tour.hole.style.width = (r.width + 10) + 'px';
  tour.hole.style.height = (r.height + 10) + 'px';
  const tip = tour.tip;
  clear(tip);
  tip.append(
    h('div', { class: 'micro tour-step-label', text: 'the tour · step ' + (i + 1) + ' of ' + TOUR_STEPS.length }),
    h('div', { class: 'tour-title', text: def.title }),
    h('div', { class: 'tour-body', text: def.body }),
    h('div', { class: 'tour-src mono', text: def.src }),
    h('div', { class: 'tour-foot' },
      (() => {
        const dots = h('div', { class: 'tour-dots' });
        tour.dots = TOUR_STEPS.map((_, di) => {
          const d = h('button', {
            class: 'tour-dot' + (di < i ? ' done' : di === i ? ' cur' : ''),
            title: TOUR_STEPS[di].title,
            onclick: () => tourShow(di),
          });
          dots.append(d);
          return d;
        });
        return dots;
      })(),
      i > 0 ? h('button', { class: 'btn', text: 'BACK', onclick: tourPrev }) : null,
      h('button', { class: 'btn btn-primary', text: i === TOUR_STEPS.length - 1 ? 'DONE' : 'NEXT', onclick: tourNext }),
      h('button', { class: 'btn btn-ghost', text: 'SKIP', onclick: stopTour })));
  // tooltip rides to the right of the sidebar nav, arrow bridging the gap
  const tipX = r.right + 22;
  const tipY = Math.max(12, Math.min(window.innerHeight - 300, r.top - 40));
  tip.style.left = tipX + 'px';
  tip.style.top = tipY + 'px';
  tour.arrow.style.left = (r.right + 8) + 'px';
  tour.arrow.style.top = (r.top + r.height / 2 - 8) + 'px';
}

function tourNext() {
  if (!tour) return;
  if (tour.step >= TOUR_STEPS.length - 1) { stopTour(); return; }
  tourShow(tour.step + 1);
}

function tourPrev() {
  if (!tour || tour.step === 0) return;
  tourShow(tour.step - 1);
}

function tourKeys(e) {
  if (!tour) return;
  if (e.key === 'Escape') { stopTour(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { tourNext(); }
  else if (e.key === 'ArrowLeft') { tourPrev(); }
}

function tourPlace() {
  if (tour) tourShow(tour.step);
}

function stopTour() {
  if (!tour) return;
  document.removeEventListener('keydown', tourKeys, true);
  window.removeEventListener('resize', tourPlace);
  for (const n of [tour.layer, tour.hole, tour.arrow, tour.tip]) {
    try { n.remove(); } catch (e) { /* already gone */ }
  }
  tour = null;
  try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* private mode re-tours */ }
}

// ------------------------------------------------------------------- start

boot();
