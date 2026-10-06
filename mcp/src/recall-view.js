// Trust Layer P1.2 (PROGRAM-mycelium-trust-layer §P1.2): the CLIENT side of
// "memory is data, never authority". The MCP tool texts a model reads render
// recalled/stored content — savepoint handoff, memory-search hits, extracted
// facts — and until now that text was interpolated raw into prose that reads
// as instructions. Every renderer here pushes the recalled fields through the
// ONE shared memory fence (server/lib/memory-fence.js) so a client that
// pastes a recall into a prompt brings the fence with it.
//
// The renderers are pure (rows in → lines out) so the injection canaries in
// test/unit/memory-fence.test.js run them without an MCP server or API.
//
// Boundary (deliberate, recorded in the P1.2 PR): directives, requests and
// work-queue items stay OUTSIDE the fence — they are the live work channel,
// authority-carrying by design; recalled handoff/memory content is not. The
// agent roster's working_on lines sit on the RECALLED side of that line even
// though they are not "memory search results": they are self-set stored text
// rendered CROSS-AGENT (review A blocker @ b89ca693 — a multi-line working_on
// reached the boot seed raw), so agentRosterLines below fences them like any
// other recalled row. The same side holds for the roster's display_name — it
// is agents.name, AGENT-settable via PUT /agents/:id (review A round 2 blocker
// @ 8e5e6909) — for the boot seed's role contract (description, responsibilities,
// constraints, guidelines: stored text lifted from the peer-authored
// roles/<agentId> context key into `-`/`!` scaffolding; write side closed by
// making roles/ admin-owned for new keys), for agent_profiles (self-set via
// PUT /agents/:id/profile, rendered cross-agent by studio_agent_profile), and
// for the overview's recent_activity lines (event summaries embed working_on
// verbatim).

import { fenceRecalledMemory } from '../../server/lib/memory-fence.js';

// Push a fenced block of recalled rows into `lines` (skip when no rows).
function pushFencedRecall(lines, rows) {
  var block = fenceRecalledMemory(rows);
  if (!block) return;
  for (var line of block.split('\n')) lines.push(line);
}

// The public row-level twin of pushFencedRecall: fence arbitrary recalled rows
// into render lines ([] when there is nothing to fence). Call sites that build
// their own metadata header lines (the drone roster) collect recalled rows and
// push these.
export function fencedRecallLines(rows) {
  var block = fenceRecalledMemory(rows);
  return block ? block.split('\n') : [];
}

// --- studio_boot: the Session-Resume section -------------------------------
// sp: data.savepoint (has_savepoint already checked by the caller).
// opts: { hasDirectives, changesSinceLast } — the boot handler's context.
// Recalled fields (was_working_on, notes, progress entries, claimed item and
// plan-step titles — all stored, notes cross-agent-writable via
// mycelium_leave_notes) are fenced; the handler's own framing, the computed
// change counts and the action line stay outside the fence.
export function bootSavepointSection(sp, opts) {
  var options = opts || {};
  var prevState = sp.previous_state || {};
  var cleanShutdown = prevState.session_end === true;
  var lines = [''];

  if (options.hasDirectives) {
    if (sp.was_working_on) lines.push('=== Session Resume (PAUSED — handle directives first) ===');
    pushFencedRecall(lines, resumeRows(sp, prevState));
    return lines;
  }

  if (sp.was_working_on || prevState.claimed_item || prevState.current_step) {
    lines.push('=== RESUME SESSION' + (cleanShutdown ? '' : ' (previous session did not shut down cleanly)') + ' ===');
    pushFencedRecall(lines, resumeRows(sp, prevState));
    if (sp.summary) {
      var changeParts = [];
      if (sp.summary.messages) changeParts.push(sp.summary.messages + ' new message(s)');
      if (sp.summary.tasks) changeParts.push(sp.summary.tasks + ' task change(s)');
      if (sp.summary.plans) changeParts.push(sp.summary.plans + ' plan change(s)');
      if (sp.summary.bugs) changeParts.push(sp.summary.bugs + ' bug change(s)');
      if (sp.summary.context) changeParts.push(sp.summary.context + ' context update(s)');
      if (changeParts.length) lines.push('Changes while away: ' + changeParts.join(', '));
    } else if (options.changesSinceLast) {
      lines.push('Changes while away: ' + options.changesSinceLast);
    }
    lines.push('Action: Check messages/requests first if any pending, then continue where you left off.');
  } else {
    lines.push('=== Session Resume ===');
    lines.push('Last session: idle');
    pushFencedRecall(lines, resumeRows(sp, prevState));
    if (options.changesSinceLast) lines.push('Changes: ' + options.changesSinceLast);
  }
  return lines;
}

