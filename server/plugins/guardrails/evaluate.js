// Safe expression evaluator for custom guardrail rules.
// Replaces new Function() to prevent arbitrary code injection.
// Supports: field lookups, comparisons, logical operators.

// Safely resolve a dotted path like "data.priority" on an object
function resolvePath(obj, path) {
  if (!path || typeof path !== 'string') return undefined;
  var parts = path.split('.');
  var current = obj;
  for (var i = 0; i < parts.length; i++) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[parts[i]];
  }
  return current;
}

// Evaluate a single comparison: { field, op, value }
// field is resolved against a flat context { data.*, agent, type, project_id }
function evaluateComparison(comp, context) {
  var actual = resolvePath(context, comp.field);
  var expected = comp.value;
  switch (comp.op || 'eq') {
    case 'eq': return actual == expected;
    case 'neq': return actual != expected;
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'contains': return typeof actual === 'string' && actual.indexOf(String(expected)) !== -1;
    case 'not_contains': return typeof actual !== 'string' || actual.indexOf(String(expected)) === -1;
    case 'exists': return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    case 'in': return Array.isArray(expected) && expected.indexOf(actual) !== -1;
    case 'not_in': return !Array.isArray(expected) || expected.indexOf(actual) === -1;
    case 'matches': try { return new RegExp(String(expected)).test(String(actual)); } catch (e) { return false; }
    default: return false;
  }
}

// Build a flat context object for field lookups
function buildContext(data, eventData) {
  var ctx = {};
  // Top-level event fields
  ctx.agent = eventData.agent || '';
  ctx.type = eventData.type || eventData.event_type || '';
  ctx.project_id = eventData.project_id || '';
  // All data fields, both flat and prefixed
  if (data && typeof data === 'object') {
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      ctx[keys[i]] = data[keys[i]];
      ctx['data.' + keys[i]] = data[keys[i]];
    }
  }
  ctx.data = data;
  ctx.event = eventData;
  return ctx;
}

// Evaluate a custom rule expression safely.
// conditions.checks: array of { field, op, value } comparisons
// conditions.logic: 'and' (default) or 'or'
// Returns true if the rule is violated (expression matched).
export function evaluateSafeExpression(conditions, data, eventData) {
  var checks = conditions.checks || conditions.comparisons || [];
  if (!Array.isArray(checks) || checks.length === 0) return false;

  var context = buildContext(data, eventData);
  var logic = conditions.logic || 'and';

  if (logic === 'or') {
    for (var i = 0; i < checks.length; i++) {
      if (evaluateComparison(checks[i], context)) return true;
    }
    return false;
  }

  // Default: 'and'
  for (var i = 0; i < checks.length; i++) {
    if (!evaluateComparison(checks[i], context)) return false;
  }
  return true;
}

export function evaluateCondition(conditions, eventData) {
  var data = eventData.data || {};
  switch (conditions.type) {
    case 'require_field':
      if (!data[conditions.field]) return { violated: true, detail: conditions.message || 'Missing required field: ' + conditions.field };
      return { violated: false };
    case 'max_value':
      var val = parseInt(data[conditions.field]) || 0;
      if (val > (conditions.max || 0)) return { violated: true, detail: conditions.message || conditions.field + ' exceeds max (' + val + ' > ' + conditions.max + ')' };
      return { violated: false };
    case 'require_approval':
      if (!data.approval_id) return { violated: true, detail: conditions.message || 'Approval required for ' + conditions.action_type };
      return { violated: false };
    case 'block_agent':
      if ((eventData.agent || '') === conditions.agent_id) return { violated: true, detail: conditions.message || 'Agent ' + conditions.agent_id + ' is restricted' };
      return { violated: false };
    case 'custom':
      try {
        var result = evaluateSafeExpression(conditions, data, eventData);
        if (result) return { violated: true, detail: conditions.message || 'Custom rule violated' };
        return { violated: false };
      } catch (e) {
        return { violated: false };
      }
    default:
      return { violated: false };
  }
}
