// =============== MYCELIUM — DB entity: node profiles + calibration ===============
// Extracted from server/db.js (Wave 3 of the decomposition). Coupling:
// `resolveProfileChain` imports `getAgent` (agents);
// `buildCalibrationBlock` imports `getLatestSavepoint` (savepoints) +
// `getContextKey`/`upsertContextKey` (context) — 3-module fan-out, and it
// WRITES (persists the `standup` context key). `seedPlatformProfiles` is one of
// the three initDB seeds — the barrel's initDB calls this import directly. The
// private NODE_PROFILE_JSON_FIELDS / stringifyProfileField / parseProfileRow
// helpers move with the module and stay unexported. The functions below use the
// live `db` binding from ./core.js. Bodies moved VERBATIM. The barrel
// server/db.js re-exports these via `export * from './db/node-profiles.js'` so
// no consumer changes a single import.
import { db } from './core.js';
import { getAgent } from './agents.js';
import { getLatestSavepoint } from './savepoints.js';
import { getContextKey, upsertContextKey } from './context.js';

// =============== NODE PROFILES — Stand Up Calibration ===============

var NODE_PROFILE_JSON_FIELDS = ['rules', 'required_concepts', 'mcp_config', 'tool_whitelist', 'repo_list', 'md_checkpoints', 'md_blocklist'];

function stringifyProfileField(val) {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function parseProfileRow(row) {
  if (!row) return null;
  for (var f of NODE_PROFILE_JSON_FIELDS) {
    if (row[f]) {
      try { row[f] = JSON.parse(row[f]); } catch (e) { /* keep as string */ }
    }
  }
  return row;
}

export function createNodeProfile(id, data) {
  var d = data || {};
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    d.node_type || 'agent',
    d.layer || 'customer',
    d.parent_id || null,
    stringifyProfileField(d.rules) || '{}',
    stringifyProfileField(d.required_concepts) || '[]',
    stringifyProfileField(d.mcp_config) || '{}',
    stringifyProfileField(d.tool_whitelist) || '[]',
    stringifyProfileField(d.repo_list) || '[]',
    stringifyProfileField(d.md_checkpoints) || '[]',
    stringifyProfileField(d.md_blocklist) || '[]'
  );
  return getNodeProfile(id);
}

export function getNodeProfile(id) {
  var row = db.prepare('SELECT * FROM node_profiles WHERE id = ?').get(id);
  return parseProfileRow(row);
}

export function listNodeProfiles(filter) {
  var where = [];
  var params = [];
  if (filter && filter.node_type) { where.push('node_type = ?'); params.push(filter.node_type); }
  if (filter && filter.layer) { where.push('layer = ?'); params.push(filter.layer); }
  var sql = 'SELECT * FROM node_profiles' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY layer, node_type, id';
  var rows = db.prepare(sql).all.apply(db.prepare(sql), params);
  return rows.map(parseProfileRow);
}

export function updateNodeProfile(id, data) {
  var existing = getNodeProfile(id);
  if (!existing) return null;
  if (existing.layer === 'platform') return null;

  var sets = ["updated_at = datetime('now')"];
  var values = [];
  if (data.node_type !== undefined) { sets.push('node_type = ?'); values.push(data.node_type); }
  if (data.layer !== undefined) { sets.push('layer = ?'); values.push(data.layer); }
  if (data.parent_id !== undefined) { sets.push('parent_id = ?'); values.push(data.parent_id); }
  for (var f of NODE_PROFILE_JSON_FIELDS) {
    if (data[f] !== undefined) { sets.push(f + ' = ?'); values.push(stringifyProfileField(data[f])); }
  }
  if (values.length === 0) return existing;
  values.push(id);
  db.prepare('UPDATE node_profiles SET ' + sets.join(', ') + ' WHERE id = ?').run.apply(
    db.prepare('UPDATE node_profiles SET ' + sets.join(', ') + ' WHERE id = ?'), values
  );
  return getNodeProfile(id);
}

export function deleteNodeProfile(id) {
  var existing = getNodeProfile(id);
  if (!existing) return null;
  if (existing.layer === 'platform') return null;
  db.prepare('DELETE FROM node_profiles WHERE id = ?').run(id);
  return existing;
}

