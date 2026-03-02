// =============== admin-claude Event Handlers ===============
// Clean split: requests = coordination/judgment. Drone jobs = compute execution.
// admin-claude handles requests, never creates drone jobs directly.
// Approval tiers: low+medium = auto-approve. high+critical = escalate to dashboard.

import { ask, askJson } from './claude.js';
import { apiGet, apiPost, apiPut } from './api.js';
import { AGENT_ID, GITHUB_TOKEN, GITHUB_REPOS } from './config.js';

// Track handled message IDs to prevent duplicate processing
var handledMessages = new Set();
// Periodically clear old IDs to prevent memory growth
setInterval(function () { handledMessages.clear(); }, 30 * 60 * 1000);

// Update heartbeat so dashboard shows what admin-claude is doing
async function setStatus(workingOn) {
  try {
    await apiPut('/admin/agents/' + AGENT_ID + '/heartbeat', {
      status: 'online',
      working_on: workingOn
    });
  } catch (err) {
    // Non-critical
  }
}

async function resetStatus() {
  return setStatus('Listening for webhooks');
}

// ---- Event Router ----

export async function handleEvent(event, data, agentId) {
  // Skip events from ourselves to prevent loops
  if (agentId === AGENT_ID) return;

  switch (event) {
    case 'message_sent':
      return handleMessageSent(data);
    case 'bug_created':
      return handleBugCreated(data);
    case 'drone_job_exhausted':
      return handleDroneJobExhausted(data);
    case 'approval_requested':
      return handleApprovalRequested(data);
    // request_created is handled via message_sent to avoid duplicate processing
    case 'request_created':
      return; // Skip — handled by message_sent
    default:
      break;
  }
}

// ---- Handler: message_sent ----
// Handles ALL messages sent TO admin-claude:
// - Directives: MUST respond (priority command from human)
// - Requests: Check if it's a PR merge request (handle specially) or general request
// - Regular messages: Respond if actionable

async function handleMessageSent(data) {
  if (!data.message_id) return;

  // Dedup — prevent double-processing from webhook + backlog
  var msgKey = 'msg-' + data.message_id;
  if (handledMessages.has(msgKey)) return;
  handledMessages.add(msgKey);

  // Fetch the message
  var msg;
  try {
    var msgs = await apiGet('/messages?limit=30&to_agent=' + encodeURIComponent(AGENT_ID));
    msg = msgs.find(function (m) { return m.id === data.message_id || m.id === parseInt(data.message_id); });
  } catch (err) {
    console.error('[message] Failed to fetch messages:', err.message);
  }

  if (!msg) {
    console.log('[message] Could not find message #' + data.message_id + ' — skipping');
    return;
  }

  // Skip if already resolved
  if (msg.resolved_at) return;

  // Skip messages from ourselves or system (prevent feedback loops)
  if (msg.from_agent === AGENT_ID || msg.from_agent === '__admin__' || msg.from_agent === '__system__') return;

  var isDirective = msg.msg_type === 'directive';
  var isRequest = msg.msg_type === 'request';

  // Skip info messages (system notifications)
  if (msg.msg_type === 'info') return;

  var fromAgent = msg.from_agent || data.from || 'unknown';
  var typeLabel = isDirective ? 'directive' : isRequest ? 'request' : 'message';
  await setStatus('Processing ' + typeLabel + ' from ' + fromAgent);

  // Check if this is a PR merge request — handle with GitHub API directly
  if (isRequest && isPRMergeRequest(msg.content)) {
    await handlePRMergeRequest(msg, fromAgent);
    await resetStatus();
    return;
  }

  // Get network context
  var ops;
  try { ops = await apiGet('/admin/ops'); } catch (err) { ops = {}; }

  var context = typeLabel.toUpperCase() + ' from: ' + fromAgent + '\n' +
    'Content: ' + msg.content + '\n' +
    'Current unassigned tasks: ' + (ops.unassigned_tasks ? ops.unassigned_tasks.length : 0) + '\n' +
    'Current open bugs: ' + (ops.unassigned_bugs ? ops.unassigned_bugs.length : 0) + '\n' +
    'Failed drone jobs: ' + (ops.failed_drone_jobs ? ops.failed_drone_jobs.length : 0);

  var prompt;
  if (isDirective) {
    prompt = 'A human operator sent you a DIRECTIVE — this is a priority command that MUST be acted on. ' +
      'Read the directive carefully and respond with what you will do or have done. Be specific and actionable. ' +
      'If the directive requires actions you cannot take (like deploying code), say exactly what needs to happen and who should do it.';
  } else if (isRequest) {
    prompt = 'An agent sent a request that needs a response. Draft a helpful, concise response. ' +
      'If they are asking for work, suggest available tasks or bugs they could claim. ' +
      'If they are asking a question, answer directly. Be actionable, not vague.';
  } else {
    prompt = 'Someone sent you a message. Read it and respond helpfully if it requires action. ' +
      'If it is asking you to do something, acknowledge and describe what you will do. ' +
      'Keep your response concise. If the message does not need a response, just say "Acknowledged."';
  }

  var response = await ask(prompt, context);

  // If rate limited, skip — don't send empty/null messages
  if (!response) {
    console.log('[message] Rate limited — will retry on next backlog sweep for #' + msg.id);
    // Remove from dedup so it gets retried
    handledMessages.delete(msgKey);
    await resetStatus();
    return;
  }

  // Resolve (for directives/requests) and send follow-up
  try {
    if (isDirective || isRequest) {
      await apiPut('/messages/' + msg.id + '/resolve', {
        resolved_by: AGENT_ID,
        response: response
      });
    }
    await apiPost('/messages', {
      from_agent: AGENT_ID,
      to_agent: fromAgent,
      content: response,
      msg_type: 'message'
    });
    console.log('[message] Handled ' + typeLabel + ' #' + msg.id + ' from ' + fromAgent + ': ' + response.substring(0, 100));
  } catch (err) {
    console.error('[message] Failed to handle #' + msg.id + ':', err.message);
  }
  await resetStatus();
}

