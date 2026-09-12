// LLM provider abstraction for auto-memory extraction + consolidation
// Supports: ollama (default, free), openai, anthropic, custom HTTP

// How long ollama may keep the extraction model resident after a call.
// MUST be finite: the platform box is small and shared (on jetson01, node +
// the semantic-memory embedder + the extraction model all live on one board),
// and an ollama unit running OLLAMA_KEEP_ALIVE=-1 pins whatever this plugin
// loaded forever. Measured 2026-09-11: nemotron-mini (2,696 MB) sat resident
// 1.5 days with no requests in 90 min; the box reached 948 MB available /
// 1,965 MB swap and wedged its event loop three times in 3.5 h. An explicit
// keep_alive here overrides the unit default per call. The semantic-memory
// embedder is deliberately NOT given one — it is hit constantly and must
// stay warm. Override with AUTO_MEMORY_LLM_KEEP_ALIVE ('0' evicts at once).
var DEFAULT_KEEP_ALIVE = '10m';

function extractionKeepAlive() {
  var v = process.env.AUTO_MEMORY_LLM_KEEP_ALIVE;
  return (v === undefined || v === '') ? DEFAULT_KEEP_ALIVE : v;
}

export async function callLLM(config, prompt) {
  var provider = config.llm_provider || 'none';
  var model = config.llm_model || '';
  var url = config.llm_url || '';
  var apiKey = config.llm_api_key || '';

  if (provider === 'none' || !provider) {
    console.log('[auto-memory] No LLM provider configured — skipping extraction');
    return null;
  }

  if (provider === 'ollama') {
    return callOllama(url || 'http://localhost:11434', model || 'llama3.2', prompt);
  } else if (provider === 'openai') {
    return callOpenAI(url || 'https://api.openai.com/v1', model || 'gpt-4o-mini', apiKey, prompt);
  } else if (provider === 'anthropic') {
    return callAnthropic(url || 'https://api.anthropic.com/v1', model || 'claude-haiku-4-5-20251001', apiKey, prompt);
  } else if (provider === 'custom') {
    return callCustom(url, apiKey, prompt);
  }

  console.warn('[auto-memory] Unknown LLM provider:', provider);
  return null;
}

async function callOllama(baseUrl, model, prompt) {
  var response = await fetch(baseUrl + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model, prompt: prompt, stream: false, keep_alive: extractionKeepAlive() }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error('Ollama error: HTTP ' + response.status);
  var data = await response.json();
  return data.response || '';
}

async function callOpenAI(baseUrl, model, apiKey, prompt) {
  if (!apiKey) throw new Error('OpenAI API key required');
  var response = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000,
      // Constrained decoding: force valid JSON so small local models (nemotron-mini on
      // the jetson) can't return markdown/prose the fact-parser then silently drops.
      // Both auto-memory prompts (extraction + consolidation) request JSON. (2026-07-06)
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(60000)  // jetson small model ~22s/call; 30s was too tight
  });
  if (!response.ok) throw new Error('OpenAI error: HTTP ' + response.status);
  var data = await response.json();
  return data.choices && data.choices[0] ? data.choices[0].message.content : '';
}

async function callAnthropic(baseUrl, model, apiKey, prompt) {
  if (!apiKey) throw new Error('Anthropic API key required');
  var response = await fetch(baseUrl + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Anthropic error: HTTP ' + response.status);
  var data = await response.json();
  return data.content && data.content[0] ? data.content[0].text : '';
}

async function callCustom(url, apiKey, prompt) {
  if (!url) throw new Error('Custom LLM URL required');
  var headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  var response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ prompt: prompt, text: prompt }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Custom LLM error: HTTP ' + response.status);
  var data = await response.json();
  return data.response || data.text || data.content || JSON.stringify(data);
}
