// =============== MYCELIUM — security context keys + the enforcement-rules cache ===============
// Trust layer P0 (F-253, 2026-09-28; found by review B of PR #191).
//
// `mycelium/enforcement_rules` is the one context key whose value is an
// authorization gate: checkEnforcementRules (routes/mycelium.js) turns it
// into 403s on POST /messages and PR merges. A key that gates security has
// three properties, all enforced here so the context routes
// (routes/context.js) and the gate share one definition:
//
//   1. it is not writable by the principals it gates (admin key only);
//   2. it cannot hold a shape its reader silently reads as "no rules"
//      (validated on write — the old Object.assign merge turned a bare-array
//      PUT into {"0":…,"1":…}, which `data.rules || []` reads as zero rules);
//   3. a write takes effect at once (the cache invalidates on write — the
//      60s TTL bounds re-reads only, never read-your-writes);
//   4. the cap cannot remove it behind the cache's back: the per-namespace
//      key cap (db/context.js enforceNamespaceCap) never counts nor evicts a
//      census key — the cap is driven by ORDINARY writes to the namespace,
//      so without this a non-admin flood deletes the key without any write
//      to it, and a delete that bypasses the routes cannot invalidate the
//      cache (the gate reads intact until the TTL lapses, then reads zero
//      rules). Review B of PR #193. The census NAMESPACE is additionally
//      admin-owned for NEW keys on the context routes (isSecurityContextNamespace).
//   5. it is durable BY CONSTRUCTION: the write paths refuse ttl/expires_at
//      (400 / per-entry) and force category 'durable'; both expiry sweeps
//      (purgeExpiredContextKeys, getContextKey's lazy-expiry DELETE) skip
//      census keys; boot sanitizes any legacy row (sanitizeSecurityContextKeys).
//      An expires_at on the census row would re-open #4's failure mode by
//      clock instead of by write — the gate reads intact until the TTL lapses,
//      then reads zero rules, no event, no admin present. Review A round 2 of
//      PR #193.
//
// A future key that starts gating a security check joins SECURITY_CONTEXT_KEYS
// and inherits all five.

export const ENFORCEMENT_RULES_NS = 'mycelium';
export const ENFORCEMENT_RULES_KEY = 'enforcement_rules';

// The census: context keys whose values a security check READS. Writes require
// the admin key; reads stay open (rules are not secrets — knowing them is the
// point). Everything else read server-side is informational, not
// authorization: standups are diary entries, and the admin/api_limits +
// admin/api_usage keys are response caches behind already-admin-only routes.
// roles/<agentId> and <project>/guidelines are not authorization either — but
// they DO feed the boot role contract (db.js buildRoleContract), which makes
// them model-facing seeds, so their namespace is admin-owned for NEW keys
// (SECURITY_CONTEXT_NAMESPACES below; trust layer P1.2, review A round 2 of
// PR #199 — a cross-project agent could create roles/<victim> freely because
// the F1 project-scope check runs only on existing keys).
export const SECURITY_CONTEXT_KEYS = [
  {
    namespace: ENFORCEMENT_RULES_NS,
    key: ENFORCEMENT_RULES_KEY,
    gate: 'checkEnforcementRules (POST /messages send_message; POST /github/prs/:owner/:repo/:number/merge merge_pr)',
  },
];

// Namespaces admin-owned for NEW keys on the context routes, beyond the
// namespaces that imply it by holding a census key. roles/ is here because it
// is the boot role contract's source: a non-admin-creatable roles/<agentId> is
// a peer-writable boot seed (P1.2's standard is model-facing seeds, not
// authorization inputs). Existing roles/ keys keep the context routes'
// project-scope rules — they are NOT security keys (isSecurityContextKey stays
// false for them), and the render side fences the contract so a write that
// does land is quoted data, never authority.
export const SECURITY_CONTEXT_NAMESPACES = ['roles'];

export function isSecurityContextKey(namespace, key) {
  if (!namespace || !key) return false;
  return SECURITY_CONTEXT_KEYS.some(function (k) {
    return k.namespace === namespace && k.key === key;
  });
}

