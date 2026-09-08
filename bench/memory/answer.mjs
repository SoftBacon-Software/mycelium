// OpenAI-compatible chat adapter (llama.cpp /v1, oMLX /v1, any /v1 endpoint).
// Used for both the ANSWERER and (wrapped with the judge prompt) the JUDGE.

// qwen-family thinking models may emit <think> blocks in content; the label
// and the graded answer live outside them.
export function stripThink(text) {
  let hadThink = false;
  let out = String(text ?? '');
  while (true) {
    const open = out.indexOf('<think>');
    if (open === -1) break;
    const close = out.indexOf('</think>', open);
    hadThink = true;
    out = close === -1 ? out.slice(0, open) : out.slice(0, open) + out.slice(close + '</think>'.length);
  }
  return { text: out.trim(), hadThink };
}

export function makeOpenAIChat({ url, model, apiKey = null, temperature = 0, maxTokens = 256, timeoutMs = 300000, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/+$/, '')}/chat/completions`;
  return async function chat({ system, user }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat ${model} -> ${res.status}: ${text.slice(0, 200)}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`chat ${model}: non-JSON body: ${text.slice(0, 200)}`); }
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`chat ${model}: no content in response`);
      const stripped = stripThink(content);
      return { text: stripped.text, hadThink: stripped.hadThink, raw: content };
    } finally {
      clearTimeout(timer);
    }
  };
}
