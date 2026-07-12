// Teams / orgs / operators / team-settings routes — extracted verbatim from
// mycelium.js (god-file decomposition, Phase 3, 2026-07-12; see
// docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs and pinned
// by test/unit/teams-orgs-characterization.test.js.
//
// SCOPE NOTE: this slice covers the 24 routes in the characterization coverage
// map (operators CRUD, orgs CRUD, team-settings KV, teams + members + projects).
// PUT /operators/:id/availability is intentionally LEFT in mycelium.js — it is
// not in the coverage map, lives in the sleep/autonomy section, and pulls in the
// autonomy-domain deps (isNetworkAutonomous, getSleepMode, listAgents,
// createMessage) plus the mycelium.js-local displayName() helper. It belongs to
// a future autonomy/admin slice, not this one.
import {
  // operators (people)
  listOperators, getOperator, createOperator, updateOperator, deleteOperator,
  // orgs
  listOrgs, getOrg, createOrg, updateOrg, deleteOrg, listProjects,
  // team settings
  getAllTeamSettingsGrouped, listTeamSettings, upsertTeamSetting,
  deleteTeamSetting, syncTeamSettingsToProfile,
  // teams + members + projects
  listTeams, getTeam, getTeamProjects, createTeam, updateTeam, deleteTeam,
  addTeamMember, updateTeamMember, removeTeamMember,
  // teams auto-channel integration
  createChannel, getChannelBySlug, addChannelMember,
} from '../db.js';

export function registerTeamRoutes(router, deps) {
  const { asyncHandler, checkAgentOrAdmin, checkAdmin, checkAdminOrOperator, emitEvent, getAdminDisplayName, apiError } = deps;

  // ======== OPERATORS (people) ========

  router.get('/operators', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listOperators());
  }));

  router.get('/operators/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var op = getOperator(req.params.id);
    if (!op) return res.status(404).json({ error: 'Operator not found' });
    res.json(op);
  }));

  router.post('/operators', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = getAdminDisplayName(req);
    var { id, display_name, role, responsibilities, email, studio_user_id } = req.body;
    if (!id || !display_name) return res.status(400).json({ error: 'id and display_name required' });
    if (getOperator(id)) return res.status(409).json({ error: 'Operator already exists' });
    createOperator(id, display_name, role, responsibilities, email, studio_user_id);
    emitEvent('operator_created', who, null, 'Operator ' + id + ' created');
    res.json(getOperator(id));
  }));

  router.put('/operators/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = getAdminDisplayName(req);
    var op = getOperator(req.params.id);
    if (!op) return res.status(404).json({ error: 'Operator not found' });
    updateOperator(req.params.id, req.body);
    emitEvent('operator_updated', who, null, 'Operator ' + req.params.id + ' updated');
    res.json(getOperator(req.params.id));
  }));

  router.delete('/operators/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var who = getAdminDisplayName(req);
    if (!getOperator(req.params.id)) return res.status(404).json({ error: 'Operator not found' });
    deleteOperator(req.params.id);
    emitEvent('operator_deleted', who, null, 'Operator ' + req.params.id + ' deleted');
    res.json({ ok: true });
  }));

  // ======== ORGANIZATIONS ========

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

  // ======== TEAM SETTINGS ========

  // GET /team-settings — all settings grouped by section
  router.get('/team-settings', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json(getAllTeamSettingsGrouped());
  }));

  // GET /team-settings/:section — one section
  router.get('/team-settings/:section', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var rows = listTeamSettings(req.params.section);
    var result = {};
    for (var row of rows) {
      try { result[row.key] = JSON.parse(row.value); } catch (e) { result[row.key] = row.value; }
    }
    res.json(result);
  }));

  // PUT /team-settings/:section/:key — upsert a setting
  router.put('/team-settings/:section/:key', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var section = req.params.section;
    var key = req.params.key;
    var value = req.body.value;
    if (value === undefined) return res.status(400).json({ error: 'value is required' });
    var validSections = ['coding_standards', 'deploy_workflow', 'brand', 'guardrails', 'team_rules'];
    if (validSections.indexOf(section) === -1) {
      return res.status(400).json({ error: 'Invalid section. Must be one of: ' + validSections.join(', ') });
    }
    var who = getAdminDisplayName(req);
    var result = upsertTeamSetting(section, key, value, who);
    res.json({ ok: true, setting: result });
  }));

  // DELETE /team-settings/:section/:key — remove a setting
  router.delete('/team-settings/:section/:key', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    deleteTeamSetting(req.params.section, req.params.key);
    res.json({ ok: true });
  }));

  // POST /team-settings/sync — force re-sync to profiles
  router.post('/team-settings/sync', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    syncTeamSettingsToProfile();
    res.json({ ok: true, message: 'Profile sync complete' });
  }));

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
