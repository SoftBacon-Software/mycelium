// K-kira 90 — screenshot every face of the clean-room operator console.
// Zero-dep CDP driver adapted from velum-web/tools/screenshot-pages.mjs (ours).
// Signs in as the fixture operator by planting the JWT the app itself would
// store, then shoots each hash route at two viewports against the platform
// running from THIS worktree — plus the guided tour mid-step and the
// comfortable density. Chrome is THIS process's child and is killed before
// exit (lane rule 0).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9229;
const BASE = 'http://127.0.0.1:3002/console/';
const OUT = new URL('../docs/console/shots/', import.meta.url).pathname;
const LOGIN = { username: 'operator', password: 'console-fixtures-2026' };
const ROUTES = ['rounds', 'receipt', 'chat', 'agents', 'memory', 'lab', 'logs', 'maintainer', 'engines', 'about'];
const VIEWPORTS = [[1600, 1000], [1280, 800]];

// 1. operator sign-in through the same endpoint the page uses
const loginRes = await fetch('http://127.0.0.1:3002/api/mycelium/studio/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(LOGIN),
});
if (!loginRes.ok) { console.error('EXIT 2 login failed http ' + loginRes.status); process.exit(2); }
const { token } = await loginRes.json();

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/k90-chrome-profile-${process.pid}`,
  '--window-size=1600,1000', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErrTail = '';
chrome.stderr.on('data', d => { chromeErrTail = (chromeErrTail + d).slice(-3000); });

let exiting = false;
function cleanup(code, why) {
  if (exiting) return; exiting = true;
  try { chrome.kill('SIGKILL'); } catch {}
  console.log(`EXIT ${code} ${why}`);
  process.exit(code);
}
process.on('SIGINT', () => cleanup(130, 'sigint'));
process.on('SIGTERM', () => cleanup(143, 'sigterm'));
chrome.on('exit', (c) => cleanup(3, `chrome exited early rc=${c}: ${chromeErrTail.slice(-200)}`));

let up = null;
for (let i = 0; i < 60 && !up; i++) {
  try { up = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(500); }
}
if (!up) cleanup(2, 'devtools endpoint never came up');

const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++mid; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = m => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

await send('Page.enable');
mkdirSync(OUT, { recursive: true });

const failures = [];

async function plantJwtAndReload() {
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('mycelium-studio-jwt', ${JSON.stringify(token)});` +
      `localStorage.setItem('mycelium_console_tour_done','1');` +
      `localStorage.setItem('mycelium_console_density','compact'); 'planted'`,
    returnByValue: true,
  });
  await send('Page.navigate', { url: BASE });
  await sleep(3500); // boot: me() verify, first fetches, SSE open
}

async function shoot(name, minBytes = 50000) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = OUT + name;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const bytes = statSync(file).size;
  if (bytes < minBytes) failures.push(`${name} only ${bytes}B`);
  console.log(`${name}: ${bytes}B`);
}

// sign-in well first (fail-closed proof): no JWT in the page
await send('Page.navigate', { url: BASE });
await sleep(2500);
await send('Runtime.evaluate', { expression: `localStorage.clear(); 'cleared'`, returnByValue: true });
await send('Page.navigate', { url: BASE });
await sleep(2000);
await shoot('90-signin-1600.png');

for (const [w, hgt] of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: false });
  await plantJwtAndReload();
  for (const route of ROUTES) {
    await send('Runtime.evaluate', { expression: `location.hash = '#/${route}'; 'ok'`, returnByValue: true });
    await sleep(3000); // fetches + a render tick; SSE lines accumulate
    await shoot(`90-${route}-${w}.png`);
  }
}

// the guided tour, mid-step (step 2 — the Receipt), at 1600
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Runtime.evaluate', { expression: `localStorage.removeItem('mycelium_console_tour_done'); location.hash = '#/rounds'; 'ok'`, returnByValue: true });
await send('Page.navigate', { url: BASE });
await sleep(4000); // boot runs maybeFirstRunTour → step 1; advance one step
await send('Runtime.evaluate', { expression: `document.querySelector('.tour-tip .btn-primary') && document.querySelector('.tour-tip .btn-primary').click(); 'next'`, returnByValue: true });
await sleep(900);
await shoot('90-tour-step2-1600.png');
// leave the page clean for the density shot
await send('Runtime.evaluate', { expression: `localStorage.setItem('mycelium_console_tour_done','1'); location.hash = '#/rounds'; location.reload(); 'ok'`, returnByValue: true });
await sleep(3000);

// comfortable density at 1600 (the toggle's visible effect, memory face has the densest rows)
await send('Runtime.evaluate', { expression: `localStorage.setItem('mycelium_console_density','comfortable'); location.hash = '#/memory'; 'ok'`, returnByValue: true });
await sleep(1200);
await send('Runtime.evaluate', { expression: `document.getElementById('density-btn') && document.getElementById('density-btn').click(); 'toggled'`, returnByValue: true });
await sleep(1500);
await shoot('90-comfortable-memory-1600.png');

try { ws.close(); } catch {}
if (failures.length) cleanup(1, 'undersized shots: ' + failures.join('; '));
cleanup(0, 'done');
