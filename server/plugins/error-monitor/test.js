// error-monitor plugin load+mount smoke — closes the plugin-test blind spot
// (CI's `node --test server/plugins/*/test.js` glob skipped any plugin without
// a test.js, so a broken plugin shipped green). Mirrors the
// workflows/semantic-memory node:test suites: real schema.sql on an in-memory
// better-sqlite3 DB, a faithful pluginCore fake, and the plugin's own
// routes/handlers loaded the same way server/plugins.js loads them. The bar is
// "the plugin loads and its contract holds" — routes register and hooks
// register without throwing — not exhaustive endpoint coverage.
//
// Run from repo root:  node --test server/plugins/error-monitor/test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import createRoutes from './routes.js';
import { registerHooks } from './handlers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeCore(db) {
  var subscriptions = [];
  return {
    db: db,
    _subscriptions: subscriptions,
    auth: {
      checkAgentOrAdmin(req, res) {
        if (req.headers && req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return (req.headers && req.headers['x-acting-as']) || 'tester';
      },
      checkAdmin() { return 'tester'; },
      getAdminDisplayName() { return 'tester'; }
    },
    apiError(res, status, message, extra) { return res.status(status).json(Object.assign({ error: message }, extra || {})); },
    parseIntParam(val) { var n = parseInt(val, 10); return isNaN(n) ? null : n; },
    validateEnum() { return true; },
    emitEvent() {},
    onEvent(type) { subscriptions.push(type); },
    gatedActions: [],
    inbox: {}
  };
}

function freshDB() {
  var db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

test('error-monitor: routes load against a fresh schema and register without throwing', () => {
  var router = createRoutes(makeCore(freshDB()));
  assert.ok(router, 'createRoutes returned a value');
  assert.equal(typeof router.use, 'function', 'createRoutes returned an express Router');
  assert.ok(router.stack.length > 0, 'error-monitor registered at least one route');
});

test('error-monitor: event hooks register without throwing and subscribe to ≥1 event', () => {
  var core = makeCore(freshDB());
  registerHooks(core);
  assert.ok(core._subscriptions.length > 0, 'error-monitor subscribed to at least one platform event');
});