// ---- PR Merge Detection + Handling ----

function isPRMergeRequest(content) {
  if (!content) return false;
  var lower = content.toLowerCase();
  return (lower.includes('merge') || lower.includes('review')) &&
    (lower.includes('pr #') || lower.includes('pull/') || lower.includes('pull request'));
}

function extractPRNumber(content) {
  // Match "PR #14", "pull/14", "#14"
  var match = content.match(/(?:PR\s*#|pull\/)(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractRepo(content) {
  // Match "github.com/owner/repo/pull/14"
  var match = content.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
  return match ? match[1] : (GITHUB_REPOS.length > 0 ? GITHUB_REPOS[0] : null);
}

async function handlePRMergeRequest(msg, fromAgent) {
  var prNumber = extractPRNumber(msg.content);
  var repo = extractRepo(msg.content);

  if (!prNumber || !repo) {
    await resolveWithResponse(msg, fromAgent, 'Could not parse PR number or repo from request. Please include the PR URL.');
    return;
  }

  if (!GITHUB_TOKEN) {
    await resolveWithResponse(msg, fromAgent, 'GitHub token not configured — cannot review or merge PRs.');
    return;
  }

  await setStatus('Reviewing + merging PR #' + prNumber);

  try {
    // Fetch PR details
    var prResponse = await fetch('https://api.github.com/repos/' + repo + '/pulls/' + prNumber, {
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!prResponse.ok) {
      await resolveWithResponse(msg, fromAgent, 'Failed to fetch PR #' + prNumber + ': HTTP ' + prResponse.status);
      return;
    }
    var pr = await prResponse.json();

    // Check if already merged/closed
    if (pr.merged) {
      await resolveWithResponse(msg, fromAgent, 'PR #' + prNumber + ' is already merged.');
      return;
    }
    if (pr.state === 'closed') {
      await resolveWithResponse(msg, fromAgent, 'PR #' + prNumber + ' is closed (not merged).');
      return;
    }

    // Fetch diff for review
    var diffResponse = await fetch('https://api.github.com/repos/' + repo + '/pulls/' + prNumber, {
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3.diff' }
    });
    var diff = diffResponse.ok ? await diffResponse.text() : '';

    // Review with Claude
    var truncatedDiff = diff.substring(0, 15000);
    var review = await ask(
      'Review this pull request diff. Focus on: bugs, logic errors, security issues, and code quality. ' +
      'Be concise. If the PR looks good, say "LGTM" at the start. If there are blocking issues, say "BLOCKING:" at the start.\n\n' +
      'PR #' + prNumber + ': ' + pr.title + '\n' +
      'Author: ' + (pr.user ? pr.user.login : 'unknown') + '\n' +
      'Description: ' + (pr.body || '(none)').substring(0, 500),
      'Diff:\n' + truncatedDiff
    );

    if (!review) {
      // Rate limited — retry later
      handledMessages.delete('msg-' + msg.id);
      return;
    }

    // Post review as comment on GitHub
    await fetch('https://api.github.com/repos/' + repo + '/issues/' + prNumber + '/comments', {
      method: 'POST',
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body: '**admin-claude review:**\n\n' + review })
    });

    // Check if review found blocking issues
    var hasBlockingIssues = review.toUpperCase().startsWith('BLOCKING');

    if (hasBlockingIssues) {
      await resolveWithResponse(msg, fromAgent,
        'PR #' + prNumber + ' reviewed — found blocking issues. Review posted on GitHub. Please fix and re-request.\n\n' + review.substring(0, 300));
      return;
    }

    // No blocking issues — merge the PR
    var mergeResponse = await fetch('https://api.github.com/repos/' + repo + '/pulls/' + prNumber + '/merge', {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        merge_method: 'merge',
        commit_title: pr.title + ' (#' + prNumber + ')'
      })
    });

    if (mergeResponse.ok) {
      await resolveWithResponse(msg, fromAgent,
        'PR #' + prNumber + ' (' + pr.title + ') reviewed and merged. Review posted on GitHub.');
      console.log('[github] Merged PR #' + prNumber + ' in ' + repo);

      // Mark reviewed in context
      try {
        await apiPut('/context/keys/admin-claude/pr-reviewed-' + prNumber, {
          data: JSON.stringify({ reviewed: true, merged: true, at: new Date().toISOString() })
        });
      } catch (err) { /* non-critical */ }
    } else {
      var mergeError = await mergeResponse.json().catch(function () { return {}; });
      await resolveWithResponse(msg, fromAgent,
        'PR #' + prNumber + ' reviewed (LGTM) but merge failed: ' + (mergeError.message || 'HTTP ' + mergeResponse.status) +
        '. Review posted on GitHub. May need manual merge.');
    }
  } catch (err) {
    console.error('[github] Error handling PR merge request:', err.message);
    await resolveWithResponse(msg, fromAgent, 'Error processing PR #' + prNumber + ': ' + err.message);
  }
}

