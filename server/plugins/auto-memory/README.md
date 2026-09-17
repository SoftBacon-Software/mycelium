# auto-memory

Fact extraction + consolidation into an agent's auto-memory store, via a
configurable LLM provider (`llm.js` — ollama by default, or openai/anthropic/
custom HTTP).

## Ops note: the extraction model must be evicted (2026-09-11)

An extraction model on the platform box must have a **finite** keep_alive,
because the box is small and shared and ollama's default here was forever:
the jetson01 ollama unit ran `OLLAMA_KEEP_ALIVE=-1`, so one auto-memory
extraction pinned `nemotron-mini:latest` (2,696 MB) resident for 1.5 days —
with no requests in the final 90 minutes — on a 7,619 MB board that also
hosts the platform node (~1.4 GB under load) and the semantic-memory
embedder (308 MB). The box fell to 948 MB available / 1,965 MB swap and the
platform's event loop wedged three times in 3.5 h (20:30, 20:50, 21:50 CDT);
hand-unloading the model took it back to 4,386 MB available / 555 MB swap.
So every ollama call this plugin makes now carries `keep_alive` from
`AUTO_MEMORY_LLM_KEEP_ALIVE` (default `10m`; `0` evicts immediately), and
the embedder path in semantic-memory is deliberately left unpinned — it is
hit constantly and must stay warm. Unit-level fix and verify commands:
`docs/runbooks/jetson-ollama-keep-alive.md`.
