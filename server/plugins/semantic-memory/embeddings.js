// Embedding provider abstraction for semantic memory
// Supports: ollama (nomic-embed-text), openai (text-embedding-3-small), drone (async via job queue)

// -- Embed call scheduler (2026-09-09) ----------------------------------------
// A local embedder is a SERIAL resource: ollama serves one /api/embed request
// at a time per model instance. Before this scheduler the plugin had no
// in-process queue at all — every /index/bulk request started its own
// unawaited sequential embed chain, /backfill-embeddings and /reindex ran
// theirs, event on-ramps added more, and a search's single-string query
// embed entered the embedder's FIFO at the tail with nothing marking it
// priority. Measured on jetson01 (bench runs B2/B3/B4): after a bulk index,
// POST /memory/search waited >30 s behind the backlog — long enough for
// embedOllama's AbortSignal.timeout(30000) to abort the query embed and
// degrade the search to keyword. This scheduler bounds what the plugin has
// in flight (embedding_max_concurrency, default 1 — what a serial embedder
// serves anyway, so bulk throughput is unchanged) and gives query embeddings
// their own lane that drains before the bulk lane: a search now waits behind
// at most `embedding_max_concurrency` in-flight embeds, never behind the
// queued backlog. Backfill still drains at one embed per service time — the
// scheduler merges the concurrent chains into one queue at the same rate.
// (Since 2026-09-18 an ollama BATCH call is one scheduler unit — see
// generateEmbeddingBatch — so a bulk drain moves up to
// EMBEDDING_OLLAMA_BATCH_MAX rows per embedder service time.)
var embedLanes = { high: [], low: [] };
var embedInFlight = 0;
var embedMaxInFlight = 1; // last config seen; every embed call passes config, so this applies live

function scheduleEmbedCall(priority, config, runFn) {
  embedMaxInFlight = embedConcurrency(config); // applied live — every call carries config
  return new Promise(function (resolve, reject) {
    embedLanes[priority === 'high' ? 'high' : 'low'].push({ run: runFn, resolve: resolve, reject: reject });
    pumpEmbedQueue();
  });
}

function pumpEmbedQueue() {
  while (embedInFlight < embedMaxInFlight) {
    var lane = embedLanes.high.length > 0 ? embedLanes.high : embedLanes.low;
    var job = lane.shift();
    if (!job) return;
    embedInFlight++;
    (function (j) {
      j.run().then(function (v) { j.resolve(v); }, function (e) { j.reject(e); }).then(function () {
        embedInFlight--;
        pumpEmbedQueue();
      });
    })(job);
  }
}

function embedConcurrency(config) {
  var n = parseInt(config && config.embedding_max_concurrency, 10);
  if (isNaN(n) || n < 1) n = 1;
  return Math.min(n, 16);
}

// Queue depth snapshot for /memory/stats — the in-process half of the embed
// pipeline (the row-level half is db.countUnembedded → embed_backlog).
export function embedQueueDepth() {
  return {
    in_flight: embedInFlight,
    queued_high: embedLanes.high.length,
    queued_low: embedLanes.low.length
  };
}

// -- Boot drain / self-check receipt (2026-09-18, task 219) --------------------
// A restart forgets embedLanes above: rows written with a NULL embedding but
// not yet embedded when the process died stayed NULL forever unless the Mac's
// launchd job happened to POST /backfill-embeddings within its 30-min cadence.
// The drain itself lives in boot-drain.js; the RECEIPT lives here with the
// queue it talks about, so db.stats() can surface it next to embed_queue
// without a new import edge. last_drain_at stamps every completed pass
// (including a 0-row sweep — a receipt that moves is what proves the
// self-check is alive); rows_enqueued_at_boot counts rows the BOOT pass
// enqueued, because the field says what it counts.
var drainReceipt = { last_drain_at: null, rows_enqueued_at_boot: 0 };

export function embedDrainSnapshot() {
  return {
    last_drain_at: drainReceipt.last_drain_at,
    rows_enqueued_at_boot: drainReceipt.rows_enqueued_at_boot
  };
}

export function recordDrainPass(cause, enqueued) {
  drainReceipt.last_drain_at = new Date().toISOString();
  if (cause === 'boot' && enqueued > 0) drainReceipt.rows_enqueued_at_boot += enqueued;
}

