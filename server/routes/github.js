// GitHub routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.

export function registerGithubRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, getAdminDisplayName,
    checkEnforcementRules,
  } = deps;

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
