// Projects routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listProjects, createProject, getProject, updateProject, deleteProject,
  getProjectConcepts,
} from '../db.js';

export function registerProjectRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
    getAdminDisplayName, getBugCategories,
  } = deps;

  // =============== PROJECTS ===============

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
