// =============== admin-claude Event Handlers ===============
// Clean split: requests = coordination/judgment. Drone jobs = compute execution.
// admin-claude handles requests, never creates drone jobs directly.

import { ask, askJson } from './claude.js';
import { apiGet, apiPost, apiPut } from './api.js';
import { AGENT_ID, GITHUB_TOKEN, GITHUB_REPOS } from './config.js';

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
    case 'request_created':
      return handleRequestCreated(data);
    case 'bug_created':
      return handleBugCreated(data);
    case 'drone_job_exhausted':
      return handleDroneJobExhausted(data);
    case 'approval_requested':
      return handleApprovalRequested(data);
    default:
      // Log but don't process other events
      break;
  }
}

// ---- Handler: request_created ----
// Read the request, call Claude to draft a helpful response, resolve it.
// Posture: "approve and route" — be helpful, don't gatekeep.

async function handleRequestCreated(data) {
  if (!data.message_id) return;
  var fromAgent = data.from || 'unknown';
  await setStatus('Responding to request from ' + fromAgent);

  // Fetch the full request message
  var msg;
  try {
    msg = await apiGet('/messages?limit=1&from_agent=' + encodeURIComponent(data.from || ''));
    // The webhook data might have message_id — try to get context
  } catch (err) {
    console.error('[request] Failed to fetch request context:', err.message);
  }

  var content = data.content || '(no content)';
  var fromAgent = data.from || 'unknown';

  // Get current network state for context
  var ops;
  try {
    ops = await apiGet('/admin/ops');
  } catch (err) {
    ops = {};
  }

  var context = 'Request from: ' + fromAgent + '\n' +
    'Request content: ' + content + '\n' +
    'Current unassigned tasks: ' + (ops.unassigned_tasks ? ops.unassigned_tasks.length : 0) + '\n' +
    'Current open bugs: ' + (ops.unassigned_bugs ? ops.unassigned_bugs.length : 0);

  var response = await ask(
    'An agent sent a request that needs a response. Draft a helpful, concise response. ' +
    'If they are asking for work, suggest available tasks or bugs they could claim. ' +
    'If they are asking a question, answer directly. Be actionable, not vague.',
    context
  );

  // Resolve the request with our response
  try {
    await apiPut('/messages/' + data.message_id + '/resolve', {
      resolved_by: AGENT_ID,
      response: response
    });
    // Send a follow-up message so the agent sees the response
    await apiPost('/messages', {
      from_agent: AGENT_ID,
      to_agent: fromAgent,
      content: response,
      msg_type: 'message'
    });
    console.log('[request] Resolved request #' + data.message_id + ' from ' + fromAgent);
  } catch (err) {
    console.error('[request] Failed to resolve:', err.message);
  }
  await resetStatus();
}

// ---- Handler: bug_created ----
// If unassigned, assess severity and suggest an assignee by project match.

async function handleBugCreated(data) {
  if (!data.bug_id) return;
  await setStatus('Triaging bug #' + data.bug_id);

  // Fetch the full bug
  var bug;
  try {
    bug = await apiGet('/bugs/' + data.bug_id);
  } catch (err) {
    console.error('[bug] Failed to fetch bug #' + data.bug_id + ':', err.message);
    return;
  }

  // Don't reassign bugs that already have an owner
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
// All drones failed this job. Notify the requester with error details.

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
// Low risk: auto-approve. Medium+: broadcast to human operators.

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

  if (riskTier === 'low') {
    // Auto-approve low risk actions
    try {
      await apiPut('/approvals/' + approval.id, {
        status: 'approved',
        reason: '[admin-claude] Auto-approved: low risk action'
      });
      console.log('[approval] Auto-approved low-risk #' + approval.id + ': ' + approval.title);
    } catch (err) {
      console.error('[approval] Failed to auto-approve:', err.message);
    }
  } else {
    // Medium+ risk: broadcast to human operators
    var message = 'Approval needed [' + riskTier + ' risk]: ' + approval.title + ' (' + approval.action_type + ')' +
      '\nRequested by: ' + approval.requested_by +
      '\nApproval #' + approval.id + ' — review in dashboard or respond here.';

    try {
      await apiPost('/messages', {
        from_agent: AGENT_ID,
        to_agent: null, // broadcast
        content: message,
        msg_type: 'info'
      });
      console.log('[approval] Escalated ' + riskTier + '-risk #' + approval.id + ' to humans');
    } catch (err) {
      console.error('[approval] Failed to escalate:', err.message);
    }
  }
  await resetStatus();
}

