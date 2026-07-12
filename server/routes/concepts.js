// Concepts / projects / skills routes — extracted verbatim from mycelium.js
// (god-file decomposition, Phase 3, 2026-07-12; see
// docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — pinned by
// test/unit/concepts-projects-skills-characterization.test.js.
import {
  createProject, listProjects, getProject, updateProject, deleteProject,
  createSkill, getSkill, listSkills, updateSkill, installSkill, uninstallSkill,
  createConcept, getConcept, listConcepts, updateConcept, deleteConcept,
  linkConceptToProject, unlinkConceptFromProject, getProjectConcepts, getConceptProjects,
} from '../db.js';

export function registerConceptRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
    parseIntParam, getAdminDisplayName, checkApprovalGate, getBugCategories,
  } = deps;

  // ======== SKILLS REGISTRY ========

  router.get('/skills', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var skills = listSkills({
      category: req.query.category,
      search: req.query.search
    });
    res.json(skills);
  }));

  router.get('/skills/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var skill = getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'skill not found' });
    res.json(skill);
  }));

  router.post('/skills', asyncHandler(function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var b = req.body;
    if (!b.id || !b.name) return res.status(400).json({ error: 'id and name required' });
    try {
      var result = createSkill(b.id, b.name, b.description, b.category, b.version, b.author,
        b.install_type, b.install_data, b.required_capabilities, b.tags);
      emitEvent('skill_created', 'admin', '', b.name, { skill_id: b.id });
      res.status(201).json(result);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) return res.status(409).json({ error: 'skill already exists' });
      throw err;
    }
  }));

  router.put('/skills/:id', asyncHandler(function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var updated = updateSkill(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'skill not found' });
    res.json(updated);
  }));

  // Agent skill management
  router.post('/skills/:id/install', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var agentId = (who === '__admin__' || who === '__system__') ? (req.body.agent_id || who) : who;
    if (!agentId) return res.status(400).json({ error: 'agent_id required' });
    var skill = getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'skill not found' });
    installSkill(agentId, req.params.id, req.body.config);
    emitEvent('skill_installed', agentId, '', skill.name, { skill_id: req.params.id });
    res.json({ ok: true, skill_id: req.params.id, agent_id: agentId });
  }));

  router.post('/skills/:id/uninstall', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var agentId = (who === '__admin__' || who === '__system__') ? (req.body.agent_id || who) : who;
    if (!agentId) return res.status(400).json({ error: 'agent_id required' });
    uninstallSkill(agentId, req.params.id);
    res.json({ ok: true });
  }));

  // ======== PROJECTS ========

  // List projects (optional ?org_id= filter)
  router.get('/projects', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listProjects(req.query.org_id));
  }));

  // Create project (admin only)
  router.post('/projects', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var { id, name, description, repo_url, org_id, type } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    createProject(id, name, description || '', repo_url || '', org_id || '', type || 'software');
    var project = getProject(id);
    emitEvent('project_created', getAdminDisplayName(req), id, 'Project created: ' + name);
    res.json(project);
  }));

  router.get('/projects/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  }));

  router.put('/projects/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    updateProject(req.params.id, req.body);
    res.json(getProject(req.params.id));
  }));

  router.delete('/projects/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    deleteProject(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  }));

  // GET /projects/:id/bug-categories — get bug categories for a project (dynamic or defaults)
  router.get('/projects/:id/bug-categories', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json({ project_id: req.params.id, categories: getBugCategories(req.params.id) });
  }));

  // =============== SHARED CONCEPTS ===============

  // List all concepts (optional ?type= filter)
  router.get('/concepts', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {};
    if (req.query.type) filters.type = req.query.type;
    var concepts = listConcepts(filters);
    // Attach linked projects to each concept
    concepts.forEach(function (c) {
      c.projects = getConceptProjects(c.id);
      try { c.data = JSON.parse(c.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + c.id + '):', e.message); }
    });
    res.json(concepts);
  }));

  // Get single concept
  router.get('/concepts/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var concept = getConcept(parseIntParam(req.params.id));
    if (!concept) return res.status(404).json({ error: 'Concept not found' });
    concept.projects = getConceptProjects(concept.id);
    try { concept.data = JSON.parse(concept.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + concept.id + '):', e.message); }
    res.json(concept);
  }));

  // Create concept (admin or agent)
  router.post('/concepts', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { name, type, description, data } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    var validTypes = ['character', 'style', 'ruleset', 'library', 'brand', 'custom'];
    if (type && validTypes.indexOf(type) === -1) {
      return res.status(400).json({ error: 'type must be one of: ' + validTypes.join(', ') });
    }
    var id = createConcept(name, type, description, data, who);
    emitEvent('concept_created', who, null, 'Created concept: ' + name + ' (' + (type || 'custom') + ')');
    var concept = getConcept(id);
    try { concept.data = JSON.parse(concept.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + id + '):', e.message); }
    concept.projects = [];
    res.json(concept);
  }));

  // Update concept
  router.put('/concepts/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var concept = getConcept(parseIntParam(req.params.id));
    if (!concept) return res.status(404).json({ error: 'Concept not found' });
    updateConcept(concept.id, req.body);
    var updated = getConcept(concept.id);
    try { updated.data = JSON.parse(updated.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + concept.id + '):', e.message); }
    updated.projects = getConceptProjects(updated.id);
    emitEvent('concept_updated', who, null, 'Updated concept: ' + updated.name);
    res.json(updated);
  }));

  // Delete concept
  router.delete('/concepts/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var gate = checkApprovalGate(req, who, 'delete');
    if (!gate.ok && !gate.soft) return res.status(403).json({ error: gate.error, approval_required: true });
    var concept = getConcept(parseIntParam(req.params.id));
    if (!concept) return res.status(404).json({ error: 'Concept not found' });
    deleteConcept(concept.id);
    emitEvent('concept_deleted', who, null, who + ' deleted concept: ' + concept.name);
    var result = { ok: true };
    if (gate.warning) result.approval_warning = gate.warning;
    res.json(result);
  }));

  // Link concept to project
  router.post('/concepts/:id/link', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var concept = getConcept(parseIntParam(req.params.id));
    if (!concept) return res.status(404).json({ error: 'Concept not found' });
    var projectId = req.body.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    linkConceptToProject(projectId, concept.id, who);
    emitEvent('concept_linked', who, projectId, 'Linked concept "' + concept.name + '" to project ' + projectId);
    res.json({ ok: true, concept_id: concept.id, project: projectId });
  }));

  // Unlink concept from project
  router.delete('/concepts/:id/link/:projectId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    unlinkConceptFromProject(req.params.projectId, parseIntParam(req.params.id));
    res.json({ ok: true });
  }));

  // Get concepts for a specific project
  router.get('/projects/:projectId/concepts', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var concepts = getProjectConcepts(req.params.projectId);
    concepts.forEach(function (c) {
      try { c.data = JSON.parse(c.data); } catch (e) { console.warn('[mycelium] JSON parse failed for concept.data (id: ' + c.id + '):', e.message); }
    });
    res.json(concepts);
  }));
}
