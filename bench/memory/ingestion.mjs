// The ingestion controls (task 182): the {Mycelium, Mem0} × {raw, extract} grid.
//
// As-shipped arms compare a WHOLE system. The control arms split the two
// decisions a memory system makes:
//   raw     — store the session text as-is (Mycelium: one row per session;
//             Mem0: Memory.add(infer=False), one row per non-system turn);
//             only retrieval + answer are measured.
//   extract — an LLM distils facts before the write (Mem0: its own extraction
//             prompt; Mycelium-extract: the SAME answerer model at temperature
//             0, thinking OFF, one row per fact).
//
// arm-name → cell:
//   mycelium          = Mycelium × raw      (as shipped)
//   mycelium-extract  = Mycelium × extract  (task 182)
//   mem0              = Mem0     × extract  (as shipped)
//   mem0-raw          = Mem0     × raw      (task 182)

export const GRID_ROWS = [
  { label: 'Mycelium', raw: 'mycelium', extract: 'mycelium-extract' },
  { label: 'Mem0', raw: 'mem0-raw', extract: 'mem0' },
];

export const INGESTION_POLICY = {
  mycelium: 'raw',
  'mycelium-extract': 'extract',
  'mem0-raw': 'raw',
  mem0: 'extract',
};

// Which extraction-thinking mode each arm runs. null = the arm does no LLM
// extraction (raw ingestion, or the mycelium arm which never extracted) — such
// arms are exempt from the one-mode-per-run rule. 'mem0' is resolved at
// sidecar-start time (its /health reports extraction_thinking from
// MEM0_NO_THINK); 'mycelium-extract' is hardcoded off at the factory.
export function extractionThinkingByArm(arms, { mem0Health = null } = {}) {
  const out = {};
  for (const a of arms) {
    if (a === 'mem0') out[a] = mem0Health?.extraction_thinking ?? 'on';
    else if (a === 'mycelium-extract') out[a] = 'off';
  }
  return out;
}

// One run = one extraction-thinking mode across ALL extraction arms. A mixed
// run (one arm extracting thinking-on, another thinking-off) would attribute
// the difference in stored facts to the ingestion POLICY when it might be the
// thinking mode — refuse, naming the arms and the fix.
export function assertNoExtractionThinkingMix(arms, thinkingByArm) {
  const present = arms.filter((a) => thinkingByArm[a] != null).map((a) => [a, thinkingByArm[a]]);
  const modes = [...new Set(present.map(([, m]) => m))];
  if (modes.length > 1) {
    const detail = present.map(([a, m]) => `${a}=thinking ${m}`).join(', ');
    throw new Error(
      `unstamped extraction-thinking mix in one run (${detail}) — every extraction arm in a run must share ONE ` +
        `stamped thinking mode (mycelium-extract is always off; start the mem0 sidecar with MEM0_NO_THINK=1)`
    );
  }
  return modes[0] ?? null;
}

// 'mean 4.20 facts/session (21 facts over 5 sessions, min 0, max 9)' — or null
// when the arm reported no per-session counts.
export function factsStatLine(writeInfo) {
  const counts = writeInfo?.facts_counts;
  if (!Array.isArray(counts) || counts.length === 0) return null;
  const total = counts.reduce((a, b) => a + b, 0);
  const mean = total / counts.length;
  return `${total} facts over ${counts.length} sessions — mean ${mean.toFixed(2)}, min ${Math.min(...counts)}, max ${Math.max(...counts)}`;
}

// Ingestion LOSS: sessions the arm's extractor dropped because its reply could
// not be parsed. mem0 skips such a session and only logs it (the sidecar counts
// the log records); mycelium-extract counts its own. Null when the arm does not
// report the number (raw arms have no extractor); "0 of N" is a real zero.
export function dropStatLine(writeInfo) {
  if (typeof writeInfo?.parse_failures !== 'number') return null;
  const docs = typeof writeInfo.docs === 'number' ? writeInfo.docs : null;
  const pct = docs ? ` (${((100 * writeInfo.parse_failures) / docs).toFixed(1)}%)` : '';
  return `${writeInfo.parse_failures}${docs ? ` of ${docs}` : ''} sessions dropped by the extractor (reply unparseable)${pct}`;
}

// The 2×2 table, rendered ONLY when all four grid arms are present (a smoke
// that runs just the controls has no grid to render). Cells carry the p1_score
// with its raw exact/partial/wrong counts — counts stay the primary record.
export function renderIngestionGrid(armsSummary, writeInfoByArm = null) {
  const names = GRID_ROWS.flatMap((r) => [r.raw, r.extract]);
  if (!names.every((n) => armsSummary?.[n])) return null;
  const cell = (n) => {
    const a = armsSummary[n];
    const c = a?.score?.counts;
    if (!c) return 'n/a';
    return `${a.score.p1_score?.toFixed(3) ?? 'n/a'} (${c.exact}/${c.partial}/${c.wrong})`;
  };
  const L = [];
  L.push('| system \\ ingestion | raw | extract |');
  L.push('|---|---|---|');
  for (const r of GRID_ROWS) L.push(`| ${r.label} | ${cell(r.raw)} | ${cell(r.extract)} |`);
  L.push('');
  L.push(
    'Cell = p1_score (exact/partial/wrong). Raw = session text stored as-is ' +
      '(Mycelium: one row per session; Mem0: `Memory.add(infer=False)`, one row per non-system turn). ' +
      'Extract = an LLM distils facts before the write (Mem0: its own extraction prompt; ' +
      'Mycelium-extract: the same answerer model at temperature 0, thinking off, one row per fact).'
  );
  for (const [arm, label] of [
    ['mycelium-extract', 'mycelium-extract'],
    ['mem0', 'mem0'],
    ['mem0-raw', 'mem0-raw'],
  ]) {
    const line = factsStatLine(writeInfoByArm?.[arm]);
    if (line) L.push(`Facts per session (${label}): ${line}.`);
  }
  return L;
}
