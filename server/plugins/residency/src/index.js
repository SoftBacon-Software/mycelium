// residency plugin — factory entry point (plain JavaScript / ESM) — the briefed shape
//
//   createResidencyPlugin(dbPath) -> MyceliumPlugin
//
// Returns a self-contained plugin object: it opens its OWN better-sqlite3
// connection at `dbPath`, creates the tables in init(), and exposes a read-only
// GET route plus the raw SQL schema and a cleanup() hook. This is the unit the
// vitest suite exercises (no platform wiring required) and the shape future
// actuators / ingestion will build on.
//
// The platform's directory-plugin loader (server/plugins.js) instead mounts
// routes.js against the shared core.db; both paths share db.js (the DB core
// stays JavaScript because the loader imports routes.js in plain Node, which
// cannot load .ts). This module + policy.js are the testable surface.

import Database from 'better-sqlite3';
import createResidencyDB, { SCHEMA_SQL } from '../db.js';
import { decideResidency, estimateRss, modelRssLookup } from './policy.js';

// ---- Factory --------------------------------------------------------------

// GET /api/mycelium/residency — the live residency map.
function buildGetHandler(store) {
  return function getResidency() {
    return { ok: true, residency: store.getMap() };
  };
}

export function createResidencyPlugin(dbPath) {
  let db = null;
  let store = null;

  return {
    name: 'residency',
    version: '0.1.0',

    // Raw DDL — single source of truth in schema.sql (re-exported via db.js).
    schema: SCHEMA_SQL,

    // Open the connection and create tables (createResidencyDB applies the
    // idempotent schema). `hub` is optional and unused in P1 (no event
    // subscriptions yet); accepted for forward-compat with the loader.
    init(_hub) {
      db = new Database(dbPath);
      if (dbPath !== ':memory:') {
        try {
          db.pragma('journal_mode = WAL');
        } catch (_e) {
          /* WAL not applicable / unavailable — non-fatal */
        }
      }
      store = createResidencyDB(db);
      return this;
    },

    // P1 exposes a single read-only route. The handler returns the JSON body
    // directly; an Express adapter (routes.js) wraps it in res.json().
    routes: [
      {
        method: 'GET',
        path: '/api/mycelium/residency',
        handler: function () {
          if (!store) throw new Error('residency plugin not initialised — call init() first');
          return buildGetHandler(store)();
        }
      }
    ],

    // Close the DB connection. Safe to call once.
    cleanup() {
      if (db) {
        db.close();
        db = null;
        store = null;
      }
    },

    // Exposed for tests + future ingestion/actuator code.
    getStore() {
      return store;
    },

    // Exposed so callers can inspect/apply the schema without init() (e.g. the
    // platform loader, which owns its own connection).
    getSchema() {
      return SCHEMA_SQL;
    }
  };
}

// Re-exports — single entry point for consumers.
export { SCHEMA_SQL, createResidencyDB };
export { decideResidency, estimateRss, modelRssLookup };