// A census NAMESPACE (any namespace holding a census key, or named in
// SECURITY_CONTEXT_NAMESPACES) is admin-owned for NEW keys on the context
// routes (review B of PR #193; roles/ added by P1.2 review A round 2). Why the
// namespace and not just the key: the namespace is injected wholesale into
// every agent's boot context (db.js platform keys + workContext) or lifted
// into the role contract (db.js buildRoleContract), so a non-admin-creatable
// key there is a swarm-wide boot-injection vector — and it is the exact write
// pressure that drives the per-namespace cap. Existing keys keep the context
// routes' project-scope rules; admin (key or admin-role JWT) keeps the
// namespace.
export function isSecurityContextNamespace(namespace) {
  if (!namespace) return false;
  if (SECURITY_CONTEXT_KEYS.some(function (k) {
    return k.namespace === namespace;
  })) return true;
  return SECURITY_CONTEXT_NAMESPACES.indexOf(namespace) !== -1;
}

// ---- shape validation ----
// The READER tolerates loose shapes: an unknown severity reads as warn, a bad
// regex silently skips the rule, a bare array still iterates. Every one of
// those tolerances is a way for a malformed write to silently weaken or empty
// the gate — so the WRITE side accepts only the canonical shape.
// Returns { ok: true, value } with value the canonical JSON string to store,
// or { ok: false, error }.

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function ruleError(index, why) {
  return { ok: false, error: 'invalid enforcement rules: rule[' + index + '] ' + why };
}

function validateRule(rule, index) {
  if (!isPlainObject(rule)) {
    return { ok: false, error: 'invalid enforcement rules: rule[' + index + '] must be an object' };
  }
  if (typeof rule.id !== 'string' || !rule.id.trim()) {
    return ruleError(index, 'needs a non-empty string id (403s and violation events cite it)');
  }
  if (typeof rule.tool !== 'string' || !rule.tool.trim()) {
    return ruleError(index, 'needs a non-empty string tool ("*" or a tool name)');
  }
  if (rule.severity !== undefined && rule.severity !== 'warn' && rule.severity !== 'block') {
    return ruleError(index, 'severity must be "warn" or "block" (anything else would silently read as warn)');
  }
  if (rule.message !== undefined && typeof rule.message !== 'string') {
    return ruleError(index, 'message must be a string');
  }
  if (rule.match !== undefined) {
    if (!isPlainObject(rule.match)) return ruleError(index, 'match must be an object');
    if (rule.match.content_pattern !== undefined) {
      if (typeof rule.match.content_pattern !== 'string') {
        return ruleError(index, 'match.content_pattern must be a string');
      }
      try { new RegExp(rule.match.content_pattern, 'i'); } catch (e) {
        return ruleError(index, 'match.content_pattern does not compile as a regex (the reader would silently skip the rule)');
      }
    }
  }
  if (rule.enforce !== undefined) {
    if (!isPlainObject(rule.enforce)) return ruleError(index, 'enforce must be an object');
    if (rule.enforce.expected_tool !== undefined &&
        (typeof rule.enforce.expected_tool !== 'string' || !rule.enforce.expected_tool.trim())) {
      return ruleError(index, 'enforce.expected_tool must be a non-empty string');
    }
    if (rule.enforce.expected_args !== undefined && !isPlainObject(rule.enforce.expected_args)) {
      return ruleError(index, 'enforce.expected_args must be an object');
    }
    if (rule.enforce.required_role !== undefined &&
        (typeof rule.enforce.required_role !== 'string' || !rule.enforce.required_role.trim())) {
      return ruleError(index, 'enforce.required_role must be a non-empty string');
    }
  }
  return { ok: true };
}

export function validateEnforcementRulesData(data) {
  var parsed = data;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) {
      return { ok: false, error: 'invalid enforcement rules: data is not valid JSON' };
    }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'invalid enforcement rules: data must be an object with a rules array (a bare array would merge-corrupt into no rules)' };
  }
  if (!Array.isArray(parsed.rules)) {
    return { ok: false, error: 'invalid enforcement rules: rules must be an array' };
  }
  for (var i = 0; i < parsed.rules.length; i++) {
    var check = validateRule(parsed.rules[i], i);
    if (!check.ok) return check;
  }
  return { ok: true, value: JSON.stringify(parsed) };
}

// ---- cache (60s TTL; writes invalidate via invalidateEnforcementRulesCache) ----
var _cache = null;
var _cacheTime = 0;

export var ENFORCEMENT_CACHE_TTL = 60000; // 60s — bounds DB re-reads, never read-your-writes

export function getCachedEnforcementRules(load) {
  var now = Date.now();
  if (_cache && (now - _cacheTime) < ENFORCEMENT_CACHE_TTL) return _cache;
  _cache = load();
  _cacheTime = now;
  return _cache;
}

export function invalidateEnforcementRulesCache() {
  _cache = null;
  _cacheTime = 0;
}
