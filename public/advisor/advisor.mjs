// Pure recommendation logic over a model-selector-ruleset/v1 object.
// No DOM, no I/O — fully unit-testable.

// Map a memory amount to the nearest lower-or-equal bucket key for a platform.
// cpu_only has a single "any" tier. Below the lowest bucket -> lowest (floor);
// above the highest -> highest (clamp). Never returns undefined.
export function bucketMemory(ruleset, platform, memoryGb) {
  if (platform === 'cpu_only') return 'any';
  const buckets = [...ruleset.memory_buckets[platform]].sort((a, b) => a - b);
  let best = buckets[0];
  for (const b of buckets) {
    if (b <= memoryGb) best = b;
  }
  return String(best);
}

// Classify a model string into one of the ruleset's tps_guidance classes.
// Order matters: the MoE check must precede the generic 30B/32B checks.
export function modelClass(model) {
  const m = model.toLowerCase();
  if (/a3b|moe/.test(m)) return '30B-A3B (MoE)';
  // Mistral-Nemo ships as a date-name ("Mistral-Nemo-Instruct-2407") with no
  // size token — it's a 12B, classify by name.
  if (/mistral-nemo/.test(m)) return '12-14B';
  if (/\b(7b|8b|9b)\b/.test(m)) return '7-8B';   // gemma-2-9b sits with the small tier
  if (/\b(12b|13b|14b)\b/.test(m)) return '12-14B';
  if (/\b32b\b/.test(m)) return '32B dense';
  if (/\b(65b|70b|72b)\b/.test(m)) return '70B dense';
  return null;
}

// Look up the rough output-tokens/sec guidance string for a model.
export function estimateTPS(ruleset, model) {
  const cls = modelClass(model);
  if (!cls) return null;
  return ruleset.tps_guidance.by_model_class[cls] ?? null;
}

// Canonical Ollama library tags for the NVIDIA/CPU family-name picks — every
// one HF/ollama-verified (HTTP 200 at ollama.com/library/<name>) 2026-05-31.
// Apple picks are mlx-community repo ids (MLX, not GGUF) so they get NO tag.
// The 1M-context variants are intentionally absent: ollama's standard library
// ships 128k-max, not the -1M weights, so those fall back to a family-name
// search rather than a wrong `ollama pull`.
const OLLAMA_TAGS = {
  'Qwen2.5-Coder-7B-Instruct':  'qwen2.5-coder:7b',
  'Qwen2.5-Coder-14B-Instruct': 'qwen2.5-coder:14b',
  'Qwen2.5-Coder-32B-Instruct': 'qwen2.5-coder:32b',
  'Qwen2.5-14B-Instruct':       'qwen2.5:14b',
  'Qwen2.5-32B-Instruct':       'qwen2.5:32b',
  'Qwen3-Coder-30B-A3B-Instruct':'qwen3-coder:30b',
  'Llama-3.1-8B-Instruct':      'llama3.1:8b',
  'Llama-3.3-70B-Instruct':     'llama3.3:70b',
  'gemma-2-9b-it':              'gemma2:9b',
  'Mistral-Nemo-Instruct-2407': 'mistral-nemo:12b',
};

// Resolve ONE opinionated recommendation from the ruleset.
// input: { platform, memoryGb, task, priority?, comfort? }
// returns: { platform, memoryGb, bucket, task, model, quant, format, runner,
//            agenticTool, priorityNote, warning, tpsRange, ollamaTag }
export function resolve(ruleset, input) {
  const platform = input.platform;
  const task = input.task;
  const priority = input.priority || 'balanced';
  const comfort = input.comfort || 'just_works';

  const bucket = bucketMemory(ruleset, platform, input.memoryGb);
  const cell = ruleset.rules[platform]?.[bucket];
  if (!cell) {
    throw new Error(`no rules for platform=${platform} bucket=${bucket}`);
  }
  const model = cell[task];
  if (!model) {
    throw new Error(`no pick for task=${task} at ${platform}/${bucket}`);
  }

  // Quant: default unless the model string already declares a bit-depth — either
  // the legacy "(6-bit)" label OR the bit-depth embedded in an mlx-community repo id
  // (e.g. "...-4bit", "...-8bit"). When embedded, leave quant blank so the line
  // doesn't double up ("...-4bit, 4-bit MLX").
  const quant = /\(\d+-bit\)|-\d+bit\b/.test(model) ? '' : ruleset.default_quant;

  const backend = ruleset.backends[platform];
  const format = backend.format;
  const runner = backend[comfort];

  const agenticTool = task === 'agentic_code' ? ruleset.agentic_tools[comfort] : null;
  const priorityNote = ruleset.priority_modifiers[priority];
  const warning = cell.warning || null;
  const tpsRange = estimateTPS(ruleset, model);
  // Ollama pull tag for non-Apple (GGUF) picks only; Apple is an mlx repo id.
  const ollamaTag = platform === 'apple_silicon' ? null : (OLLAMA_TAGS[model] || null);

  return { platform, memoryGb: input.memoryGb, bucket, task,
           model, quant, format, runner, agenticTool, priorityNote, warning, tpsRange, ollamaTag };
}

