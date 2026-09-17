// task 206 capped-smoke route driver — the am_facts routes' first REAL caller
// outside the test suites. Drives bench/memory/platform.mjs (the same client
// the timeline arm uses) against the scratch local server: 3 creates, one
// supersede through POST /facts/:id/supersede, search-hybrid over the am_fact
// index, second-namespace + unscoped isolation reads. No model, no 3090 slot.
import { createPlatform } from '/private/tmp/myc-amfacts/bench/memory/platform.mjs';

const BASE = 'http://127.0.0.1:3999';
const KEY = 'smoke-local-admin';
const platform = createPlatform({
  baseUrl: BASE,
  headers: { 'X-Admin-Key': KEY, 'X-Acting-As': 'm5Max' },
  timeoutMs: 15000,
  maxRetries: 2,
});

const NS = 'bench-p1-smoke20260917-amfacts'; // the run-scoped namespace, arm-shaped
const OTHER = 'bench-p1-smoke20260917-other-amfacts';
const log = (...a) => console.log(...a);

// 1. ADD — three facts in the run namespace (q-003's manager pair + one bystander)
const alex = await platform.factsCreate({
  fact_text: "User's manager is Alex", namespace: NS, category: 'general',
  source_type: 'bench_longmemeval', source_id: 'smoke-q003-tl-f0',
  valid_from: '2023/05/20 (Sat) 02:21',
  metadata: { question_id: 'q-003', layer: 'fact', episode: 'smoke-q003-s0', session_date: '2023/05/20 (Sat) 02:21', valid_from: '2023/05/20 (Sat) 02:21', valid_to: null, supersedes: null, superseded_by: null, ingestion: 'timeline', run_id: 'smoke20260917' },
});
const fish = await platform.factsCreate({
  fact_text: 'Cats dream during REM sleep', namespace: NS, category: 'general',
  source_type: 'bench_longmemeval', source_id: 'smoke-q002-tl-f0',
  valid_from: '2023/05/21 (Sun) 09:15',
  metadata: { question_id: 'q-002', layer: 'fact', episode: 'smoke-q002-s1', valid_from: '2023/05/21 (Sun) 09:15', ingestion: 'timeline', run_id: 'smoke20260917' },
});
log('ADD  alex -> id', alex.id, '| cats -> id', fish.id);

// 2. SEARCH — the new fact answers a hybrid search in its namespace ONLY
let hits = await platform.search({ query: 'manager Alex', namespace: NS, sourceTypes: ['am_fact'], limit: 5 });
log('SEARCH ns hits:', hits.results.map((r) => `${r.source_id}:${(r.metadata || {}).question_id}`).join(', '));
const otherHits = await platform.search({ query: 'manager Alex', namespace: OTHER, sourceTypes: ['am_fact'], limit: 5 });
log('SEARCH other-ns hits:', otherHits.results.length);

// 3. SUPERSEDE — Dana replaces Alex, through the route
const dana = await platform.factsCreate({
  fact_text: "User's new manager is Dana now", namespace: NS, category: 'general',
  source_type: 'bench_longmemeval', source_id: 'smoke-q003-tl-f1',
  valid_from: '2023/05/22 (Mon) 18:00',
  metadata: { question_id: 'q-003', layer: 'fact', episode: 'smoke-q003-s1', session_date: '2023/05/22 (Mon) 18:00', valid_from: '2023/05/22 (Mon) 18:00', valid_to: null, supersedes: String(alex.id), ingestion: 'timeline', run_id: 'smoke20260917' },
});
log('ADD  dana -> id', dana.id);
const sup = await platform.factsSupersede(alex.id, dana.id, NS);
log('SUPERSEDE receipt:', JSON.stringify({ ok: sup.ok, old_valid_to: sup.fact?.valid_to, old_superseded_by: sup.fact?.superseded_by, old_ns: sup.fact?.namespace, replacement_id: sup.replacement?.id }));

// 4. THE OLD ROW STILL ANSWERS — with its valid_to + supersede line
const idxRows = await platform.listByType('am_fact', { namespace: NS, limit: 50 });
const oldRow = (idxRows.items ?? idxRows ?? []).find?.((r) => String(r.source_id) === String(alex.id));
if (oldRow) {
  log('OLD ROW indexed:', JSON.stringify({ source_id: oldRow.source_id, has_valid_to: Boolean(oldRow.metadata?.valid_to), superseded_by: oldRow.metadata?.superseded_by, text_tail: String(oldRow.content_text).slice(-90) }));
} else {
  log('OLD ROW via /memory/list shape:', JSON.stringify(idxRows).slice(0, 300));
}
const supHits = await platform.search({ query: 'manager', namespace: NS, sourceTypes: ['am_fact'], limit: 10 });
log('SEARCH after supersede:', supHits.results.map((r) => `${r.source_id}${(r.metadata || {}).valid_to ? '[superseded]' : '[current]'}`).join(', '));

// 5. ISOLATION — second namespace sees 0 of the first's rows, unscoped sees 0 at all
const listNS = await platform.factsList({ namespace: NS, limit: 50 });
const listOTHER = await platform.factsList({ namespace: OTHER, limit: 50 });
const unscoped = await platform.factsList({ limit: 50 });
log('LIST ns:', listNS.length, 'rows | other-ns:', listOTHER.length, 'rows | unscoped:', unscoped.length, 'rows');

// 6. KEEP — a scoped read that finds nothing new is the keep path (no write)
log('DONE — route smoke complete');
