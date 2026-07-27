// =============== MYCELIUM — DB entity: plans, steps, step comments ===============
// Extracted from server/db.js (Wave 4 of the decomposition). Coupling:
// `createPlanStep` / `updatePlanStep` import `resolveAssignee` (agents).
// `completeLinkedPlanSteps` spans plan_steps + plans (status flip gated on
// status='active') but is single-module. `autoRetryOrEscalatePlanStep` runs its
// own db.transaction and re-calls `addPlanStepComment` (same module). The
// route-level done-cascade (routes/tasks.js) spans tasks + plans +
// agent-profiles + messages via getDB().transaction — unaffected by this split.
// The functions below use the live `db` + `buildUpdate` bindings from ./core.js.
// Bodies moved VERBATIM — bare db.prepare(...) / buildUpdate(...) keep working
// via the ESM live bindings (initDBConnection assigns db; nobody else may). The
// barrel server/db.js re-exports these via `export * from './db/plans.js'` so
// no consumer changes a single import.
import { db, buildUpdate } from './core.js';
import { resolveAssignee } from './agents.js';

// -- Plan Step Comments --

export function addPlanStepComment(stepId, planId, author, content) {
  var result = db.prepare(
    "INSERT INTO plan_step_comments (step_id, plan_id, author, content) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(stepId, planId, author, content);
  return result;
}

export function getPlanStepComments(stepId) {
  return db.prepare(
    "SELECT * FROM plan_step_comments WHERE step_id = ? ORDER BY created_at ASC"
  ).all(stepId);
}
// -- Plans --

export function createPlan(title, description, projectId, owner, priority, tags, createdBy) {
  var result = db.prepare(
    "INSERT INTO plans (title, description, project_id, owner, priority, tags, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(title, description || '', projectId || '', owner || '', priority || 'normal', tags || '[]', createdBy || '');
  return result.id;
}

export function getPlan(id) {
  var plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
  if (!plan) return null;
  var steps = db.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_order, id").all(id);
  // Batch-fetch all comments for this plan and group by step
  var allComments = db.prepare("SELECT * FROM plan_step_comments WHERE plan_id = ? ORDER BY created_at ASC").all(id);
  var commentsByStep = {};
  for (var c of allComments) {
    if (!commentsByStep[c.step_id]) commentsByStep[c.step_id] = [];
    commentsByStep[c.step_id].push(c);
  }
  for (var s of steps) {
    s.comments = commentsByStep[s.id] || [];
  }
  var total = steps.length;
  var completed = steps.filter(function (s) { return s.status === 'completed'; }).length;
  plan.steps = steps;
  plan.progress = { total: total, completed: completed, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
  return plan;
}

export function listPlans(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.owner) { where.push('owner = ?'); params.push(filters.owner); }
  if (filters.exclude_status) { where.push('status != ?'); params.push(filters.exclude_status); }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  var plans = db.prepare('SELECT * FROM plans WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
  if (plans.length > 0) {
    var planIds = plans.map(function (p) { return p.id; });
    var placeholders = planIds.map(function () { return '?'; }).join(',');
    var allSteps = db.prepare("SELECT plan_id, id, status, title, assignee, step_order FROM plan_steps WHERE plan_id IN (" + placeholders + ") ORDER BY step_order ASC").all(...planIds);
    var stepsByPlan = {};
    for (var s of allSteps) {
      if (!stepsByPlan[s.plan_id]) stepsByPlan[s.plan_id] = [];
      stepsByPlan[s.plan_id].push(s);
    }
    for (var p of plans) {
      var steps = stepsByPlan[p.id] || [];
      p.steps = steps;
      var total = steps.length;
      var completed = steps.filter(function (st) { return st.status === 'completed'; }).length;
      p.step_count = total;
      p.progress = { total: total, completed: completed, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
      var current = steps.find(function (st) { return st.status === 'in_progress'; }) ||
                    steps.find(function (st) { return st.status === 'pending'; });
      p.current_step = current ? current.title : null;
    }
  }
  return plans;
}

export function updatePlan(id, fields) {
  var f = Object.assign({}, fields);
  if (f.tags !== undefined && typeof f.tags !== 'string') f.tags = JSON.stringify(f.tags);
  buildUpdate('plans', id, f, ['title', 'description', 'status', 'owner', 'priority', 'tags', 'project_id'], { updatedAt: true });
}

export function deletePlan(id) {
  db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
  db.prepare("DELETE FROM plans WHERE id = ?").run(id);
}

export function createPlanStep(planId, title, description, assignee, phase) {
  assignee = resolveAssignee(assignee);
  var maxOrder = db.prepare("SELECT MAX(step_order) as m FROM plan_steps WHERE plan_id = ?").get(planId);
  var order = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 0;
  var result = db.prepare(
    "INSERT INTO plan_steps (plan_id, step_order, title, description, assignee, phase) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(planId, order, title, description || '', assignee || null, phase || '');
  db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  return result.id;
}

export function updatePlanStep(stepId, fields) {
  if (fields.assignee !== undefined && fields.assignee !== null) fields.assignee = resolveAssignee(fields.assignee);
  var extra = fields.status === 'completed' ? ["completed_at = datetime('now')"] : [];
  buildUpdate('plan_steps', stepId, fields, ['title', 'description', 'status', 'assignee', 'linked_task_id', 'linked_branch', 'linked_pr_url', 'phase', 'step_order'], { updatedAt: true, extraSets: extra });
  // Update parent plan's updated_at
  var step = db.prepare("SELECT plan_id FROM plan_steps WHERE id = ?").get(stepId);
  if (step) db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

// Bounded self-heal for a FAILED plan step. If the step still has retry budget,
// reopen it + the phase it guards (the immediately-prior step_order) to 'pending'
// and attach the failure `critique` to those reopened steps, so the work re-cycles
// with the verifier's reasons fed forward. Returns {action:'retried'|'exhausted'|'none'}.
// Runtime-agnostic: it only moves platform rows; the reopened steps flow through the
// normal work queue to whatever agent/runner is assigned. The caller decides what to
// do on 'exhausted' (block + escalate). maxAttempts is the caller's policy knob.
export function autoRetryOrEscalatePlanStep(planId, stepId, maxAttempts, critique) {
  var failed = db.prepare("SELECT id, step_order, attempt_count FROM plan_steps WHERE id = ? AND plan_id = ?").get(stepId, planId);
  if (!failed) return { action: 'none' };
  var attempts = failed.attempt_count || 0;
  if (attempts >= maxAttempts) return { action: 'exhausted', attempts: attempts };
  var nextAttempt = attempts + 1;
  var steps = db.prepare("SELECT id, step_order, status FROM plan_steps WHERE plan_id = ?").all(planId);
  // The phase this step guards = the greatest step_order below it (re-run the impl
  // a verify step checks). Reopen those completed steps + the failed step itself.
  var priorOrders = steps.map(function (s) { return s.step_order; }).filter(function (o) { return o < failed.step_order; });
  var priorOrder = priorOrders.length ? Math.max.apply(null, priorOrders) : null;
  var toReopen = steps.filter(function (s) {
    return s.id === stepId || (priorOrder !== null && s.step_order === priorOrder && s.status === 'completed');
  });
  var tx = db.transaction(function () {
    for (var s of toReopen) {
      db.prepare("UPDATE plan_steps SET status = 'pending', completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(s.id);
      if (critique && s.id !== stepId) {
        addPlanStepComment(s.id, planId, '__system__',
          '[auto-retry ' + nextAttempt + '/' + maxAttempts + '] Prior verification FAILED — fix before re-submitting:\n' + critique);
      }
    }
    db.prepare("UPDATE plan_steps SET attempt_count = ?, updated_at = datetime('now') WHERE id = ?").run(nextAttempt, stepId);
    db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  });
  tx();
  return { action: 'retried', attempt: nextAttempt, max: maxAttempts, reopened: toReopen.length };
}

export function deletePlanStep(stepId) {
  var step = db.prepare("SELECT plan_id FROM plan_steps WHERE id = ?").get(stepId);
  db.prepare("DELETE FROM plan_steps WHERE id = ?").run(stepId);
  if (step) db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(step.plan_id);
}

export function reorderPlanSteps(planId, stepIds) {
  var reorder = db.transaction(function () {
    for (var i = 0; i < stepIds.length; i++) {
      db.prepare("UPDATE plan_steps SET step_order = ? WHERE id = ? AND plan_id = ?").run(i, stepIds[i], planId);
    }
    db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
  });
  reorder();
}

export function completeLinkedPlanSteps(taskId) {
  var steps = db.prepare("SELECT id, plan_id FROM plan_steps WHERE linked_task_id = ? AND status != 'completed'").all(taskId);
  var affectedPlanIds = [];
  for (var step of steps) {
    db.prepare("UPDATE plan_steps SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(step.id);
    if (affectedPlanIds.indexOf(step.plan_id) === -1) affectedPlanIds.push(step.plan_id);
  }
  // Check if any affected plans are now fully complete
  var completedPlans = [];
  for (var planId of affectedPlanIds) {
    var remaining = db.prepare("SELECT COUNT(*) as c FROM plan_steps WHERE plan_id = ? AND status NOT IN ('completed', 'skipped')").get(planId);
    if (remaining.c === 0) {
      db.prepare("UPDATE plans SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'active'").run(planId);
      completedPlans.push(planId);
    } else {
      db.prepare("UPDATE plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
    }
  }
  return { steps_completed: steps.length, plans_completed: completedPlans };
}
