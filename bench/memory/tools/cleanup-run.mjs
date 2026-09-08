// Remove a bench run's rows from the platform memory index.
//
// run.mjs cleans up after itself on success, but a run that crashes mid-way
// (failed answer, Ctrl-C, dead socket) leaves its rows indexed. This tool
// re-derives the run's source_ids from the split (arm_mycelium writes
// `${runId}-${questionId}-s${sessionIndex}`) and deletes each one, then
// verifies nothing is left under the run's source_type.
//
//   node bench/memory/tools/cleanup-run.mjs --run-id 2026-09-08-p1-160138 \
//     [--split longmemeval] [--keep-last 0] [--pace-ms 50]

import { parseArgs } from 'node:util';
import { loadSplit } from '../split.mjs';
import { createPlatform, resolvePlatformEnv, resolveAdminKey } from '../platform.mjs';
import { BENCH_SOURCE_TYPE } from '../arms/arm_mycelium.mjs';

const { values } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    split: { type: 'string', default: 'longmemeval' },
    'pace-ms': { type: 'string', default: '50' },
  },
});

if (!values['run-id']) {
  console.error('usage: cleanup-run.mjs --run-id <runId> [--split longmemeval] [--pace-ms 50]');
  process.exit(2);
}

const split = await loadSplit(values.split);
const env = resolvePlatformEnv();
const key = process.env.MYCELIUM_ADMIN_KEY ?? (await resolveAdminKey({ keychainService: env.keychainService }));
if (!key) {
  console.error('no admin key (MYCELIUM_ADMIN_KEY or the keychain service)');
  process.exit(2);
}
const platform = createPlatform({ baseUrl: env.baseUrl, headers: { 'X-Admin-Key': key, 'X-Acting-As': 'm5Max' } });

const ids = [];
for (const item of split.items) {
  for (let s = 0; s < item.haystack_sessions.length; s++) {
    ids.push(`${values['run-id']}-${item.question_id}-s${s}`);
  }
}
console.log(`[cleanup] ${ids.length} source_ids to delete (${values['run-id']})`);

const paceMs = Number(values['pace-ms']);
let deleted = 0;
const failed = [];
for (const id of ids) {
  try {
    await platform.deleteIndex(BENCH_SOURCE_TYPE, id);
    deleted++;
  } catch (e) {
    if (!/-> 404/.test(e.message)) failed.push({ id, error: e.message.slice(0, 140) });
  }
  if (paceMs > 0 && deleted % 25 === 0) await new Promise((r) => setTimeout(r, paceMs));
  if (deleted % 250 === 0) console.log(`[cleanup] ${deleted}/${ids.length}`);
}

const left = await platform.listByType(BENCH_SOURCE_TYPE, { namespace: `bench-p1-${values['run-id']}` });
const remaining = (left.results ?? []).length;
console.log(`[cleanup] deleted=${deleted} failed=${failed.length} rows_remaining=${remaining}`);
if (failed.length) {
  console.error('[cleanup] failures:', JSON.stringify(failed.slice(0, 10), null, 2));
  process.exit(1);
}
if (remaining !== 0) {
  console.error('[cleanup] rows still present after deletion — inspect /memory/list manually');
  process.exit(1);
}
console.log('[cleanup] clean');
