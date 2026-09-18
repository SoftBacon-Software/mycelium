// Boot drain + self-check for the embed queue (2026-09-18, task 219).
//
// WHY. The scheduler's queue (embedLanes in embeddings.js) is IN-MEMORY, so a
// platform restart forgets every row it had not yet embedded, and nothing on
// the platform re-discovers them — the only thing that did was the Mac's
// launchd job com.gilbert.memory-embed-backfill (StartInterval 1800), i.e. up
// to 30 minutes of a dead embedder per restart. Measured on jetson01
// 2026-09-18 00:05-00:09 CDT: after the director's deploy, GET /memory/stats
// read embed_backlog 32,282 with embed_queue all zeros and the embedded count
// frozen for four minutes while the n=50 timeline bench sat in its embedding
// wait. This module is the self-starting drain: boot re-enqueues every
// sm_embeddings row with embedding IS NULL at LOW priority (query embeds keep
// their high-priority jump — the scheduler's lanes, 2026-09-09), and a
// periodic self-check re-enqueues rows a dropped or failed batch left behind,
// so the platform heals itself without waiting for the Mac's outer loop
// (which stays up as belt-and-braces).
//
// SHAPE. One pass = page through the NULL rows, chunk-split oversized rows
// (db.expandOversizedRows — the same treatment /reindex and
// /backfill-embeddings give them), schedule each EMBEDDING_OLLAMA_BATCH_MAX
// chunk as ONE low-priority scheduler unit, write vectors back as each chunk
// completes. Bounded per chunk and resumable: a row whose embed fails stays
// NULL, is never retried inside the same pass (the attempted set — the same
// working-set rule /backfill uses), and a later self-check pass retries it —
// the Mac job's MAX_ROUNDS/STALLED guard, inverted into a retry-later instead
// of a stop-now. /memory/stats carries the receipt
// (embed_queue.last_drain_at + rows_enqueued_at_boot) via embedDrainSnapshot().
import { generateEmbeddingBatch, EMBEDDING_OLLAMA_BATCH_MAX, embedQueueDepth, recordDrainPass } from './embeddings.js';

export var SELF_DRAIN_DEFAULT_INTERVAL_S = 300; // embedding_self_drain_interval_s when unset
export var SELF_DRAIN_TICK_S = 60;   // ticker period; the interval config is read per tick, so PUT /memory/config applies live
var DRAIN_PAGE = 512;                // rows per getUnembedded page; each page yields ceil(page/64) scheduler units

var passInFlight = false;
var lastPassEndMs = 0;
var selfDrainTimer = null;
var selfDrainTimerDb = null;
var lastPassPromise = null;

// The self-check interval, read per call so config changes apply live.
// Absent/unparseable → the 300s default; 0 → disabled (the caller's sentinel).
export function resolveSelfDrainIntervalS(db) {
  var raw;
  try { raw = db.getConfig('embedding_self_drain_interval_s'); } catch (e) { raw = null; }
  if (raw === null || raw === undefined || raw === '') return SELF_DRAIN_DEFAULT_INTERVAL_S;
  var n = parseInt(raw, 10);
  if (isNaN(n)) return SELF_DRAIN_DEFAULT_INTERVAL_S;
  return n;
}

