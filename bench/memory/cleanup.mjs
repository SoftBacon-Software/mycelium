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
