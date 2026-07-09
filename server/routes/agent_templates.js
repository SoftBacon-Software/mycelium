// Agent-template routes — extracted verbatim from mycelium.js (god-file
// decomposition, 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listAgentTemplates, getAgentTemplate, createAgentTemplate,
  updateAgentTemplate, deleteAgentTemplate, getAgent, updateAgent,
  addTeamMember,
} from '../db.js';

export function registerAgentTemplateRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, apiError,
    getAdminDisplayName,
  } = deps;

  // ======== AGENT TEMPLATES ========

  // GET /agent-templates — list all
  router.get('/agent-templates', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listAgentTemplates());
  }));

  // GET /agent-templates/:id — get one
  router.get('/agent-templates/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    res.json(t);
  }));

  // POST /agent-templates — create (admin only)
  router.post('/agent-templates', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = req.body.id;
    var name = req.body.name;
    if (!id || !name) return apiError(res, 400, 'id and name are required');
    if (getAgentTemplate(id)) return apiError(res, 409, 'Template ' + id + ' already exists');
    var template = createAgentTemplate(id, name, req.body.description || '', req.body, getAdminDisplayName(req));
    res.status(201).json(template);
  }));

  // PUT /agent-templates/:id — update (admin only)
  router.put('/agent-templates/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    var updated = updateAgentTemplate(req.params.id, req.body);
    res.json(updated);
  }));

  // DELETE /agent-templates/:id — delete (admin only)
  router.delete('/agent-templates/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    deleteAgentTemplate(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  }));

  // POST /agent-templates/:id/apply/:agentId — apply template to existing agent (admin only)
  router.post('/agent-templates/:id/apply/:agentId', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var t = getAgentTemplate(req.params.id);
    if (!t) return apiError(res, 404, 'Template not found');
    var agent = getAgent(req.params.agentId);
    if (!agent) return apiError(res, 404, 'Agent not found');
    // Apply template fields to agent
    var agentUpdate = {};
    if (t.runtime) agentUpdate.runtime = t.runtime;
    if (t.llm_backend) agentUpdate.llm_backend = t.llm_backend;
    if (t.llm_model) agentUpdate.llm_model = t.llm_model;
    if (t.agent_type) agentUpdate.agent_type = t.agent_type;
    if (t.capabilities && t.capabilities.length > 0) agentUpdate.capabilities = JSON.stringify(t.capabilities);
    if (Object.keys(agentUpdate).length > 0) updateAgent(req.params.agentId, agentUpdate);
    // Auto-add to template teams
    if (t.team_ids && t.team_ids.length > 0) {
      for (var teamId of t.team_ids) {
        try { addTeamMember(teamId, req.params.agentId, 'agent', 'member', false); } catch (_) {}
      }
    }
    res.json({ ok: true, agent: getAgent(req.params.agentId), template: t.id });
  }));
}