async function resolveWithResponse(msg, fromAgent, response) {
  try {
    await apiPut('/messages/' + msg.id + '/resolve', {
      resolved_by: AGENT_ID,
      response: response
    });
    await apiPost('/messages', {
      from_agent: AGENT_ID,
      to_agent: fromAgent,
      content: response,
      msg_type: 'message'
    });
    console.log('[message] Resolved #' + msg.id + ': ' + response.substring(0, 100));
  } catch (err) {
    console.error('[message] Failed to resolve #' + msg.id + ':', err.message);
  }
}

// ---- Handler: bug_created ----
// If unassigned, assess severity and suggest an assignee by project match.

async function handleBugCreated(data) {
  if (!data.bug_id) return;
  await setStatus('Triaging bug #' + data.bug_id);

  var bug;
  try {
    bug = await apiGet('/bugs/' + data.bug_id);
  } catch (err) {
    console.error('[bug] Failed to fetch bug #' + data.bug_id + ':', err.message);
    return;
  }

  if (bug.assignee) {
    console.log('[bug] Bug #' + data.bug_id + ' already assigned to ' + bug.assignee + ' — skipping');
    return;
  }

  var result = await askJson(
    'Triage this bug. Suggest an assignee based on the project. Return JSON with: ' +
    '{"severity": "low|normal|high|critical", "suggested_assignee": "agent-id or null", "reason": "brief reason"}.\n' +
    'Available agents and their projects:\n' +
    '- greatness-claude: willing-sacrifice, mycelium platform\n' +
    '- hijack-claude: king-city, UI/UX\n' +
    'If the bug is for "dioverse" (shared), assign to greatness-claude.\n' +
    'If you cannot determine, set suggested_assignee to null.',
    'Bug #' + bug.id + ': ' + bug.title + '\n' +
    'Project: ' + bug.game + '\n' +
    'Description: ' + bug.description + '\n' +
    'Current severity: ' + bug.severity + '\n' +
    'Reporter: ' + bug.reporter
  );

  if (!result) return;

  var updates = {};
  if (result.severity && result.severity !== bug.severity) {
    updates.severity = result.severity;
  }
  if (result.suggested_assignee) {
    updates.assignee = result.suggested_assignee;
  }
  if (result.reason) {
    updates.admin_notes = '[admin-claude triage] ' + result.reason;
  }

  if (Object.keys(updates).length > 0) {
    try {
      await apiPut('/bugs/' + bug.id, updates);
      console.log('[bug] Triaged bug #' + bug.id + ':', JSON.stringify(updates));
    } catch (err) {
      console.error('[bug] Failed to update bug #' + bug.id + ':', err.message);
    }
  }
  await resetStatus();
}

