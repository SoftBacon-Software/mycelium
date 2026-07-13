// =============== MYCELIUM — DB entity: teams, members, team settings ===============
// Extracted from server/db.js (Wave 4 of the decomposition). Coupling:
// `syncTeamSettingsToProfile` imports `getNodeProfile` / `updateNodeProfile` /
// `createNodeProfile` (node-profiles — landed in Wave 3). `addTeamMember` /
// `updateTeamMember` / `removeTeamMember` write `agents` / `operators
// .primary_team_id` by raw SQL (stays, note only — no cross-module import
// needed for that). Bodies moved VERBATIM — bare db.prepare(...) keeps working
// via the ESM live binding (initDBConnection assigns db; nobody else may). The
// barrel server/db.js re-exports these via `export * from './db/teams.js'` so
// no consumer changes a single import.
import { db, buildUpdate } from './core.js';
import { getNodeProfile, updateNodeProfile, createNodeProfile } from './node-profiles.js';

// =============== TEAM SETTINGS ===============

export function listTeamSettings(section) {
  if (section) {
    return db.prepare('SELECT * FROM team_settings WHERE section = ? ORDER BY key').all(section);
  }
  return db.prepare('SELECT * FROM team_settings ORDER BY section, key').all();
}

export function getTeamSetting(section, key) {
  return db.prepare('SELECT * FROM team_settings WHERE section = ? AND key = ?').get(section, key);
}

export function upsertTeamSetting(section, key, value, updatedBy) {
  var now = new Date().toISOString();
  var valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  db.prepare(
    "INSERT INTO team_settings (section, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
  ).run(section, key, valueStr, now, updatedBy || '');
  syncTeamSettingsToProfile();
  return getTeamSetting(section, key);
}

export function deleteTeamSetting(section, key) {
  var result = db.prepare('DELETE FROM team_settings WHERE section = ? AND key = ?').run(section, key);
  syncTeamSettingsToProfile();
  return result;
}

export function getAllTeamSettingsGrouped() {
  var rows = listTeamSettings();
  var grouped = {};
  for (var row of rows) {
    if (!grouped[row.section]) grouped[row.section] = {};
    try {
      grouped[row.section][row.key] = JSON.parse(row.value);
    } catch (e) {
      grouped[row.section][row.key] = row.value;
    }
  }
  return grouped;
}

export function syncTeamSettingsToProfile() {
  var settings = getAllTeamSettingsGrouped();
  var profileId = 'customer-agent';
  var existing = getNodeProfile(profileId);

  var updates = {};

  // Guardrails → direct profile mapping
  var guardrails = settings.guardrails || {};
  if (guardrails.tool_whitelist) updates.tool_whitelist = guardrails.tool_whitelist;
  if (guardrails.repo_list) updates.repo_list = guardrails.repo_list;
  if (guardrails.md_checkpoints) updates.md_checkpoints = guardrails.md_checkpoints;
  if (guardrails.md_blocklist) updates.md_blocklist = guardrails.md_blocklist;

  // Build rules from multiple sections
  var rules = {};
  if (existing) {
    try { rules = typeof existing.rules === 'object' ? existing.rules : JSON.parse(existing.rules || '{}'); } catch (e) { rules = {}; }
  }

  // Coding standards → rule
  var coding = settings.coding_standards || {};
  if (Object.keys(coding).length > 0) {
    var parts = [];
    if (coding.languages && coding.languages.length) parts.push('Languages: ' + coding.languages.join(', '));
    if (coding.linter) parts.push('Linter: ' + coding.linter);
    if (coding.formatter) parts.push('Formatter: ' + coding.formatter);
    if (coding.test_framework) parts.push('Tests: ' + coding.test_framework);
    if (coding.style_notes) parts.push(coding.style_notes);
    rules.coding_standards = { severity: 'high', description: parts.join('. ') };

    // Also add language names to md_checkpoints
    if (coding.languages && coding.languages.length) {
      var checkpoints = updates.md_checkpoints || (existing && existing.md_checkpoints) || [];
      if (typeof checkpoints === 'string') try { checkpoints = JSON.parse(checkpoints); } catch (e) { checkpoints = []; }
      for (var lang of coding.languages) {
        if (checkpoints.indexOf(lang) === -1) checkpoints.push(lang);
      }
      updates.md_checkpoints = checkpoints;
    }
  }

  // Deploy workflow → rule
  var deploy = settings.deploy_workflow || {};
  if (Object.keys(deploy).length > 0) {
    var deployParts = [];
    if (deploy.stages && deploy.stages.length) deployParts.push('Stages: ' + deploy.stages.join(' \u2192 '));
    if (deploy.deploy_method) deployParts.push('Method: ' + deploy.deploy_method);
    if (deploy.pr_requirements) deployParts.push('PR: ' + JSON.stringify(deploy.pr_requirements));
    rules.deploy_workflow = { severity: 'high', description: deployParts.join('. ') };
  }

  // Team rules → rule
  var teamRules = settings.team_rules || {};
  if (Object.keys(teamRules).length > 0) {
    var trParts = [];
    if (teamRules.communication_style) trParts.push('Style: ' + teamRules.communication_style);
    if (teamRules.timezone) trParts.push('TZ: ' + teamRules.timezone);
    if (teamRules.working_hours) trParts.push('Hours: ' + teamRules.working_hours);
    rules.team_rules = { severity: 'medium', description: trParts.join('. ') };
  }

  // Custom guardrail rules
  if (guardrails.custom_rules && Array.isArray(guardrails.custom_rules)) {
    for (var cr of guardrails.custom_rules) {
      if (cr.key && cr.description) {
        rules[cr.key] = { severity: cr.severity || 'medium', description: cr.description };
      }
    }
  }

  updates.rules = rules;

  if (existing) {
    updateNodeProfile(profileId, updates);
  } else {
    createNodeProfile(profileId, Object.assign({ node_type: 'agent', layer: 'customer' }, updates));
  }
}

