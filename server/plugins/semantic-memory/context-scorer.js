// Context key relevance scorer for smart boot
// Scores context keys against current work context using keyword overlap,
// access frequency, recency, and optionally vector similarity.

import { cosineSimilarity } from './embeddings.js';

// Keys matching these patterns are always included regardless of score
var CRITICAL_PATTERNS = ['conventions', 'enforcement_rules', 'role_'];

function isCriticalKey(namespace, key) {
  var combined = namespace + ':' + key;
  for (var pattern of CRITICAL_PATTERNS) {
    if (combined.indexOf(pattern) !== -1) return true;
  }
  return false;
}

// Build a query string from work context for keyword matching
function buildWorkContextQuery(workContext) {
  var parts = [];
  if (workContext.tasks) {
    for (var t of workContext.tasks) {
      if (t.title) parts.push(t.title);
      if (t.description) parts.push(t.description);
    }
  }
  if (workContext.plan_steps) {
    for (var s of workContext.plan_steps) {
      if (s.title) parts.push(s.title);
      if (s.description) parts.push(s.description);
    }
  }
  if (workContext.messages) {
    for (var m of workContext.messages) {
      if (m.content) parts.push(m.content);
    }
  }
  if (workContext.project_id) parts.push(workContext.project_id);
  return parts.join(' ').toLowerCase();
}

// Tokenize text into word set for overlap scoring
function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length > 2; })
  );
}

// Compute keyword overlap score (Jaccard-like)
function keywordOverlap(keyTokens, queryTokens) {
  if (queryTokens.size === 0 || keyTokens.size === 0) return 0;
  var intersection = 0;
  for (var token of keyTokens) {
    if (queryTokens.has(token)) intersection++;
  }
  // Normalize by query size (what fraction of the query is covered)
  return intersection / queryTokens.size;
}

/**
 * Score context keys against work context.
 * @param {Array} contextKeys - Array of context key rows (with data, access_count, last_accessed_at, updated_at)
 * @param {Object} workContext - { tasks, plan_steps, messages, project_id }
 * @param {Object} [opts] - { queryEmbedding, keyEmbeddings }
 * @returns {Array} Sorted array of { key, namespace, score, reasons }
 */
export function scoreContextKeys(contextKeys, workContext, opts) {
  opts = opts || {};
  var queryText = buildWorkContextQuery(workContext);
  var queryTokens = tokenize(queryText);

  var hasVectors = opts.queryEmbedding && opts.keyEmbeddings;

  // Find max access count for normalization
  var maxAccess = 1;
  for (var ck of contextKeys) {
    if ((ck.access_count || 0) > maxAccess) maxAccess = ck.access_count;
  }

  var now = Date.now();
  var scored = [];

  for (var key of contextKeys) {
    var critical = isCriticalKey(key.namespace, key.key);

    // 1. Keyword overlap (0.3 weight, or 0 if vectors available)
    var keyText = (key.namespace || '') + ' ' + (key.key || '') + ' ' + (key.data || '');
    var keyTokens = tokenize(keyText);
    var kwScore = keywordOverlap(keyTokens, queryTokens);

    // 2. Access frequency (0.2 weight)
    var accessScore = (key.access_count || 0) / maxAccess;

    // 3. Recency (0.15 weight) — decay over 90 days
    var refDate = key.updated_at || key.last_accessed_at;
    var recencyScore = 0;
    if (refDate) {
      var daysSince = (now - new Date(refDate + (refDate.endsWith('Z') ? '' : 'Z')).getTime()) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0, 1 - daysSince / 90);
    }

    // 4. Vector similarity (0.35 weight if available)
    var vectorScore = 0;
    if (hasVectors) {
      var keyId = key.namespace + ':' + key.key;
      var keyEmb = opts.keyEmbeddings[keyId];
      if (keyEmb) {
        vectorScore = Math.max(0, cosineSimilarity(opts.queryEmbedding, keyEmb));
      }
    }

    // Weighted combination
    var score;
    var reasons = [];
    if (hasVectors) {
      // With vectors: keyword weight redistributed to vector
      score = vectorScore * 0.35 + kwScore * 0.3 + accessScore * 0.2 + recencyScore * 0.15;
      if (vectorScore > 0.1) reasons.push('vector:' + vectorScore.toFixed(2));
    } else {
      // Without vectors: keyword gets full weight
      score = kwScore * 0.45 + accessScore * 0.35 + recencyScore * 0.2;
    }
    if (kwScore > 0.05) reasons.push('keyword:' + kwScore.toFixed(2));
    if (accessScore > 0.1) reasons.push('access:' + accessScore.toFixed(2));
    if (recencyScore > 0.5) reasons.push('recent');

    if (critical) {
      reasons.push('critical');
      score = Math.max(score, 1.0); // critical keys always rank at top
    }

    scored.push({
      namespace: key.namespace,
      key: key.key,
      data: key.data,
      score: score,
      critical: critical,
      reasons: reasons,
      access_count: key.access_count || 0,
      updated_at: key.updated_at
    });
  }

  scored.sort(function (a, b) { return b.score - a.score; });
  return scored;
}
