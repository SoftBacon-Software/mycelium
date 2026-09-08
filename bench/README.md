# bench/

Benchmarks we own end to end — regime-stamped, receipt-gated instruments.

- **`memory/`** — the memory-layer benchmark (P1 of
  `jarvis/runs/fable-specs/BRIEF-memory-sota-program.md`): LongMemEval-S
  under one harness, arms `none` (no memory) and `mycelium` (the platform's
  memory API), local judge, every row regime-stamped, receipts in
  `memory/receipts/`. See `memory/README.md`.
