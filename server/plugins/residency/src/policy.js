// residency plugin — co-reside / swap policy (pure, no I/O) — plain JavaScript (ESM)
//
// decideResidency() answers: given what is currently resident on a node and a
// model someone wants to load there, can it co-reside within the RAM budget, or
// must we swap (evict the resident set and load the requested model)?
//
// P1 is decision-only — the actuator that performs a swap is P2. This module is
// deliberately side-effect free so it is trivially unit-testable and reusable
// from the future actuator, the GET endpoint, or any caller.

/** A model's footprint descriptor. `rss_gb`, when present, overrides the lookup. */
// ModelFootprint: { model_id?: string, kind?: 'api'|'local', rss_gb?: number }

/** Anything we can estimate an RSS for: a footprint object or a bare model id. */
// ModelRef: ModelFootprint | string

// ResidencyDecision: { action: 'co-reside'|'swap', reason: string, total_gb: number }

// Estimated resident-set footprint (GB) by model id. Local weights reflect
// model size + typical KV/cache headroom; API models cost 0 local RAM because
// they run on a remote backend. Tune as real telemetry comes in.
export const modelRssLookup = {
  ds4: 80,
  'squad-glm': 27,
  'oMLX-Lucy-30B': 30,
  'default-local': 8,
  'default-api': 0
};

// Estimate the local RAM footprint (GB) of a model.
//
// Accepts either:
//   - a string model id, or
//   - an object { model_id, kind, rss_gb? }
//
// Resolution order: explicit rss_gb > lookup by model_id > default by kind.
export function estimateRss(model) {
  if (model == null) return 0;
  if (typeof model === 'string') {
    return Object.prototype.hasOwnProperty.call(modelRssLookup, model)
      ? modelRssLookup[model]
      : modelRssLookup['default-local'];
  }
  if (typeof model.rss_gb === 'number' && model.rss_gb > 0) return model.rss_gb;
  const id = model.model_id;
  if (id && Object.prototype.hasOwnProperty.call(modelRssLookup, id)) {
    return modelRssLookup[id];
  }
  return model.kind === 'api' ? modelRssLookup['default-api'] : modelRssLookup['default-local'];
}

// Sum the footprint of the currently resident set. Entries may carry their own
// rss_gb (from telemetry); otherwise we estimate from the lookup table.
function sumResidentRss(currentResidentSet) {
  if (!Array.isArray(currentResidentSet)) return 0;
  let total = 0;
  for (let i = 0; i < currentResidentSet.length; i++) {
    total += estimateRss(currentResidentSet[i]);
  }
  return total;
}

function modelLabel(model) {
  if (model == null) return '<unknown>';
  if (typeof model === 'string') return model;
  return model.model_id || '<unknown>';
}

// Decide whether `requestedModel` can co-reside with `currentResidentSet`
// inside `ramBudgetGb`, or whether the resident set must be evicted (swap).
//
//   currentResidentSet : Array<{ model_id?, kind?, rss_gb? }> | Array<string>
//   requestedModel     : { model_id?, kind?, rss_gb? } | string
//   ramBudgetGb        : number
//
// Returns { action: 'co-reside' | 'swap', reason: string, total_gb: number }.
export function decideResidency(currentResidentSet, requestedModel, ramBudgetGb) {
  const budget = Number(ramBudgetGb);
  if (!Number.isFinite(budget) || budget < 0) {
    return {
      action: 'swap',
      reason: 'invalid RAM budget (' + ramBudgetGb + '); refusing to co-reside',
      total_gb: NaN
    };
  }

  const currentRss = sumResidentRss(currentResidentSet);
  const requestedRss = estimateRss(requestedModel);
  const total = currentRss + requestedRss;

  if (total <= budget) {
    return {
      action: 'co-reside',
      reason:
        'resident set ' + currentRss + 'GB + ' + modelLabel(requestedModel) + ' ' +
        requestedRss + 'GB = ' + total + 'GB ≤ budget ' + budget + 'GB; co-reside',
      total_gb: total
    };
  }

  return {
    action: 'swap',
    reason:
      'resident set ' + currentRss + 'GB + ' + modelLabel(requestedModel) + ' ' +
      requestedRss + 'GB = ' + total + 'GB > budget ' + budget + 'GB; evict resident set and load',
    total_gb: total
  };
}
