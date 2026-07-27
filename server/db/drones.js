// =============== MYCELIUM — DB entity: drone jobs, profiles, templates, diagnostics, renderer ===============
// Extracted from server/db.js (Wave 4 of the decomposition). Coupling: drones
// ARE agents rows (project_id='drone' / role='drone') — listDrones / pauseDrone
// / resumeDrone / getDroneStatus / updateDroneDiagnostics read/write the
// `agents` table by raw SQL (stays, note only, no import needed).
// `renderJobForDrone` + `checkDroneCompatibility` import `getLatestSavepoint`
// (savepoints) for the diagnostics fallback. `seedDefaultJobTemplates` is one
// of the three initDB seeds — the barrel's composed initDB calls this import
// instead of a local copy. `claimDroneJob` is a db.transaction;
// `renderJobForDrone` carries the C-2 SHELL_META injection guard — byte-
// identical move, it's security-load-bearing. The functions below use the live
// `db` + `buildUpdate` bindings from ./core.js. Bodies moved VERBATIM. The
// barrel server/db.js re-exports these via `export * from './db/drones.js'` so
// no consumer changes a single import.
import { db, buildUpdate } from './core.js';
import { getLatestSavepoint } from './savepoints.js';

// -- Drone Jobs --

export function createDroneJob(title, command, inputData, requires, requester, priority, workspaceRepo, workspaceBranch, profileId) {
  var result = db.prepare(
    "INSERT INTO drone_jobs (title, command, input_data, requires, requester, priority, workspace_repo, workspace_branch, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(
    title,
    command || '',
    typeof inputData === 'string' ? inputData : JSON.stringify(inputData || {}),
    typeof requires === 'string' ? requires : JSON.stringify(requires || ['cpu']),
    requester,
    priority || 0,
    workspaceRepo || null,
    workspaceBranch || 'main',
    profileId || null
  );
  return result.id;
}

export function getDroneJob(id) {
  return db.prepare("SELECT * FROM drone_jobs WHERE id = ?").get(id);
}

export function claimDroneJob(droneId, capabilities) {
  var caps = Array.isArray(capabilities) ? capabilities : [];

  return db.transaction(function () {
    var pending = db.prepare(
      "SELECT * FROM drone_jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC"
    ).all();

    for (var i = 0; i < pending.length; i++) {
      var job = pending[i];
      var reqs = [];
      try { reqs = JSON.parse(job.requires || '["cpu"]'); } catch (e) { console.warn('[mycelium] JSON parse failed for job.requires (job: ' + job.id + '):', e.message); reqs = ['cpu']; }
      var matched = reqs.every(function (r) { return caps.indexOf(r) !== -1; });
      if (!matched) continue;

      if (job.profile_id) {
        var assignment = db.prepare(
          "SELECT setup_done FROM drone_profile_assignments WHERE drone_id = ? AND profile_id = ?"
        ).get(droneId, job.profile_id);
        if (!assignment || !assignment.setup_done) continue;
      }

      var result = db.prepare(
        "UPDATE drone_jobs SET status = 'claimed', drone_id = ?, started_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(droneId, job.id);
      if (result.changes > 0) return getDroneJob(job.id);
    }
    return null;
  })();
}

export function updateDroneJob(id, fields) {
  var f = Object.assign({}, fields);
  if (f.input_data !== undefined && typeof f.input_data !== 'string') f.input_data = JSON.stringify(f.input_data);
  if (f.result_data !== undefined && typeof f.result_data !== 'string') f.result_data = JSON.stringify(f.result_data);
  buildUpdate('drone_jobs', id, f, ['status', 'command', 'input_data', 'result_url', 'result_data', 'error', 'completed_at', 'drone_id', 'started_at']);
}

export function listDroneJobs(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.drone_id) { where.push('drone_id = ?'); params.push(filters.drone_id); }
  if (filters.requester) { where.push('requester = ?'); params.push(filters.requester); }
  var limit = Math.min(filters.limit || 50, 200);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM drone_jobs WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params);
}

