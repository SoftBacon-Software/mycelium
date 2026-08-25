// video-pipeline plugin load+mount smoke — closes the plugin-test blind spot
// (CI's `node --test server/plugins/*/test.js` glob skipped any plugin without
// a test.js, so a broken plugin shipped green). Mirrors the
// workflows/semantic-memory node:test suites: real schema.sql on an in-memory
// better-sqlite3 DB, a faithful pluginCore fake, and the plugin's own routes
// loaded the same way server/plugins.js loads them. video-pipeline has no
// handlers.js, so this is a routes-only load contract.
//
// Run from repo root:  node --test server/plugins/video-pipeline/test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import createRoutes from './routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeCore(db) {
  return {
    db: db,
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
    onEvent() {},
    gatedActions: [],
    inbox: {}
  };
}

function freshDB() {
  var db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

test('video-pipeline: routes load against a fresh schema and register without throwing', () => {
  var router = createRoutes(makeCore(freshDB()));
  assert.ok(router, 'createRoutes returned a value');
  assert.equal(typeof router.use, 'function', 'createRoutes returned an express Router');
  assert.ok(router.stack.length > 0, 'video-pipeline registered at least one route');
});
