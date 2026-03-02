// Claude/LLM wrapper for admin-claude judgment calls
// Supports two backends: 'anthropic' (cloud) and 'ollama' (local)

import { LLM_BACKEND, ANTHROPIC_API_KEY, MODEL, OLLAMA_URL, OLLAMA_MODEL, SYSTEM_PROMPT, MAX_CLAUDE_CALLS_PER_MIN } from './config.js';

var client = null;
if (LLM_BACKEND === 'anthropic') {
  try {
    var Anthropic = (await import('@anthropic-ai/sdk')).default;
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  } catch (err) {
    console.error('[claude] Failed to load @anthropic-ai/sdk:', err.message);
    console.error('[claude] Install it with: npm install @anthropic-ai/sdk');
    console.error('[claude] Or switch to local mode: LLM_BACKEND=ollama');
    process.exit(1);
  }
}

// Simple rate limiter: track calls in a sliding window
var callTimestamps = [];

function checkRateLimit() {
  var now = Date.now();
  callTimestamps = callTimestamps.filter(function (t) { return now - t < 60000; });
  if (callTimestamps.length >= MAX_CLAUDE_CALLS_PER_MIN) {
    return false;
  }
  callTimestamps.push(now);
  return true;
}

// Ask the LLM a question and get a text response
// Returns null if rate limited (callers must handle null)
export async function ask(prompt, context) {
  if (!checkRateLimit()) {
    console.warn('[llm] Rate limited — skipping call');
    return null;
  }

  var fullPrompt = prompt;
  if (context) {
    fullPrompt = 'Context:\n' + context + '\n\nTask:\n' + prompt;
  }

  if (LLM_BACKEND === 'ollama') {
    return askOllama(fullPrompt);
  }
  return askAnthropic(fullPrompt);
}

// Anthropic backend
async function askAnthropic(prompt) {
  try {
    var response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });
    var text = response.content.find(function (b) { return b.type === 'text'; });
    return text ? text.text : '';
  } catch (err) {
    console.error('[anthropic] API error:', err.message);
    return '[LLM API error: ' + err.message + ']';
  }
}

// Ollama backend (native API)
async function askOllama(prompt) {
  try {
    var response = await fetch(OLLAMA_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        stream: false,
        options: { num_predict: 2048 }
      })
    });
    if (!response.ok) {
      var errText = await response.text();
      console.error('[ollama] HTTP ' + response.status + ':', errText.substring(0, 200));
      return '[LLM error: HTTP ' + response.status + ']';
    }
    var data = await response.json();
    return data.message ? data.message.content : '';
  } catch (err) {
    console.error('[ollama] Error:', err.message);
    return '[LLM error: ' + err.message + ']';
  }
}

// Ask and parse JSON response
export async function askJson(prompt, context) {
  var raw = await ask(prompt + '\n\nRespond with valid JSON only, no markdown fences.', context);
  if (!raw) return null;
  try {
    var cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[llm] Failed to parse JSON response:', raw.substring(0, 200));
    return null;
  }
}
