// Skill routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listSkills, getSkill, createSkill, updateSkill, installSkill, uninstallSkill,
} from '../db.js';

export function registerSkillRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent,
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
}