// ---- Periodic: GitHub PR check ----
// Poll open PRs, review with Claude, post comments.

export async function checkGitHubPRs() {
  if (!GITHUB_TOKEN) return;
  await setStatus('Checking GitHub PRs');

  for (var repo of GITHUB_REPOS) {
    try {
      var prsResponse = await fetch('https://api.github.com/repos/' + repo + '/pulls?state=open&per_page=10', {
        headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!prsResponse.ok) {
        console.error('[github] Failed to fetch PRs for ' + repo + ': HTTP ' + prsResponse.status);
        continue;
      }
      var prs = await prsResponse.json();

      for (var pr of prs) {
        // Check if already reviewed via context keys
        var contextKey;
        try {
          contextKey = await apiGet('/context/keys/admin-claude/pr-reviewed-' + pr.number);
        } catch (err) {
          contextKey = null;
        }

        if (contextKey && contextKey.data) {
          var reviewData;
          try { reviewData = JSON.parse(contextKey.data); } catch (e) { reviewData = {}; }
          if (reviewData.reviewed) continue; // Already reviewed
        }

        // Fetch the diff
        var diffResponse = await fetch(pr.diff_url, {
          headers: { 'Authorization': 'token ' + GITHUB_TOKEN }
        });
        if (!diffResponse.ok) continue;
        var diff = await diffResponse.text();

        // Check if UI-heavy (>50% tsx/css changes)
        var lines = diff.split('\n');
        var uiLines = lines.filter(function (l) { return l.match(/^\+\+\+ .+\.(tsx|css|scss|svg)/); }).length;
        var totalFiles = lines.filter(function (l) { return l.startsWith('+++ '); }).length;
        var isUiHeavy = totalFiles > 0 && (uiLines / totalFiles) > 0.5;

        if (isUiHeavy) {
          // Flag for human review
          await setStatus('Flagging UI-heavy PR #' + pr.number + ' for human review');
          await apiPost('/messages', {
            from_agent: AGENT_ID,
            to_agent: null,
            content: 'PR #' + pr.number + ' in ' + repo + ' is UI-heavy (' + uiLines + '/' + totalFiles + ' UI files). Needs human review: ' + pr.html_url,
            msg_type: 'info'
          });
        } else {
          // Code-only: Claude reviews
          await setStatus('Reviewing PR #' + pr.number + ': ' + pr.title.substring(0, 40));
          var truncatedDiff = diff.substring(0, 15000); // Limit diff size for API
          var review = await ask(
            'Review this pull request diff. Focus on: bugs, logic errors, security issues, and code quality. ' +
            'Be concise. If the PR looks good, say so briefly. If there are issues, list them with specific line references.\n\n' +
            'PR #' + pr.number + ': ' + pr.title + '\n' +
            'Author: ' + (pr.user ? pr.user.login : 'unknown') + '\n' +
            'Description: ' + (pr.body || '(none)').substring(0, 500),
            'Diff:\n' + truncatedDiff
          );

          // Post review comment on GitHub
          await fetch('https://api.github.com/repos/' + repo + '/issues/' + pr.number + '/comments', {
            method: 'POST',
            headers: {
              'Authorization': 'token ' + GITHUB_TOKEN,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body: '**admin-claude review:**\n\n' + review })
          });
        }

        // Mark as reviewed in context keys
        try {
          await apiPut('/context/keys/admin-claude/pr-reviewed-' + pr.number, {
            data: JSON.stringify({ reviewed: true, at: new Date().toISOString(), ui_heavy: isUiHeavy })
          });
        } catch (err) {
          // Non-critical
        }

        console.log('[github] Reviewed PR #' + pr.number + ' in ' + repo + (isUiHeavy ? ' (flagged for human)' : ''));
      }
    } catch (err) {
      console.error('[github] Error checking PRs for ' + repo + ':', err.message);
    }
  }
  await resetStatus();
}
