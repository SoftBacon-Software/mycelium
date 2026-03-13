// Confidence decay for auto-memory facts
// Model: each cycle applies confidence *= max(0.1, 1.0 - days_since_last_access * rate)
// This compounds across cycles — effectively exponential decay.
// Accessing a fact resets the reference point (last_accessed_at), keeping active facts high.

var DECAY_RATES = {
  convention: 0.002,   // ~450 days to floor
  architecture: 0.002,
  decision: 0.005,     // ~180 days to floor
  pattern: 0.005,
  preference: 0.005,
  insight: 0.01,       // ~90 days to floor
  general: 0.01
};

var FLOOR = 0.1;

export function getDecayRate(category) {
  return DECAY_RATES[category] || DECAY_RATES.general;
}

export function computeDecayedConfidence(baseConfidence, category, daysSinceAccess) {
  var rate = getDecayRate(category);
  var factor = Math.max(FLOOR, 1.0 - daysSinceAccess * rate);
  return baseConfidence * factor;
}

export function applyDecay(db) {
  var facts = db.getDecayableFacts();
  var now = Date.now();
  var updated = 0;

  for (var fact of facts) {
    // Use last_accessed_at if available, else fall back to updated_at
    var refDate = fact.last_accessed_at || fact.updated_at;
    if (!refDate) continue;

    var daysSince = (now - new Date(refDate + (refDate.endsWith('Z') ? '' : 'Z')).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 1) continue; // skip recently accessed

    var decayed = computeDecayedConfidence(fact.confidence, fact.category, daysSince);

    // Only update if confidence actually changed meaningfully (avoid unnecessary writes)
    if (Math.abs(decayed - fact.confidence) > 0.001) {
      db.updateFactConfidence(fact.id, Math.round(decayed * 1000) / 1000);
      updated++;
    }
  }

  return updated;
}