// Bug #137: Release stale claimed jobs (claimed >1 hour ago, not completed)
// If droneId provided, scoped to that drone. Otherwise releases ALL stale jobs.
export function releaseStaleClaimedJobs(droneId) {
  var staleJobs;
  if (droneId) {
    staleJobs = db.prepare(
      "SELECT * FROM drone_jobs WHERE status = 'claimed' AND drone_id = ? AND started_at < datetime('now', '-1 hour')"
    ).all(droneId);
  } else {
    staleJobs = db.prepare(
      "SELECT * FROM drone_jobs WHERE status = 'claimed' AND started_at < datetime('now', '-1 hour')"
    ).all();
  }
  var msg = droneId
    ? '[stale_timeout] Job was claimed for >1 hour with no completion. Auto-failed on drone restart.'
    : '[stale_timeout] Job was claimed for >1 hour with no progress. Auto-failed by server.';
  for (var job of staleJobs) {
    db.prepare(
      "UPDATE drone_jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(msg, job.id);
  }
  return staleJobs;
}

export function listDrones() {
  return db.prepare("SELECT id, name, project_id, status, working_on, last_heartbeat, capabilities, created_at FROM agents WHERE project_id = 'drone' ORDER BY created_at").all();
}

export function pauseDrone(droneId) {
  db.prepare(`UPDATE agents SET status = 'paused', working_on = 'Paused (GPU released)' WHERE id = ?`).run(droneId);
  return { ok: true, status: 'paused' };
}

export function resumeDrone(droneId) {
  db.prepare(`UPDATE agents SET status = 'online', working_on = '' WHERE id = ?`).run(droneId);
  return { ok: true, status: 'online' };
}

export function getDroneStatus(droneId) {
  var agent = db.prepare(`SELECT id, name, status, working_on, capabilities, last_heartbeat FROM agents WHERE id = ?`).get(droneId);
  if (!agent) return null;
  var pendingJobs = db.prepare(`SELECT COUNT(*) as count FROM drone_jobs WHERE status = 'pending'`).get();
  return {
    ...agent,
    capabilities: JSON.parse(agent.capabilities || '[]'),
    queued_jobs: pendingJobs.count
  };
}

// -- Drone Profiles --

export function createDroneProfile(id, name, description, requires, artifacts, setupScript, workspace, env) {
  db.prepare(
    "INSERT INTO drone_profiles (id, name, description, requires, artifacts, setup_script, workspace, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id, name, description || '',
    typeof requires === 'string' ? requires : JSON.stringify(requires || {}),
    typeof artifacts === 'string' ? artifacts : JSON.stringify(artifacts || []),
    setupScript || '',
    workspace || '',
    typeof env === 'string' ? env : JSON.stringify(env || {})
  );
  return getDroneProfile(id);
}

export function getDroneProfile(id) {
  return db.prepare("SELECT * FROM drone_profiles WHERE id = ?").get(id);
}

export function listDroneProfiles() {
  return db.prepare("SELECT * FROM drone_profiles ORDER BY created_at").all();
}

export function updateDroneProfile(id, fields) {
  var sets = [];
  var values = [];
  for (var key of ['name', 'description', 'setup_script', 'workspace']) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  for (var jsonKey of ['requires', 'artifacts', 'env']) {
    if (fields[jsonKey] !== undefined) {
      sets.push(jsonKey + ' = ?');
      values.push(typeof fields[jsonKey] === 'string' ? fields[jsonKey] : JSON.stringify(fields[jsonKey]));
    }
  }
  if (sets.length === 0) return getDroneProfile(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare('UPDATE drone_profiles SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  // Invalidate setup_done for all drones assigned to this profile
  db.prepare("UPDATE drone_profile_assignments SET setup_done = 0, checksum = '' WHERE profile_id = ?").run(id);
  return getDroneProfile(id);
}

export function deleteDroneProfile(id) {
  return db.prepare("DELETE FROM drone_profiles WHERE id = ?").run(id);
}

export function assignDroneProfile(droneId, profileId) {
  db.prepare(
    "INSERT OR REPLACE INTO drone_profile_assignments (drone_id, profile_id, setup_done, checksum) VALUES (?, ?, 0, '')"
  ).run(droneId, profileId);
}

export function unassignDroneProfile(droneId, profileId) {
  return db.prepare("DELETE FROM drone_profile_assignments WHERE drone_id = ? AND profile_id = ?").run(droneId, profileId);
}

export function getDroneProfileAssignments(droneId) {
  return db.prepare(
    "SELECT a.*, p.name, p.description, p.requires, p.artifacts, p.setup_script, p.workspace, p.env, p.updated_at as profile_updated_at " +
    "FROM drone_profile_assignments a JOIN drone_profiles p ON a.profile_id = p.id WHERE a.drone_id = ? ORDER BY p.created_at"
  ).all(droneId);
}

export function markProfileSetupDone(droneId, profileId, checksum) {
  db.prepare(
    "UPDATE drone_profile_assignments SET setup_done = 1, setup_at = datetime('now'), checksum = ? WHERE drone_id = ? AND profile_id = ?"
  ).run(checksum || '', droneId, profileId);
}

export function getDronesWithProfile(profileId) {
  return db.prepare(
    "SELECT a.drone_id, a.setup_done, a.setup_at, a.checksum, ag.status, ag.last_heartbeat " +
    "FROM drone_profile_assignments a JOIN agents ag ON a.drone_id = ag.id WHERE a.profile_id = ?"
  ).all(profileId);
}

export function bulkCancelDroneJobs(statuses, olderThanDays) {
  var placeholders = statuses.map(function () { return '?'; }).join(',');
  var params = statuses.slice();
  var where = 'status IN (' + placeholders + ')';
  if (parseInt(olderThanDays) > 0) {
    where += " AND completed_at < datetime('now', '-' || ? || ' days')";
    params.push(String(parseInt(olderThanDays)));
  }
  var jobs = db.prepare('SELECT id, title, status FROM drone_jobs WHERE ' + where).all.apply(
    db.prepare('SELECT id, title, status FROM drone_jobs WHERE ' + where), params
  );
  if (jobs.length > 0) {
    var idPlaceholders = jobs.map(function () { return '?'; }).join(',');
    var ids = jobs.map(function (j) { return j.id; });
    db.prepare("UPDATE drone_jobs SET status = 'cancelled' WHERE id IN (" + idPlaceholders + ')').run.apply(
      db.prepare("UPDATE drone_jobs SET status = 'cancelled' WHERE id IN (" + idPlaceholders + ')'), ids
    );
  }
  return jobs;
}

// -- Job Templates --

// Seed the 3d_print template so new instances support printer drones out of the box.
export function seedDefaultJobTemplates() {
  var existing = db.prepare("SELECT id FROM job_templates WHERE id = '3d_print'").get();
  if (!existing) {
    db.prepare(
      "INSERT INTO job_templates (id, name, project_id, requires, min_vram_gb, min_disk_gb) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('3d_print', '3D Print Job', '', '["3d_printer"]', 0, 1);
    console.log('Seeded 3d_print job template');
  }
}

export function createJobTemplate(id, fields) {
  db.prepare(
    "INSERT INTO job_templates (id, name, project_id, requires, min_vram_gb, min_disk_gb, python_deps, python_deps_install, artifacts, setup_repo, command_template, workspace_name) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    fields.name || id,
    fields.project_id || '',
    typeof fields.requires === 'string' ? fields.requires : JSON.stringify(fields.requires || ['cpu']),
    fields.min_vram_gb || 0,
    fields.min_disk_gb || 5,
    typeof fields.python_deps === 'string' ? fields.python_deps : JSON.stringify(fields.python_deps || []),
    fields.python_deps_install || '',
    typeof fields.artifacts === 'string' ? fields.artifacts : JSON.stringify(fields.artifacts || []),
    fields.setup_repo || '',
    fields.command_template || '',
    fields.workspace_name || ''
  );
  return getJobTemplate(id);
}

export function getJobTemplate(id) {
  return db.prepare("SELECT * FROM job_templates WHERE id = ?").get(id);
}

export function listJobTemplates() {
  return db.prepare("SELECT * FROM job_templates ORDER BY created_at").all();
}

export function updateJobTemplate(id, fields) {
  var sets = [];
  var values = [];
  for (var key of ['name', 'project_id', 'python_deps_install', 'setup_repo', 'command_template', 'workspace_name']) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  for (var numKey of ['min_vram_gb', 'min_disk_gb']) {
    if (fields[numKey] !== undefined) { sets.push(numKey + ' = ?'); values.push(fields[numKey]); }
  }
  for (var jsonKey of ['requires', 'python_deps', 'artifacts']) {
    if (fields[jsonKey] !== undefined) {
      sets.push(jsonKey + ' = ?');
      values.push(typeof fields[jsonKey] === 'string' ? fields[jsonKey] : JSON.stringify(fields[jsonKey]));
    }
  }
  if (sets.length === 0) return getJobTemplate(id);
  values.push(id);
  db.prepare('UPDATE job_templates SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
  return getJobTemplate(id);
}

export function deleteJobTemplate(id) {
  return db.prepare("DELETE FROM job_templates WHERE id = ?").run(id);
}

// -- Drone Diagnostics --

export function updateDroneDiagnostics(agentId, diagnostics) {
  var json = typeof diagnostics === 'string' ? diagnostics : JSON.stringify(diagnostics);
  db.prepare("UPDATE agents SET system_diagnostics = ? WHERE id = ?").run(json, agentId);
}

export function getDroneDiagnostics(agentId) {
  var row = db.prepare("SELECT system_diagnostics FROM agents WHERE id = ?").get(agentId);
  if (!row) return null;
  try { return JSON.parse(row.system_diagnostics || '{}'); } catch (e) { return {}; }
}

// -- Platform Resolver + Command Renderer --

export function renderJobForDrone(templateId, droneId, inputData) {
  var template = getJobTemplate(templateId);
  if (!template) return { error: 'Template not found: ' + templateId };

  var diag = getDroneDiagnostics(droneId);
  if (!diag || Object.keys(diag).length === 0) {
    // Fall back to savepoint system_info
    var savepoint = getLatestSavepoint(droneId);
    if (savepoint) {
      try {
        var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
        diag = snapshot.system_info || {};
      } catch (e) { diag = {}; }
    }
  }
  if (!diag || Object.keys(diag).length === 0) {
    return { error: 'No diagnostics available for drone ' + droneId + '. Drone must heartbeat first.' };
  }

  // Compatibility checks
  var templateReqs = [];
  try { templateReqs = JSON.parse(template.requires || '["cpu"]'); } catch (e) { templateReqs = ['cpu']; }

  // Check GPU requirement
  if (templateReqs.indexOf('gpu') !== -1) {
    if (!diag.cuda_available && !diag.gpu_name) {
      return { error: 'Template requires GPU but drone has none', incompatible: true };
    }
    if (template.min_vram_gb > 0 && diag.gpu_vram_gb && diag.gpu_vram_gb < template.min_vram_gb) {
      return { error: 'Template requires ' + template.min_vram_gb + ' GB VRAM but drone has ' + diag.gpu_vram_gb + ' GB', incompatible: true };
    }
  }

  // Check disk
  if (template.min_disk_gb > 0 && diag.disk_free_gb && diag.disk_free_gb < template.min_disk_gb) {
    return { error: 'Template requires ' + template.min_disk_gb + ' GB free disk but drone has ' + diag.disk_free_gb + ' GB', incompatible: true };
  }

  // Resolve platform vars
  var isWindows = (diag.os || '').toLowerCase() === 'windows';
  var pythonPath = diag.python_path || (isWindows ? 'python' : 'python3');
  var home = diag.home || (isWindows ? 'C:/Users/' + (diag.username || 'user') : '/home/' + (diag.username || 'user'));
  var workspaceName = template.workspace_name || templateId;
  var workspace = home + '/.mycelium/workspaces/' + workspaceName;
  var nullDev = isWindows ? 'NUL' : '/dev/null';
  var pipInstall = pythonPath + ' -m pip install';
  var pathSep = isWindows ? ';' : ':';

  // Build setup steps
  var setupSteps = [];

  // Step 1: Download artifacts (handled by worker from input_data.artifacts)
  var templateArtifacts = [];
  try { templateArtifacts = JSON.parse(template.artifacts || '[]'); } catch (e) { templateArtifacts = []; }

  // Step 2: Clone setup_repo if specified
  if (template.setup_repo) {
    var repoDir = workspace + '/ai-toolkit';
    var checkClone = isWindows
      ? 'if exist "' + repoDir.replace(/\//g, '\\') + '" (exit /b 0) else (exit /b 1)'
      : 'test -d "' + repoDir + '"';
    setupSteps.push({
      name: 'Clone setup repo',
      check: checkClone,
      run: 'git clone "' + template.setup_repo + '" "' + repoDir + '"',
      skip_if_check_passes: true,
    });
  }

  // Step 3: Install CUDA torch (if GPU required)
  if (templateReqs.indexOf('gpu') !== -1) {
    setupSteps.push({
      name: 'Check/install CUDA PyTorch',
      check: pythonPath + ' -c "import torch; assert torch.cuda.is_available(), \'no cuda\'"',
      run: pipInstall + ' torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124',
      skip_if_check_passes: true,
    });
  }

  // Step 4: Install python deps
  if (template.python_deps_install) {
    var depsList = [];
    try { depsList = JSON.parse(template.python_deps || '[]'); } catch (e) { depsList = []; }
    var importChecks = depsList.map(function (d) {
      // PIL -> Pillow, map common package names
      var mod = d === 'PIL' ? 'PIL' : d;
      return 'import ' + mod;
    }).join('; ');
    setupSteps.push({
      name: 'Install Python dependencies',
      check: pythonPath + ' -c "' + importChecks + '"',
      run: pipInstall + ' ' + template.python_deps_install,
      skip_if_check_passes: true,
    });
  }

  // Render command template
  var vars = {
    python: pythonPath,
    pip_install: pipInstall,
    workspace: workspace,
    null_dev: nullDev,
    path_sep: pathSep,
  };
  // Merge inputData vars. These are user-supplied and get interpolated into a
  // command executed on the drone, so reject shell metacharacters (C-2): $ and
  // backtick do command substitution even inside quotes; ; | & < > chain and
  // redirect. Blocking them stops injection cross-OS without touching normal
  // prompt text (letters, spaces, commas, apostrophes, parens all pass).
  var SHELL_META = /[$`;|&<>\n\r\0]/;
  if (inputData && typeof inputData === 'object') {
    for (var k of Object.keys(inputData)) {
      if (k.startsWith('_')) continue;
      var v = inputData[k];
      if (typeof v === 'string' && SHELL_META.test(v)) {
        return { error: 'Input value for "' + k + '" contains disallowed shell characters ($ ` ; | & < > newline)' };
      }
      vars[k] = v;
    }
  }
  var command = template.command_template;
  for (var [varName, varVal] of Object.entries(vars)) {
    command = command.replace(new RegExp('\\{\\{' + varName + '\\}\\}', 'g'), String(varVal));
  }

  return {
    command: command,
    setup_steps: setupSteps,
    artifacts: templateArtifacts,
    requires: templateReqs,
    workspace: workspace,
    workspace_name: workspaceName,
    template_id: templateId,
    drone_diagnostics: {
      os: diag.os,
      python_path: pythonPath,
      gpu_name: diag.gpu_name,
      gpu_vram_gb: diag.gpu_vram_gb,
    },
  };
}

export function checkDroneCompatibility(droneId) {
  var templates = listJobTemplates();
  var diag = getDroneDiagnostics(droneId);
  if (!diag || Object.keys(diag).length === 0) {
    var savepoint = getLatestSavepoint(droneId);
    if (savepoint) {
      try {
        var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
        diag = snapshot.system_info || {};
      } catch (e) { diag = {}; }
    }
  }
  if (!diag || Object.keys(diag).length === 0) {
    return { drone_id: droneId, error: 'No diagnostics available', compatible: [], incompatible: [] };
  }

  var compatible = [];
  var incompatible = [];

  for (var t of templates) {
    var reqs = [];
    try { reqs = JSON.parse(t.requires || '["cpu"]'); } catch (e) { reqs = ['cpu']; }
    var issues = [];

    if (reqs.indexOf('gpu') !== -1) {
      if (!diag.cuda_available && !diag.gpu_name) {
        issues.push('Requires GPU, none detected');
      } else if (t.min_vram_gb > 0 && diag.gpu_vram_gb && diag.gpu_vram_gb < t.min_vram_gb) {
        issues.push('Requires ' + t.min_vram_gb + ' GB VRAM, has ' + diag.gpu_vram_gb + ' GB');
      }
    }
    if (t.min_disk_gb > 0 && diag.disk_free_gb && diag.disk_free_gb < t.min_disk_gb) {
      issues.push('Requires ' + t.min_disk_gb + ' GB disk, has ' + diag.disk_free_gb + ' GB');
    }

    if (issues.length === 0) {
      var notes = [];
      if (diag.gpu_name) notes.push(diag.gpu_name + ' ' + (diag.gpu_vram_gb || '?') + ' GB VRAM');
      if (diag.disk_free_gb) notes.push(diag.disk_free_gb + ' GB free disk');
      compatible.push({ template: t.id, name: t.name, status: 'ready', notes: notes.join(', ') });
    } else {
      incompatible.push({ template: t.id, name: t.name, status: 'incompatible', reasons: issues });
    }
  }

  return { drone_id: droneId, compatible: compatible, incompatible: incompatible };
}
