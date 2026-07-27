// Org routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listOrgs, createOrg, getOrg, listProjects, updateOrg, deleteOrg,
} from '../db.js';

export function registerOrgRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, emitEvent, getAdminDisplayName,
  } = deps;

  // =============== ORGANIZATIONS ===============

  router.get('/orgs', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listOrgs());
  }));

  router.post('/orgs', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var { id, name, description } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    createOrg(id, name, description || '', getAdminDisplayName(req));
    var org = getOrg(id);
    emitEvent('org_created', getAdminDisplayName(req), '', 'Organization created: ' + name);
    res.json(org);
  }));

  router.get('/orgs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var org = getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    org.projects = listProjects(req.params.id);
    res.json(org);
  }));

  router.put('/orgs/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var org = getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    updateOrg(req.params.id, req.body);
    res.json(getOrg(req.params.id));
  }));

  router.delete('/orgs/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var org = getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    deleteOrg(req.params.id);
    res.json({ ok: true });
  }));
}
