// LLM provider abstraction for auto-memory extraction + consolidation
// Supports: ollama (default, free), openai, anthropic, custom HTTP

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
    body: JSON.stringify({ model: model, prompt: prompt, stream: false }),
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
      max_tokens: 2000
    }),
    signal: AbortSignal.timeout(30000)
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