// Build human-facing lines from a resolved pick. Pure string assembly.
// The funnel line is the acquisition CTA toward the Mycelium app.
export function formatResult(ruleset, r) {
  const quantPart = r.quant ? `${r.quant} ` : '';
  const modelLine = `${r.model}, ${quantPart}${r.format}`;
  const runLine = `Run it with ${r.runner}`;
  const agenticLine = r.agenticTool
    ? `Drive it with ${r.agenticTool} (point it at the local endpoint)`
    : null;
  const expectLine = r.tpsRange
    ? `Expect roughly ${r.tpsRange} output on your hardware`
    : 'Speed varies with your hardware';
  const funnelLine = 'These are the models a real local dev squad runs on. '
    + 'Want the squad that plans, codes, and reviews — on your own hardware?';
  return { modelLine, runLine, agenticLine, expectLine,
           warning: r.warning, priorityNote: r.priorityNote, funnelLine };
}

// The smallest memory bucket (as a number) at which `model` appears in any
// task cell for this platform. That bucket is the model's minimum fit. Matching
// is case-insensitive and ignores any "(N-bit)" suffix so "Qwen2.5-32B (6-bit)"
// matches "Qwen2.5-32B". Returns null if the model never appears.
export function minFitBucket(ruleset, platform, model) {
  if (platform === 'cpu_only') return null; // cpu has a single "any" tier
  const norm = (s) => s.toLowerCase().replace(/\s*\(\d+-bit\)/, '').trim();
  const target = norm(model);
  const grid = ruleset.rules[platform] || {};
  const buckets = Object.keys(grid).map(Number).sort((a, b) => a - b);
  for (const b of buckets) {
    const cell = grid[String(b)];
    for (const k of Object.keys(cell)) {
      if (k === 'warning') continue;
      if (norm(cell[k]) === target) return b;
    }
  }
  return null;
}

// Diagnose a "my model is slow" complaint. Compares the user's model's
// minimum-fit bucket against their actual memory bucket.
// input: { platform, memoryGb, model, task }
// returns: { cause: 'spill'|'fits'|'unknown', yourBucket, minFit, explanation,
//            fixModel }  (fixModel = the bucket-appropriate pick for their task)
export function diagnose(ruleset, input) {
  const yourBucketKey = bucketMemory(ruleset, input.platform, input.memoryGb);
  const yourBucket = yourBucketKey === 'any' ? 0 : Number(yourBucketKey);
  // What they SHOULD run at their size for this task (the fitting fix):
  let fixModel = null;
  try { fixModel = resolve(ruleset, input).model; } catch { fixModel = null; }

  const minFit = minFitBucket(ruleset, input.platform, input.model);

  if (minFit === null) {
    return { cause: 'unknown', yourBucket, minFit: null, fixModel,
      explanation: `We don't have ${input.model} in our grid, so we can't size it. `
        + `For your ${input.memoryGb}GB the model that fits this task is ${fixModel}.` };
  }
  if (minFit > yourBucket) {
    return { cause: 'spill', yourBucket, minFit, fixModel,
      explanation: `${input.model} doesn't fit ${input.memoryGb}GB — it needs about a `
        + `${minFit}GB tier, so it spills out of memory and runs far slower than its `
        + `class. Drop to ${fixModel}, which fits your hardware, or use a smaller quant `
        + `that fully fits.` };
  }
  return { cause: 'fits', yourBucket, minFit, fixModel,
    explanation: `${input.model} should fit ${input.memoryGb}GB. If it's still slow, check `
      + `that it's fully offloaded to the GPU (not partly on CPU) and that you're on a `
      + `GPU-accelerated runner.` };
}

// Opinionated GPU-upgrade verdict over upgrade-knowledge/v1 data.
// input: { current, candidate, goal: 'capacity'|'speed'|'mixed', secondCard: bool }
// returns: { recommend: 'candidate'|'neither'|'current', verdict, principles,
//            candidateNote, currentNote }
export function upgrade(data, input) {
  const cards = data.cards || {};
  const cand = cards[input.candidate] || null;
  const cur = cards[input.current] || null;
  const candidateNote = cand ? cand.note : null;
  const currentNote = cur ? cur.note : null;

  // Relevant principles: PCIe + mixing matter for a 2nd card; capacity/speed always.
  const wantIds = input.secondCard
    ? ['pcie_inference', 'multi_gpu_mixing', 'capacity_vs_speed']
    : ['capacity_vs_speed'];
  const principles = (data.principles || []).filter(p => wantIds.includes(p.id));

  // Verdict: pick the matching rule, fall back to mixed/single-card guidance.
  const rules = data.verdict_rules || [];
  let verdict;
  let recommend;
  if (input.secondCard && input.goal === 'capacity') {
    verdict = (rules.find(r => /capacity/.test(r.when)) || {}).say
      || 'For more model capacity, the bigger-VRAM card is the smart second card.';
    recommend = 'candidate';
  } else if (input.secondCard && input.goal === 'speed') {
    verdict = (rules.find(r => /speed/.test(r.when)) || {}).say
      || 'A faster second card barely helps on a slow slot — save toward one bigger modern GPU.';
    recommend = 'neither';
  } else {
    verdict = (rules.find(r => /single card/.test(r.when)) || {}).say
      || 'For mixed goals, a single bigger modern GPU (capacity AND speed) is the best all-rounder.';
    recommend = cand && cur && cand.vram > cur.vram ? 'candidate' : 'neither';
  }
  return { recommend, verdict, principles, candidateNote, currentNote };
}