// ---- Handler: drone_job_exhausted ----

async function handleDroneJobExhausted(data) {
  var jobId = data.job_id || data.original_job_id;
  if (!jobId) return;
  await setStatus('Escalating failed drone job #' + jobId);

  var requester = data.requester || 'greatness-claude';
  var title = data.title || 'Unknown job';
  var failedDrones = data.failed_drones || [];
  var error = data.error || 'Unknown error';

  var message = 'Drone job "' + title + '" (original #' + (data.original_job_id || jobId) + ') has failed on ALL available drones (' +
    failedDrones.join(', ') + '). Last error: ' + error + '. ' +
    'This job needs manual investigation — the command or input data may need fixing before re-submitting.';

  try {
    await apiPost('/messages', {
      from_agent: AGENT_ID,
      to_agent: requester,
      content: message,
      msg_type: 'message'
    });
    console.log('[drone] Escalated exhausted job #' + jobId + ' to ' + requester);
  } catch (err) {
    console.error('[drone] Failed to escalate:', err.message);
  }
  await resetStatus();
}

// ---- Handler: approval_requested ----
// Low + Medium risk: auto-approve. High + Critical: escalate to dashboard for human review.

async function handleApprovalRequested(data) {
  if (!data.approval_id) return;
  await setStatus('Processing approval #' + data.approval_id);

  var approval;
  try {
    approval = await apiGet('/approvals/' + data.approval_id);
  } catch (err) {
    console.error('[approval] Failed to fetch approval #' + data.approval_id + ':', err.message);
    return;
  }

  var riskTier = approval.risk_tier || data.risk_tier || 'medium';

  if (riskTier === 'low' || riskTier === 'medium') {
    // Auto-approve low and medium risk
    try {
      await apiPut('/approvals/' + approval.id, {
        status: 'approved',
        reason: '[admin-claude] Auto-approved: ' + riskTier + ' risk action'
      });
      console.log('[approval] Auto-approved ' + riskTier + '-risk #' + approval.id + ': ' + approval.title);
    } catch (err) {
      console.error('[approval] Failed to auto-approve:', err.message);
    }
  } else {
    // High + Critical: escalate to humans via dashboard
    var message = 'APPROVAL NEEDED [' + riskTier.toUpperCase() + ' RISK]: ' + approval.title + ' (' + approval.action_type + ')' +
      '\nRequested by: ' + approval.requested_by +
      '\nApproval #' + approval.id + ' — review and vote on the Approvals page in the dashboard.';

    try {
      await apiPost('/messages', {
        from_agent: AGENT_ID,
        to_agent: null,
        content: message,
        msg_type: 'info'
      });
      console.log('[approval] Escalated ' + riskTier + '-risk #' + approval.id + ' to dashboard for human review');
    } catch (err) {
      console.error('[approval] Failed to escalate:', err.message);
    }
  }
  await resetStatus();
}

// ---- Periodic: GitHub PR check ----

