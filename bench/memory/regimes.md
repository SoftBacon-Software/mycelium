# Memory benchmark — every banked run, by regime (task 333)

Generated: 2026-09-19T14:10:07Z (the newest banked run file's date_utc — regeneration is byte-stable)

Rendered from the run files under `bench/memory/results/` (primary `summary.json` + every `summary.rejudge*.json` pass) — no hand-typed numbers. One row per run file × arm; grouped by regime. A number is quotable only beside numbers from the SAME regime; the grid composer now refuses a cross-regime composition (bench/memory/grid.mjs: `regime.answerer.url_host`, `regime.judge.url_host`, `regime.answerer.temperature`, stamped platform fields) unless `--allow-mixed-regime` is passed — and then the receipt prints the regimes side by side.

## Regime 1 of 10

qwen3.8:27b @ desktop-1uiqnip:11434 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt <unstamped> · budget 5 · n 3 · dataset bench-memory hermetic fixture

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-08T15:46:34Z | bench-memory hermetic fixture | 3 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | <unstamped> | — | none: p1 0.000 (0/0/3 of 3) · knowledge-update 0/1 · multi-session 0/1 · single-session-user 0/1 · mycelium: p1 1.000 (3/0/0 of 3) · knowledge-update 1/1 · multi-session 1/1 · single-session-user 1/1 | bench/memory/results/2026-09-08-p1-154633/summary.json |

## Regime 2 of 10

qwen3.8:27b @ desktop-1uiqnip:11434 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt <unstamped> · budget 5 · n 50 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-08T18:59:21Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | <unstamped> | — | none: p1 0.110 (0/11/39 of 50) · knowledge-update 0/15 · multi-session 0/12 · single-session-assistant 0/5 · single-session-preference 0/7 · single-session-user 0/6 · temporal-reasoning 0/5 · mycelium: p1 0.580 (21/16/13 of 50) · knowledge-update 10/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 2/6 · temporal-reasoning 2/5 | bench/memory/results/2026-09-08-p1-185920/summary.json |

## Regime 3 of 10

qwen3.8:27b @ desktop-1uiqnip:11434 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt judge-prompt.2 · budget 5 · n 50 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-08T18:59:21Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | — | none: p1 0.010 (0/1/49 of 50) · knowledge-update 0/15 · multi-session 0/12 · single-session-assistant 0/5 · single-session-preference 0/7 · single-session-user 0/6 · temporal-reasoning 0/5 · mycelium: p1 0.380 (19/0/31 of 50) · knowledge-update 9/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 1/6 · temporal-reasoning 2/5 | bench/memory/results/2026-09-08-p1-185920/summary.rejudge.json |
| 2026-09-09T19:50:34Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (mem0 sidecar @ jetson01.local:11434, 768d) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | mem0:off | mem0: p1 0.440 (21/2/27 of 50) · knowledge-update 9/15 · multi-session 4/12 · single-session-assistant 3/5 · single-session-preference 0/7 · single-session-user 3/6 · temporal-reasoning 2/5 · mem0-raw: p1 0.310 (15/1/34 of 50) · knowledge-update 3/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 4/6 · temporal-reasoning 1/5 | bench/memory/results/2026-09-09-p1-195034/summary.json |
| 2026-09-09T19:50:34Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (mem0 sidecar @ jetson01.local:11434, 768d) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | mem0:off | mem0: p1 0.440 (21/2/27 of 50) · knowledge-update 9/15 · multi-session 4/12 · single-session-assistant 3/5 · single-session-preference 0/7 · single-session-user 3/6 · temporal-reasoning 2/5 · mem0-raw: p1 0.310 (15/1/34 of 50) · knowledge-update 3/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 4/6 · temporal-reasoning 1/5 | bench/memory/results/2026-09-09-p1-195034/summary.rejudge.json |
| 2026-09-10T00:15:49Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | extract:off | mycelium: p1 0.290 (14/1/35 of 50) · knowledge-update 4/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 1/6 · temporal-reasoning 2/5 · mycelium-extract: p1 0.250 (12/1/37 of 50) · knowledge-update 7/15 · multi-session 2/12 · single-session-assistant 0/5 · single-session-preference 0/7 · single-session-user 2/6 · temporal-reasoning 1/5 | bench/memory/results/2026-09-10-p1-001549/summary.json |
| 2026-09-10T00:15:49Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | extract:off | mycelium: p1 0.290 (14/1/35 of 50) · knowledge-update 4/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 1/6 · temporal-reasoning 2/5 · mycelium-extract: p1 0.250 (12/1/37 of 50) · knowledge-update 7/15 · multi-session 2/12 · single-session-assistant 0/5 · single-session-preference 0/7 · single-session-user 2/6 · temporal-reasoning 1/5 | bench/memory/results/2026-09-10-p1-001549/summary.rejudge.json |
| 2026-09-17T22:42:25Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 0.400 (20/0/30 of 50) · knowledge-update 8/15 · multi-session 3/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 2/6 · temporal-reasoning 2/5 · write: ADD 13,505 / SUP 220 / KEEP 230 (13,955 candidates over 50 rows) | bench/memory/results/2026-09-17-p1-224225/summary.rejudge.json |

## Regime 4 of 10

scripted-smoke @ 127.0.0.1:3997 · judge scripted-smoke @ 127.0.0.1:3997 · judge prompt judge-prompt.2 · budget 5 · n 1 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-17T20:38:02Z | LongMemEval-S (cleaned) | 1 | scripted-smoke | 127.0.0.1:3997 | — | scripted-smoke @ 127.0.0.1:3997 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 1.000 (1/0/0 of 1) · single-session-user 1/1 · write: ADD 3 / SUP 1 / KEEP 6 (10 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-203802/summary.json |
| 2026-09-17T20:46:03Z | LongMemEval-S (cleaned) | 1 | scripted-smoke | 127.0.0.1:3997 | — | scripted-smoke @ 127.0.0.1:3997 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 1.000 (1/0/0 of 1) · single-session-user 1/1 · write: ADD 2 / SUP 0 / KEEP 8 (10 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-204603/summary.json |
| 2026-09-17T21:07:12Z | LongMemEval-S (cleaned) | 1 | scripted-smoke | 127.0.0.1:3997 | fake-embed (platform ollama @ 127.0.0.1:3999) | scripted-smoke @ 127.0.0.1:3997 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 1.000 (1/0/0 of 1) · single-session-user 1/1 · write: ADD 1 / SUP 4 / KEEP 0 (5 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-210712/summary.json |
| 2026-09-17T21:07:27Z | LongMemEval-S (cleaned) | 1 | scripted-smoke | 127.0.0.1:3997 | fake-embed (platform ollama @ 127.0.0.1:3999) | scripted-smoke @ 127.0.0.1:3997 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 1.000 (1/0/0 of 1) · single-session-user 1/1 · write: ADD 1 / SUP 4 / KEEP 0 (5 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-210727/summary.json |

## Regime 5 of 10

scripted-smoke @ 127.0.0.1:3997 · judge scripted-smoke @ 127.0.0.1:3997 · judge prompt judge-prompt.2 · budget 8 · n 1 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-17T21:10:39Z | LongMemEval-S (cleaned) | 1 | scripted-smoke | 127.0.0.1:3997 | fake-embed (platform ollama @ 127.0.0.1:3999) | scripted-smoke @ 127.0.0.1:3997 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 1.000 (1/0/0 of 1) · single-session-user 1/1 · write: ADD 1 / SUP 4 / KEEP 0 (5 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-211039/summary.json |
| 2026-09-17T21:11:00Z | LongMemEval-S (cleaned) | 1 | scripted-smoke | 127.0.0.1:3997 | fake-embed (platform ollama @ 127.0.0.1:3999) | scripted-smoke @ 127.0.0.1:3997 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 1.000 (1/0/0 of 1) · single-session-user 1/1 · write: ADD 1 / SUP 4 / KEEP 0 (5 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-211100/summary.json |

## Regime 6 of 10

qwen3.8:27b @ desktop-1uiqnip:11434 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt judge-prompt.3 · budget 5 · n 50 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-17T22:42:25Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.3 | timeline:off | mycelium-timeline: p1 0.540 (27/0/23 of 50) · knowledge-update 10/15 · multi-session 7/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 3/6 · temporal-reasoning 2/5 · write: ADD 13,505 / SUP 220 / KEEP 230 (13,955 candidates over 50 rows) | bench/memory/results/2026-09-17-p1-224225/summary.rejudge-v3.json |

## Regime 7 of 10

Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt judge-prompt.2 · budget 5 · n 1 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-17T22:55:26Z | LongMemEval-S (cleaned) | 1 | Laguna-XS-2.1-mlx-oq4e-agentic-ours | localhost:8780 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.2 | timeline:off | mycelium-timeline: p1 0.000 (0/0/1 of 1) · single-session-user 0/1 · write: ADD 42 / SUP 0 / KEEP 0 (42 candidates over 1 rows) | bench/memory/results/2026-09-17-p1-225526/summary.json |

## Regime 8 of 10

Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt judge-prompt.4 · budget 5 · n 1 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-18T15:42:54Z | LongMemEval-S (cleaned) | 1 | Laguna-XS-2.1-mlx-oq4e-agentic-ours | localhost:8780 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.4 | timeline:off extract:off | mycelium-timeline: p1 0.000 (0/0/1 of 1) · single-session-user 0/1 · write: ADD 37 / SUP 1 / KEEP 1 (39 candidates over 1 rows) · mycelium-extract: p1 0.000 (0/0/1 of 1) · single-session-user 0/1 | bench/memory/results/2026-09-18-p1-154254/summary.json |

## Regime 9 of 10

qwen3.8:27b @ desktop-1uiqnip:11434 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt judge-prompt.4 · budget 5 · n 1 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-19T13:43:04Z | LongMemEval-S (cleaned) | 1 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.4 | — | none: p1 0.000 (0/0/1 of 1) · single-session-user 0/1 · mycelium: p1 0.000 (0/0/1 of 1) · single-session-user 0/1 | bench/memory/results/2026-09-19-p1-134304/summary.json |

## Regime 10 of 10

qwen3.8:27b @ desktop-1uiqnip:11434 · judge Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 · judge prompt judge-prompt.4 · budget 5 · n 50 · dataset LongMemEval-S (cleaned)

| date | split | n | answerer | box | embedder | judge | judge prompt | thinking | headline (rendered from the files) | run file |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-19T13:43:58Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | nomic-embed-text (platform ollama @ jetson01.local:3002) | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.4 | — | none: p1 0.150 (7/1/42 of 50) · knowledge-update 3/15 · multi-session 1/12 · single-session-assistant 0/5 · single-session-preference 0/7 · single-session-user 2/6 · temporal-reasoning 1/5 · mycelium: p1 0.370 (18/1/31 of 50) · knowledge-update 6/15 · multi-session 2/12 · single-session-assistant 5/5 · single-session-preference 0/7 · single-session-user 3/6 · temporal-reasoning 2/5 | bench/memory/results/2026-09-19-p1-134358/summary.json |
| 2026-09-19T14:10:07Z | LongMemEval-S (cleaned) | 50 | qwen3.8:27b | desktop-1uiqnip:11434 | — | Laguna-XS-2.1-mlx-oq4e-agentic-ours @ localhost:8780 | judge-prompt.4 | — | none: p1 0.150 (7/1/42 of 50) · knowledge-update 3/15 · multi-session 1/12 · single-session-assistant 0/5 · single-session-preference 0/7 · single-session-user 2/6 · temporal-reasoning 1/5 | bench/memory/results/2026-09-19-p1-141007/summary.json |

**20 banked run files in 10 regimes.**

## Composed grids — regime audit (every `receipts/*-grid.md`)

| grid receipt | cited runs | regimes found | verdict |
|---|---|---|---|
| bench/memory/receipts/2026-09-09-p1-195034+2026-09-10-p1-001549+2026-09-11-p1-025039-grid.md | 2026-09-09-p1-195034 + 2026-09-10-p1-001549 + 2026-09-11-p1-025039 | 1 | UNVERIFIABLE: 2026-09-11-p1-025039 — no run file in the tree |
| bench/memory/receipts/2026-09-09-p1-195034+2026-09-10-p1-001549+2026-09-11-p1-123327-grid.md | 2026-09-09-p1-195034 + 2026-09-10-p1-001549 + 2026-09-11-p1-123327 | 1 | UNVERIFIABLE: 2026-09-11-p1-123327 — no run file in the tree |
| bench/memory/receipts/2026-09-09-p1-195034+2026-09-10-p1-001549-grid.md | 2026-09-09-p1-195034 + 2026-09-10-p1-001549 | 1 | one regime |
| bench/memory/receipts/2026-09-17-p1-224225-rejudge+2026-09-09-p1-195034-grid.md | 2026-09-17-p1-224225-rejudge + 2026-09-09-p1-195034 | 1 | one regime |

**4 composed grids audited: 0 MIXED, 2 unverifiable citation(s) (2026-09-11-p1-025039, 2026-09-11-p1-123327).** A grid citing a run file that no longer exists in the tree cannot be re-checked — named, never silent.

Result dirs with NO banked summary (route smokes / evidence-gone dirs — excluded from the table): 2026-09-11-p1-025039, 2026-09-11-p1-123327, 2026-09-17-p1-task206-smoke, 2026-09-17-p1-task210-smoke, 2026-09-17-p1-task211-smoke, 2026-09-17-p1-task214-smoke, 2026-09-17-p1-task216-smoke.
