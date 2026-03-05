import { Router } from 'express';
import createSteamDB from './db.js';
import { createDroneJob, getDroneJob } from '../../db.js';

var WORKER_REPO = 'https://github.com/SoftBacon-Software/wsac-agent';

// Game facts must be provided per-request or stored in plugin config.
// No defaults — keeps the plugin project-agnostic.
function getGameFacts(core) {
  try {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'steam-assets' AND key = 'game_facts'").get();
    return row ? JSON.parse(row.value) : null;
  } catch (e) { return null; }
}

export default function (core) {
  var router = Router();
  var db = createSteamDB(core.db);
  // Use shared helpers from core — single source of truth for error format.
  var { apiError, parseIntParam } = core;

  // ── Asset CRUD ──

  // GET /assets — List steam assets
  router.get('/assets', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listAssets({
      project_id: req.query.project_id,
      asset_type: req.query.asset_type,
      status: req.query.status,
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /assets/:id — Get asset details
  router.get('/assets/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var asset = db.getAsset(parseIntParam(req.params.id));
    if (!asset) return apiError(res, 404, 'Asset not found');
    // Include drone job status if linked
    if (asset.drone_job_id) {
      var job = getDroneJob(asset.drone_job_id);
      if (job) asset.drone_job = { id: job.id, status: job.status, error: job.error, result_data: job.result_data };
    }
    res.json(asset);
  });

  // DELETE /assets/:id — Delete asset
  router.delete('/assets/:id', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (id === null) return apiError(res, 400, 'Invalid id');
    db.deleteAsset(id);
    res.json({ ok: true });
  });

  // ── Store Copy Generation (lightweight, in-process) ──

  // POST /store-copy — Generate Steam store page BBCode via prompt
  // This returns a structured prompt that agents can use with Claude API
  router.post('/store-copy', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var projectId = req.body.project_id || '';
    var gameFacts = req.body.game_facts || getGameFacts(core);
    if (!gameFacts) return apiError(res, 400, 'game_facts required — provide in request body or set in plugin config');
    var sections = req.body.sections || ['short_description', 'about', 'features', 'tags'];

    var prompt = buildStoreCopyPrompt(gameFacts, sections);

    var assetId = db.createAsset(projectId, 'store_copy', 'Store page copy', { game_facts: gameFacts, sections: sections }, who);

    core.emitEvent('steam_store_copy_requested', who, projectId,
      'Store copy generation requested', { asset_id: assetId });

    res.json({
      ok: true,
      asset_id: assetId,
      prompt: prompt,
      instructions: 'Send this prompt to Claude API to generate BBCode store page copy. Update the asset with result_data when done.'
    });
  });

  // ── Screenshot Extraction (drone job) ──

  // POST /screenshots — Submit screenshot extraction drone job
  router.post('/screenshots', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var projectId = req.body.project_id || '';
    var footageUrl = req.body.footage_url;
    if (!footageUrl) return apiError(res, 400, 'footage_url required');

    var count = req.body.count || 10;
    var categories = req.body.categories || ['combat', 'loot', 'builds', 'pvp', 'exploration', 'ui'];

    var assetId = db.createAsset(projectId, 'screenshots', 'Steam screenshots (' + count + ')',
      { footage_url: footageUrl, count: count, categories: categories }, who);

    var jobId = createDroneJob(
      'Steam screenshots: ' + count + ' curated frames',
      'python -c "from steam.screenshot_extractor import *; import json, os; ' +
        'data = json.loads(os.environ[\'MYCELIUM_JOB_INPUT\']); ' +
        'extract_screenshots(data[\'footage_url\'], data[\'count\'], data[\'categories\'])"',
      {
        asset_id: assetId,
        footage_url: footageUrl,
        count: count,
        categories: categories,
        callback_url: '/api/mycelium/steam/assets/' + assetId
      },
      ['cpu', 'gpu'],
      who,
      req.body.priority || 5,
      WORKER_REPO,
      'master'
    );

    db.updateAsset(assetId, { drone_job_id: jobId, status: 'processing' });
    core.emitEvent('steam_screenshots_started', who, projectId,
      'Started screenshot extraction (' + count + ' frames)', { asset_id: assetId, job_id: jobId });
    res.json({ ok: true, asset_id: assetId, job_id: jobId });
  });

  // ── Trailer Building (drone job) ──

  // POST /trailer — Submit trailer build drone job
  router.post('/trailer', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var projectId = req.body.project_id || '';
    var footageUrl = req.body.footage_url;
    if (!footageUrl) return apiError(res, 400, 'footage_url required');

    var maxDuration = req.body.max_duration || 120;
    var videoSessionId = req.body.video_session_id;

    var assetId = db.createAsset(projectId, 'trailer', 'Steam trailer (' + maxDuration + 's max)',
      { footage_url: footageUrl, max_duration: maxDuration, video_session_id: videoSessionId }, who);

    var jobId = createDroneJob(
      'Steam trailer: ' + maxDuration + 's segmented',
      'python -c "from steam.trailer_builder import *; import json, os; ' +
        'data = json.loads(os.environ[\'MYCELIUM_JOB_INPUT\']); ' +
        'build_trailer(data[\'footage_url\'], data[\'max_duration\'])"',
      {
        asset_id: assetId,
        footage_url: footageUrl,
        max_duration: maxDuration,
        video_session_id: videoSessionId,
        tts_url: req.body.tts_url || 'http://127.0.0.1:5099/tts',
        callback_url: '/api/mycelium/steam/assets/' + assetId
      },
      ['cpu', 'gpu'],
      who,
      req.body.priority || 5,
      WORKER_REPO,
      'master'
    );

    db.updateAsset(assetId, { drone_job_id: jobId, status: 'processing' });
    core.emitEvent('steam_trailer_started', who, projectId,
      'Started trailer build (' + maxDuration + 's max)', { asset_id: assetId, job_id: jobId });
    res.json({ ok: true, asset_id: assetId, job_id: jobId });
  });

  return router;
}

// ── Helpers ──

function buildStoreCopyPrompt(facts, sections) {
  var prompt = 'You are writing Steam store page copy in BBCode format for "' + facts.title + '".\n\n';
  prompt += 'Game Facts:\n';
  for (var key in facts) {
    if (typeof facts[key] === 'object') {
      prompt += '- ' + key + ': ' + JSON.stringify(facts[key]) + '\n';
    } else {
      prompt += '- ' + key + ': ' + facts[key] + '\n';
    }
  }
  prompt += '\nGenerate the following sections in Steam BBCode format:\n';
  if (sections.includes('short_description')) prompt += '1. Short description (max 300 characters, no BBCode)\n';
  if (sections.includes('about')) prompt += '2. About This Game — with subsections for Rules, Loot, Stakes, Narrator, Creator. Use [h2], [list], [*] tags.\n';
  if (sections.includes('features')) prompt += '3. Feature list — 6-8 bullet points of key selling points.\n';
  if (sections.includes('tags')) prompt += '4. Recommended Steam tags (comma-separated list of 15-20 tags).\n';
  prompt += '\nTone: Confident, slightly dark, matches the game\'s tone. Use the project\'s narrator voice if configured.\n';
  prompt += 'Format: BBCode only (Steam compatible). Use [h2], [b], [i], [list], [*], [url] tags.\n';
  return prompt;
}
