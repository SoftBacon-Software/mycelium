// Profile routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listNodeProfiles, resolveProfileChain, getNodeProfile,
  createNodeProfile, updateNodeProfile, deleteNodeProfile,
} from '../db.js';

export function registerProfileRoutes(router, deps) {
  const {
    asyncHandler, checkAdmin, emitEvent, getAdminDisplayName,
  } = deps;

  router.get('/profiles', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var filter = {};
    if (req.query.node_type) filter.node_type = req.query.node_type;
    if (req.query.layer) filter.layer = req.query.layer;
    var profiles = listNodeProfiles(filter);
    res.json({ count: profiles.length, profiles: profiles });
  }));

  // Resolve profile chain for an agent (admin only)
  // NOTE: This route must be before /profiles/:id to avoid matching "resolve" as an ID
  router.get('/profiles/resolve/:agentId', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var resolved = resolveProfileChain(req.params.agentId);
    res.json(resolved);
  }));

  // Get single profile (admin only)
  router.get('/profiles/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var profile = getNodeProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
  }));

  // Create profile (admin only)
  router.post('/profiles', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = req.body.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    // Check if profile already exists
    var existing = getNodeProfile(id);
    if (existing) return res.status(409).json({ error: 'Profile already exists: ' + id });
    try {
      var profile = createNodeProfile(id, req.body);
      emitEvent('profile_created', getAdminDisplayName(req), null, 'Profile created: ' + id);
      res.status(201).json(profile);
    } catch (e) {
      console.error('[mycelium] profile creation error:', e.message);
      res.status(500).json({ error: 'Failed to create profile' });
    }
  }));

  // Update profile (admin only, partial)
  router.put('/profiles/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var updated = updateNodeProfile(req.params.id, req.body);
    if (!updated) {
      var existing = getNodeProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Profile not found' });
      return res.status(403).json({ error: 'Cannot modify platform-layer profiles' });
    }
    emitEvent('profile_updated', getAdminDisplayName(req), null, 'Profile updated: ' + req.params.id);
    res.json(updated);
  }));

  // Delete profile (admin only, blocked for platform layer)
  router.delete('/profiles/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var deleted = deleteNodeProfile(req.params.id);
    if (!deleted) {
      var existing = getNodeProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Profile not found' });
      return res.status(403).json({ error: 'Cannot delete platform-layer profiles' });
    }
    emitEvent('profile_deleted', getAdminDisplayName(req), null, 'Profile deleted: ' + req.params.id);
    res.json({ ok: true, deleted: deleted });
  }));
}