export function resolveProfileChain(agentId) {
  // Load agent to determine type
  var agent = getAgent(agentId);
  var agentType = (agent && agent.agent_type) ? agent.agent_type : 'agent';

  // Build chain: platform default -> customer default -> agent-specific
  var chainIds = [
    'default-' + agentType,
    'customer-' + agentType,
    agentId
  ];

  var merged = {
    rules: {},
    required_concepts: [],
    mcp_config: {},
    tool_whitelist: [],
    repo_list: [],
    md_checkpoints: [],
    md_blocklist: [],
    layers_applied: []
  };

  // Track platform critical rules so they can't be downgraded
  var platformCritical = {};

  for (var profileId of chainIds) {
    var profile = getNodeProfile(profileId);
    if (!profile) continue;

    merged.layers_applied.push({ id: profile.id, layer: profile.layer, node_type: profile.node_type });

    // Merge rules: later layers override, but can't downgrade platform critical severity
    var rules = profile.rules || {};
    for (var ruleKey in rules) {
      if (profile.layer === 'platform' && rules[ruleKey].severity === 'critical') {
        platformCritical[ruleKey] = true;
      }
      if (platformCritical[ruleKey] && profile.layer !== 'platform') {
        // Can't downgrade platform critical — keep severity, allow other fields to merge
        var incoming = typeof rules[ruleKey] === 'object' ? Object.assign({}, rules[ruleKey]) : { severity: rules[ruleKey] };
        incoming.severity = 'critical';
        merged.rules[ruleKey] = incoming;
      } else {
        merged.rules[ruleKey] = rules[ruleKey];
      }
    }

    // Overlay objects: mcp_config
    var mcp = profile.mcp_config || {};
    for (var mk in mcp) {
      merged.mcp_config[mk] = mcp[mk];
    }

    // Concatenate + deduplicate arrays
    var arrayFields = ['required_concepts', 'tool_whitelist', 'repo_list', 'md_checkpoints', 'md_blocklist'];
    for (var af of arrayFields) {
      var arr = profile[af];
      if (Array.isArray(arr)) {
        for (var item of arr) {
          if (merged[af].indexOf(item) === -1) {
            merged[af].push(item);
          }
        }
      }
    }
  }

  return merged;
}

// ---- Seed Platform Profiles ----

export function seedPlatformProfiles() {
  // Only seed if default-agent doesn't exist yet
  var existing = db.prepare('SELECT id FROM node_profiles WHERE id = ?').get('default-agent');
  if (existing) return;

  // default-agent: base rules for all agents
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'default-agent',
    'agent',
    'platform',
    null,
    JSON.stringify({
      honesty: { severity: 'critical', description: 'Never fabricate information or pretend something worked when it did not' },
      evidence_based: { severity: 'critical', description: 'Verify files exist before editing. Read before writing. No guessing.' },
      identity: { severity: 'high', description: 'Maintain assigned agent identity. Do not impersonate other agents.' },
      communication: { severity: 'high', description: 'Report failures immediately. Use clear, direct language.' },
      coordination: { severity: 'high', description: 'Update the network when fixing bugs, completing steps, or assigning work.' },
      security: { severity: 'critical', description: 'Never commit secrets, credentials, or API keys. Never expose admin keys.' },
      paid_services: { severity: 'critical', description: 'Never call paid APIs without explicit approval. No unauthorized spending.' },
      code_standards: { severity: 'medium', description: 'Follow existing codebase conventions. Match style of surrounding code.' }
    }),
    '[]',
    '{}',
    '[]',
    '[]',
    JSON.stringify(['mycelium_boot', 'No guessing', 'No silent failures']),
    JSON.stringify(['studio_boot', 'studio_get_work', 'studio_read_messages', 'generate_sprites.py', 'Pixel Arena', 'Some of You May Die'])
  );

  // default-drone: minimal rules for GPU/CPU workers
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'default-drone',
    'drone',
    'platform',
    null,
    JSON.stringify({
      execution: { severity: 'critical', description: 'Execute assigned jobs faithfully. Report results accurately.' },
      no_messages: { severity: 'high', description: 'Drones do not send messages or participate in coordination. Execute only.' }
    }),
    '[]',
    '{}',
    '[]',
    '[]',
    '[]',
    '[]'
  );

  // default-admin: inherits agent rules + coordination emphasis
  db.prepare(
    'INSERT INTO node_profiles (id, node_type, layer, parent_id, rules, required_concepts, mcp_config, tool_whitelist, repo_list, md_checkpoints, md_blocklist) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'default-admin',
    'admin',
    'platform',
    'default-agent',
    JSON.stringify({
      honesty: { severity: 'critical', description: 'Never fabricate information or pretend something worked when it did not' },
      evidence_based: { severity: 'critical', description: 'Verify files exist before editing. Read before writing. No guessing.' },
      identity: { severity: 'high', description: 'Maintain assigned agent identity. Do not impersonate other agents.' },
      communication: { severity: 'high', description: 'Report failures immediately. Use clear, direct language.' },
      coordination: { severity: 'critical', description: 'Coordinate work across all agents. Ensure no agent is idle. Route tasks by domain.' },
      security: { severity: 'critical', description: 'Never commit secrets, credentials, or API keys. Never expose admin keys.' },
      paid_services: { severity: 'critical', description: 'Never call paid APIs without explicit approval. No unauthorized spending.' },
      code_standards: { severity: 'medium', description: 'Follow existing codebase conventions. Match style of surrounding code.' }
    }),
    '[]',
    '{}',
    '[]',
    '[]',
    JSON.stringify(['mycelium_boot', 'No guessing', 'No silent failures']),
    JSON.stringify(['studio_boot', 'studio_get_work', 'studio_read_messages', 'generate_sprites.py', 'Pixel Arena', 'Some of You May Die'])
  );

  console.log('Seeded platform node profiles: default-agent, default-drone, default-admin');
}

