// Embedding provider abstraction for semantic memory
// Supports: ollama (nomic-embed-text), openai (text-embedding-3-small), drone (async via job queue)

// Queue a drone job to embed content asynchronously.
// The drone worker calls local Ollama, then PUTs the vector back via callback endpoint.
export function createDroneEmbedJob(rawDb, sourceType, sourceId, chunkIndex, text, model) {
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

// opts (optional): { db, sourceType, sourceId, chunkIndex } — needed for drone provider to queue jobs
export async function generateEmbedding(config, text, opts) {
  var provider = config.embedding_provider || 'none';
  if (provider === 'none' || !provider) return null;

  if (provider === 'drone') {
    // Drone provider: queue async job if caller provides context, always return null
    if (opts && opts.db && opts.sourceType && opts.sourceId) {
      createDroneEmbedJob(opts.db, opts.sourceType, opts.sourceId, opts.chunkIndex || 0, text, config.embedding_model);
    }
    return null;
  }

  if (provider === 'ollama') {
    return embedOllama(config.embedding_url || 'http://localhost:11434', config.embedding_model || 'nomic-embed-text', text);
  } else if (provider === 'openai') {
    return embedOpenAI(config.embedding_url || 'https://api.openai.com/v1', config.embedding_model || 'text-embedding-3-small', config.embedding_api_key, text);
  }

  console.warn('[semantic-memory] Unknown embedding provider:', provider);
  return null;
}

// opts (optional): { db, items: [{ source_type, source_id, chunk_index }] } — needed for drone provider
export async function generateEmbeddingBatch(config, texts, opts) {
  var provider = config.embedding_provider || 'none';
  if (provider === 'none' || !provider) return texts.map(function () { return null; });

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
    // Ollama doesn't have a batch endpoint, call sequentially
    var results = [];
    for (var t of texts) {
      try {
        results.push(await embedOllama(config.embedding_url || 'http://localhost:11434', config.embedding_model || 'nomic-embed-text', t));
      } catch (e) {
        console.error('[semantic-memory] Batch embed failed for item:', e.message);
        results.push(null);
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
      return await embedOpenAIBatch(config.embedding_url || 'https://api.openai.com/v1', config.embedding_model || 'text-embedding-3-small', config.embedding_api_key, texts);
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