// One bounded drain pass over the NULL-embedding rows. Never blocks the
// caller's event loop turn (yields before sweeping — boot registration
// returns first), never retries a failed row within the pass, never overlaps
// another pass.
export async function drainNullEmbeddings(db, opts) {
  var cause = (opts && opts.cause) || 'manual';
  var config;
  try { config = db.getAllConfig(); } catch (e) { config = {}; }
  if (!config.embedding_provider || config.embedding_provider === 'none') {
    // Honest skip: nothing enqueued, nothing stamped — the self-check picks
    // the rows up once a provider exists (fresh-install-then-configure).
    return { cause: cause, skipped: 'no_provider', enqueued: 0, embedded: 0, failed: 0, remaining: db.countUnembedded() };
  }
  if (passInFlight) {
    return { cause: cause, skipped: 'drain_in_progress', enqueued: 0, embedded: 0, failed: 0 };
  }
  passInFlight = true;
  var attempted = new Set(); // row ids tried THIS pass — a failed row stays NULL and must not spin the page loop
  var chunkPromises = [];
  var enqueued = 0;
  var embedded = 0;
  var failed = 0;
  try {
    // Yield before sweeping so the boot caller (registerHooks) returns before
    // any sweep work — the drain is background work, never startup work.
    await new Promise(function (r) { setImmediate(r); });
    while (true) {
      var all = db.getUnembedded(DRAIN_PAGE);
      var rows = [];
      for (var i = 0; i < all.length; i++) {
        if (!attempted.has(all[i].id)) rows.push(all[i]);
      }
      if (rows.length === 0) break;
      for (var j = 0; j < rows.length; j++) attempted.add(rows[j].id);
      // Oversized rows can never embed whole — chunk-split them first, the
      // same treatment /reindex and /backfill-embeddings give them. Their
      // piece rows carry no id (they were just (re-)written); the write-back
      // keys on (source_type, source_id, chunk_index).
      rows = db.expandOversizedRows(rows);
      for (var c = 0; c < rows.length; c += EMBEDDING_OLLAMA_BATCH_MAX) {
        (function (chunk) {
          enqueued += chunk.length;
          chunkPromises.push(
            generateEmbeddingBatch(config, chunk.map(function (r) { return r.content_text; }), { priority: 'low' })
              .then(function (vectors) {
                for (var i = 0; i < chunk.length; i++) {
                  if (vectors && vectors[i]) {
                    try {
                      db.updateEmbedding(chunk[i].source_type, chunk[i].source_id, chunk[i].chunk_index, vectors[i], config.embedding_model || config.embedding_provider);
                      embedded++;
                    } catch (e) {
                      failed++;
                      console.error('[semantic-memory] ' + cause + ' drain embed update failed for ' + chunk[i].source_type + ':' + chunk[i].source_id + ':', e.message);
                    }
                  } else {
                    failed++;
                  }
                }
              }, function (e) {
                failed += chunk.length;
                console.error('[semantic-memory] ' + cause + ' drain batch failed:', e.message);
              })
          );
        })(rows.slice(c, c + EMBEDDING_OLLAMA_BATCH_MAX));
      }
      if (all.length < DRAIN_PAGE) break; // short page → the table is swept; stragglers wait for the next pass
    }
    await Promise.all(chunkPromises);
  } finally {
    passInFlight = false;
    lastPassEndMs = Date.now();
    // Stamped on every completed pass, including a 0-row sweep — a receipt
    // that moves is what proves the self-check is alive. rows_enqueued_at_boot
    // counts the boot pass only (the field says what it counts).
    recordDrainPass(cause, enqueued);
  }
  return { cause: cause, enqueued: enqueued, embedded: embedded, failed: failed, remaining: db.countUnembedded() };
}

// The periodic self-check: re-enqueue NULL rows ONLY when the scheduler queue
// is empty (never compete with live work), never while a pass runs, and no
// more often than embedding_self_drain_interval_s (0 disables entirely).
export async function selfDrainTick(db) {
  var intervalS = resolveSelfDrainIntervalS(db);
  if (!intervalS || intervalS <= 0) {
    return { cause: 'self_check', skipped: 'disabled', interval_s: intervalS };
  }
  if (passInFlight) return { cause: 'self_check', skipped: 'drain_in_progress' };
  var depth = embedQueueDepth();
  if (depth.in_flight > 0 || depth.queued_high > 0 || depth.queued_low > 0) {
    return { cause: 'self_check', skipped: 'queue_busy' };
  }
  if (lastPassEndMs && (Date.now() - lastPassEndMs) < intervalS * 1000) {
    return { cause: 'self_check', skipped: 'before_interval', interval_s: intervalS };
  }
  return drainNullEmbeddings(db, { cause: 'self_check' });
}

// Plugin boot: run the boot pass (fire-and-forget — callers may .catch the
// returned promise but must not await it on the startup path) and start the
// self-check ticker. The ticker is process-lifetime; tests call stopBootDrain().
export function startBootDrain(db) {
  var pass = drainNullEmbeddings(db, { cause: 'boot' });
  lastPassPromise = pass;
  if (!selfDrainTimer) {
    selfDrainTimer = setInterval(function () {
      Promise.resolve(selfDrainTick(selfDrainTimerDb)).catch(function (e) {
        console.error('[semantic-memory] embed self-drain tick failed:', e.message);
      });
    }, SELF_DRAIN_TICK_S * 1000);
    if (selfDrainTimer.unref) selfDrainTimer.unref(); // never hold the process open for a check
  }
  selfDrainTimerDb = db;
  return pass;
}

// The most recent drain-pass promise — the test seam for "boot started the
// drain" without waiting on wall-clock.
export function lastDrainPromise() {
  return lastPassPromise;
}

export function stopBootDrain() {
  if (selfDrainTimer) {
    clearInterval(selfDrainTimer);
    selfDrainTimer = null;
    selfDrainTimerDb = null;
  }
  // Reset the interval gate too: this is the drain's lifecycle-stop seam
  // (production runs to process exit and never calls it; tests call it between
  // fixtures, and a gate left armed from a previous fixture's pass would
  // silently swallow the next fixture's first tick as before_interval).
  lastPassEndMs = 0;
}
