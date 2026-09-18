// fallback_provisional — keyword-fallback reads mark a column PROVISIONAL
// (task 235).
//
// The platform's search answers `mode: 'hybrid'` or, when the embed index
// degraded, falls back to `mode: 'keyword'` (server/plugins/semantic-memory).
// The bench stamps that mode per row (arm_mycelium: meta.retrieval_mode), but
// nothing read it back as a rule: a run whose reads silently degraded would
// still produce a quotable p1 and a WIN/MISS verdict. This module is the rule:
//
//   - the share is stamped per arm at answer time (core.mjs →
//     summary.arms[arm].fallback_share = {fallback, answered, unstamped});
//     rows with NO retrieval_mode field count in `unstamped` — never guessed
//     into either side;
//   - the receipt renders a PROVISIONAL banner on ANY fallback read;
//   - the grid reads a column whose share exceeds BENCH_GRID_MAX_FALLBACK_SHARE
//     (pre-committed: 0.05, fixed BEFORE the next n=50, not chosen after
//     seeing one) as UNDECIDED regardless of the cells — a keyword-read cell
//     is not the hybrid number the bars were pre-committed against.

export const DEFAULT_MAX_FALLBACK_SHARE = 0.05;

/**
 * The pre-committed bound. `source` names where it came from ('default' or
 * 'env') so every rendering stamps its provenance — a bound whose value was
 * tuned after seeing a run is not pre-committed, so the reader must be able
 * to tell. Throws on a malformed override: a silently-ignored typo would run
 * the grid under the default while the operator believes the override.
 */
export function maxFallbackShare(env = process.env) {
  const raw = env.BENCH_GRID_MAX_FALLBACK_SHARE;
  if (raw == null || raw === '') return { bound: DEFAULT_MAX_FALLBACK_SHARE, source: 'default' };
  const bound = Number(raw);
  if (!Number.isFinite(bound) || bound < 0 || bound > 1) {
    throw new Error(`BENCH_GRID_MAX_FALLBACK_SHARE must be a number in [0, 1] (got '${raw}')`);
  }
  return { bound, source: 'env' };
}

/**
 * The fallback share over one arm's answer rows. `answered` counts rows whose
 * meta carries a retrieval_mode field (the share's denominator); `fallback`
 * counts those whose mode is not 'hybrid'; `unstamped` counts rows with no
 * field (pre-stamp runs) — a third bucket, never folded into either side.
 * An explicit undefined counts unstamped: it is what survives a JSON
 * round-trip of an undefined mode, so memory and disk agree.
 */
export function computeFallbackShare(rows) {
  let fallback = 0;
  let answered = 0;
  let unstamped = 0;
  for (const r of rows ?? []) {
    const meta = r?.meta ?? {};
    if (meta.retrieval_mode === undefined || meta.retrieval_mode === null) {
      unstamped += 1;
      continue;
    }
    answered += 1;
    if (meta.retrieval_mode !== 'hybrid') fallback += 1;
  }
  return { fallback, answered, unstamped };
}

/**
 * One arm's grid state against the bound:
 *   - 'provisional' — stamped, answered > 0, share strictly above the bound;
 *   - 'clean'       — stamped, answered > 0, share at or under the bound
 *                     (the boundary is inclusive: exactly 5% is not over);
 *   - 'unstamped'   — no stamp, or no stamped reads (pre-mode runs, arms that
 *                     do not stamp retrieval modes) — composes as before.
 */
export function armFallbackState(armEntry, bound) {
  const fs = armEntry?.fallback_share;
  const answered = typeof fs?.answered === 'number' ? fs.answered : 0;
  const fallback = typeof fs?.fallback === 'number' ? fs.fallback : 0;
  const unstamped = typeof fs?.unstamped === 'number' ? fs.unstamped : 0;
  if (answered <= 0) return { kind: 'unstamped', fallback, answered, unstamped, share: null };
  const share = fallback / answered;
  return { kind: share > bound ? 'provisional' : 'clean', fallback, answered, unstamped, share };
}

/** The scores-table suffix for one (run, arm): the column's header stamp. */
export function columnFallbackSuffix(armEntry, bound) {
  const st = armFallbackState(armEntry, bound);
  if (st.kind === 'provisional') return ` (PROVISIONAL — fallback ${st.fallback}/${st.answered})`;
  if (st.kind === 'unstamped') return ' (retrieval-mode unstamped (pre-mode run))';
  return '';
}

/** Rendered form of the bound + its provenance (receipt regime block, grid). */
export function renderFallbackBound(boundStamp) {
  return `Fallback-provisional bound: ${boundStamp.bound} (BENCH_GRID_MAX_FALLBACK_SHARE=${boundStamp.source})`;
}
