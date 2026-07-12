// Misc routes — GITHUB proxy + SPEND + RUNS + VOICE — extracted verbatim from
// mycelium.js (god-file decomposition, Phase 3, 2026-07-12; see
// docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs and pinned
// by test/unit/github-spend-runs-voice-characterization.test.js.
import {
  logAgentSpend, getAgentSpend, getSpendSummary,
  createRun, updateRun, getRun, listRuns, claimRun, releaseStaleClaimedRuns,
  listAgents, listTasks, listBugs,
} from '../db.js';

export function registerMiscRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, checkGuardrails,
    checkAdminOrOperator, checkProjectScope, emitEvent,
    getAdminDisplayName, checkEnforcementRules,
  } = deps;

  // ======== SPEND TRACKING ========

  router.post('/spend', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'spend_logged', { agent: agentId, project_id: req.body.project_id, cost_usd: req.body.cost_usd })) return;
    var costUsd = parseFloat(req.body.cost_usd) || 0;
    if (costUsd < 0) return res.status(400).json({ error: 'cost_usd must be non-negative' });
    logAgentSpend(
      agentId,
      req.body.project_id || '',
      costUsd,
      req.body.source || '',
      req.body.description || '',
      req.body.model || '',
      parseInt(req.body.tokens_in) || 0,
      parseInt(req.body.tokens_out) || 0
    );
    res.json({ ok: true });
  }));

  router.get('/spend/:agentId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var entries = getAgentSpend(req.params.agentId, {
      since: req.query.since,
      project_id: req.query.project_id,
      limit: parseInt(req.query.limit) || 50
    });
    res.json(entries);
  }));

  router.get('/spend', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var summary = getSpendSummary({
      since: req.query.since,
      project_id: req.query.project_id
    });
    var total = summary.reduce(function (acc, r) { return acc + (r.total_cost || 0); }, 0);
    res.json({ total_cost_usd: Math.round(total * 10000) / 10000, breakdown: summary });
  }));

  // ======== RUNS (the run-log) ========

  // Open a run. Squad writes (agent key); operator/admin pass too. Returns the row.
  router.post('/runs', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!checkGuardrails(req, res, 'run_started', { agent: who, project_id: req.body.project_id })) return;
    // Bind the run to the AUTHENTICATED agent — a non-admin can't attribute a run to
    // another agent. Admin (e.g. the bridge recording on behalf of an agent) may set it.
    var ownerAgent = req._authIsAdmin ? (req.body.agent_id || who) : (req._authAgentId || who);
    var run = createRun({
      id: req.body.id || crypto.randomUUID(),
      agent_id: ownerAgent,
      model: req.body.model,
      project_id: req.body.project_id,
      workflow_id: req.body.workflow_id || null,
      brief: req.body.brief,
      status: req.body.status || 'running'
    });
    res.json(run);
  }));

  // Close/update a run with telemetry (turns/tokens/energy/artifacts/result/finished_at).
  router.put('/runs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var existing = getRun(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Run not found' });
    // Only the run's OWN agent, the worker that claimed it, or an admin may report telemetry.
    if (!req._authIsAdmin && existing.agent_id !== req._authAgentId && existing.claimed_by !== req._authAgentId) {
      return res.status(403).json({ error: 'Forbidden — not your run' });
    }
    var fields = {};
    ['model', 'status', 'turns', 'tool_calls', 'tokens_in', 'tokens_out',
     'energy_joules', 'artifacts', 'result', 'finished_at', 'duration_ms'].forEach(function (k) {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    });
    // Accept JSON arrays for tool_calls/artifacts; store as strings.
    if (fields.tool_calls !== undefined && typeof fields.tool_calls !== 'string') fields.tool_calls = JSON.stringify(fields.tool_calls);
    if (fields.artifacts !== undefined && typeof fields.artifacts !== 'string') fields.artifacts = JSON.stringify(fields.artifacts);
    res.json(updateRun(req.params.id, fields));
  }));

  // A run-worker claims the next PENDING run (drone-style atomic claim), optionally scoped
  // to one agent_id. Reaps stale claims first (like the drone claim path), so a dead worker
  // can't strand a run. Returns the claimed run, or 204 when the queue is empty.
  router.post('/runs/claim', asyncHandler(function (req, res) {
    var workerId = checkAgentOrAdmin(req, res);
    if (!workerId) return;
    // Stale-reap window is a SERVER constant — never client-controlled (a client could pass
    // 0 to fail every in-flight run). The worker is the authenticated principal, not
    // client-supplied (no claiming as another worker).
    releaseStaleClaimedRuns();   // default 60-min window
    var run = claimRun(workerId, { agent_id: req.body.agent_id });
    if (!run) return res.status(204).end();
    res.json(run);
  }));

  // The run-log the Engine Room renders. Operator-readable (studio JWT passes checkAgentOrAdmin).
  router.get('/runs', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(listRuns({
      agent_id: req.query.agent_id,
      project_id: req.query.project_id,
      status: req.query.status,
      since: req.query.since,
      limit: parseInt(req.query.limit) || 50
    }));
  }));

  router.get('/runs/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var run = getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  }));

  // Re-run THIS agent (the singular, scope=this rerun): records a NEW pending run with the
  // same agent+brief, linked via rerun_of; a run-worker claims it via POST /runs/claim. A
  // run that's part of a COLLECTION (workflow_id set) defaults to re-firing the WHOLE
  // workflow instead — that lives in the workflow layer, not here.
  router.post('/runs/:id/rerun', asyncHandler(function (req, res) {
    var who = checkAdminOrOperator(req, res);   // rerun is an operator action — not arbitrary agents
    if (!who) return;
    var orig = getRun(req.params.id);
    if (!orig) return res.status(404).json({ error: 'Run not found' });
    if (!checkProjectScope(req, res, orig.project_id)) return;
    var fresh = createRun({
      id: crypto.randomUUID(),
      agent_id: orig.agent_id,
      model: orig.model,
      project_id: orig.project_id,
      workflow_id: orig.workflow_id || null,
      brief: orig.brief,
      status: 'pending',
      rerun_of: orig.id
    });
    res.json(fresh);
  }));

  // ======== VOICE COMMANDS ========

  // Process a voice command — parse natural language into Mycelium actions
  router.post('/voice/command', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    // Strip wake word
    text = text.replace(/^(hey |ok |hello )?(mycelium|mycelia)[,.]?\s*/i, '').trim();
    if (!text) return res.json({ action: 'none', response: 'How can I help?' });

    // Parse intent
    var result = parseVoiceCommand(text, who);
    emitEvent('voice_command', who || 'operator', '', text, { action: result.action });
    res.json(result);
  }));

  function parseVoiceCommand(text, who) {
    var lower = text.toLowerCase();

    // Status queries
    if (lower.match(/status|how.*(things|going|look)|what.*(happening|going on)/)) {
      var agents = listAgents ? listAgents() : [];
      var online = agents.filter(function(a) { return a.status === 'online'; });
      var working = online.filter(function(a) { return a.working_on; });
      return {
        action: 'status',
        response: online.length + ' agents online, ' + working.length + ' working. ' +
          (working.length > 0 ? working.map(function(a) { return a.id + ' is on ' + a.working_on; }).join('. ') : 'Everyone is idle.')
      };
    }

    // Agent-specific status
    var agentMatch = lower.match(/(?:status|what.* doing|where.*is|check on)\s+(\S+)/);
    if (agentMatch) {
      var agentId = agentMatch[1].replace(/-claude$/, '') + '-claude';
      var agents2 = listAgents ? listAgents() : [];
      var agent = agents2.find(function(a) { return a.id === agentId || a.id === agentMatch[1]; });
      if (agent) {
        return {
          action: 'agent_status',
          response: agent.id + ' is ' + agent.status + '. ' + (agent.working_on ? 'Working on: ' + agent.working_on : 'Currently idle.')
        };
      }
    }

    // Drone status
    if (lower.match(/drone|gpu|3090|art.*drone/)) {
      var drones = listAgents ? listAgents().filter(function(a) { return a.agent_type === 'drone'; }) : [];
      return {
        action: 'drone_status',
        response: drones.length + ' drones registered. ' + drones.map(function(d) {
          return d.id + ': ' + d.status + (d.working_on ? ' (' + d.working_on + ')' : '');
        }).join('. ')
      };
    }

    // Task queries
    if (lower.match(/task|open.*task|pending.*task|what.*needs.*done/)) {
      var tasks = listTasks ? listTasks({ status: 'open', limit: 5 }) : [];
      return {
        action: 'tasks',
        response: tasks.length + ' open tasks. ' + (tasks.length > 0 ? tasks.slice(0, 3).map(function(t) { return '#' + t.id + ': ' + t.title; }).join('. ') : 'All clear.')
      };
    }

    // Bug queries
    if (lower.match(/bug|issue|problem/)) {
      var bugs = listBugs ? listBugs({ status: 'open' }) : [];
      return {
        action: 'bugs',
        response: bugs.length + ' open bugs. ' + (bugs.length > 0 ? bugs.slice(0, 3).map(function(b) { return '#' + b.id + ': ' + b.title; }).join('. ') : 'No open bugs.')
      };
    }

    // Assign task
    var assignMatch = lower.match(/assign\s+(.+?)\s+to\s+(\S+)/);
    if (assignMatch) {
      return {
        action: 'assign',
        response: 'To assign tasks, use the dashboard or send a directive. I noted your request: assign "' + assignMatch[1] + '" to ' + assignMatch[2] + '.'
      };
    }

    // Fallback
    return {
      action: 'unknown',
      response: 'I heard: "' + text + '". Try asking about agent status, tasks, bugs, or drones.'
    };
  }

  // ── GitHub Proxy Routes ────────────────────────────────────────
  // Proxies GitHub API via server-side GITHUB_TOKEN so agents don't need their own tokens.
  var GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

  function githubApi(method, path, body) {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Mycelium/1.0'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + GITHUB_TOKEN;
    var opts = { method: method, headers: headers };
    if (body) {
      opts.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    return fetch('https://api.github.com' + path, opts);
  }

  // List PRs
  router.get('/github/prs/:owner/:repo', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured on server' });
    var state = req.query.state || 'open';
    githubApi('GET', '/repos/' + req.params.owner + '/' + req.params.repo + '/pulls?state=' + state + '&per_page=30')
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (r) {
        if (r.status !== 200) return res.status(r.status).json({ error: r.data.message || 'GitHub API error' });
        var prs = r.data.map(function (pr) {
          return { number: pr.number, title: pr.title, author: pr.user.login, branch: pr.head.ref, base: pr.base.ref, state: pr.state, draft: pr.draft, url: pr.html_url, created_at: pr.created_at, updated_at: pr.updated_at };
        });
        res.json({ count: prs.length, prs: prs });
      })
      .catch(function (e) { console.error('[mycelium] GitHub API error:', e.message); res.status(500).json({ error: 'GitHub request failed' }); });
  }));

  // Merge PR
  router.post('/github/prs/:owner/:repo/:number/merge', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    // Enforcement rules check
    var who = getAdminDisplayName(req);
    var enforcement = checkEnforcementRules('merge_pr', { owner: req.params.owner, repo: req.params.repo, number: req.params.number }, who);
    if (!enforcement.allowed) {
      return res.status(403).json({ error: enforcement.blocks[0].message, enforcement_rule: enforcement.blocks[0].rule_id });
    }
    if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured on server' });
    var body = { merge_method: req.body.merge_method || 'squash' };
    if (req.body.commit_title) body.commit_title = req.body.commit_title;
    if (req.body.commit_message) body.commit_message = req.body.commit_message;
    githubApi('PUT', '/repos/' + req.params.owner + '/' + req.params.repo + '/pulls/' + req.params.number + '/merge', body)
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (r) {
        if (r.status !== 200) return res.status(r.status).json({ error: r.data.message || 'Merge failed' });
        res.json({ number: parseInt(req.params.number), sha: r.data.sha, merged: true });
      })
      .catch(function (e) { console.error('[mycelium] GitHub API error:', e.message); res.status(500).json({ error: 'GitHub request failed' }); });
  }));

  // Create PR
  router.post('/github/prs/:owner/:repo', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured on server' });
    var body = { title: req.body.title, head: req.body.head, base: req.body.base, body: req.body.body || '', draft: !!req.body.draft };
    githubApi('POST', '/repos/' + req.params.owner + '/' + req.params.repo + '/pulls', body)
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (r) {
        if (r.status !== 201) return res.status(r.status).json({ error: r.data.message || 'Create PR failed' });
        res.json({ number: r.data.number, title: r.data.title, url: r.data.html_url });
      })
      .catch(function (e) { console.error('[mycelium] GitHub API error:', e.message); res.status(500).json({ error: 'GitHub request failed' }); });
  }));
}
