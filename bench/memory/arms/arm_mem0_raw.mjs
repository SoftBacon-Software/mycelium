// arm_mem0_raw — the RAW-ingestion control arm for the Mem0 column (task 182).
//
// Mem0 with extraction OFF: Memory.add(messages, infer=False) — mem0ai 2.0.20
// (mem0/memory/main.py:770 declares `infer: bool = True`; :880 the raw path in
// _add_to_vector_store stores each NON-SYSTEM message verbatim — one memory per
// turn, content embedded directly, NO LLM in the ingestion path). Only Mem0's
// retrieval + the shared RAG answer are measured.
//
// Same sidecar, same embedder, same answerer, same budget as arm mem0. The
// scope is suffixed `-raw` so the two mem0-family arms in one run never see
// each other's rows, and the resume checkpoint is named per arm for the same
// reason (see arm_mem0's cpFile).

import { createArmMem0, mem0Scope } from './arm_mem0.mjs';

export function mem0RawScope(runId) {
  return `${mem0Scope(runId)}-raw`;
}

// Same ctx contract as createArmMem0 (answerChat, runId, retrievalBudget,
// sidecar | mem0, resumeDir, restartSidecar, log, ...). The factory pins the
// control arm's identity: name, infer:false and the -raw scope are NOT
// caller-overridable.
export function createArmMem0Raw(ctx = {}) {
  const { runId } = ctx;
  if (!runId) throw new Error('arm_mem0_raw requires runId');
  return createArmMem0({
    ...ctx,
    name: 'mem0-raw',
    infer: false,
    scope: mem0RawScope(runId),
  });
}