export async function checkGitHubPRs() {
  console.log('[github] Starting PR check. Token set:', !!GITHUB_TOKEN, 'Repos:', GITHUB_REPOS);
  if (!GITHUB_TOKEN) { console.log('[github] No token — skipping'); return; }
  await setStatus('Checking GitHub PRs');

  for (var repo of GITHUB_REPOS) {
    console.log('[github] Checking repo:', repo);
    try {
      var prsResponse = await fetch('https://api.github.com/repos/' + repo + '/pulls?state=open&per_page=10', {
        headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!prsResponse.ok) {
        console.error('[github] Failed to fetch PRs for ' + repo + ': HTTP ' + prsResponse.status);
        continue;
      }
      var prs = await prsResponse.json();
      console.log('[github] Found', prs.length, 'open PRs in', repo);

      for (var pr of prs) {
        console.log('[github] Processing PR #' + pr.number + ': ' + pr.title);
        // Check if already reviewed
        var contextKey;
        try {
          contextKey = await apiGet('/context/keys/admin-claude/pr-reviewed-' + pr.number);
        } catch (err) {
          contextKey = null;
        }

        if (contextKey && contextKey.data) {
          var reviewData;
          try { reviewData = JSON.parse(contextKey.data); } catch (e) { console.warn('[github] JSON parse failed for PR review context (pr: ' + pr.number + '):', e.message); reviewData = {}; }
          if (reviewData.reviewed) { console.log('[github] PR #' + pr.number + ' already reviewed — skipping'); continue; }
        }

        // Fetch diff
        console.log('[github] Fetching diff for PR #' + pr.number);
        var diffResponse = await fetch('https://api.github.com/repos/' + repo + '/pulls/' + pr.number, {
          headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3.diff' }
        });
        if (!diffResponse.ok) { console.log('[github] Failed to fetch diff: HTTP ' + diffResponse.status); continue; }
        var diff = await diffResponse.text();
        console.log('[github] Diff size:', diff.length, 'chars');

        // Check if pure design assets
        var lines = diff.split('\n');
        var designOnlyFiles = lines.filter(function (l) { return l.match(/^\+\+\+ .+\.(css|scss|svg|png|jpg|jpeg|gif|webp|ico)/); }).length;
        var totalFiles = lines.filter(function (l) { return l.startsWith('+++ '); }).length;
        var isDesignOnly = totalFiles > 0 && designOnlyFiles === totalFiles;

        // Review with Claude
        console.log('[github] Calling Claude to review PR #' + pr.number);
        await setStatus('Reviewing PR #' + pr.number + ': ' + pr.title.substring(0, 40));
        var truncatedDiff = diff.substring(0, 15000);
        var review = await ask(
          'Review this pull request diff. Focus on: bugs, logic errors, security issues, and code quality. ' +
          'Be concise. If the PR looks good, say so briefly. If there are issues, list them with specific line references.\n\n' +
          'PR #' + pr.number + ': ' + pr.title + '\n' +
          'Author: ' + (pr.user ? pr.user.login : 'unknown') + '\n' +
          'Description: ' + (pr.body || '(none)').substring(0, 500),
          'Diff:\n' + truncatedDiff
        );

        // If rate limited, skip this PR
        if (!review) {
          console.log('[github] Rate limited — skipping PR #' + pr.number);
          continue;
        }

        // Post review on GitHub
        await fetch('https://api.github.com/repos/' + repo + '/issues/' + pr.number + '/comments', {
          method: 'POST',
          headers: {
            'Authorization': 'token ' + GITHUB_TOKEN,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: '**admin-claude review:**\n\n' + review })
        });

        if (isDesignOnly) {
          await apiPost('/messages', {
            from_agent: AGENT_ID,
            to_agent: null,
            content: 'PR #' + pr.number + ' in ' + repo + ' is design-only (' + designOnlyFiles + ' asset files). Claude reviewed the code, but visual changes need human eyes: ' + pr.html_url,
            msg_type: 'info'
          });
        }

        // Mark reviewed
        try {
          await apiPut('/context/keys/admin-claude/pr-reviewed-' + pr.number, {
            data: JSON.stringify({ reviewed: true, at: new Date().toISOString(), design_only: isDesignOnly })
          });
        } catch (err) {
          // Non-critical
        }

        console.log('[github] Reviewed PR #' + pr.number + ' in ' + repo + (isDesignOnly ? ' (design-only, flagged for human)' : ''));
      }
    } catch (err) {
      console.error('[github] Error checking PRs for ' + repo + ':', err.message);
    }
  }
  await resetStatus();
}
