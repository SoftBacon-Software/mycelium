// Team routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  listTeams, getTeam, getTeamProjects, createTeam, updateTeam, deleteTeam,
  addTeamMember, updateTeamMember, removeTeamMember,
  createChannel, getChannelBySlug, addChannelMember,
} from '../db.js';

export function registerTeamRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkAdminOrOperator,
    getAdminDisplayName, apiError,
  } = deps;

  // ======== TEAMS ========

  // GET /teams — list teams
  router.get('/teams', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json({ teams: listTeams(req.query.org_id || null) });
  }));

  // GET /teams/:id — team detail with members and projects
  router.get('/teams/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var team = getTeam(req.params.id);
    if (!team) return apiError(res, 404, 'Team not found');
    team.projects = getTeamProjects(req.params.id);
    res.json(team);
  }));

  // POST /teams — create team (admin only)
  router.post('/teams', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var { id, org_id, name, description } = req.body;
    if (!id || !org_id || !name) return apiError(res, 400, 'id, org_id, and name required');
    try {
      var who = getAdminDisplayName(req);
      var team = createTeam(id, org_id, name, description, who);
      // Auto-create team channel
      try {
        var channelSlug = 'team-' + id;
        createChannel('#team-' + id, channelSlug, 'team', 'team', id, 'Team channel for ' + name, who);
      } catch (chErr) { console.log('[teams] Auto-channel creation failed:', chErr.message); }
      res.json(team);
    } catch (err) {
      return apiError(res, 400, err.message);
    }
  }));

  // PUT /teams/:id — update team (admin only)
  router.put('/teams/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var team = updateTeam(req.params.id, req.body);
    if (!team) return apiError(res, 404, 'Team not found');
    res.json(team);
  }));

  // DELETE /teams/:id — delete empty team (admin only)
  router.delete('/teams/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    try {
      deleteTeam(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 400, err.message);
    }
  }));

  // POST /teams/:id/members — add member (any operator or admin)
  router.post('/teams/:id/members', asyncHandler(function (req, res) {
    if (!checkAdminOrOperator(req, res)) return;
    var { user_id, user_type, role, is_primary } = req.body;
    if (!user_id) return apiError(res, 400, 'user_id required');
    try {
      var member = addTeamMember(req.params.id, user_id, user_type, role, is_primary);
      // Auto-join team channel
      try {
        var ch = getChannelBySlug('team-' + req.params.id);
        if (ch) addChannelMember(ch.id, user_id, user_type || 'operator', 'member');
      } catch (_) {}
      res.json(member);
    } catch (err) {
      return apiError(res, 400, err.message);
    }
  }));

  // PUT /teams/:id/members/:userId — update member role/primary (any operator or admin)
  router.put('/teams/:id/members/:userId', asyncHandler(function (req, res) {
    if (!checkAdminOrOperator(req, res)) return;
    updateTeamMember(req.params.id, req.params.userId, req.body);
    res.json({ ok: true });
  }));

  // DELETE /teams/:id/members/:userId — remove member (any operator or admin)
  router.delete('/teams/:id/members/:userId', asyncHandler(function (req, res) {
    if (!checkAdminOrOperator(req, res)) return;
    removeTeamMember(req.params.id, req.params.userId);
    res.json({ ok: true });
  }));

  // GET /teams/:id/projects — team's projects
  router.get('/teams/:id/projects', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json({ projects: getTeamProjects(req.params.id) });
  }));
}
