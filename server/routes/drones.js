// Drone routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import fs from 'fs';
import nodePath from 'path';
import {
  listDrones, getLatestSavepoint, createMessage, pauseDrone, resumeDrone,
  getDroneStatus, releaseStaleClaimedJobs, claimDroneJob, renderJobForDrone,
  getDB, updateDroneJob, getDroneProfile, getJobTemplate, createDroneJob,
  getDroneJob, listDroneJobs, listAssetsByDroneJob, updateAsset,
  bulkCancelDroneJobs, dispatchWebhook,
  listJobTemplates, createJobTemplate, updateJobTemplate, deleteJobTemplate,
  checkDroneCompatibility, listDroneProfiles, getDronesWithProfile,
  createDroneProfile, updateDroneProfile, deleteDroneProfile,
  assignDroneProfile, unassignDroneProfile, getDroneProfileAssignments,
  markProfileSetupDone, getAgent,
} from '../db.js';

export function registerDroneRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAgent, checkAdmin, checkGuardrails,
    agentWriteLimiter, escapeHtml, parseLimit, parseIntParam, validateEnum,
    apiError, emitEvent, getAdminDisplayName, isAdminKey, getStudioUser,
    requireAuth, artifactUpload, ARTIFACTS_DIR,
    DRONE_JOB_STATUSES,
  } = deps;

  // ======== DRONES ========

  // List all drones (agents with project_id='drone') with diagnostics
  router.get('/drones', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var drones = listDrones();
    // Enrich each drone with system diagnostics from latest savepoint
    drones = drones.map(function (d) {
      var savepoint = getLatestSavepoint(d.id);
      if (savepoint) {
        try {
          var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
          d.system_info = snapshot.system_info || null;
          d.warnings = snapshot.warnings || [];
          d.worker_version = snapshot.worker_version || null;
        } catch (e) { console.warn('[mycelium] JSON parse failed for state_snapshot (drone: ' + d.id + '):', e.message); }
      }
      return d;
    });
    res.json(drones);
  }));

  // Pause drone — stop job assignment, signal worker to unload models
  router.put('/drones/:id/pause', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var result = pauseDrone(req.params.id);
    try {
      createMessage(who, req.params.id, null, 'mycelium',
        JSON.stringify({ action: 'pause' }), '{}', 'message', null, 'normal');
    } catch (e) { /* best effort */ }
    res.json(result);
  }));

  // Resume drone — restart job assignment, signal worker to reload models
  router.put('/drones/:id/resume', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var result = resumeDrone(req.params.id);
    try {
      createMessage(who, req.params.id, null, 'mycelium',
        JSON.stringify({ action: 'resume' }), '{}', 'message', null, 'normal');
    } catch (e) { /* best effort */ }
    res.json(result);
  }));

  // Get drone status with queued job count
  router.get('/drones/:id/status', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var status = getDroneStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Drone not found' });
    res.json(status);
  }));

  // Claim next job matching drone capabilities (drone-side)
  // If the job has a job_type, render platform-specific commands from the template
  router.post('/drones/claim', asyncHandler(function (req, res) {
    var agentId = checkAgent(req, res);
    if (!agentId) return;
    var capabilities = req.body.capabilities || [];

    // Bug #137: Release stale claimed jobs before claiming new work
    // Auto-fail jobs claimed by this drone for >1 hour with no completion
    var staleJobs = releaseStaleClaimedJobs(agentId);
    var staleReleased = staleJobs.length;

    var job = claimDroneJob(agentId, capabilities);
    if (!job) return res.json({ job: null, stale_released: staleReleased });

    // If job has a job_type, render commands from template
    if (job.job_type) {
      var inputData = {};
      try { inputData = JSON.parse(job.input_data || '{}'); } catch (e) { inputData = {}; }
      var rendered = renderJobForDrone(job.job_type, agentId, inputData);
      if (rendered.error) {
        // Incompatible — unclaim and skip
        updateDroneJob(job.id, { status: 'pending' });
        // Remove drone_id by updating the raw record
        try { var db2 = getDB(); db2.prepare("UPDATE drone_jobs SET status = 'pending', drone_id = NULL, started_at = NULL WHERE id = ?").run(job.id); } catch (e) { /* fallback already set status */ }
        return res.json({ job: null, skipped: { job_id: job.id, reason: rendered.error } });
      }
      // Write rendered command back to the job (only if job doesn't already have one)
      if (!job.command) {
        updateDroneJob(job.id, { command: rendered.command });
      }
      // Bug #136: Merge template setup_steps/artifacts with job's own, instead of replacing
      // Job-specified artifacts take priority (appended after template artifacts, deduped)
      var jobArtifacts = inputData.artifacts || [];
      var templateArtifacts = rendered.artifacts || [];
      var mergedArtifacts = templateArtifacts.slice();
      for (var a of jobArtifacts) {
        if (mergedArtifacts.indexOf(a) === -1) mergedArtifacts.push(a);
      }
      inputData.artifacts = mergedArtifacts;
      // Job-specified setup_steps come after template steps
      var jobSetupSteps = inputData.setup_steps || [];
      inputData.setup_steps = (rendered.setup_steps || []).concat(jobSetupSteps);
      inputData.workspace_dir = rendered.workspace_name;
      updateDroneJob(job.id, { input_data: JSON.stringify(inputData) });
      // Return enriched job
      if (!job.command) job.command = rendered.command;
      job.input_data = JSON.stringify(inputData);
    }

    emitEvent('drone_job_claimed', agentId, 'drone', agentId + ' claimed drone job #' + job.id + ': ' + job.title, { job_id: job.id });
    res.json({ job: job });
  }));

  // Submit a drone job
  // Accepts optional job_type — when provided, auto-fills requires from template and command is rendered at claim time
  router.post('/drones/jobs', agentWriteLimiter, asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!checkGuardrails(req, res, 'drone_job_queued', { agent: who, title: req.body.title })) return;
    var title = escapeHtml(req.body.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    var command = req.body.command || '';
    // A raw command runs verbatim on the drone box (shell exec). Only admins may
    // submit one; non-admin agents must go through job_type/templates, whose
    // command is server-rendered from an admin-defined template. Without this
    // gate, any agent key = arbitrary code execution on every drone (C-1).
    if (command && !req._authIsAdmin) {
      return apiError(res, 403, 'Raw drone commands are admin-only. Submit a template job (job_type / from-template) instead.');
    }
    var inputData = req.body.input_data || {};
    // input_data.setup is a free-form command the drone shell-executes at
    // workspace setup (drone-worker.py). Like a raw `command`, only admins may
    // supply one — the render-time metachar reject (C-2) blocks shell operators
    // but not a bare command (`pip install evil`, `python -c "..."`), so an
    // ungated setup = RCE on the drone from any agent key. Non-admin setup must
    // come from an admin-defined template (setup_repo), not free-form input (C-4).
    if (inputData && inputData.setup !== undefined && !req._authIsAdmin) {
      return apiError(res, 403, 'input_data.setup is admin-only — it is shell-executed on the drone. Use a template setup_repo instead.');
    }
    var requires = req.body.requires || ['cpu'];
    var priority = parseInt(req.body.priority) || 0;
    var workspaceRepo = req.body.workspace_repo || null;
    var workspaceBranch = req.body.workspace_branch || 'main';
    var profileId = req.body.profile_id || null;
    var jobType = req.body.job_type || null;
    if (profileId && !getDroneProfile(profileId)) return res.status(400).json({ error: 'Profile not found: ' + profileId });
    // When job_type is provided, auto-fill requires from template
    if (jobType) {
      var template = getJobTemplate(jobType);
      if (!template) return res.status(400).json({ error: 'Job template not found: ' + jobType });
      try { requires = JSON.parse(template.requires || '["cpu"]'); } catch (e) { requires = ['cpu']; }
      if (!command) command = ''; // Command will be rendered at claim time
    }
    var id = createDroneJob(title, command, inputData, requires, who, priority, workspaceRepo, workspaceBranch, profileId);
    if (jobType) {
      try { getDB().prepare("UPDATE drone_jobs SET job_type = ? WHERE id = ?").run(jobType, id); } catch (e) { /* col may not exist */ }
    }
    emitEvent('drone_job_created', who, 'drone', who + ' submitted drone job: ' + title, { job_id: id, job_type: jobType });
    dispatchWebhook('drone_job_created', who, { job_id: id, title: title, requires: requires, requester: who, job_type: jobType });
    res.json({ ok: true, id: id, title: title, job_type: jobType });
  }));

  // Convenience: create a job from a template with minimal params
  router.post('/drones/jobs/from-template', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var templateId = req.body.template_id;
    if (!templateId) return res.status(400).json({ error: 'template_id is required' });
    var template = getJobTemplate(templateId);
    if (!template) return res.status(404).json({ error: 'Template not found: ' + templateId });
    var inputData = req.body.input_data || {};
    // input_data.setup is admin-only — shell-executed on the drone (see the C-4
    // gate on POST /drones/jobs). Block non-admin free-form setup here too.
    if (inputData && inputData.setup !== undefined && !req._authIsAdmin) {
      return apiError(res, 403, 'input_data.setup is admin-only — it is shell-executed on the drone. Use a template setup_repo instead.');
    }
    var priority = parseInt(req.body.priority) || 0;
    var requires = [];
    try { requires = JSON.parse(template.requires || '["cpu"]'); } catch (e) { requires = ['cpu']; }
    var title = template.name;
    if (inputData.batch) title += ' (batch ' + inputData.batch + ')';
    var id = createDroneJob(title, '', inputData, requires, who, priority, null, 'main', null);
    try { getDB().prepare("UPDATE drone_jobs SET job_type = ? WHERE id = ?").run(templateId, id); } catch (e) { /* col may not exist */ }
    emitEvent('drone_job_created', who, 'drone', who + ' submitted ' + templateId + ' job: ' + title, { job_id: id, job_type: templateId });
    dispatchWebhook('drone_job_created', who, { job_id: id, title: title, requires: requires, requester: who, job_type: templateId });
    res.json({ ok: true, id: id, title: title, job_type: templateId });
  }));

  // List drone jobs (filterable by status, drone_id, requester)
  router.get('/drones/jobs', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      status: req.query.status,
      drone_id: req.query.drone_id,
      requester: req.query.requester,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    res.json(listDroneJobs(filters));
  }));

  // Get single drone job
  router.get('/drones/jobs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var job = getDroneJob(parseIntParam(req.params.id));
    if (!job) return res.status(404).json({ error: 'Drone job not found' });
    res.json(job);
  }));

  // Update drone job (status, result_url, result_data, error)
  router.put('/drones/jobs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var job = getDroneJob(parseIntParam(req.params.id));
    if (!job) return res.status(404).json({ error: 'Drone job not found' });
    // Only the assigned drone, the requester, or an admin can update a job
    var isAdmin = isAdminKey(req.headers['x-admin-key']) || !!getStudioUser(req);
    if (!isAdmin && job.drone_id && job.drone_id !== who && job.requester !== who) {
      return res.status(403).json({ error: 'Not authorized to update this job' });
    }
    var fields = {};
    // Accept 'completed' as alias for 'done'
    var statusVal = req.body.status;
    if (statusVal === 'completed') statusVal = 'done';
    if (!validateEnum(res, statusVal, DRONE_JOB_STATUSES, 'status')) return;
    if (statusVal !== undefined) fields.status = statusVal;
    if (req.body.result_url !== undefined) fields.result_url = req.body.result_url;
    if (req.body.result_data !== undefined) fields.result_data = req.body.result_data;
    if (req.body.error !== undefined) fields.error = req.body.error;
    if (req.body.drone_id !== undefined) fields.drone_id = req.body.drone_id;
    if (fields.status === 'claimed' && !job.started_at) {
      fields.started_at = new Date().toISOString();
      if (!fields.drone_id) fields.drone_id = who;
    }
    if (fields.status === 'done' || fields.status === 'failed') {
      fields.completed_at = new Date().toISOString();
    }
    updateDroneJob(job.id, fields);
    if (fields.status) {
      emitEvent('drone_job_' + fields.status, who, 'drone', who + ' set drone job #' + job.id + ' to ' + fields.status, { job_id: job.id, drone_id: job.drone_id });
      // Webhook dispatches for completed/failed
      if (fields.status === 'done') {
        dispatchWebhook('drone_job_completed', job.requester, { job_id: job.id, title: job.title, drone_id: job.drone_id, result_url: fields.result_url });
      }
      if (fields.status === 'failed') {
        dispatchWebhook('drone_job_failed', job.requester, { job_id: job.id, title: job.title, drone_id: job.drone_id, error: fields.error });
      }
      // Auto-update linked assets when job completes
      if (fields.status === 'done' || fields.status === 'failed') {
        var linkedAssets = listAssetsByDroneJob(job.id);
        var assetStatus = fields.status === 'done' ? 'ready' : 'requested';
        for (var asset of linkedAssets) {
          updateAsset(asset.id, { status: assetStatus });
        }
        if (linkedAssets.length > 0) {
          emitEvent('assets_status_updated', who, null, linkedAssets.length + ' assets set to ' + assetStatus + ' (job #' + job.id + ' ' + fields.status + ')', { job_id: job.id, asset_count: linkedAssets.length });
        }
      }
      // Smart retry logic for failed drone jobs
      // Tracks: _retry_count (per-drone attempts), _requeue_count (cross-drone cycles),
      //         _original_title (clean title), _original_job_id, _failed_drones
      if (fields.status === 'failed') {
        var MAX_RETRIES = 2;    // per-drone retries (0,1,2 = 3 attempts)
        var MAX_REQUEUES = 3;   // max cross-drone requeue cycles
        var inputData = {};
        try { inputData = JSON.parse(job.input_data || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for input_data (job: ' + job.id + '):', e.message); }

        // Honor _no_retry flag — skip all retry/requeue logic
        if (inputData._no_retry) {
          emitEvent('drone_job_exhausted', who, 'drone', 'Job #' + job.id + ' failed (no-retry flag set)', { original_job_id: inputData._original_job_id || job.id, reason: '_no_retry flag set' });
        } else {
        var retryCount = inputData._retry_count || 0;
        var requeueCount = inputData._requeue_count || 0;
        var failedDrones = inputData._failed_drones || [];
        var originalJobId = inputData._original_job_id || job.id;
        var originalTitle = inputData._original_title || job.title;
        var failedDroneId = job.drone_id;

        if (retryCount < MAX_RETRIES) {
          // Retry on same drone (up to 3 attempts: 0, 1, 2)
          var retryInput = Object.assign({}, inputData, {
            _retry_count: retryCount + 1,
            _requeue_count: requeueCount,
            _failed_drones: failedDrones,
            _original_job_id: originalJobId,
            _original_title: originalTitle
          });
          var retryTitle = originalTitle + ' [retry ' + (retryCount + 1) + '/' + MAX_RETRIES + ']';
          var retryId = createDroneJob(retryTitle, job.command, retryInput, job.requires, job.requester, job.priority, job.workspace_repo, job.workspace_branch, job.profile_id);
          emitEvent('drone_job_retry', who, 'drone', 'Auto-retry #' + (retryCount + 1) + ' for job #' + originalJobId + ' -> new job #' + retryId, { original_job_id: originalJobId, retry_job_id: retryId, retry_count: retryCount + 1 });
        } else {
          // Max retries on this drone — add to failed list, check if we should requeue
          if (failedDroneId && failedDrones.indexOf(failedDroneId) === -1) {
            failedDrones.push(failedDroneId);
          }
          var allDrones = listDrones();
          var allDroneIds = allDrones.map(function (d) { return d.id; });
          var allExhausted = allDroneIds.length === 0 || allDroneIds.every(function (did) { return failedDrones.indexOf(did) !== -1; });

          if (allExhausted || requeueCount >= MAX_REQUEUES) {
            // All drones exhausted OR max requeue limit reached — stop retrying
            var reason = allExhausted ? 'all drones exhausted' : 'max requeue limit (' + MAX_REQUEUES + ') reached';
            emitEvent('drone_job_exhausted', who, 'drone', 'Job #' + originalJobId + ' abandoned: ' + reason, { original_job_id: originalJobId, failed_drones: failedDrones, requeue_count: requeueCount });
            dispatchWebhook('drone_job_exhausted', job.requester, { job_id: job.id, original_job_id: originalJobId, title: originalTitle, failed_drones: failedDrones, error: fields.error, reason: reason });
          } else {
            // Reset retry count, put back in queue for next drone
            var resetInput = Object.assign({}, inputData, {
              _retry_count: 0,
              _requeue_count: requeueCount + 1,
              _failed_drones: failedDrones,
              _original_job_id: originalJobId,
              _original_title: originalTitle
            });
            var requeueTitle = originalTitle + ' [requeue ' + (requeueCount + 1) + '/' + MAX_REQUEUES + ']';
            var requeueId = createDroneJob(requeueTitle, job.command, resetInput, job.requires, job.requester, job.priority, job.workspace_repo, job.workspace_branch, job.profile_id);
            emitEvent('drone_job_requeue', who, 'drone', 'Job #' + originalJobId + ' requeued as #' + requeueId + ' (cycle ' + (requeueCount + 1) + '/' + MAX_REQUEUES + ') after failures on ' + failedDroneId, { original_job_id: originalJobId, requeue_job_id: requeueId, failed_drone: failedDroneId, requeue_count: requeueCount + 1 });
          }
        }
        } // end _no_retry else
      }
    }
    res.json({ ok: true, id: job.id });
  }));

  // Cancel/delete drone job (admin only — works on any status)
  router.delete('/drones/jobs/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var job = getDroneJob(parseIntParam(req.params.id));
    if (!job) return res.status(404).json({ error: 'Drone job not found' });
    updateDroneJob(job.id, { status: 'cancelled', completed_at: job.completed_at || new Date().toISOString() });
    emitEvent('drone_job_cancelled', getAdminDisplayName(req), 'drone', 'Cancelled drone job #' + job.id + ' (was: ' + job.status + ')', { job_id: job.id });
    res.json({ ok: true, id: job.id, cancelled: true });
  }));

  // Bulk cleanup: cancel old done/failed jobs (admin only)
  // DELETE /drones/jobs?older_than_days=7&status=failed
  router.delete('/drones/jobs', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var days = parseInt(req.query.older_than_days) || 0; // 0 = all matching
    var statusFilter = req.query.status || 'failed'; // failed, done, or both
    var statuses = statusFilter === 'both' ? ['failed', 'done'] : [statusFilter];
    if (statuses.some(function (s) { return s !== 'failed' && s !== 'done'; })) {
      return res.status(400).json({ error: 'status must be failed, done, or both' });
    }
    var jobs = bulkCancelDroneJobs(statuses, days);
    emitEvent('drone_jobs_cleanup', getAdminDisplayName(req), 'drone', 'Bulk cancelled ' + jobs.length + ' ' + statusFilter + ' drone jobs', { count: jobs.length });
    res.json({ ok: true, cancelled: jobs.length, jobs: jobs.map(function (j) { return { id: j.id, title: j.title }; }) });
  }));

  // ======== JOB TEMPLATES (reusable job type definitions for smart routing) ========
  // Must be before /drones/:id to prevent :id from catching "templates"

  router.get('/drones/templates', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listJobTemplates());
  }));

  router.get('/drones/templates/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var template = getJobTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  }));

  router.post('/drones/templates', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = req.body.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (getJobTemplate(id)) return res.status(409).json({ error: 'Template already exists: ' + id });
    var template = createJobTemplate(id, req.body);
    emitEvent('job_template_created', getAdminDisplayName(req), 'drone', 'Created job template: ' + id);
    res.json(template);
  }));

  router.put('/drones/templates/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var template = getJobTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    var updated = updateJobTemplate(req.params.id, req.body);
    emitEvent('job_template_updated', getAdminDisplayName(req), 'drone', 'Updated job template: ' + req.params.id);
    res.json(updated);
  }));

  router.delete('/drones/templates/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var template = getJobTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    deleteJobTemplate(req.params.id);
    emitEvent('job_template_deleted', getAdminDisplayName(req), 'drone', 'Deleted job template: ' + req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  }));

  // ======== DRONE COMPATIBILITY CHECK ========

  router.get('/drones/:id/compatibility', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Drone not found' });
    var result = checkDroneCompatibility(req.params.id);
    res.json(result);
  }));

  // ======== DRONE PROFILES (per-drone setup & dependency definitions) ========
  // Must be before /drones/:id to prevent :id from catching "profiles"

  // List all profiles
  router.get('/drones/profiles', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var profiles = listDroneProfiles();
    profiles = profiles.map(function (p) {
      p.requires = JSON.parse(p.requires || '{}');
      p.artifacts = JSON.parse(p.artifacts || '[]');
      p.env = JSON.parse(p.env || '{}');
      p.drones = getDronesWithProfile(p.id);
      return p;
    });
    res.json(profiles);
  }));

  // Create a profile (admin only)
  router.post('/drones/profiles', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = req.body.id;
    if (!id) return res.status(400).json({ error: 'id is required (slug, e.g. "kc-art-gen")' });
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    if (getDroneProfile(id)) return res.status(409).json({ error: 'Profile already exists: ' + id });
    var profile = createDroneProfile(
      id, req.body.name, req.body.description,
      req.body.requires, req.body.artifacts,
      req.body.setup_script, req.body.workspace, req.body.env
    );
    emitEvent('drone_profile_created', '__admin__', 'drone', 'Created drone profile: ' + id);
    res.json(profile);
  }));

  // Get single profile
  router.get('/drones/profiles/:profileId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var profile = getDroneProfile(req.params.profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    profile.requires = JSON.parse(profile.requires || '{}');
    profile.artifacts = JSON.parse(profile.artifacts || '[]');
    profile.env = JSON.parse(profile.env || '{}');
    profile.drones = getDronesWithProfile(profile.id);
    res.json(profile);
  }));

  // Update a profile (admin only) — invalidates setup_done for all assigned drones
  router.put('/drones/profiles/:profileId', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var profile = getDroneProfile(req.params.profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    var updated = updateDroneProfile(req.params.profileId, req.body);
    updated.requires = JSON.parse(updated.requires || '{}');
    updated.artifacts = JSON.parse(updated.artifacts || '[]');
    updated.env = JSON.parse(updated.env || '{}');
    emitEvent('drone_profile_updated', '__admin__', 'drone', 'Updated drone profile: ' + req.params.profileId + ' (all drone setups invalidated)');
    res.json(updated);
  }));

  // Delete a profile (admin only)
  router.delete('/drones/profiles/:profileId', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var profile = getDroneProfile(req.params.profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    deleteDroneProfile(req.params.profileId);
    emitEvent('drone_profile_deleted', '__admin__', 'drone', 'Deleted drone profile: ' + req.params.profileId);
    res.json({ ok: true, deleted: req.params.profileId });
  }));

  // Assign profile to drone
  router.post('/drones/profiles/:profileId/assign', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var profileId = req.params.profileId;
    var droneId = req.body.drone_id;
    if (!droneId) return res.status(400).json({ error: 'drone_id is required' });
    if (!getDroneProfile(profileId)) return res.status(404).json({ error: 'Profile not found: ' + profileId });
    var agent = getAgent(droneId);
    if (!agent) return res.status(404).json({ error: 'Drone not found: ' + droneId });
    assignDroneProfile(droneId, profileId);
    emitEvent('drone_profile_assigned', '__admin__', 'drone', 'Assigned profile ' + profileId + ' to drone ' + droneId);
    res.json({ ok: true, drone_id: droneId, profile_id: profileId });
  }));

  // Unassign profile from drone
  router.delete('/drones/profiles/:profileId/assign/:droneId', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    unassignDroneProfile(req.params.droneId, req.params.profileId);
    res.json({ ok: true, unassigned: true });
  }));

  // Get profiles assigned to a drone (used by worker at boot)
  router.get('/drones/profiles/by-drone/:droneId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var assignments = getDroneProfileAssignments(req.params.droneId);
    assignments = assignments.map(function (a) {
      a.requires = JSON.parse(a.requires || '{}');
      a.artifacts = JSON.parse(a.artifacts || '[]');
      a.env = JSON.parse(a.env || '{}');
      return a;
    });
    res.json(assignments);
  }));

  // Drone reports profile setup complete
  router.post('/drones/profiles/:profileId/setup-complete', asyncHandler(function (req, res) {
    var agentId = checkAgent(req, res);
    if (!agentId) return;
    var profileId = req.params.profileId;
    if (!getDroneProfile(profileId)) return res.status(404).json({ error: 'Profile not found' });
    var checksum = req.body.checksum || '';
    markProfileSetupDone(agentId, profileId, checksum);
    emitEvent('drone_profile_setup_done', agentId, 'drone', agentId + ' completed setup for profile ' + profileId);
    res.json({ ok: true, profile_id: profileId, setup_done: true });
  }));

  // ======== DRONE ARTIFACTS (persistent files — models, LoRAs, etc.) ========
  // Must be before /drones/:id to prevent :id from catching "artifacts"

  // Upload a drone artifact (persistent, no TTL) — ADMIN ONLY.
  // Artifacts (e.g. generate_flux.py, model weights) are trusted files that drones
  // download and EXECUTE. The store overwrites by filename, so a non-admin upload of
  // name=generate_flux.py would poison the trusted script → mesh-wide RCE (C-3).
  // The admin gate MUST run before multer writes the file to disk, so it sits ahead
  // of artifactUpload in the chain rather than inside the handler.
  router.post('/drones/artifacts', requireAuth, function (req, res, next) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return; // 401 already sent
    if (!req._authIsAdmin) return apiError(res, 403, 'Artifact upload is admin-only — artifacts are trusted code executed on drones.');
    next();
  }, artifactUpload.single('file'), asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart form with field name "file"' });
    var protocol = req.headers['x-forwarded-proto'] || req.protocol;
    var host = req.headers['x-forwarded-host'] || req.get('host');
    var baseUrl = protocol + '://' + host;
    var url = baseUrl + '/api/mycelium/drones/artifacts/' + req.file.filename;
    var sizeStr = req.file.size > 1024 * 1024 ? Math.round(req.file.size / 1024 / 1024) + 'MB' : Math.round(req.file.size / 1024) + 'KB';
    emitEvent('artifact_uploaded', who, 'drone', 'Uploaded drone artifact: ' + req.file.filename + ' (' + sizeStr + ')');
    res.json({ ok: true, name: req.file.filename, url: url, size: req.file.size });
  }));

  // List drone artifacts
  router.get('/drones/artifacts', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var protocol = req.headers['x-forwarded-proto'] || req.protocol;
    var host = req.headers['x-forwarded-host'] || req.get('host');
    var baseUrl = protocol + '://' + host;
    var artifacts = [];
    try {
      artifacts = fs.readdirSync(ARTIFACTS_DIR).map(function (f) {
        var stat = fs.statSync(nodePath.join(ARTIFACTS_DIR, f));
        return { name: f, size: stat.size, uploaded: stat.mtime.toISOString(), url: baseUrl + '/api/mycelium/drones/artifacts/' + f };
      });
    } catch (e) { /* empty */ }
    res.json(artifacts);
  }));

  // Download a drone artifact (auth required)
  router.get('/drones/artifacts/:name', asyncHandler(function (req, res) {
    if (!checkAgentOrAdmin(req, res)) return;
    var name = req.params.name.replace(/[^a-zA-Z0-9_.\-]/g, '');
    var filePath = nodePath.join(ARTIFACTS_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found' });
    res.download(filePath, name);
  }));

  // Delete a drone artifact (admin only)
  router.delete('/drones/artifacts/:name', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var name = req.params.name.replace(/[^a-zA-Z0-9_.\-]/g, '');
    var filePath = nodePath.join(ARTIFACTS_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true, deleted: name });
  }));

  // Get single drone + recent jobs + diagnostics (must be after /drones/artifacts to prevent :id catching "artifacts")
  router.get('/drones/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var agent = getAgent(req.params.id);
    if (!agent || agent.project_id !== 'drone') return res.status(404).json({ error: 'Drone not found' });
    var { api_key_hash, ...safe } = agent;
    var recentJobs = listDroneJobs({ drone_id: req.params.id, limit: 20 });
    safe.recent_jobs = recentJobs;
    // Include system diagnostics from latest savepoint
    var savepoint = getLatestSavepoint(req.params.id);
    if (savepoint) {
      try {
        var snapshot = JSON.parse(savepoint.state_snapshot || '{}');
        safe.system_info = snapshot.system_info || null;
        safe.warnings = snapshot.warnings || [];
        safe.worker_version = snapshot.worker_version || null;
      } catch (e) { console.warn('[mycelium] JSON parse failed for state_snapshot (drone: ' + req.params.id + '):', e.message); }
    }
    // Error summary from recent failed jobs
    var failedJobs = recentJobs.filter(function (j) { return j.status === 'failed'; });
    if (failedJobs.length > 0) {
      safe.error_summary = failedJobs.slice(0, 5).map(function (j) {
        var resultData = {};
        try { resultData = JSON.parse(j.result_data || '{}'); } catch (e) { console.warn('[mycelium] JSON parse failed for result_data (job: ' + j.id + '):', e.message); }
        return {
          job_id: j.id,
          title: j.title,
          error_type: resultData.error_type || 'unknown',
          message: (resultData.message || j.error || '').substring(0, 200),
          suggestion: (resultData.suggestion || '').substring(0, 200),
          failed_at: j.completed_at,
        };
      });
    }
    // Include profile assignments
    safe.profiles = getDroneProfileAssignments(req.params.id).map(function (a) {
      a.requires = JSON.parse(a.requires || '{}');
      a.artifacts = JSON.parse(a.artifacts || '[]');
      return a;
    });
    res.json(safe);
  }));
}
