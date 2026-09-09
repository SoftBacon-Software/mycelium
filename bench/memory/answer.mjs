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

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A transient failure is retried; a deterministic one is not. Transient =
// the transport (fetch failed, connection reset, our own timeout) and the
// server saying "not now" (429, 5xx). Deterministic = a 4xx contract error
// and the empty-answer guard below (the same request would fail again).
// A 14-hour detached run must not die on one blip at the answerer or the
// judge — that is what --from-results --rejudge cannot repair.
export const CHAT_TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|abort|timeout/i;

export function isTransientChatError(e) {
  if (e?.transientStatus) return true;
  // every field the runtime may carry the cause in — name alone is 'TypeError'
  // for a failed fetch, the message says 'fetch failed'
  const text = [e?.cause?.code, e?.cause?.message, e?.name, e?.message].filter(Boolean).join(' ');
  return CHAT_TRANSIENT.test(text);
}

export function makeOpenAIChat({
  url,
  model,
  apiKey = null,
  temperature = 0,
  maxTokens = 256,
  timeoutMs = 300000,
  fetchImpl = fetch,
  // extra top-level body fields, merged verbatim (e.g. the extract arm's
  // {chat_template_kwargs: {enable_thinking: false}} — llama.cpp honours it).
  // The answerer chat never sets this: the answer phase must stay identical
  // across arms.
  extraBody = null,
  // transient-failure policy: attempts = 1 + retries; backoff grows 4× per retry
  retries = 3,
  retryBaseMs = 5000,
  sleep = defaultSleep,
  log = () => {},
}) {
  const once = makeOpenAIChatOnce({ url, model, apiKey, temperature, maxTokens, timeoutMs, fetchImpl, extraBody });
  return async function chat(req) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(req);
      } catch (e) {
        if (attempt >= retries || !isTransientChatError(e)) throw e;
        const wait = retryBaseMs * 4 ** attempt;
        log(`chat ${model}: transient failure (attempt ${attempt + 1}/${retries + 1}): ${String(e.message).slice(0, 160)} — retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  };
}

function makeOpenAIChatOnce({ url, model, apiKey, temperature, maxTokens, timeoutMs, fetchImpl, extraBody }) {
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
          ...(extraBody ?? {}),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`chat ${model} -> ${res.status}: ${text.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) err.transientStatus = res.status;
        throw err;
      }
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`chat ${model}: non-JSON body: ${text.slice(0, 200)}`); }
      const message = json?.choices?.[0]?.message;
      const content = message?.content;
      if (typeof content !== 'string') throw new Error(`chat ${model}: no content in response`);
      const finishReason = json?.choices?.[0]?.finish_reason ?? null;
      const reasoningLen = typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0;
      const stripped = stripThink(content);
      if (!stripped.text) {
        // Thinking models (qwen3.8 on llama.cpp) emit their reasoning in a
        // separate `reasoning_content` field that still spends max_tokens: a
        // too-small budget leaves content empty with nothing on the table.
        throw new Error(
          `chat ${model}: empty answer (finish_reason=${finishReason}, ` +
          `reasoning_content_chars=${reasoningLen}, content_chars=${content.length}) — ` +
          `the model spent its whole token budget thinking; raise max_tokens`
        );
      }
      return { text: stripped.text, hadThink: stripped.hadThink, raw: content, reasoningLen, finishReason };
    } finally {
      clearTimeout(timer);
    }
  };
}
