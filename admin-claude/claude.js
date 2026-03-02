// Claude API wrapper for admin-claude judgment calls
// Uses Sonnet for fast/cheap triage

import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, MODEL, SYSTEM_PROMPT, MAX_CLAUDE_CALLS_PER_MIN } from './config.js';

var client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Simple rate limiter: track calls in a sliding window
var callTimestamps = [];

function checkRateLimit() {
  var now = Date.now();
  // Remove timestamps older than 1 minute
  callTimestamps = callTimestamps.filter(function (t) { return now - t < 60000; });
  if (callTimestamps.length >= MAX_CLAUDE_CALLS_PER_MIN) {
    return false;
  }
  callTimestamps.push(now);
  return true;
}

// Ask Claude a question and get a text response
export async function ask(prompt, context) {
  if (!checkRateLimit()) {
    console.warn('[claude] Rate limited — skipping call');
    return '[Rate limited — try again in a minute]';
  }
  var messages = [{ role: 'user', content: prompt }];
  if (context) {
    messages[0].content = 'Context:\n' + context + '\n\nTask:\n' + prompt;
  }
  try {
    var response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: messages
    });
    var text = response.content.find(function (b) { return b.type === 'text'; });
    return text ? text.text : '';
  } catch (err) {
    console.error('[claude] API error:', err.message);
    return '[Claude API error: ' + err.message + ']';
  }
}

// Ask Claude and parse JSON response
export async function askJson(prompt, context) {
  var raw = await ask(prompt + '\n\nRespond with valid JSON only, no markdown fences.', context);
  try {
    // Strip markdown code fences if present
    var cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[claude] Failed to parse JSON response:', raw.substring(0, 200));
    return null;
  }
}
