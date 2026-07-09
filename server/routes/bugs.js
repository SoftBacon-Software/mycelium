// Bug routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  createBug, getBug, listBugs, updateBug, deleteBug, countBugs,
  dispatchWebhook, incrementProfileCounter,
} from '../db.js';

export function registerBugRoutes(router, deps) {
  const {
    asyncHandler, agentWriteLimiter, checkAgentOrAdmin, checkAdmin, checkProjectScope,
    checkGuardrails, emitEvent, validateEnum, validateStringLength, getBugCategories,
    parseLimit, parseIntParam, warnSuspectTransition, getAdminDisplayName,
    MAX_TITLE, MAX_DESCRIPTION, BUG_STATUSES, BUG_SEVERITIES,
  } = deps;

  // POST /bugs — create a bug report (agent or admin)
  router.post('/bugs', agentWriteLimiter, asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!checkGuardrails(req, res, 'bug_created', { agent: who, project_id: req.body.project_id, title: req.body.title })) return;
    var { project_id, title, description, category, severity, assignee, diagnostic_data } = req.body;
    var projectId = project_id;
    if (!title || !description) return res.status(400).json({ error: 'title and description are required' });
    if (!validateStringLength(res, title, MAX_TITLE, 'title')) return;
    if (!validateStringLength(res, description, MAX_DESCRIPTION, 'description')) return;
    if (!validateEnum(res, category, getBugCategories(projectId), 'category')) return;
    if (!validateEnum(res, severity, BUG_SEVERITIES, 'severity')) return;
    var diagStr = null;
    if (diagnostic_data) {
      diagStr = typeof diagnostic_data === 'string' ? diagnostic_data : JSON.stringify(diagnostic_data);
    }
    var id = createBug(projectId, title, description, category, severity, who, assignee, diagStr);
    emitEvent('bug_created', who, projectId || '', who + ' filed bug #' + id + ': ' + title, { bug_id: id });
    dispatchWebhook('bug_created', who, { bug_id: id, title: title, project_id: projectId, severity: severity, reporter: who, assignee: assignee });
    res.json({ ok: true, id: id });
  }));

  // GET /bugs — list bugs (agent or admin, optional filters: project_id, status, assignee)
  router.get('/bugs', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {};
    if (req.query.project_id) filters.project_id = req.query.project_id;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.assignee) filters.assignee = req.query.assignee;
    if (req.query.reporter) filters.reporter = req.query.reporter;
    if (req.query.severity) filters.severity = req.query.severity;
    if (req.query.category) filters.category = req.query.category;
    filters.limit = parseLimit(req.query.limit, 50);
    filters.offset = parseInt(req.query.offset) || 0;
    var bugs = listBugs(filters);
    var counts = countBugs();
    res.json({ bugs: bugs, counts: counts });
  }));

  // GET /bugs/:id — get bug detail
  router.get('/bugs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var bug = getBug(parseIntParam(req.params.id));
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    res.json(bug);
  }));

  // POST /bugs/:id/claim — claim a bug (convenience route)
  router.post('/bugs/:id/claim', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var bug = getBug(parseIntParam(req.params.id));
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    if (!checkProjectScope(req, res, bug.project_id, bug.assignee)) return;
    // Assignee derives from AUTH, not the client body: a regular agent may only
    // claim for itself (the `who` value); only admin may assign on behalf of
    // another agent via req.body.agent_id. (Mirrors the /messages directive gate.)
    var agentId = (req._authIsAdmin && req.body.agent_id) ? req.body.agent_id : who;
    updateBug(bug.id, { assignee: agentId, status: 'in_progress' });
    emitEvent('bug_claimed', who, bug.project_id, who + ' claimed bug #' + bug.id, { bug_id: bug.id, agent: agentId });
    res.json({ ok: true, id: bug.id, assignee: agentId, status: 'in_progress' });
  }));

  // PUT /bugs/:id — update bug (status, assignee, admin_notes, severity)
  router.put('/bugs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var bug = getBug(parseIntParam(req.params.id));
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    if (!checkProjectScope(req, res, bug.project_id, bug.assignee)) return;
    if (!validateEnum(res, req.body.status, BUG_STATUSES, 'status')) return;
    if (!validateEnum(res, req.body.severity, BUG_SEVERITIES, 'severity')) return;
    warnSuspectTransition('bug', bug.status, req.body.status);
    var updates = {};
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.assignee !== undefined) updates.assignee = req.body.assignee;
    if (req.body.admin_notes !== undefined) updates.admin_notes = req.body.admin_notes;
    if (req.body.severity !== undefined) updates.severity = req.body.severity;
    updateBug(bug.id, updates);
    if (updates.status) {
      emitEvent('bug_updated', who, bug.project_id, who + ' set bug #' + bug.id + ' to ' + updates.status, { bug_id: bug.id });
      if (updates.status === 'fixed' || updates.status === 'closed') {
        try { incrementProfileCounter(bug.assignee || who, 'total_bugs_fixed'); } catch (e) { /* non-critical */ }
      }
    }
    dispatchWebhook('bug_updated', who, { bug_id: bug.id, title: bug.title, updates: updates });
    // Webhook: notify assignee when bug is assigned
    var bugTarget = updates.assignee || bug.assignee;
    if (bugTarget && (updates.assignee || updates.status)) {
      dispatchWebhook('bug_assigned', bugTarget, { bug_id: bug.id, title: bug.title, status: updates.status || bug.status });
    }
    res.json({ ok: true, id: bug.id });
  }));

  // Delete bug (admin only)
  router.delete('/bugs/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var bug = getBug(parseIntParam(req.params.id));
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    deleteBug(bug.id);
    emitEvent('bug_deleted', getAdminDisplayName(req), bug.project_id, 'Deleted bug #' + bug.id + ': ' + bug.title, { bug_id: bug.id });
    res.json({ ok: true, id: bug.id });
  }));
}
