// =============== admin-claude Configuration ===============

export var MYCELIUM_API_URL = process.env.MYCELIUM_API_URL || 'https://mycelium.fyi/api/mycelium';
export var MYCELIUM_ADMIN_KEY = process.env.MYCELIUM_ADMIN_KEY || '';
export var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export var WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
export var GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export var PORT = parseInt(process.env.PORT) || 3003;
export var AGENT_ID = 'admin-claude';
export var MODEL = 'claude-sonnet-4-6'; // Sonnet for fast/cheap triage

// Rate limiting: max Claude API calls per minute
export var MAX_CLAUDE_CALLS_PER_MIN = parseInt(process.env.MAX_CLAUDE_CALLS_PER_MIN) || 30;

// GitHub repos to watch for PRs
export var GITHUB_REPOS = (process.env.GITHUB_REPOS || 'grbarajas-soymd/mycelium').split(',').map(function (r) { return r.trim(); });

// System prompt for admin-claude's judgment calls
export var SYSTEM_PROMPT = `You are admin-claude, the automated administrator for Mycelium — a distributed development platform.

Your posture is "approve and route" — be helpful, don't gatekeep. Your job is to keep the network running smoothly by:
- Responding helpfully to agent requests
- Triaging and assigning bugs by project match
- Escalating things that need human eyes
- Auto-approving low-risk actions

Key context:
- Agents: greatness-claude (admin, WS project), hijack-claude (agent, KC project), unakron-gpu/unakron-gpu-2 (drones)
- Projects: willing-sacrifice (WS), king-city (KC), mycelium (platform), dioverse (shared universe)
- Operators (humans): greatness (owner), hijack (ui_lead), unakron (member)
- Drones handle compute (art gen, scripts, training). Agents handle coordination/code.
- Don't auto-assign tasks — agents claim work FIFO. You can suggest assignees for bugs.

Keep responses concise and actionable. When routing, include specific next steps.`;

// Actions admin-claude can take without human approval
export var SAFE_ACTIONS = [
  'respond_to_request',
  'assign_bug',
  'send_message',
  'update_bug_severity',
  'approve_low_risk',
  'approve_medium_risk',
  'merge_pr'
];

// Actions that require human escalation (dashboard Approvals page)
export var GATED_ACTIONS = [
  'approve_high_risk',
  'approve_critical_risk',
  'deploy',
  'delete_anything',
  'modify_agent_config'
];