// ---- Stand Up: Calibration Block ----

export function buildCalibrationBlock(agentId) {
  var resolved = resolveProfileChain(agentId);
  var drift = [];

  // Get latest savepoint to extract md_report
  var savepoint = getLatestSavepoint(agentId);
  var stateSnapshot = {};
  if (savepoint && savepoint.state_snapshot) {
    if (typeof savepoint.state_snapshot === 'object') {
      stateSnapshot = savepoint.state_snapshot;
    } else {
      try { stateSnapshot = JSON.parse(savepoint.state_snapshot || '{}'); } catch (e) { /* */ }
    }
  }

  var mdReport = stateSnapshot.md_report || null;

  // Also check context key for md_report (heartbeat may have persisted it)
  if (!mdReport) {
    var mdCtx = getContextKey(agentId, 'md_report');
    if (mdCtx && mdCtx.data) {
      try { mdReport = typeof mdCtx.data === 'object' ? mdCtx.data : JSON.parse(mdCtx.data); } catch (e) { /* */ }
    }
  }

  if (mdReport) {
    // Check anchors: md_checkpoints should be present in agent's CLAUDE.md
    var checkpoints = resolved.md_checkpoints || [];
    var anchorsPresent = mdReport.anchors_present || [];
    for (var i = 0; i < checkpoints.length; i++) {
      var cp = checkpoints[i];
      if (anchorsPresent.indexOf(cp) === -1) {
        drift.push({ level: 'warning', rule: 'md_checkpoint_missing', detail: 'Expected anchor not found in CLAUDE.md: ' + cp });
      }
    }

    // Check blocklist: md_blocklist items should NOT be present
    var blocklist = resolved.md_blocklist || [];
    var blocklistFound = mdReport.blocklist_found || [];
    for (var j = 0; j < blocklist.length; j++) {
      var bl = blocklist[j];
      if (blocklistFound.indexOf(bl) !== -1) {
        drift.push({ level: 'critical', rule: 'md_blocklist_found', detail: 'Blocked term found in CLAUDE.md: ' + bl });
      }
    }
  } else {
    drift.push({ level: 'info', rule: 'md_report_missing', detail: 'Send md_report in heartbeat state_snapshot to enable CLAUDE.md drift detection' });
  }

  // Determine status based on drift items
  var status = 'aligned';
  for (var d = 0; d < drift.length; d++) {
    if (drift[d].level === 'critical') { status = 'critical'; break; }
    if (drift[d].level === 'warning') { status = 'drifted'; }
  }

  var calibration = {
    status: status,
    profile_chain: resolved.layers_applied || [],
    rules: resolved.rules || {},
    drift: drift,
    md_checkpoints: resolved.md_checkpoints || [],
    md_blocklist: resolved.md_blocklist || [],
    last_standup: new Date().toISOString()
  };

  // Persist to context key
  upsertContextKey(agentId, 'standup', JSON.stringify(calibration), 'system');

  return calibration;
}
