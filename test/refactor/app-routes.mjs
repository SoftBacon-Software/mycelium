// app-route extractor — every route the REAL Express app registers, with full
// mount prefixes. Sibling to route-manifest.mjs.
//
// route-manifest.mjs walks the /api/mycelium sub-router in isolation (it imports
// server/routes/mycelium.js directly, never server/index.js). That is exactly
// why its snapshot has no root-app routes — GET /health (server/index.js,
// mounted on the root app, not the sub-router) is outside its universe. The
// docs-endpoint-truth gate needs the OPPOSITE view: the full app, root routes
// included, so it can prove README/CONTRIBUTING citations like `GET /health`
// resolve where the docs say they do (root, not /api/mycelium).
//
// So this script builds the real server/index.js — the same app strangers run —
// captures it WITHOUT binding a port (listen() is turned into a capture + stub
// so no socket is opened and the boot callback's DB maintenance is skipped),
// then walks app._router.stack recursively. Mounted sub-routers are descended
// into with their mount prefix reconstructed from layer.regexp (Express stores
// the `app.use('/api/mycelium', router)` mount path there, not on layer.path,
// which is undefined). Output is the sorted set of `METHOD path` lines, written
// as JSON to the path in $APP_ROUTES_OUT (a file — keeps it clear of index.js's
// boot-time stdout chatter).
//
// Usage (the gate drives this; env is required by index.js at import time):
//   DATA_DIR=<tmp> ADMIN_KEY=<k> JWT_SECRET=<s> APP_ROUTES_OUT=<path> \
//     node test/refactor/app-routes.mjs
import express from 'express'
import { writeFileSync } from 'node:fs'

// --- no-listen capture -------------------------------------------------------
// index.js ends with `var server = app.listen(PORT, cb)` at module top level
// (no require.main guard, no app export). Intercept listen so importing the
// module builds + wires every route without opening a socket or running the
// boot-callback maintenance. Return a stub satisfying gracefulShutdown's
// server.close() (only reached on SIGTERM/SIGINT, never during introspection).
let app = null
const stubServer = {
  close(cb) { try { cb && cb() } catch {} },
  address() { return { port: 0 } },
  on() { return this },
  once() { return this },
}
express.application.listen = function () { app = this; return stubServer }

// index.js validates env then calls initDB()/initPlugins() at import; the gate
// supplies DATA_DIR + ADMIN_KEY + JWT_SECRET. Neutralize process.exit for the
// import window so a hard exit on a stray validation can't kill the dump
// silently — we want the routes or a loud crash, never an empty result.
const realExit = process.exit
process.exit = (code) => {
  throw new Error('server/index.js attempted process.exit(' + code + ') during route extraction')
}

try {
  await import('../../server/index.js')
} finally {
  process.exit = realExit
}

// --- prefix reconstruction --------------------------------------------------
// Express does not set layer.path for `app.use(mountPath, router)`; it encodes
// the literal mount path as the leading run of layer.regexp.source. Unescape
// that run (\/ -> /, \. -> .) up to the first real metacharacter. The bare root
// mount regexp is '^\\/?(?=\\/|$)' — that is prefix ''.
function mountPrefix(layer) {
  const src = layer.regexp && layer.regexp.source
  if (!src) return ''
  if (src === '^\\/?(?=\\/|$)') return ''
  let s = src.replace(/^\^/, '')
  let prefix = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === '/' || next === '.') { prefix += next; i += 2; continue }
      break
    }
    if (/[A-Za-z0-9_-]/.test(ch)) { prefix += ch; i++; continue }
    if (ch === '/') { prefix += ch; i++; continue }
    break
  }
  return prefix
}

// --- recursive walk ---------------------------------------------------------
// Emit one `METHOD path` per (method, route). Descend mounted sub-routers with
// their accumulated prefix. Plugin routers mount inside the sub-router, so their
// routes land at /api/mycelium/<plugin>/... — same walk, recursively. Collapse
// repeated slashes: the sub-router's route paths keep their leading '/', so
// prefix('/api/mycelium') + path('/agents') would double to '//agents' without
// this; plugin mounts double at their own join too.
function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const fullPath = (prefix + layer.route.path).replace(/\/{2,}/g, '/')
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase())
      for (const m of methods) out.push(m + ' ' + fullPath)
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), out)
    }
  }
}

const routes = []
if (app && app._router && app._router.stack) {
  walk(app._router.stack, '', routes)
}
routes.sort()

if (!routes.length) {
  // A silent empty result would make the gate pass vacuously. Fail loud instead.
  console.error('[app-routes] captured zero routes — app build failed or stack shape changed')
  realExit.call(process, 2)
}

const out = process.env.APP_ROUTES_OUT
if (out) {
  writeFileSync(out, JSON.stringify(routes))
} else {
  process.stdout.write(JSON.stringify(routes))
}

// index.js leaves timers alive (health-patrol interval, worker plugins); this
// is a one-shot dump, so terminate once the routes are written.
realExit.call(process, 0)
