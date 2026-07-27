// Shared-concept routes — extracted verbatim from mycelium.js (god-file
// decomposition, 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listConcepts, getConceptProjects, getConcept, createConcept, updateConcept,
  deleteConcept, linkConceptToProject, unlinkConceptFromProject,
} from '../db.js';

export function registerConceptRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, parseIntParam, emitEvent, checkApprovalGate,
  } = deps;

  // ======== SHARED CONCEPTS ========

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
}