// The savepoint's recalled fields as fence rows (labels on the rows so the
// datamarked lines stay readable).
function resumeRows(sp, prevState) {
  var rows = [];
  if (sp.was_working_on) rows.push('working_on: ' + sp.was_working_on);
  if (prevState.claimed_item) {
    var ci = prevState.claimed_item;
    rows.push('claimed: ' + (ci.type || 'item') + ' #' + ci.id + (ci.title ? ' — ' + ci.title : ''));
  }
  if (prevState.current_step) {
    var cs = prevState.current_step;
    rows.push('plan_step: plan #' + cs.plan_id + ' step #' + cs.step_id + (cs.title ? ' — ' + cs.title : ''));
  }
  if (prevState.progress && prevState.progress.length > 0) {
    for (var pn of prevState.progress) rows.push('progress: ' + pn);
  }
  if (sp.notes) rows.push('notes: ' + sp.notes);
  return rows;
}

// --- studio_view_savepoint ---------------------------------------------------
// Header fields (agent id, heartbeat, session id) are server-owned metadata
// and stay outside; everything the savepoint STORES (working_on, notes,
// state snapshot — notes cross-agent-writable) is fenced.
export function savepointViewLines(sp) {
  var lines = [
    '=== Savepoint for ' + sp.agent_id + ' ===',
    'Last heartbeat: ' + (sp.heartbeat_at || 'unknown'),
    'Session: ' + (sp.session_id || 'none')
  ];
  var rows = [];
  if (sp.working_on) rows.push('working_on: ' + sp.working_on);
  if (sp.notes) rows.push('notes: ' + sp.notes);
  if (sp.state_snapshot && sp.state_snapshot !== '{}') {
    var state = sp.state_snapshot;
    try { state = JSON.stringify(JSON.parse(sp.state_snapshot), null, 2); } catch { /* keep raw */ }
    rows.push('state: ' + state);
  }
  pushFencedRecall(lines, rows);
  return lines;
}

// --- studio_savepoint_diff ---------------------------------------------------
// was_working_on + notes are the recalled handoff (fenced); the change counts
// are computed numbers (outside). The old "NOTES FROM ADMIN" framing is gone:
// notes are written by any agent via mycelium_leave_notes, so claiming an
// admin origin was itself an injection-friendly lie.
export function savepointDiffLines(diff) {
  var lines = ['=== Changes since savepoint (' + diff.savepoint_at + ') ==='];
  pushFencedRecall(lines, diffRecallRows(diff));
  var s = diff.summary || {};
  lines.push('');
  lines.push('Changes:');
  if (s.messages > 0) lines.push('  ' + s.messages + ' new messages');
  if (s.tasks > 0) lines.push('  ' + s.tasks + ' tasks changed');
  if (s.context > 0) lines.push('  ' + s.context + ' context keys updated');
  if (s.plans > 0) lines.push('  ' + s.plans + ' plans changed');
  if (s.bugs > 0) lines.push('  ' + s.bugs + ' bugs changed');
  if (s.drone_jobs > 0) lines.push('  ' + s.drone_jobs + ' drone jobs changed');
  if (s.events > 0) lines.push('  ' + s.events + ' events since');
  if (s.messages === 0 && s.tasks === 0 && s.context === 0 && s.plans === 0 && s.bugs === 0 && s.drone_jobs === 0) {
    lines.push('  No changes detected.');
  }
  return lines;
}

function diffRecallRows(diff) {
  var rows = [];
  if (diff.was_working_on) rows.push('was_working_on: ' + diff.was_working_on);
  if (diff.notes) rows.push('notes: ' + diff.notes);
  return rows;
}

// --- the dynamic plugin recall tools -----------------------------------------

// mycelium_memory_search: POST /memory/search → { results: [...] }.
export function renderSearchRecallView(result) {
  var results = (result && Array.isArray(result.results)) ? result.results : [];
  if (!results.length) return null;
  var rows = results.map(function (r) {
    var head = '[source_type=' + (r.source_type || '?') + ' id=' + (r.source_id || r.id || '?');
    if (r.score !== undefined) head += ' score=' + r.score;
    head += '] ';
    return head + (r.text || r.content_text || '');
  });
  return fenceRecalledMemory(rows) || null;
}

// mycelium_auto_memory_facts: GET /auto-memory/facts → a bare array of facts.
// Same ID/category framing the consolidation prompt uses, so a model sees the
// two surfaces identically.
export function renderFactsRecallView(facts) {
  var list = Array.isArray(facts) ? facts : [];
  if (!list.length) return null;
  var rows = list.map(function (f) {
    return 'ID:' + f.id + ' [' + (f.category || 'general') + '] (confidence:' + f.confidence + ') ' + (f.fact_text || '');
  });
  return fenceRecalledMemory(rows) || null;
}

// Collapse newlines to spaces — a metadata line stays one physical line no
// matter what stored text carries. NOT a fence substitute: agent-settable
// fields go INSIDE the fence (rows below); this only keeps the server-owned
// metadata that remains outside single-line by construction.
function singleLine(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n?/g, '\n').split('\n').join(' ');
}

