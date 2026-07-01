// residency plugin — DB helpers (better-sqlite3)
//
// Framework-agnostic CRUD over the residency tables. Takes an already-open
// better-sqlite3 connection (shared with the platform under the directory
// plugin convention, or opened by the createResidencyPlugin() factory). Mirrors
// the createXxxDB(db) idiom used by every other mycelium plugin.
//
// Self-sufficient: createResidencyDB() applies the schema (idempotent
// CREATE TABLE IF NOT EXISTS) so any caller — tests, the factory, the loader
// path — gets working tables from a single call. Re-application is a no-op.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

export function applySchema(db) {
  db.exec(SCHEMA_SQL);
}

export default function createResidencyDB(db) {
  applySchema(db);

  function nowIso() {
    return new Date().toISOString();
  }

  // --- nodes -------------------------------------------------------------
  function upsertNode(n) {
    db.prepare(
      `INSERT INTO residency_nodes
         (node_id, ram_total_gb, ram_budget_gb, actuator_kind, actuator_url, updated_at)
       VALUES (@node_id, @ram_total_gb, @ram_budget_gb, @actuator_kind, @actuator_url, @updated_at)
       ON CONFLICT(node_id) DO UPDATE SET
         ram_total_gb  = excluded.ram_total_gb,
         ram_budget_gb = excluded.ram_budget_gb,
         actuator_kind = excluded.actuator_kind,
         actuator_url  = excluded.actuator_url,
         updated_at    = excluded.updated_at`
    ).run({
      node_id: n.node_id,
      ram_total_gb: n.ram_total_gb,
      ram_budget_gb: n.ram_budget_gb,
      actuator_kind: n.actuator_kind || null,
      actuator_url: n.actuator_url || null,
      updated_at: nowIso()
    });
    return getNode(n.node_id);
  }

  function getNode(nodeId) {
    return db.prepare('SELECT * FROM residency_nodes WHERE node_id = ?').get(nodeId) || null;
  }

  function listNodes() {
    return db.prepare('SELECT * FROM residency_nodes ORDER BY node_id').all();
  }

  function removeNode(nodeId) {
    db.prepare('DELETE FROM residency_models WHERE node_id = ?').run(nodeId);
    return db.prepare('DELETE FROM residency_nodes WHERE node_id = ?').run(nodeId).changes;
  }

  // --- models (resident set) --------------------------------------------
  function upsertModel(m) {
    db.prepare(
      `INSERT INTO residency_models
         (node_id, model_id, backend, kind, state, rss_gb, last_used_at)
       VALUES (@node_id, @model_id, @backend, @kind, @state, @rss_gb, @last_used_at)
       ON CONFLICT(node_id, model_id) DO UPDATE SET
         backend     = excluded.backend,
         kind        = excluded.kind,
         state       = excluded.state,
         rss_gb      = excluded.rss_gb,
         last_used_at = excluded.last_used_at`
    ).run({
      node_id: m.node_id,
      model_id: m.model_id,
      backend: m.backend,
      kind: m.kind,
      state: m.state,
      rss_gb: m.rss_gb != null ? m.rss_gb : 0,
      last_used_at: m.last_used_at || nowIso()
    });
    return m;
  }

  function listModelsForNode(nodeId) {
    return db
      .prepare('SELECT * FROM residency_models WHERE node_id = ? ORDER BY model_id')
      .all(nodeId);
  }

  function setModelState(nodeId, modelId, state) {
    return db
      .prepare(
        `UPDATE residency_models SET state = ?, last_used_at = ?
         WHERE node_id = ? AND model_id = ?`
      )
      .run(state, nowIso(), nodeId, modelId).changes;
  }

  function removeModel(nodeId, modelId) {
    return db
      .prepare('DELETE FROM residency_models WHERE node_id = ? AND model_id = ?')
      .run(nodeId, modelId).changes;
  }

  // --- seat routes -------------------------------------------------------
  function upsertRoute(r) {
    db.prepare(
      `INSERT INTO residency_seat_routes (seat, backend, kind, mode_pref)
       VALUES (@seat, @backend, @kind, @mode_pref)
       ON CONFLICT(seat) DO UPDATE SET
         backend = excluded.backend,
         kind    = excluded.kind,
         mode_pref = excluded.mode_pref`
    ).run({
      seat: r.seat,
      backend: r.backend,
      kind: r.kind,
      mode_pref: r.mode_pref || null
    });
    return r;
  }

  function listRoutes() {
    return db.prepare('SELECT * FROM residency_seat_routes ORDER BY seat').all();
  }

  // --- aggregate live map (what GET /residency returns) ------------------
  function getMap() {
    var nodes = listNodes();
    var seatRoutes = listRoutes();
    // Attach each node's resident set (resident/warm/loading models).
    var nodesWithSets = nodes.map(function (node) {
      var residentSet = listModelsForNode(node.node_id);
      return Object.assign({}, node, { resident_set: residentSet });
    });
    return { nodes: nodesWithSets, seat_routes: seatRoutes };
  }

  return {
    upsertNode,
    getNode,
    listNodes,
    removeNode,
    upsertModel,
    listModelsForNode,
    setModelState,
    removeModel,
    upsertRoute,
    listRoutes,
    getMap
  };
}
