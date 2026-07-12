// =============== MYCELIUM — Database Layer (barrel facade) ===============
// Design: this file is the FACADE endpoint of the db.js decomposition
// (docs/DB-DECOMPOSITION-PLAN.md). All 306 DB exports (304 functions +
// GATED_ACTIONS + async dispatchWebhook) now live in 30 entity modules
// under server/db/, plus server/db/core.js at the bottom of the module
// graph (the live `db` connection binding, prepared-statement cache
// `stmt`, generic UPDATE builder `buildUpdate`, connection/schema/
// migration). Every entity module imports its shared bindings from
// './core.js' and imports any cross-entity dependency directly from the
// sibling module that owns it (callee-first) — a db/* module must NEVER
// import this barrel (../db.js); that would be an instant cycle. `stmt` /
// `buildUpdate` / `db` / `initDBConnection` are exported by core.js for
// siblings only and are deliberately NOT re-exported here.
// This file only re-exports (`export * from './db/<entity>.js'`, ordered
// callee-first / by extraction wave) plus the composed `initDB()` — the
// ONE non-verbatim edit in the whole campaign: core.initDBConnection()
// (connection + migrations + schema + instance_config seeding) followed
// by the three entity-owned seeds (ensureDefaultChannels,
// seedPlatformProfiles, seedDefaultJobTemplates) and the boot log line.
// No downstream consumer (15 route modules, server/index.js,
// server/plugins.js, deep plugin imports, test/unit/db-*.test.js) changed
// a single import across the whole decomposition.
// Gate: `node test/refactor/db-manifest.mjs --check` pins the public
// surface at exactly 306 exports (name:typeof:arity) — any lost, added,
// re-typed, or re-arited export fails the build.
import { getDB, initDBConnection, DB_PATH } from './db/core.js';
import { ensureDefaultChannels } from './db/channels.js';
import { seedPlatformProfiles } from './db/node-profiles.js';
import { seedDefaultJobTemplates } from './db/drones.js';

export { getDB };

export * from './db/spend.js';
export * from './db/config.js';
export * from './db/bugs.js';
export * from './db/feedback.js';
export * from './db/events.js';
export * from './db/widgets.js';
export * from './db/skills.js';
export * from './db/concepts.js';
export * from './db/projects.js';
export * from './db/runs.js';
export * from './db/plugins.js';
export * from './db/health.js';
export * from './db/webhooks.js';
export * from './db/context.js';
export * from './db/savepoints.js';
export * from './db/messages.js';
export * from './db/operators.js';
export * from './db/approvals.js';
export * from './db/agents.js';
export * from './db/tasks.js';
export * from './db/plans.js';
export * from './db/agent-profiles.js';
export * from './db/channels.js';
export * from './db/drones.js';
export * from './db/node-profiles.js';
export * from './db/assets.js';
export * from './db/teams.js';
export * from './db/workqueue.js';
export * from './db/overview.js';
export * from './db/boot.js';

// Composed initDB — the ONE non-verbatim edit in the campaign (see Design
// comment above): core owns connection+migrations+schema+instance_config
// seeding (initDBConnection); this barrel composes the three entity seeds
// (each now a named import from the module that owns it) + the log line.
export function initDB() {
  initDBConnection();
  ensureDefaultChannels();
  seedPlatformProfiles();
  seedDefaultJobTemplates();
  console.log('Mycelium DB initialized at ' + DB_PATH);
}
