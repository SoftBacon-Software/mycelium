// Task routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listTasksNeedingApproval, listTasks, createTask, updateTask,
  setTaskDependency, getTask, resolveTaskDependencies, updateAsset,
  completeLinkedPlanSteps, getMessage, resolveMessage, getDB,
  getSleepMode, appendSleepLog, incrementProfileCounter, dispatchWebhook,
  approveTask, getTaskComments, addTaskComment, getTaskDeliverables,
  addTaskDeliverable, deleteTask, getTaskComment, deleteTaskComment,
} from '../db.js';

export function registerTaskRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
    agentWriteLimiter, escapeHtml, parseLimit, parseIntParam, validateEnum,
    emitEvent,
    validateStringLength, checkProjectScope, warnSuspectTransition,
    dispatchWorkToIdleAgents,
    MAX_TITLE, MAX_DESCRIPTION, TASK_STATUSES, TASK_PRIORITIES,
  } = deps;

  router.get('/tasks/approval-queue', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json(listTasksNeedingApproval());
  }));

  router.get('/tasks', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      project_id: req.query.project_id,
      status: req.query.status,
      assignee: req.query.assignee,
      requester: req.query.requester,
      priority: req.query.priority,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    res.json(listTasks(filters));
  }));

  router.post('/tasks', agentWriteLimiter, asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'task_created', { agent: agentId, project_id: req.body.project_id, title: req.body.title })) return;
    var title = escapeHtml(req.body.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!validateStringLength(res, req.body.title, MAX_TITLE, 'title')) return;
    if (!validateStringLength(res, req.body.description, MAX_DESCRIPTION, 'description')) return;
    var description = escapeHtml(req.body.description || '');
    var projectId = req.body.project_id || '';
    var priority = req.body.priority || 'normal';
    var tags = req.body.tags ? JSON.stringify(req.body.tags) : '[]';
    var id = createTask(title, description, projectId, agentId, priority, tags);
    // Handle optional fields
    var updates = {};
    if (req.body.assignee) updates.assignee = req.body.assignee;
    if (req.body.needs_approval) updates.needs_approval = 1;
    if (Object.keys(updates).length > 0) updateTask(id, updates);
    // Process blocked_by dependencies inline (Bug #92)
    if (Array.isArray(req.body.blocked_by)) {
      for (var i = 0; i < req.body.blocked_by.length; i++) {
        setTaskDependency(id, parseInt(req.body.blocked_by[i]));
      }
    }
    emitEvent('task_created', agentId, projectId, agentId + ' created task: ' + title, { task_id: id });
    if (req.body.assignee) {
      dispatchWebhook('task_created', req.body.assignee, { task_id: id, title: title });
    }
    res.json({ id: id, title: title });
  }));

  router.get('/tasks/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  }));

  router.put('/tasks/:id', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'task_updated', { agent: agentId, task_id: req.params.id, status: req.body.status })) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!checkProjectScope(req, res, task.project_id, task.assignee)) return;
    if (!validateEnum(res, req.body.status, TASK_STATUSES, 'status')) return;
    if (!validateEnum(res, req.body.priority, TASK_PRIORITIES, 'priority')) return;
    warnSuspectTransition('task', task.status, req.body.status);
    var fields = {};
    if (req.body.title !== undefined) fields.title = escapeHtml(req.body.title);
    if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
    if (req.body.status !== undefined) fields.status = req.body.status;
    if (req.body.assignee !== undefined) fields.assignee = req.body.assignee;
    if (req.body.priority !== undefined) fields.priority = req.body.priority;
    if (req.body.tags !== undefined) fields.tags = JSON.stringify(req.body.tags);
    if (req.body.needs_approval !== undefined) fields.needs_approval = req.body.needs_approval;
    if (req.body.branch !== undefined) fields.branch = req.body.branch;
    if (req.body.pr_url !== undefined) fields.pr_url = req.body.pr_url;
    if (req.body.repo !== undefined) fields.repo = req.body.repo;
    if (req.body.review_metadata !== undefined) fields.review_metadata = typeof req.body.review_metadata === 'string' ? req.body.review_metadata : JSON.stringify(req.body.review_metadata);
    updateTask(task.id, fields);

    var result = { ok: true, id: task.id };

    // Handle blocked_by via the dependency system (not the general update handler)
    if (req.body.blocked_by !== undefined) {
      var blockers = Array.isArray(req.body.blocked_by) ? req.body.blocked_by : [req.body.blocked_by];
      var addedDeps = [];
      for (var bid of blockers) {
        var depId = parseInt(bid);
        if (depId && depId !== task.id) {
          var ok = setTaskDependency(task.id, depId);
          if (ok) addedDeps.push(depId);
        }
      }
      if (addedDeps.length > 0) result.blocked_by = addedDeps;
    }

    // When task completes: resolve dependencies and update linked asset
    if (fields.status === 'done') {
      if (getSleepMode().active) appendSleepLog('tasks_completed', { id: task.id, title: task.title, agent: agentId, time: new Date().toISOString() });
      try { incrementProfileCounter(agentId, 'total_tasks_completed'); } catch (e) { /* non-critical */ }

      // Wrap the done-cascade DB side-effects in a transaction so a mid-cascade
      // failure rolls back cleanly (dependencies, asset delivery, plan steps, and
      // request resolution are all-or-nothing). Event emissions and dispatch run
      // AFTER commit — a rollback must never notify of side-effects that didn't
      // happen, nor dispatch work for a task whose cascade failed.
      var cascadeResult = { unblocked: [], planResult: { steps_completed: 0, plans_completed: [] }, requestResolved: false };
      try {
        cascadeResult = getDB().transaction(function () {
          var acc = { unblocked: [], planResult: { steps_completed: 0, plans_completed: [] }, requestResolved: false };

          // 1. Resolve blocked tasks
          acc.unblocked = resolveTaskDependencies(task.id);

          // 2. Auto-deliver linked asset
          if (task.linked_asset_id) {
            updateAsset(task.linked_asset_id, { status: 'delivered' });
          }

          // 3. Auto-complete linked plan steps
          acc.planResult = completeLinkedPlanSteps(task.id);

          // 4. Auto-resolve linked request
          if (task.request_id) {
            try {
              var linkedReq = getMessage(task.request_id);
              if (linkedReq && linkedReq.status !== 'resolved') {
                resolveMessage(task.request_id, agentId);
                acc.requestResolved = true;
              }
            } catch (e) { /* non-critical */ }
          }

          return acc;
        })();
      } catch (e) {
        console.error('[tasks] done-cascade transaction failed:', e.message);
        return res.status(500).json({ error: 'Failed to complete task cascade: ' + e.message });
      }

      // Emit cascade events (outside the transaction — fire-and-forget notifications)
      var unblocked = cascadeResult.unblocked;
      if (unblocked.length > 0) {
        result.unblocked = unblocked;
        for (var uid of unblocked) {
          emitEvent('task_unblocked', agentId, task.project_id, 'Task #' + uid + ' unblocked by completion of #' + task.id, { task_id: uid, completed_task_id: task.id });
        }
      }
      // Auto-deliver linked asset
      if (task.linked_asset_id) {
        emitEvent('asset_delivered', agentId, task.project_id, 'Asset #' + task.linked_asset_id + ' auto-delivered (task #' + task.id + ' done)', { asset_id: task.linked_asset_id, task_id: task.id });
      }
      // Auto-complete linked plan steps
      var planResult = cascadeResult.planResult;
      if (planResult.steps_completed > 0) {
        result.plan_steps_completed = planResult.steps_completed;
        emitEvent('plan_step_completed', agentId, task.project_id, planResult.steps_completed + ' plan step(s) auto-completed by task #' + task.id, { task_id: task.id, steps: planResult.steps_completed });
      }
      if (planResult.plans_completed.length > 0) {
        for (var pid of planResult.plans_completed) {
          emitEvent('plan_completed', agentId, task.project_id, 'Plan #' + pid + ' auto-completed (all steps done)', { plan_id: pid, task_id: task.id });
        }
        result.plans_completed = planResult.plans_completed;
      }
      // Auto-resolve linked request
      if (cascadeResult.requestResolved) {
        emitEvent('request_resolved', agentId, task.project_id, 'Request #' + task.request_id + ' auto-resolved (task #' + task.id + ' done)', { message_id: task.request_id, task_id: task.id });
      }
      // Auto-dispatch: push work to any idle agents (AFTER commit — has non-DB SSE emissions)
      try {
        var dispatched = dispatchWorkToIdleAgents('task_completed:#' + task.id);
        if (dispatched.length > 0) result.auto_dispatched = dispatched;
      } catch (e) { /* non-critical */ }
    }

    if (fields.status) {
      emitEvent('task_' + fields.status, agentId, task.project_id, agentId + ' set task #' + task.id + ' to ' + fields.status, { task_id: task.id });
    }
    // Webhook: notify assignee when task is assigned or updated
    var targetAgent = fields.assignee || task.assignee;
    if (targetAgent && (fields.assignee || fields.status)) {
      dispatchWebhook('task_assigned', targetAgent, { task_id: task.id, title: task.title, status: fields.status || task.status });
    }
    res.json(result);
  }));

  // POST /tasks/:id/claim — claim a task (convenience route)
  router.post('/tasks/:id/claim', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!checkProjectScope(req, res, task.project_id, task.assignee)) return;
    // Assignee derives from AUTH, not the client body: a regular agent may only
    // claim for itself (the `who` value); only admin may assign on behalf of
    // another agent via req.body.agent_id. (Mirrors the /messages directive gate.)
    var agentId = (req._authIsAdmin && req.body.agent_id) ? req.body.agent_id : who;
    updateTask(task.id, { assignee: agentId, status: 'in_progress' });
    emitEvent('task_claimed', who, task.project_id, who + ' claimed task #' + task.id, { task_id: task.id, agent: agentId });
    res.json({ ok: true, id: task.id, assignee: agentId, status: 'in_progress' });
  }));

  // Task dependencies
  router.post('/tasks/:id/dependency', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    var taskId = parseIntParam(req.params.id);
    var blockedById = parseIntParam(req.body.blocked_by);
    if (!blockedById) return res.status(400).json({ error: 'blocked_by (task ID) is required' });
    if (taskId === blockedById) return res.status(400).json({ error: 'A task cannot block itself' });
    var ok = setTaskDependency(taskId, blockedById);
    if (!ok) return res.status(404).json({ error: 'One or both tasks not found' });
    emitEvent('task_dependency', agentId, null, 'Task #' + taskId + ' now blocked by #' + blockedById, { task_id: taskId, blocked_by: blockedById });
    res.json({ ok: true, task: taskId, blocked_by: blockedById });
  }));

  // Task approval (admin only)
  router.put('/tasks/:id/approve', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.needs_approval) return res.status(400).json({ error: 'Task does not require approval' });
    if (task.approved_by) return res.status(400).json({ error: 'Task already approved by ' + task.approved_by });
    approveTask(task.id, '__admin__');
    emitEvent('task_approved', '__admin__', task.project_id, 'Admin approved task #' + task.id + ': ' + task.title, { task_id: task.id });
    res.json({ ok: true, id: task.id, approved: true });
  }));

  // ======== TASK COMMENTS ========

  router.get('/tasks/:id/comments', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(getTaskComments(task.id));
  }));

  router.post('/tasks/:id/comments', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    var author = escapeHtml((req._authIsAdmin && req.body.author) ? req.body.author : who);
    var content = escapeHtml(req.body.content);
    if (!content) return res.status(400).json({ error: 'content is required' });
    var comment = addTaskComment(task.id, author, content);
    emitEvent('task_comment', who, task.project_id, who + ' commented on task #' + task.id, { task_id: task.id, comment_id: comment.id });
    res.json(comment);
  }));

  // ======== TASK DELIVERABLES ========
  // An agent's final output (typed, raw markdown). Distinct from the comment
  // thread; a deliverable row existing == the task produced real output.

  router.get('/tasks/:id/deliverables', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(getTaskDeliverables(task.id));
  }));

  router.post('/tasks/:id/deliverable', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    var author = escapeHtml((req._authIsAdmin && req.body.author) ? req.body.author : who);
    var kind = escapeHtml(req.body.kind || 'report');
    var format = escapeHtml(req.body.format || 'markdown');
    var flags = escapeHtml(req.body.flags || '');
    // content is stored RAW markdown — NOT escapeHtml'd (comments escape because
    // they render as HTML; deliverables render through a markdown view in Phase 2,
    // where escaping would corrupt code blocks). The Phase-2 renderer must treat
    // this as markdown, never raw-inject it as HTML.
    var content = req.body.content;
    if (!content) return res.status(400).json({ error: 'content is required' });
    var deliverable = addTaskDeliverable(task.id, author, kind, format, content, flags);
    emitEvent('task_deliverable', who, task.project_id, who + ' delivered task #' + task.id + ' (' + kind + ')', { task_id: task.id, deliverable_id: deliverable.id, kind: kind });
    res.json(deliverable);
  }));

  router.delete('/tasks/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = parseIntParam(req.params.id);
    var task = getTask(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    deleteTask(id);
    emitEvent('task_deleted', '__system__', task.project_id, 'Task #' + id + ' deleted: ' + task.title);
    res.json({ ok: true, id: id });
  }));

  router.delete('/tasks/:id/comments/:commentId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = getTask(parseIntParam(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!checkProjectScope(req, res, task.project_id)) return;
    var comment = getTaskComment(parseIntParam(req.params.commentId));
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    // Only the comment author or admins can delete
    if (!req._authIsAdmin && comment.author !== who) {
      return res.status(403).json({ error: 'Can only delete your own comments' });
    }
    deleteTaskComment(comment.id);
    res.json({ ok: true, deleted: comment.id });
  }));
}