// Queue a drone job to embed content asynchronously.
// The drone worker calls local Ollama, then PUTs the vector back via callback endpoint.
export function createDroneEmbedJob(rawDb, sourceType, sourceId, chunkIndex, text, model) {
  if (sourceType === 'companion') {
    // Companion rows are per-user private (F-mycelium/246, review A r2 MAJOR):
    // a drone embed job stores the row's FULL TEXT in drone_jobs.input_data,
    // and agent keys can read drone jobs (claim/list). Queuing one would leak
    // a person's memory to the agent surface — the exact leak the companion
    // privacy guards exist to prevent. Refuse the QUEUE, not the row: the row
    // stays keyword-searchable with the honest embedded:false stamp, and the
    // companion search response already reports keyword-fallback mode.
    // (Spelled inline — embeddings.js sits below db.js in the import graph.)
    console.warn('[semantic-memory] companion row NOT drone-embedded: its text would enter the agent-readable drone job queue (docs/companion-memory-api.md, isolation guarantee 4)');
    return null;
  }
  var callbackPath = '/api/mycelium/memory/embeddings/' + encodeURIComponent(sourceType) + '/' + encodeURIComponent(sourceId);
  var inputData = JSON.stringify({
    text: text,
    source_type: sourceType,
    source_id: sourceId,
    chunk_index: chunkIndex || 0,
    model: model || 'nomic-embed-text',
    callback_path: callbackPath
  });
  var result = rawDb.prepare(
    "INSERT INTO drone_jobs (title, command, input_data, requires, requester, priority, job_type) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(
    'Embed: ' + sourceType + ':' + sourceId,
    '',
    inputData,
    JSON.stringify(['ollama']),
    'semantic-memory',
    3,
    'embed'
  );
  return result.id;
}

// opts (optional): { db, sourceType, sourceId, chunkIndex, priority } — db/item
// context for the drone provider to queue jobs; priority 'high' marks work
// that must not wait behind the bulk backlog (search query vectors — see the
// scheduler note above). Everything bulk/backfill/event-shaped defaults to
// the low lane.
export async function generateEmbedding(config, text, opts) {
  var provider = config.embedding_provider || 'none';
  if (provider === 'none' || !provider) return null;
  var priority = (opts && opts.priority === 'high') ? 'high' : 'low';

  if (provider === 'drone') {
    // Drone provider: queue async job if caller provides context, always return null
    if (opts && opts.db && opts.sourceType && opts.sourceId) {
      createDroneEmbedJob(opts.db, opts.sourceType, opts.sourceId, opts.chunkIndex || 0, text, config.embedding_model);
    }
    return null;
  }

  if (provider === 'ollama') {
    return scheduleEmbedCall(priority, config, function () {
      return embedOllama(config.embedding_url || 'http://localhost:11434', config.embedding_model || 'nomic-embed-text', text);
    });
  } else if (provider === 'openai') {
    return scheduleEmbedCall(priority, config, function () {
      return embedOpenAI(config.embedding_url || 'https://api.openai.com/v1', config.embedding_model || 'text-embedding-3-small', config.embedding_api_key, text);
    });
  }

  console.warn('[semantic-memory] Unknown embedding provider:', provider);
  return null;
}

// Max texts per ollama batch call (embedding_ollama_batch_max). /api/embed
// accepts the whole list, but an unbounded body on a huge bulk (a timeline
// n=50 writes ~20k rows of episodes + facts) risks the embedder's request
// limits and one very long HTTP round-trip; 64 keeps each call bounded while
// collapsing the Jetson's serial embed wall from N calls to ceil(N / 64).
// Cited by the batch tests in plugins/semantic-memory/test.js.
export var EMBEDDING_OLLAMA_BATCH_MAX = 64;

