// Team-settings routes — extracted verbatim from mycelium.js (god-file
// decomposition, 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  getAllTeamSettingsGrouped, listTeamSettings, upsertTeamSetting,
  deleteTeamSetting, syncTeamSettingsToProfile,
} from '../db.js';

export function registerTeamSettingsRoutes(router, deps) {
  const { asyncHandler, checkAdmin, getAdminDisplayName } = deps;

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
}
