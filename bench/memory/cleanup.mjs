// Post-run purge of a bench run's rows from the platform memory index.
//
// GET /memory/list is hard-capped server-side (db.listByType takes
// Math.min(limit, 100)), so "list once, delete what you saw" silently stops
// at 100 rows — a 50-question run indexes ~7k+ chunk rows under its
// namespace. This purge loops the (namespace, source_type)-scoped list until
// it drains, then verifies with one final list. It refuses to run without an
// explicit namespace: bench cleanup is always scoped, never a store-wide
// delete.

export async function purgeRunRows(platform, { sourceType, namespace, batchLimit = 100, maxBatches = 500, paceMs = 0 } = {}) {
  if (!namespace) throw new Error('purgeRunRows requires an explicit namespace — refusing an unfiltered purge');
  let deleted = 0;
  const failed = [];
  let batches = 0;
  while (batches < maxBatches) {
    const listed = await platform.listByType(sourceType, { namespace, limit: batchLimit });
    const results = listed.results ?? [];
    if (results.length === 0) break;
    batches++;
    let deletedThisBatch = 0;
    for (const id of [...new Set(results.map((r) => r.source_id))]) {
      try { await platform.deleteIndex(sourceType, id); deleted++; deletedThisBatch++; }
      catch (e) { failed.push({ id, error: String(e.message).slice(0, 120) }); }
      if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
    }
    if (deletedThisBatch === 0) break; // every delete failed — stop, report, don't spin
  }
  const after = await platform.listByType(sourceType, { namespace, limit: batchLimit });
  return {
    namespace,
    source_type: sourceType,
    batches,
    deleted,
    failed_deletes: failed,
    rows_remaining_after: (after.results ?? []).length,
    kept: false,
  };
}

/**
 * Purge every namespace a run indexed (the extract control arm writes to a
 * suffixed namespace of its own). Returns the receipt's `cleanup` shape: the
 * single purge for one namespace, an aggregate with per_namespace for more.
 * Shared by the success path and the failure path of run.mjs — a run that
 * dies mid-way must not leave thousands of bench rows for the embedder to
 * chew on (run B, 2026-09-09: 7,767 orphan rows after a 30 s timeout).
 */
export async function purgeNamespaces(platform, { sourceType, namespaces, sourceTypesByNamespace = null, log = () => {}, purge = purgeRunRows } = {}) {
  const per = [];
  for (const ns of namespaces) {
    // a namespace's index rows may carry a DIFFERENT source type than the
    // run's dataset type (the timeline arm's routes layer indexes as
    // 'am_fact') — purge with the namespace's own type or the purge finds
    // nothing and leaks (task 210 flag-path smoke)
    const nsType = (sourceTypesByNamespace && sourceTypesByNamespace[ns]) || sourceType;
    const p = await purge(platform, { sourceType: nsType, namespace: ns });
    log(`cleanup ${ns} (${nsType}): ${p.deleted} deleted in ${p.batches} batches, ${p.failed_deletes.length} failed, ${p.rows_remaining_after} remaining`);
    per.push(p);
  }
  if (per.length === 1) return per[0];
  return {
    namespaces: per.map((p) => p.namespace),
    deleted: per.reduce((a, p) => a + p.deleted, 0),
    batches: per.reduce((a, p) => a + p.batches, 0),
    failed_deletes: per.flatMap((p) => p.failed_deletes),
    rows_remaining_after: per.reduce((a, p) => a + p.rows_remaining_after, 0),
    kept: false,
    per_namespace: per,
  };
}

/**
 * The routes layer's cleanup (task 216): the fact ROWS a run wrote through
 * POST /auto-memory/facts live in the auto-memory TABLE under the <ns>-amfacts
 * namespace, which purgeNamespaces cannot reach — it drains the semantic-INDEX
 * half only. This purges the rows first (DELETE /auto-memory/facts?namespace=
 * <ns>, task 211), then the index purge, then the two verify reads the cleanup
 * receipt states (factsList → 0 rows; a namespace-scoped /memory/search → 0
 * hits — 206's seam indexes facts, so both halves must drain). factsNamespace
 * is the routes layer's namespace ONLY: the episodic layer never has fact rows
 * and never touches the facts route.
 *
 * Shared by the success path and the failure path of run.mjs — the order the
 * receipt states holds for both. A rows-purge failure never masks the index
 * purge (a mid-write death must not strand the index rows either): the index
 * half runs anyway, then the rows error surfaces loudly. The default path
 * (factsNamespace null) is purgeNamespaces, byte-identically — no facts calls,
 * no facts_cleanup key.
 */
export async function purgeRunWithFacts(platform, {
  sourceType,
  namespaces,
  sourceTypesByNamespace = null,
  factsNamespace = null,
  verify = null,
  log = () => {},
  purge = purgeRunRows,
} = {}) {
  if (factsNamespace && (!verify || !verify.query)) {
    throw new Error('purgeRunWithFacts: routes-mode cleanup needs verify { query, sourceTypes, limit } — the cleanup receipt must state both post-purge reads (factsList rows, scoped search hits)');
  }
  let factsPurged = null;
  let factsError = null;
  if (factsNamespace) {
    if (!namespaces.includes(factsNamespace)) {
      throw new Error(`purgeRunWithFacts: facts namespace ${factsNamespace} is outside the run's own namespace list — refusing a purge this run did not earn`);
    }
    try {
      factsPurged = await platform.factsPurgeByNamespace(factsNamespace);
      log(`cleanup facts ${factsNamespace}: ${factsPurged.deleted} fact rows purged (DELETE /auto-memory/facts?namespace=${factsNamespace})`);
    } catch (e) {
      factsError = e;
      log(`cleanup facts ${factsNamespace} FAILED (${String(e.message).slice(0, 120)}) — the index purge still runs, the rows remain`);
    }
  }
  const out = await purgeNamespaces(platform, { sourceType, namespaces, sourceTypesByNamespace, log, purge });
  if (factsNamespace) {
    let verifyReads = null;
    try {
      const listed = await platform.factsList({ namespace: factsNamespace, limit: 1 });
      const rows = Array.isArray(listed) ? listed : (listed.results ?? listed.items ?? []);
      const searched = await platform.search({
        query: verify.query,
        namespace: factsNamespace,
        sourceTypes: verify.sourceTypes,
        limit: verify.limit,
      });
      verifyReads = {
        facts_rows_remaining_after: rows.length,
        search_hits_after: (searched.results ?? []).length,
        search: { query: verify.query, namespace: factsNamespace, source_types: verify.sourceTypes },
      };
    } catch (e) {
      if (!factsError) {
        log(`cleanup verify reads FAILED for ${factsNamespace} (${String(e.message).slice(0, 120)}) — the receipt cannot state "drained"`);
        throw e;
      }
      // the rows purge already failed — that is the error to surface
    }
    out.facts_cleanup = {
      namespace: factsNamespace,
      route: 'DELETE /auto-memory/facts?namespace=<ns>',
      facts_deleted: factsPurged ? factsPurged.deleted : null,
      ...verifyReads,
      ...(factsError ? { facts_error: String(factsError.message).slice(0, 200) } : {}),
    };
    if (factsError) throw factsError;
  }
  return out;
}