// --- the agent roster (boot seed / list_agents / the overview's Agents) ------
// working_on is SELF-SET stored text rendered CROSS-AGENT — the boot seed
// lists every other agent's line next to the savepoint recall — and so is the
// display name (agents.name, settable by the agent itself via PUT /agents/:id;
// review A round 2 blocker @ 8e5e6909). Stored text is stored text: every line
// of both travels inside the memory fence as a labelled datamarked row.
// Status flag, agent id, project and heartbeat are server-owned metadata (the
// heartbeat route enum-validates status; project and id are admin-set at
// creation and on the admin-only PUT block) and stay outside, single-line by
// construction. opts.formatHeartbeat — optional ISO→relative formatter for rows
// carrying a raw last_heartbeat (list/overview call sites); boot's slim rows
// carry either no heartbeat or a pre-formatted one.
export function agentRosterLines(agents, opts) {
  var list = Array.isArray(agents) ? agents : [];
  var formatHeartbeat = (opts && opts.formatHeartbeat) || null;
  var lines = [];
  var rows = [];
  for (var a of list) {
    if (!a || !a.id) continue;
    var line = '[' + (a.status === 'online' ? 'ON' : singleLine(a.status || 'offline').toUpperCase()) + '] ' + a.id;
    if (a.project_id) line += ' — ' + singleLine(a.project_id);
    var heartbeat = a.heartbeat || (formatHeartbeat && a.last_heartbeat ? formatHeartbeat(a.last_heartbeat) : '');
    if (heartbeat) line += ' | heartbeat ' + singleLine(heartbeat);
    lines.push(line);
    if (a.display_name || a.name) rows.push('name (' + a.id + '): ' + (a.display_name || a.name));
    if (a.working_on) rows.push('working_on (' + a.id + '): ' + a.working_on);
  }
  pushFencedRecall(lines, rows);
  return lines;
}

// --- the boot seed's role contract --------------------------------------------
// buildRoleContract (server/db.js) lifts description / responsibilities /
// constraints / guidelines from the roles/<agentId> context key — peer-authored
// stored text (write side: roles/ is admin-owned for NEW keys since review A
// round 2; existing keys stay project-scoped) — and guidelines also from
// <project>/guidelines. The old render wrapped them in `- responsibility` /
// `! constraint` scaffolding RAW, so stored text wore authority-shaped framing
// in the boot seed. Every line now travels inside the memory fence as a
// labelled datamarked row. The metadata line keeps only admin-set fields
// (role via the admin-only PUT block; capabilities via admin creation/PUT),
// single-line by construction; llm_backend/llm_model are AGENT-settable
// (PUT /agents/:id self-fields + the heartbeat whitelist) so they are fenced
// rows too.
export function roleContractLines(rc) {
  var lines = ['', '=== Role Contract ==='];
  if (typeof rc === 'string') {
    // Defensive legacy shape — nothing in the repo produces a string role
    // contract today; if one ever does it is stored-shape text and gets the
    // fence like every other recalled row.
    pushFencedRecall(lines, ['role_contract: ' + rc]);
    return lines;
  }
  var contract = rc || {};
  lines.push('Role: ' + singleLine(contract.role || 'agent'));
  var rows = [];
  if (contract.llm_backend || contract.llm_model) {
    rows.push('llm: ' + singleLine(contract.llm_backend || '?') + '/' + singleLine(contract.llm_model || '?'));
  }
  if (contract.description) rows.push('description: ' + contract.description);
  if (contract.responsibilities && contract.responsibilities.length) {
    for (var resp of contract.responsibilities) rows.push('responsibility: ' + resp);
  }
  if (contract.constraints && contract.constraints.length) {
    for (var con of contract.constraints) rows.push('constraint: ' + con);
  }
  if (contract.guidelines) rows.push('guidelines: ' + contract.guidelines);
  pushFencedRecall(lines, rows);
  if (contract.capabilities && contract.capabilities.length) {
    lines.push('Can: ' + contract.capabilities.map(singleLine).join(', '));
  }
  return lines;
}

// --- studio_agent_profile: the fenced view of self-set profile fields ---------
// display_name / specializations / preferred_projects / profile_data are set by
// the agent itself (PUT /agents/:id/profile) and the tool hands the profile to
// OTHER agents. The tool keeps its FIRST content block byte-identical (the raw
// JSON programs parse) and appends this fence as a second block — the same
// shape studio_get_context got in review A minor 1.
export function renderProfileRecallView(profile) {
  if (!profile || typeof profile !== 'object') return null;
  var rows = [];
  if (profile.display_name) rows.push('display_name: ' + profile.display_name);
  if (profile.specializations) rows.push('specializations: ' + profile.specializations);
  if (profile.preferred_projects) rows.push('preferred_projects: ' + profile.preferred_projects);
  if (profile.profile_data !== undefined && profile.profile_data !== null) {
    rows.push('profile_data: ' + (typeof profile.profile_data === 'string' ? profile.profile_data : JSON.stringify(profile.profile_data)));
  }
  if (!rows.length) return null;
  return fenceRecalledMemory(rows) || null;
}

// --- studio_get_context: the fenced view of stored context values ------------
// Context keys are memory too (the auto-index path indexes every context-key
// update), and a model reads the tool result — so the stored value gets the
// same fenced second block memory_search got. The caller keeps its FIRST
// content block byte-identical and appends this as a second block.
export function renderContextRecallView(value) {
  if (value === null || value === undefined) return null;
  var rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!rendered.trim()) return null;
  return fenceRecalledMemory(['context: ' + rendered]) || null;
}