// =============== TEAMS ===============

export function createTeam(id, orgId, name, description, createdBy) {
  db.prepare(
    'INSERT INTO teams (id, org_id, name, description, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, orgId, name, description || '', createdBy || '');
  return getTeam(id);
}

export function getTeam(id) {
  var team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (team) {
    team.members = db.prepare(
      'SELECT * FROM team_members WHERE team_id = ? ORDER BY role, joined_at'
    ).all(id);
  }
  return team;
}

export function listTeams(orgId) {
  var sql = orgId
    ? 'SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count FROM teams t WHERE t.org_id = ? ORDER BY t.name'
    : 'SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count FROM teams t ORDER BY t.name';
  return orgId ? db.prepare(sql).all(orgId) : db.prepare(sql).all();
}

export function updateTeam(id, fields) {
  var changed = buildUpdate('teams', id, fields, ['name', 'description', 'org_id'], { updatedAt: true });
  if (!changed) return getTeam(id);
  return getTeam(id);
}

export function deleteTeam(id) {
  var memberCount = db.prepare('SELECT COUNT(*) as c FROM team_members WHERE team_id = ?').get(id).c;
  if (memberCount > 0) throw new Error('Team has members — remove them first');
  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
}

export function addTeamMember(teamId, userId, userType, role, isPrimary) {
  if (isPrimary) {
    db.prepare('UPDATE team_members SET is_primary = 0 WHERE user_id = ? AND is_primary = 1').run(userId);
  }
  db.prepare(
    'INSERT INTO team_members (team_id, user_id, user_type, role, is_primary) VALUES (?, ?, ?, ?, ?)'
  ).run(teamId, userId, userType || 'operator', role || 'member', isPrimary ? 1 : 0);

  if (isPrimary) {
    var table = userType === 'agent' ? 'agents' : 'operators';
    db.prepare('UPDATE ' + table + ' SET primary_team_id = ? WHERE id = ?').run(teamId, userId);
  }
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
}

export function updateTeamMember(teamId, userId, fields) {
  var sets = [];
  var values = [];
  if (fields.role) { sets.push('role = ?'); values.push(fields.role); }
  if (fields.is_primary !== undefined) {
    if (fields.is_primary) {
      db.prepare('UPDATE team_members SET is_primary = 0 WHERE user_id = ? AND is_primary = 1').run(userId);
    }
    sets.push('is_primary = ?');
    values.push(fields.is_primary ? 1 : 0);
  }
  if (sets.length === 0) return;
  values.push(teamId, userId);
  db.prepare('UPDATE team_members SET ' + sets.join(', ') + ' WHERE team_id = ? AND user_id = ?').run(...values);

  if (fields.is_primary) {
    var member = db.prepare('SELECT user_type FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
    if (member) {
      var table = member.user_type === 'agent' ? 'agents' : 'operators';
      db.prepare('UPDATE ' + table + ' SET primary_team_id = ? WHERE id = ?').run(teamId, userId);
    }
  }
}

export function removeTeamMember(teamId, userId) {
  var member = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  if (!member) return;
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);

  if (member.is_primary) {
    var table = member.user_type === 'agent' ? 'agents' : 'operators';
    db.prepare('UPDATE ' + table + ' SET primary_team_id = NULL WHERE id = ?').run(userId);
  }
}

export function getTeamsForUser(userId) {
  return db.prepare(
    'SELECT t.*, tm.role, tm.is_primary FROM teams t JOIN team_members tm ON t.id = tm.team_id WHERE tm.user_id = ? ORDER BY tm.is_primary DESC, t.name'
  ).all(userId);
}

export function getTeamProjects(teamId) {
  return db.prepare('SELECT * FROM projects WHERE team_id = ?').all(teamId);
}