// opts (optional): { db, items: [{ source_type, source_id, chunk_index }], priority } —
// db/items for the drone provider; priority as in generateEmbedding (bulk callers
// leave it low; only the search's query embed rides high).
export async function generateEmbeddingBatch(config, texts, opts) {
  var provider = config.embedding_provider || 'none';
  if (provider === 'none' || !provider) return texts.map(function () { return null; });
  var priority = (opts && opts.priority === 'high') ? 'high' : 'low';

  if (provider === 'drone') {
    // Queue individual drone jobs for each text
    if (opts && opts.db && opts.items) {
      for (var i = 0; i < opts.items.length; i++) {
        var item = opts.items[i];
        try {
          createDroneEmbedJob(opts.db, item.source_type, item.source_id, item.chunk_index || 0, texts[i], config.embedding_model);
        } catch (e) {
          console.error('[semantic-memory] Drone batch embed queue failed:', e.message);
        }
      }
    }
    return texts.map(function () { return null; });
  }

  if (provider === 'ollama') {
    // /api/embed takes `input` as a string OR an array and answers
    // { embeddings: [[...]] } in input order (embedOllama below already POSTs
    // it — the old "Ollama doesn't have a batch endpoint" comment here was
    // stale), so like the OpenAI path the batch is ONE scheduler unit per
    // chunk: N rows collapse from N embedder calls to ceil(N /
    // EMBEDDING_OLLAMA_BATCH_MAX), and a high-priority query embed arriving
    // between two chunks still jumps ahead of the remainder — it waits behind
    // at most one chunk in flight, never the whole list.
    //
    // Degrade is STRICTLY-NO-WORSE: a batch-shaped failure (HTTP >= 400,
    // unexpected shape, timeout) falls back to the sequential per-item loop —
    // one notch better than the OpenAI path's per-item nulls, because the rows
    // still embed (one call at a time is what every pre-array ollama served
    // anyway). A per-item failure inside that fallback stays null, exactly
    // like the old loop.
    var results = [];
    for (var c = 0; c < texts.length; c += EMBEDDING_OLLAMA_BATCH_MAX) {
      var chunk = texts.slice(c, c + EMBEDDING_OLLAMA_BATCH_MAX);
      var vectors = null;
      try {
        vectors = await scheduleEmbedCall(priority, config, function () {
          return embedOllamaBatch(config.embedding_url || 'http://localhost:11434', config.embedding_model || 'nomic-embed-text', chunk);
        });
      } catch (batchErr) {
        console.error('[semantic-memory] Ollama batch embed failed, falling back to sequential:', batchErr.message);
      }
      if (vectors) {
        for (var v of vectors) results.push(v);
      } else {
        for (var t of chunk) {
          try {
            results.push(await scheduleEmbedCall(priority, config, function () {
              return embedOllama(config.embedding_url || 'http://localhost:11434', config.embedding_model || 'nomic-embed-text', t);
            }));
          } catch (e) {
            console.error('[semantic-memory] Batch embed failed for item:', e.message);
            results.push(null);
          }
        }
      }
    }
    return results;
  } else if (provider === 'openai') {
    // OpenAI batch is a single fetch for ALL texts, so on ANY provider
    // hiccup (missing key / HTTP>=400 / bad format / fetch reject) we
    // degrade to per-item nulls — mirroring the ollama path above — instead
    // of throwing an unhandled rejection that crashes the whole platform
    // from a routine admin reindex during one API hiccup.
    try {
      // One scheduler unit per batch — the batch IS one HTTP call.
      return await scheduleEmbedCall(priority, config, function () {
        return embedOpenAIBatch(config.embedding_url || 'https://api.openai.com/v1', config.embedding_model || 'text-embedding-3-small', config.embedding_api_key, texts);
      });
    } catch (e) {
      console.error('[semantic-memory] OpenAI batch embed failed:', e.message);
      return texts.map(function () { return null; });
    }
  }

  return texts.map(function () { return null; });
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dot = 0, magA = 0, magB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  var denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// -- Ollama --

async function embedOllama(baseUrl, model, text) {
  var response = await fetch(baseUrl + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model, input: text }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Ollama embed error: HTTP ' + response.status);
  var data = await response.json();
  // Ollama returns { embeddings: [[...]] } for /api/embed
  if (data.embeddings && data.embeddings[0]) return data.embeddings[0];
  // Fallback for older API
  if (data.embedding) return data.embedding;
  throw new Error('Ollama embed: unexpected response format');
}

// Batch variant of embedOllama: one POST for the whole chunk, `input` as an
// array, one vector per input text in input order. 60s timeout, mirroring
// embedOpenAIBatch — a chunk is up to EMBEDDING_OLLAMA_BATCH_MAX texts, not
// one. A response whose row count doesn't match the request is a FAILED batch
// (the caller falls back to the sequential loop) rather than silently zipping
// misaligned vectors into the index.
async function embedOllamaBatch(baseUrl, model, texts) {
  var response = await fetch(baseUrl + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model, input: texts }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error('Ollama batch embed error: HTTP ' + response.status);
  var data = await response.json();
  if (data.embeddings && Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
    return data.embeddings;
  }
  throw new Error('Ollama batch embed: unexpected response format');
}

// -- OpenAI --

async function embedOpenAI(baseUrl, model, apiKey, text) {
  if (!apiKey) throw new Error('OpenAI API key required for embeddings');
  var response = await fetch(baseUrl + '/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({ model: model, input: text }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('OpenAI embed error: HTTP ' + response.status);
  var data = await response.json();
  if (data.data && data.data[0]) return data.data[0].embedding;
  throw new Error('OpenAI embed: unexpected response format');
}

async function embedOpenAIBatch(baseUrl, model, apiKey, texts) {
  if (!apiKey) throw new Error('OpenAI API key required for embeddings');
  var response = await fetch(baseUrl + '/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({ model: model, input: texts }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error('OpenAI batch embed error: HTTP ' + response.status);
  var data = await response.json();
  if (data.data && Array.isArray(data.data)) {
    // OpenAI returns sorted by index
    return data.data.sort(function (a, b) { return a.index - b.index; }).map(function (d) { return d.embedding; });
  }
  throw new Error('OpenAI batch embed: unexpected response format');
}
