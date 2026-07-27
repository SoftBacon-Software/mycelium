// Plan routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listPlans, createPlan, getPlan, updatePlan, deletePlan,
  createPlanStep, updatePlanStep, deletePlanStep,
  addPlanStepComment, getPlanStepComments, reorderPlanSteps,
  autoRetryOrEscalatePlanStep, getSleepMode, appendSleepLog,
  createInboxItemForAllOperators, dispatchWebhook,
} from '../db.js';

export function registerPlanRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkGuardrails, escapeHtml,
    parseLimit, parseIntParam, validateStringLength, validateEnum,
    checkApprovalGate, checkProjectScope, warnSuspectTransition,
    emitEvent, MAX_TITLE, MAX_DESCRIPTION, PLAN_STATUSES, PLAN_STEP_STATUSES,
  } = deps;

  // ======== PLANS ========

  router.get('/plans', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      project_id: req.query.project_id,
      status: req.query.status,
      owner: req.query.owner,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    res.json(listPlans(filters));
  }));

  router.post('/plans', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'plan_created', { agent: agentId, project_id: req.body.project_id, title: req.body.title })) return;
    var gate = checkApprovalGate(req, agentId, 'plan_create');
    var title = escapeHtml(req.body.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!validateStringLength(res, req.body.title, MAX_TITLE, 'title')) return;
    if (!validateStringLength(res, req.body.description, MAX_DESCRIPTION, 'description')) return;
    var description = escapeHtml(req.body.description || '');
    var projectId = req.body.project_id || '';
    var owner = escapeHtml(req.body.owner || '');
    var priority = req.body.priority || 'normal';
    var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
    var id = createPlan(title, description, projectId, owner, priority, tags, agentId);
    // Process inline steps array if provided (Bug #90)
    var stepIds = [];
    if (Array.isArray(req.body.steps)) {
      for (var i = 0; i < req.body.steps.length; i++) {
        var s = req.body.steps[i];
        var sTitle = escapeHtml(s.title || '');
        if (!sTitle) continue;
        var sDesc = escapeHtml(s.description || '');
        var sAssignee = escapeHtml(s.assignee || '');
        var sPhase = s.phase || null;
        var stepId = createPlanStep(id, sTitle, sDesc, sAssignee, sPhase);
        stepIds.push(stepId);
      }
    }
    emitEvent('plan_created', agentId, projectId, agentId + ' created plan: ' + title, { plan_id: id });
    dispatchWebhook('plan_created', agentId, { plan_id: id, title: title, project_id: projectId, owner: owner });
    var result = { id: id, title: title };
    if (stepIds.length) result.steps_created = stepIds.length;
    if (gate.warning) result.approval_warning = gate.warning;
    res.json(result);
  }));

  router.get('/plans/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    res.json(plan);
  }));

  router.put('/plans/:id', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    if (!validateEnum(res, req.body.status, PLAN_STATUSES, 'status')) return;
    warnSuspectTransition('plan', plan.status, req.body.status);
    var fields = {};
    if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
    if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
    if (req.body.status !== undefined) fields.status = req.body.status;
    if (req.body.owner !== undefined) fields.owner = escapeHtml(req.body.owner);
    if (req.body.priority !== undefined) fields.priority = req.body.priority;
    if (req.body.tags !== undefined) fields.tags = req.body.tags;
    if (req.body.project_id !== undefined) fields.project_id = req.body.project_id;
    updatePlan(plan.id, fields);
    if (fields.status) {
      emitEvent('plan_' + fields.status, agentId, plan.project_id, agentId + ' set plan #' + plan.id + ' to ' + fields.status, { plan_id: plan.id });
    }
    res.json({ ok: true, id: plan.id });
  }));

  router.delete('/plans/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var gate = checkApprovalGate(req, who, 'delete');
    if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    deletePlan(plan.id);
    emitEvent('plan_deleted', who, plan.project_id, who + ' deleted plan #' + plan.id + ': ' + plan.title, { plan_id: plan.id });
    var result = { ok: true, deleted: plan.id };
    if (gate.warning) result.approval_warning = gate.warning;
    res.json(result);
  }));

  // -- Plan Steps --

  router.post('/plans/:id/steps', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    var title = escapeHtml(req.body.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    var description = escapeHtml(req.body.description || '');
    var assignee = req.body.assignee || null;
    var phase = escapeHtml(req.body.phase || '');
    var stepId = createPlanStep(plan.id, title, description, assignee, phase);
    // Optionally link task/branch/PR at creation
    var updates = {};
    if (req.body.linked_task_id !== undefined) updates.linked_task_id = req.body.linked_task_id;
    if (req.body.linked_branch !== undefined) updates.linked_branch = req.body.linked_branch;
    if (req.body.linked_pr_url !== undefined) updates.linked_pr_url = req.body.linked_pr_url;
    if (Object.keys(updates).length > 0) updatePlanStep(stepId, updates);
    emitEvent('plan_step_added', agentId, plan.project_id, agentId + ' added step to plan #' + plan.id + ': ' + title, { plan_id: plan.id, step_id: stepId });
    // Route operator_input steps to all operators' inboxes
    if (assignee === 'operator_input') {
      createInboxItemForAllOperators('approval', 'plan_step', stepId, 'Operator input needed: ' + title, 'Plan #' + plan.id + ' — ' + (plan.title || '') + '. Step requires your review/approval.', { plan_id: plan.id, step_id: stepId, step_title: title }, 'high');
    }
    res.json({ id: stepId, plan_id: plan.id });
  }));

  router.put('/plans/:id/steps/:stepId', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    var stepId0 = parseIntParam(req.params.stepId);
    var planStep = plan.steps ? plan.steps.find(function (s) { return s.id === stepId0; }) : null;
    if (!planStep) return res.status(404).json({ error: 'Plan step not found' });
    if (!checkProjectScope(req, res, plan.project_id, planStep ? planStep.assignee : null)) return;
    if (!validateEnum(res, req.body.status, PLAN_STEP_STATUSES, 'status')) return;
    var fields = {};
    if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
    if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
    if (req.body.status !== undefined) fields.status = req.body.status;
    if (req.body.assignee !== undefined) fields.assignee = req.body.assignee;
    if (req.body.linked_task_id !== undefined) fields.linked_task_id = req.body.linked_task_id;
    if (req.body.linked_branch !== undefined) fields.linked_branch = req.body.linked_branch;
    if (req.body.linked_pr_url !== undefined) fields.linked_pr_url = req.body.linked_pr_url;
    if (req.body.phase !== undefined) fields.phase = escapeHtml(req.body.phase);
    var stepPlanId = parseIntParam(req.params.id);
    var stepStepId = parseIntParam(req.params.stepId);
    updatePlanStep(stepStepId, fields);
    if (fields.status === 'completed' && getSleepMode().active) {
      appendSleepLog('steps_completed', { id: stepStepId, plan_id: stepPlanId, agent: agentId, time: new Date().toISOString() });
    }
    emitEvent('plan_step_updated', agentId, plan ? plan.project_id : null, agentId + ' updated step #' + stepStepId + ' on plan #' + stepPlanId, { plan_id: stepPlanId, step_id: stepStepId, fields: fields });
    dispatchWebhook('plan_step_updated', agentId, { plan_id: stepPlanId, step_id: stepStepId, fields: fields });
    // A FAILED step triggers the platform's bounded SELF-HEAL: reopen the step + the
    // phase it guards (with the failure critique) for another attempt; after RETRY_MAX
    // attempts, finalize as terminal-failed → block the plan → escalate to operators.
    // Runtime-agnostic: reopened steps flow through the normal work queue to whoever's
    // assigned — no orchestrator/runtime/agent assumptions live here. (Worker may pass
    // an optional `critique` in the PUT body; the failed step's own comment otherwise.)
    if (fields.status === 'failed') {
      var RETRY_MAX = 2; // resilient default; first knob to lift to per-scope config
      var critique = req.body.critique || null;
      var rr = autoRetryOrEscalatePlanStep(stepPlanId, stepStepId, RETRY_MAX, critique);
      if (rr.action === 'retried') {
        emitEvent('plan_step_retry', agentId, plan ? plan.project_id : null,
          agentId + ' — step #' + stepStepId + ' failed; auto-retry ' + rr.attempt + '/' + rr.max +
          ' (reopened ' + rr.reopened + ' step(s) with the critique)',
          { plan_id: stepPlanId, step_id: stepStepId, attempt: rr.attempt });
      } else {
        emitEvent('plan_step_failed', agentId, plan ? plan.project_id : null,
          agentId + ' FAILED step #' + stepStepId + ' on plan #' + stepPlanId +
          (planStep ? (': ' + planStep.title) : '') + ' (auto-retries exhausted)',
          { plan_id: stepPlanId, step_id: stepStepId });
        updatePlan(stepPlanId, { status: 'blocked' });
        createInboxItemForAllOperators('approval', 'plan_step', stepStepId,
          'Plan step failed after retries: ' + (planStep ? planStep.title : ('#' + stepStepId)),
          'Plan #' + stepPlanId + ' — ' + (plan ? (plan.title || '') : '') + '. Step #' + stepStepId +
          ' exhausted ' + RETRY_MAX + ' auto-retries and was blocked for review.',
          { plan_id: stepPlanId, step_id: stepStepId }, 'high');
        emitEvent('plan_blocked', agentId, plan ? plan.project_id : null,
          'Plan #' + stepPlanId + ' blocked — step #' + stepStepId + ' failed after ' + RETRY_MAX + ' auto-retries',
          { plan_id: stepPlanId });
      }
    }
    // Route operator_input assignments to all operators' inboxes
    if (fields.assignee === 'operator_input') {
      var stepTitle = planStep ? planStep.title : ('Step #' + stepStepId);
      createInboxItemForAllOperators('approval', 'plan_step', stepStepId, 'Operator input needed: ' + stepTitle, 'Plan #' + stepPlanId + ' — ' + (plan.title || '') + '. Step requires your review/approval.', { plan_id: stepPlanId, step_id: stepStepId, step_title: stepTitle }, 'high');
    }
    // Auto-complete plan when all steps are done
    if (fields.status === 'completed') {
      var updatedPlan = getPlan(stepPlanId);
      if (updatedPlan && updatedPlan.steps) {
        var allDone = updatedPlan.steps.every(function (s) { return s.status === 'completed' || s.status === 'skipped'; });
        if (allDone && updatedPlan.status !== 'completed') {
          updatePlan(stepPlanId, { status: 'completed' });
          emitEvent('plan_completed', agentId, updatedPlan.project_id, 'Plan #' + stepPlanId + ' auto-completed (all steps done)', { plan_id: stepPlanId });
        }
      }
    }
    res.json({ ok: true, step_id: stepStepId });
  }));

  router.delete('/plans/:id/steps/:stepId', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    var delStepId = parseIntParam(req.params.stepId);
    var delPlanStep = plan.steps ? plan.steps.find(function (s) { return s.id === delStepId; }) : null;
    if (!delPlanStep) return res.status(404).json({ error: 'Plan step not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    deletePlanStep(delStepId);
    res.json({ ok: true, deleted: delStepId });
  }));

  // -- Plan Step Comments --

  router.post('/plans/:id/steps/:stepId/comments', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    var stepId = parseIntParam(req.params.stepId);
    var step = plan.steps ? plan.steps.find(function (s) { return s.id === stepId; }) : null;
    if (!step) return res.status(404).json({ error: 'Step not found' });
    var content = escapeHtml(req.body.content);
    if (!content) return res.status(400).json({ error: 'content is required' });
    var author = escapeHtml((req._authIsAdmin && req.body.author) ? req.body.author : who);
    var comment = addPlanStepComment(stepId, plan.id, author, content);
    emitEvent('plan_step_comment', who, plan.project_id, who + ' commented on step #' + stepId + ' of plan #' + plan.id, { plan_id: plan.id, step_id: stepId, comment_id: comment.id });
    res.json(comment);
  }));

  router.get('/plans/:id/steps/:stepId/comments', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    var stepId = parseIntParam(req.params.stepId);
    res.json(getPlanStepComments(stepId));
  }));

  router.put('/plans/:id/reorder', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var plan = getPlan(parseIntParam(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!checkProjectScope(req, res, plan.project_id)) return;
    var order = req.body.order;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of step IDs' });
    reorderPlanSteps(parseIntParam(req.params.id), order);
    res.json({ ok: true, plan_id: parseIntParam(req.params.id) });
  }));
}
