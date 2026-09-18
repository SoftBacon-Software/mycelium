// jetson-relay.mjs — loopback HTTP relay that forwards to the Jetson's ollama
// USING /usr/bin/curl, one curl per request. WHY THIS EXISTS: on this Mac, raw
// sockets from node AND python to 192.168.50.x fail EHOSTUNREACH while curl
// connects (recorded lesson: ledger-blind lanes; re-probed 2026-09-17
// unsandboxed — node fails, python fails, curl answers; macOS per-app
// Local-Network permission is the suspected mechanism, never granted to the
// node/python binaries). The scratch smoke server embeds via node fetch, so it
// can only reach the Jetson THROUGH this relay. Instrument-side plumbing, NOT
// a platform change — the deployed platform embeds on the Jetson itself, over
// loopback, where fetch works.

import { spawn } from 'node:child_process';
import http from 'node:http';

const UPSTREAM = 'http://192.168.50.106:11434';
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);

export function startJetsonRelay({ upstream = UPSTREAM, log = () => {} } = {}) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const args = ['-sS', '--max-time', '120', '-X', req.method, '-w', '\n%{http_code}'];
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) args.push('-H', `${k}: ${v}`);
      }
      if (body.length) args.push('--data-binary', '@-');
      args.push(`${upstream}${req.url}`);
      const curl = spawn('/usr/bin/curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      let errTxt = '';
      curl.stdout.on('data', (c) => out.push(c));
      curl.stderr.on('data', (c) => { errTxt += c; });
      curl.on('close', (code) => {
        if (code !== 0) {
          log(`relay: curl exit ${code} for ${req.method} ${req.url}: ${errTxt.trim().slice(0, 200)}`);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`jetson-relay: upstream curl failed (exit ${code}): ${errTxt.trim().slice(0, 200)}`);
          return;
        }
        const raw = Buffer.concat(out);
        const nl = raw.lastIndexOf(10);
        let status = 200;
        let payload = raw;
        if (nl !== -1) {
          const tail = raw.toString('utf8', nl + 1).trim();
          if (/^\d{3}$/.test(tail)) {
            status = parseInt(tail, 10);
            payload = raw.subarray(0, nl);
          }
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      });
      curl.stdin.end(body);
      req.on('error', () => curl.kill('SIGKILL'));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        stop: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}
