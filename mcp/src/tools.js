// All MCP tool registrations for the Mycelium API
// Tools are registered as mycelium_* (primary) with studio_* aliases.

import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from './api.js';
import { getState, setWorkingOn, setBooted, startHeartbeat, sendHeartbeat, setClaimedItem, setCurrentStep, addProgressNote } from './state.js';

function text(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] };
}

// Register a tool under mycelium_* name only (studio_* aliases removed to stay under tool limits)
// Wraps handler with error handling so failures return MCP error content instead of crashing
function registerDual(server, studioName, description, schema, handler) {
  var myceliumName = studioName.replace(/^studio_/, 'mycelium_');
  var safeHandler = async function(args) {
    try {
      return await handler(args);
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      return { content: [{ type: 'text', text: 'Error in ' + myceliumName + ': ' + msg }], isError: true };
    }
  };
  server.tool(myceliumName, description, schema, safeHandler);
}

// Safely parse a JSON string param, returning fallback on failure
function safeParseJSON(str, fallback) {
  if (!str) return fallback !== undefined ? fallback : {};
  try { return JSON.parse(str); } catch (e) {
    throw new Error('Invalid JSON: ' + e.message + ' — input: ' + str.substring(0, 100));
  }
}

function timeAgo(iso) {
  if (!iso) return 'never';
  var ms = Date.now() - new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (ms < 60000) return Math.round(ms / 1000) + 's ago';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
  return Math.round(ms / 86400000) + 'd ago';
}

function formatAgent(a) {
  var line = (a.status === 'online' ? '[ON] ' : '[OFF] ') + a.name + ' (' + a.id + ')';
  if (a.project_id) line += ' — ' + a.project_id;
  if (a.working_on) line += '\n  Working on: ' + a.working_on;
  line += '\n  Heartbeat: ' + timeAgo(a.last_heartbeat);
  return line;
}

function formatTask(t) {
  return '#' + t.id + ' [' + t.status + '] ' + t.title + (t.assignee ? ' →' + t.assignee : '') + (t.priority && t.priority !== 'normal' ? ' [' + t.priority + ']' : '');
}

function formatBug(b) {
  return '#' + b.id + ' [' + b.severity + '] ' + b.title + (b.assignee ? ' →' + b.assignee : '') + ' (' + b.status + ')';
}

function formatMessage(m) {
  var tag = m.msg_type === 'request' ? '[REQ] ' : m.msg_type === 'directive' ? '[DIR] ' : '';
  var body = (m.content || '').slice(0, 200);
  if ((m.content || '').length > 200) body += '...';
  return tag + m.from_agent + '→' + (m.to_agent || 'all') + ': ' + body;
}

function formatPlan(p) {
  var steps = (p.steps || []);
  var done = steps.filter(function (s) { return s.status === 'completed'; }).length;
  return '#' + p.id + ' [' + p.status + '] ' + p.title + ' (' + done + '/' + steps.length + ' steps done)';
}

export function registerTools(server) {

  // ===== SESSION =====

  registerDual(server,
    'studio_boot',
    'Boot agent session or get admin overview. Agent mode: starts auto-heartbeat, returns tasks/messages/plans. Admin mode: returns full dashboard.',
    {},
    async () => {
      var st = getState();
      if (st.role === 'agent' && st.agentId) {
        var data = await apiGet('/boot/' + st.agentId + '?verbose=true');
        setBooted(data);
        startHeartbeat();
        var proj = data.agent.project || '';
        var lines = ['Booted as ' + st.agentId + ' (' + proj + ')'];

        // Role contract
        if (data.role_contract) {
          lines.push('');
          lines.push('=== Role Contract ===');
          var rc = data.role_contract;
          if (typeof rc === 'string') {
            lines.push(rc);
          } else {
            lines.push('Role: ' + (rc.role || '') + (rc.llm_backend ? ' (' + rc.llm_backend + '/' + (rc.llm_model || '?') + ')' : ''));
            if (rc.description) lines.push(rc.description);
            if (rc.responsibilities && rc.responsibilities.length) {
              for (var resp of rc.responsibilities) lines.push('- ' + resp);
            }
            if (rc.constraints && rc.constraints.length) {
              for (var con of rc.constraints) lines.push('! ' + con);
            }
            if (rc.capabilities && rc.capabilities.length) lines.push('Can: ' + rc.capabilities.join(', '));
          }
        }

        // Counts summary
        if (data.counts) {
          var c = data.counts;
          var parts = [];
          if (c.directives) parts.push(c.directives + ' directive' + (c.directives > 1 ? 's' : ''));
          if (c.requests) parts.push(c.requests + ' request' + (c.requests > 1 ? 's' : ''));
          if (c.messages_unread) parts.push(c.messages_unread + ' unread');
          if (c.tasks_mine) parts.push(c.tasks_mine + ' task' + (c.tasks_mine > 1 ? 's' : ''));
          if (c.bugs_open) parts.push(c.bugs_open + ' bug' + (c.bugs_open > 1 ? 's' : ''));
          if (c.plans_active) parts.push(c.plans_active + ' active plan' + (c.plans_active > 1 ? 's' : ''));
          if (parts.length) lines.push('\nPending: ' + parts.join(', '));
        }

        // Work queue
        if (data.work_queue && data.work_queue.length > 0) {
          lines.push('');
          lines.push('=== Work Queue (' + data.work_queue.length + ' items) ===');
          for (var item of data.work_queue) {
            lines.push((item.type || '').toUpperCase() + ' #' + item.id + ': ' + item.title);
          }
        }

        // Blocking directives
        if (data.pending_directives && data.pending_directives.length > 0) {
          lines.push('');
          lines.push('*** BLOCKING DIRECTIVES (' + data.pending_directives.length + ') ***');
          lines.push('You MUST respond to these before receiving work assignments.');
          for (var dir of data.pending_directives) {
            lines.push('  #' + dir.id + ' from ' + dir.from + ': ' + (dir.content || '').substring(0, 200));
          }
        }

        // Pending requests
        if (data.pending_requests && data.pending_requests.length > 0) {
          lines.push('');
          lines.push('=== Pending Requests (' + data.pending_requests.length + ') ===');
          for (var r of data.pending_requests) {
            lines.push('[REQ] ' + r.from + ': ' + (r.content || '').substring(0, 200));
          }
        }

        // Other agents
        if (data.other_agents && data.other_agents.length > 0) {
          lines.push('');
          lines.push('=== Agents ===');
          for (var a of data.other_agents) {
            lines.push('[' + (a.status === 'online' ? 'ON' : 'OFF') + '] ' + a.id + (a.working_on ? ': ' + a.working_on : ''));
          }
        }

        // Savepoint
        if (data.savepoint && data.savepoint.has_savepoint) {
          var sp = data.savepoint;
          lines.push('');
          lines.push('=== Session Resume ===');
          lines.push('Last session: ' + (sp.was_working_on || 'idle'));
          if (sp.notes) lines.push('*** NOTES: ' + sp.notes + ' ***');
        }

        if (data.changes_since_last) {
          lines.push('Changes: ' + data.changes_since_last);
        }

        lines.push('', 'Auto-heartbeat started. Server time: ' + data.server_time);
        return text(lines.join('\n'));
      }

      // Admin mode — request verbose format (slim boot removed full data)
      var overview = await apiGet('/admin/overview?verbose=true');
      return text(formatOverview(overview));
    }
  );

  registerDual(server,
    'studio_overview',
    'Get full Mycelium dashboard snapshot: agents, tasks, messages, plans, bugs.',
    {},
    async () => {
      var data = await apiGet('/admin/overview?verbose=true');
      return text(formatOverview(data));
    }
  );

  // ===== TASKS =====

  registerDual(server,
    'studio_get_work',
    'Get prioritized work queue: directives > requests > plan steps > tasks > bugs. Set auto_claim=true to automatically claim and start the top work item.',
    {
      auto_claim: { type: 'boolean', description: 'Auto-claim the top work item (assign to self, set in_progress). Default: false.' }
    },
    async (params) => {
      var st = getState();
      var lines = [];
      var autoClaim = params && params.auto_claim;

      if (st.role === 'agent' && st.agentId) {
        var endpoint = '/work/' + st.agentId + (autoClaim ? '?auto_claim=true' : '');
        var data = await apiGet(endpoint);
        var queue = data.queue || data.work_queue || [];

        if (data.claimed) {
          lines.push('=== AUTO-CLAIMED ===');
          var c = data.claimed;
          lines.push('Type: ' + c.type + ' | ID: #' + c.id);
          lines.push('Title: ' + c.title);
          if (c.description) lines.push('Description: ' + c.description);
          if (c.plan_title) lines.push('Plan: ' + c.plan_title);
          if (c.summary) lines.push('Summary: ' + c.summary);
          lines.push('');
          setClaimedItem({ type: c.type, id: c.id, title: c.title });
        }

        if (queue.length) {
          var typeLabels = { directive: 'DIRECTIVE', request: 'REQUEST', plan_step: 'PLAN STEP', task: 'TASK', bug: 'BUG', plan_step_unassigned: 'PLAN STEP (unclaimed)', bug_unassigned: 'BUG (unclaimed)' };
          lines.push('=== Prioritized Work Queue (' + queue.length + ' items) ===');
          for (var i = 0; i < queue.length; i++) {
            var item = queue[i];
            var label = typeLabels[item.type] || item.type;
            var line = (i + 1) + '. [' + label + '] #' + item.id;
            if (item.plan_title) line += ' (' + item.plan_title + ')';
            line += ': ' + item.title;
            if (item.status) line += ' [' + item.status + ']';
            if (item.summary) line += ' — ' + item.summary;
            lines.push(line);
          }
        } else if (!data.claimed) {
          lines.push('No work items found. You are idle.');
        }
        return text(lines.join('\n'));
      }

      // Admin: show all open work
      var overview = await apiGet('/admin/overview');
      var tasks = overview.tasks || {};
      var allTasks = [].concat(tasks.open || [], tasks.in_progress || [], tasks.review || []);
      if (allTasks.length) {
        lines.push('=== All Open Tasks (' + allTasks.length + ') ===');
        for (var t2 of allTasks) lines.push(formatTask(t2));
        lines.push('');
      }
      if (overview.approval_queue && overview.approval_queue.length) {
        lines.push('=== Approval Queue (' + overview.approval_queue.length + ') ===');
        for (var aq of overview.approval_queue) lines.push(formatTask(aq));
        lines.push('');
      }
      if (!lines.length) lines.push('No open work items.');
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_claim_task',
    'Claim a task: assigns it to you, sets status to in_progress, and updates your working_on status automatically.',
    { task_id: z.number().describe('Task ID to claim') },
    async (args) => {
      var st = getState();
      var assignee = st.agentId || '__admin__';

      // Get task details first
      var task = await apiGet('/tasks/' + args.task_id);
      await apiPut('/tasks/' + args.task_id, { assignee: assignee, status: 'in_progress' });

      // Auto-update working_on and track claimed item
      setWorkingOn(task.title);
      setClaimedItem({ type: 'task', id: args.task_id, title: task.title });
      if (st.role === 'agent') await sendHeartbeat();

      return text('Claimed task #' + args.task_id + ': ' + task.title + '\nworking_on updated to: "' + task.title + '"');
    }
  );

  registerDual(server,
    'studio_complete_task',
    'Mark a task as done. Automatically advances working_on to next task or clears it if no more work.',
    {
      task_id: z.number().describe('Task ID to complete'),
      notes: z.string().optional().describe('Optional completion notes')
    },
    async (args) => {
      var st = getState();
      var update = { status: 'done' };
      if (args.notes) update.description = args.notes;
      await apiPut('/tasks/' + args.task_id, update);
      addProgressNote('Completed task #' + args.task_id);
      setClaimedItem(null);

      // Find next task (use /work/ to avoid emitting a spurious agent_boot event)
      var nextWork = '';
      if (st.role === 'agent' && st.agentId) {
        try {
          var workData = await apiGet('/work/' + st.agentId);
          if (workData.tasks.length) {
            nextWork = workData.tasks[0].title;
          }
        } catch { /* ignore */ }
      }

      setWorkingOn(nextWork);
      if (st.role === 'agent') await sendHeartbeat();

      var msg = 'Completed task #' + args.task_id + '.';
      if (nextWork) msg += '\nworking_on advanced to: "' + nextWork + '"';
      else msg += '\nworking_on cleared (no more tasks).';
      return text(msg);
    }
  );

  registerDual(server,
    'studio_create_task',
    'Create a new task on the board.',
    {
      title: z.string().describe('Task title'),
      description: z.string().describe('Task description'),
      project_id: z.string().describe('Project identifier'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level'),
      assignee: z.string().optional().describe('Agent ID to assign to'),
      needs_approval: z.boolean().optional().describe('Whether task needs admin approval before work starts')
    },
    async (args) => {
      var st = getState();
      var body = {
        title: args.title,
        description: args.description,
        project_id: args.project_id,
        priority: args.priority || 'normal',
        requester: st.agentId || '__admin__'
      };
      if (args.assignee) body.assignee = args.assignee;
      if (args.needs_approval) body.needs_approval = 1;
      var result = await apiPost('/tasks', body);
      return text('Created task #' + result.id + ': ' + args.title);
    }
  );

  // ===== COMMUNICATION =====

  registerDual(server,
    'studio_send_message',
    'Send a message to an agent or broadcast to all.',
    {
      content: z.string().describe('Message content'),
      to: z.string().optional().describe('Agent ID to send to (omit for broadcast)'),
      project_id: z.string().optional().describe('Project context')
    },
    async (args) => {
      var st = getState();
      var body = {
        content: args.content,
        from_agent: st.agentId || '__admin__'
      };
      if (args.to) body.to_agent = args.to;
      if (args.project_id) body.project_id = args.project_id;
      var result = await apiPost('/messages', body);
      return text('Message sent (id: ' + result.id + ') to ' + (args.to || 'all'));
    }
  );

  registerDual(server,
    'studio_send_request',
    'Send a blocking request to an agent. They must respond before you can continue.',
    {
      content: z.string().describe('What you need from them'),
      to: z.string().describe('Agent ID to request from'),
      auto_task: z.boolean().optional().describe('Auto-create a task for this request'),
      project_id: z.string().optional().describe('Project context')
    },
    async (args) => {
      var st = getState();
      var body = {
        content: args.content,
        to_agent: args.to,
        from_agent: st.agentId || '__admin__'
      };
      if (args.auto_task) body.auto_task = true;
      if (args.project_id) body.project_id = args.project_id;
      var result = await apiPost('/requests', body);
      return text('Request sent (id: ' + result.id + ') to ' + args.to +
        (result.task_id ? '\nAuto-created task #' + result.task_id : ''));
    }
  );

  registerDual(server,
    'studio_respond_to_request',
    'Respond to a pending request, resolving it.',
    {
      request_id: z.number().describe('Request/message ID to respond to'),
      response: z.string().describe('Your response')
    },
    async (args) => {
      await apiPut('/messages/' + args.request_id + '/resolve', { response: args.response });
      return text('Request #' + args.request_id + ' resolved.');
    }
  );

  registerDual(server,
    'studio_read_messages',
    'Read recent messages and pending requests.',
    {
      since: z.string().optional().describe('ISO timestamp to filter messages from'),
      from: z.string().optional().describe('Filter by sender agent ID'),
      limit: z.number().optional().describe('Max messages to return (default 30)')
    },
    async (args) => {
      var st = getState();
      var params = [];
      if (args.since) params.push('since=' + encodeURIComponent(args.since));
      if (args.from) params.push('from=' + encodeURIComponent(args.from));
      if (args.limit) params.push('limit=' + args.limit);
      // Auto-filter to this agent's inbox (messages TO me + broadcasts)
      if (st.agentId && !args.from) params.push('to=' + encodeURIComponent(st.agentId));
      var qs = params.length ? '?' + params.join('&') : '';
      var messages = await apiGet('/messages' + qs);
      // Also fetch pending requests targeted at this agent
      var pending = [];
      if (st.agentId) {
        try {
          pending = await apiGet('/messages?to=' + encodeURIComponent(st.agentId) + '&status=pending&msg_type=request&limit=10');
        } catch (e) { /* non-fatal */ }
      }
      // Merge: pending requests first (deduped), then recent messages
      var seenIds = new Set();
      var all = [];
      for (var p of pending) { seenIds.add(p.id); all.push(p); }
      for (var m of messages) { if (!seenIds.has(m.id)) all.push(m); }
      if (!all.length) return text('No messages found.');
      var lines = all.map(formatMessage);
      return text(lines.join('\n'));
    }
  );

  // ===== PLANS =====

  registerDual(server,
    'studio_check_plans',
    'View active plans and their steps.',
    {
      project_id: z.string().optional().describe('Filter by project'),
      status: z.string().optional().describe('Filter by status (default: active)')
    },
    async (args) => {
      var params = [];
      if (args.project_id) params.push('project_id=' + encodeURIComponent(args.project_id));
      params.push('status=' + (args.status || 'active'));
      var plans = await apiGet('/plans?' + params.join('&'));
      if (!plans.length) return text('No plans found.');

      var lines = [];
      for (var p of plans) {
        // Fetch full plan with steps
        var full = await apiGet('/plans/' + p.id);
        lines.push(formatPlan(full));
        lines.push('');
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_update_step',
    'Update a plan step status, assignee, or linked resources.',
    {
      plan_id: z.number().describe('Plan ID'),
      step_id: z.number().describe('Step ID'),
      status: z.string().optional().describe('New status: pending, in_progress, completed, blocked'),
      assignee: z.string().optional().describe('Agent ID to assign step to'),
      linked_task_id: z.number().optional().describe('Link to a task ID'),
      linked_branch: z.string().optional().describe('Git branch name')
    },
    async (args) => {
      var body = {};
      if (args.status) body.status = args.status;
      if (args.assignee) body.assignee = args.assignee;
      if (args.linked_task_id) body.linked_task_id = args.linked_task_id;
      if (args.linked_branch) body.linked_branch = args.linked_branch;
      await apiPut('/plans/' + args.plan_id + '/steps/' + args.step_id, body);
      if (args.status === 'in_progress') {
        setCurrentStep({ plan_id: args.plan_id, step_id: args.step_id });
      } else if (args.status === 'completed' || args.status === 'done') {
        addProgressNote('Completed step #' + args.step_id + ' on plan #' + args.plan_id);
        setCurrentStep(null);
      }
      return text('Updated step #' + args.step_id + ' on plan #' + args.plan_id);
    }
  );

  // ===== PLAN CREATION =====

  registerDual(server,
    'studio_create_plan',
    'Create a new plan with optional steps. Returns the created plan ID.',
    {
      title: z.string().describe('Plan title'),
      description: z.string().describe('Plan description'),
      project_id: z.string().describe('Project identifier'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level'),
      steps: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        assignee: z.string().optional()
      })).optional().describe('Ordered list of plan steps to create')
    },
    async (args) => {
      var st = getState();
      var body = {
        title: args.title,
        description: args.description,
        project_id: args.project_id,
        priority: args.priority || 'normal',
        owner: st.agentId || '__admin__'
      };
      if (args.steps) body.steps = args.steps;
      var result = await apiPost('/plans', body);
      var msg = 'Created plan #' + result.id + ': ' + args.title;
      if (args.steps && args.steps.length) msg += ' (' + args.steps.length + ' steps)';
      return text(msg);
    }
  );

  // ===== BUG FILING =====

  registerDual(server,
    'studio_file_bug',
    'File a new bug report.',
    {
      title: z.string().describe('Bug title'),
      description: z.string().describe('Bug description with repro steps'),
      project_id: z.string().describe('Project identifier'),
      severity: z.enum(['low', 'normal', 'high', 'critical']).optional().describe('Severity level (default: normal)'),
      category: z.string().optional().describe('Bug category (e.g. ui, api, data, other)')
    },
    async (args) => {
      var st = getState();
      var body = {
        title: args.title,
        description: args.description,
        project_id: args.project_id,
        severity: args.severity || 'normal',
        category: args.category || 'other',
        reporter: st.agentId || '__admin__'
      };
      var result = await apiPost('/bugs', body);
      return text('Filed bug #' + result.id + ' [' + (args.severity || 'normal') + ']: ' + args.title);
    }
  );

  // ===== CONTEXT =====

  registerDual(server,
    'studio_get_context',
    'Read context keys from namespaced storage.',
    {
      namespace: z.string().describe('Namespace (e.g. agent name, project name)'),
      key: z.string().optional().describe('Specific key to read (omit for all keys in namespace)')
    },
    async (args) => {
      if (args.key) {
        var val = await apiGet('/context/keys/' + encodeURIComponent(args.namespace) + '/' + encodeURIComponent(args.key));
        return text(val);
      }
      var keys = await apiGet('/context/keys/' + encodeURIComponent(args.namespace));
      return text(keys);
    }
  );

  registerDual(server,
    'studio_set_context',
    'Store a value in namespaced context storage. Persists across sessions.',
    {
      namespace: z.string().describe('Namespace'),
      key: z.string().describe('Key name'),
      data: z.string().describe('Value to store (string or JSON string)')
    },
    async (args) => {
      await apiPut('/context/keys/' + encodeURIComponent(args.namespace) + '/' + encodeURIComponent(args.key), {
        data: args.data
      });
      return text('Saved context: ' + args.namespace + '/' + args.key);
    }
  );

  // ===== BUGS =====

  registerDual(server,
    'studio_list_bugs',
    'List bug reports.',
    {
      project_id: z.string().optional().describe('Filter by project'),
      status: z.string().optional().describe('Filter by status: open, in_progress, fixed, closed')
    },
    async (args) => {
      var params = [];
      if (args.project_id) params.push('project_id=' + encodeURIComponent(args.project_id));
      if (args.status) params.push('status=' + encodeURIComponent(args.status));
      var qs = params.length ? '?' + params.join('&') : '';
      var bugs = await apiGet('/bugs' + qs);
      if (!bugs.length) return text('No bugs found.');
      return text(bugs.map(formatBug).join('\n'));
    }
  );

  registerDual(server,
    'studio_claim_bug',
    'Claim a bug and start working on it. Updates your working_on status.',
    { bug_id: z.number().describe('Bug ID to claim') },
    async (args) => {
      var st = getState();
      var bug = await apiGet('/bugs/' + args.bug_id);
      await apiPut('/bugs/' + args.bug_id, {
        status: 'in_progress',
        assignee: st.agentId || '__admin__'
      });
      setWorkingOn('Bug #' + args.bug_id + ': ' + bug.title);
      setClaimedItem({ type: 'bug', id: args.bug_id, title: bug.title });
      if (st.role === 'agent') await sendHeartbeat();
      return text('Claimed bug #' + args.bug_id + ': ' + bug.title);
    }
  );

  registerDual(server,
    'studio_fix_bug',
    'Mark a bug as fixed. Clears working_on if no other work.',
    {
      bug_id: z.number().describe('Bug ID to mark fixed'),
      notes: z.string().optional().describe('Fix notes')
    },
    async (args) => {
      var update = { status: 'fixed' };
      if (args.notes) update.admin_notes = args.notes;
      await apiPut('/bugs/' + args.bug_id, update);
      addProgressNote('Fixed bug #' + args.bug_id);
      setClaimedItem(null);

      // Check for remaining work (use /work/ to avoid emitting a spurious agent_boot event)
      var st = getState();
      var nextWork = '';
      if (st.role === 'agent' && st.agentId) {
        try {
          var workData = await apiGet('/work/' + st.agentId);
          if (workData.tasks.length) nextWork = workData.tasks[0].title;
        } catch { /* ignore */ }
      }
      setWorkingOn(nextWork);
      if (st.role === 'agent') await sendHeartbeat();
      return text('Bug #' + args.bug_id + ' marked fixed.' +
        (nextWork ? '\nworking_on: "' + nextWork + '"' : '\nworking_on cleared.'));
    }
  );

  // ===== HEARTBEAT =====

  registerDual(server,
    'studio_heartbeat',
    'Manually update your working_on status and send a heartbeat. Optionally include messages_acked and state_snapshot for savepoint.',
    {
      working_on: z.string().describe('What you are currently working on (empty string to clear)'),
      messages_acked: z.array(z.number()).optional().describe('Message IDs you have read this session'),
      state_snapshot: z.string().optional().describe('JSON snapshot of custom session state to persist')
    },
    async (args) => {
      setWorkingOn(args.working_on);
      if (getState().role === 'agent') {
        // Send heartbeat with savepoint data
        var body = { status: 'online', working_on: args.working_on };
        if (args.messages_acked) body.messages_acked = JSON.stringify(args.messages_acked);
        if (args.state_snapshot) body.state_snapshot = args.state_snapshot;
        var result = await apiPost('/agents/heartbeat', body);
        var line = 'Heartbeat sent. working_on: "' + (args.working_on || '') + '"';
        if (result && result.pending > 0) line += ' | ' + result.pending + ' pending';
        if (result && result.wake) line += ' | WAKE: urgent items waiting — run mycelium_get_work';
        if (result && result.auto_dispatched && result.auto_dispatched.length > 0) {
          line += '\nAuto-dispatched: ' + result.auto_dispatched.map(function (d) { return d.title; }).join(', ');
        }
        return text(line);
      }
      return text('working_on set locally: "' + args.working_on + '" (admin mode — no heartbeat sent)');
    }
  );

  // ===== SLEEP MODE =====

  registerDual(server,
    'studio_sleep',
    'Turn sleep mode on or off. When on, agents receive a night directive and work autonomously. When off, you get a morning summary of what happened.',
    {
      action: z.enum(['on', 'off']).describe('on = go to sleep, off = wake up'),
      directive: z.string().optional().describe('Night directive for agents (what to work on while you sleep). Only used with action=on.'),
      operator_id: z.string().optional().describe('Your operator ID (auto-detected if omitted)'),
    },
    async (args) => {
      var body = { action: args.action };
      if (args.directive) body.directive = args.directive;
      if (args.operator_id) body.operator_id = args.operator_id;
      var data = await apiPut('/admin/sleep', body);
      if (args.action === 'on') {
        var lines = ['Sleep mode ON. Agents notified.'];
        if (data.sleep_mode && data.sleep_mode.directive) lines.push('Directive: ' + data.sleep_mode.directive);
        lines.push('Run mycelium_sleep with action=off when you wake up to get your morning summary.');
        return text(lines.join('\n'));
      } else {
        var wlines = ['Sleep mode OFF. Good morning!'];
        var log = data.morning_summary;
        if (log) {
          if (log.tasks_completed && log.tasks_completed.length > 0) {
            wlines.push('\nTasks completed (' + log.tasks_completed.length + '):');
            for (var t of log.tasks_completed) wlines.push('  ✓ ' + (t.title || t.id));
          }
          if (log.steps_completed && log.steps_completed.length > 0) {
            wlines.push('\nPlan steps completed (' + log.steps_completed.length + '):');
            for (var s of log.steps_completed) wlines.push('  ✓ ' + (s.title || s.id));
          }
          if (log.approvals_queued && log.approvals_queued.length > 0) {
            wlines.push('\nApprovals waiting (' + log.approvals_queued.length + '):');
            for (var a of log.approvals_queued) wlines.push('  ! ' + (a.title || a.id));
          }
          if ((!log.tasks_completed || log.tasks_completed.length === 0) &&
              (!log.steps_completed || log.steps_completed.length === 0)) {
            wlines.push('Nothing was completed while you slept.');
          }
        }
        if (data.slept_since) wlines.push('\nSlept since: ' + data.slept_since);
        return text(wlines.join('\n'));
      }
    }
  );

  // ===== REKEY =====

  registerDual(server,
    'studio_rekey',
    'Rotate your agent API key. Returns a new key — update your MCP config (MYCELIUM_API_KEY) with it and restart your session.',
    {},
    async () => {
      var st = getState();
      if (st.role !== 'agent' || !st.agentId) {
        return text('Rekey is only available in agent mode.');
      }
      var result = await apiPost('/agents/rekey', {});
      return text('New API key for ' + result.id + ':\n\n  ' + result.api_key + '\n\nUpdate MYCELIUM_API_KEY in your MCP config (e.g. ~/.claude/settings.json) and restart your Claude session.');
    }
  );

  // ===== PROFILE =====

  registerDual(server,
    'studio_set_avatar',
    'Set your agent avatar to a URL. Use an image from your project assets or any public image URL.',
    {
      avatar_url: z.string().describe('URL of the avatar image (or empty string to clear)')
    },
    async (args) => {
      var st = getState();
      if (st.role !== 'agent' || !st.agentId) {
        return text('Avatar can only be set in agent mode.');
      }
      await apiPut('/agents/' + st.agentId, { avatar_url: args.avatar_url });
      return text('Avatar updated for ' + st.agentId + (args.avatar_url ? ': ' + args.avatar_url : ' (cleared)'));
    }
  );

  // ===== ORGANIZATIONS =====

  registerDual(server,
    'studio_list_orgs',
    'List organizations on the network.',
    {},
    async () => {
      var orgs = await apiGet('/orgs');
      if (!orgs.length) return text('No organizations found.');
      var lines = ['=== Organizations (' + orgs.length + ') ==='];
      for (var o of orgs) {
        lines.push('#' + o.id + ' ' + o.name + (o.description ? ' — ' + o.description : ''));
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_create_org',
    'Create a new organization.',
    {
      name: z.string().describe('Organization name'),
      description: z.string().optional().describe('Organization description')
    },
    async (args) => {
      var body = { name: args.name };
      if (args.description) body.description = args.description;
      var result = await apiPost('/orgs', body);
      return text('Created org #' + result.id + ': ' + args.name);
    }
  );

  // ===== PROJECTS =====

  registerDual(server,
    'studio_list_projects',
    'List projects on the network.',
    {
      org_id: z.number().optional().describe('Filter by organization ID')
    },
    async (args) => {
      var params = [];
      if (args.org_id) params.push('org_id=' + args.org_id);
      var qs = params.length ? '?' + params.join('&') : '';
      var projects = await apiGet('/projects' + qs);
      if (!projects.length) return text('No projects found.');
      var lines = ['=== Projects (' + projects.length + ') ==='];
      for (var p of projects) {
        lines.push(p.id + ' — ' + (p.name || p.id) +
          (p.type ? ' [' + p.type + ']' : '') +
          (p.description ? ': ' + p.description : ''));
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_create_project',
    'Create a new project.',
    {
      id: z.string().describe('Project identifier (slug, e.g. my-project)'),
      name: z.string().describe('Display name'),
      description: z.string().optional().describe('Project description'),
      type: z.string().optional().describe('Project type (e.g. game, film, software, book)'),
      org_id: z.number().optional().describe('Organization ID to link to')
    },
    async (args) => {
      var body = { id: args.id, name: args.name };
      if (args.description) body.description = args.description;
      if (args.type) body.type = args.type;
      if (args.org_id) body.org_id = args.org_id;
      var result = await apiPost('/projects', body);
      return text('Created project: ' + args.id + ' (' + args.name + ')');
    }
  );

  registerDual(server,
    'studio_update_project',
    'Update an existing project.',
    {
      id: z.string().describe('Project identifier'),
      name: z.string().optional().describe('New display name'),
      description: z.string().optional().describe('New description'),
      type: z.string().optional().describe('New project type')
    },
    async (args) => {
      var body = {};
      if (args.name) body.name = args.name;
      if (args.description) body.description = args.description;
      if (args.type) body.type = args.type;
      await apiPut('/projects/' + encodeURIComponent(args.id), body);
      return text('Updated project: ' + args.id);
    }
  );

  // ===== CONCEPTS =====

  registerDual(server,
    'studio_list_concepts',
    'List shared concepts (characters, styles, rulesets, etc). Optionally filter by type.',
    {
      type: z.enum(['character', 'style', 'ruleset', 'library', 'brand', 'custom']).optional().describe('Filter by concept type')
    },
    async (args) => {
      var qs = args.type ? '?type=' + encodeURIComponent(args.type) : '';
      var concepts = await apiGet('/concepts' + qs);
      if (!concepts.length) return text('No concepts found.');
      var lines = ['=== Concepts (' + concepts.length + ') ==='];
      for (var c of concepts) {
        lines.push('#' + c.id + ' [' + c.type + '] ' + c.name +
          (c.description ? ' — ' + c.description : ''));
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_get_concept',
    'Get a single concept by ID, including linked projects.',
    {
      concept_id: z.string().describe('Concept ID')
    },
    async (args) => {
      var concept = await apiGet('/concepts/' + encodeURIComponent(args.concept_id));
      var lines = [
        'Concept #' + concept.id + ' [' + concept.type + ']',
        'Name: ' + concept.name,
        'Description: ' + (concept.description || '(none)')
      ];
      if (concept.data) {
        lines.push('Data: ' + (typeof concept.data === 'string' ? concept.data : JSON.stringify(concept.data, null, 2)));
      }
      if (concept.projects && concept.projects.length) {
        lines.push('');
        lines.push('Linked projects:');
        for (var p of concept.projects) {
          lines.push('  - ' + (p.name || p.id || p));
        }
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_create_concept',
    'Create a new shared concept (character, style, ruleset, library, brand, or custom).',
    {
      name: z.string().describe('Concept name'),
      type: z.enum(['character', 'style', 'ruleset', 'library', 'brand', 'custom']).describe('Concept type'),
      description: z.string().optional().describe('Short description'),
      data: z.string().optional().describe('JSON string of additional concept data')
    },
    async (args) => {
      var body = { name: args.name, type: args.type };
      if (args.description) body.description = args.description;
      if (args.data) body.data = safeParseJSON(args.data);
      var result = await apiPost('/concepts', body);
      return text('Created concept #' + result.id + ': ' + args.name + ' [' + args.type + ']');
    }
  );

  registerDual(server,
    'studio_update_concept',
    'Update an existing concept (name, description, data, or type).',
    {
      concept_id: z.string().describe('Concept ID to update'),
      name: z.string().optional().describe('New name'),
      type: z.enum(['character', 'style', 'ruleset', 'library', 'brand', 'custom']).optional().describe('New type'),
      description: z.string().optional().describe('New description'),
      data: z.string().optional().describe('JSON string of updated concept data')
    },
    async (args) => {
      var body = {};
      if (args.name) body.name = args.name;
      if (args.type) body.type = args.type;
      if (args.description) body.description = args.description;
      if (args.data) body.data = safeParseJSON(args.data);
      await apiPut('/concepts/' + encodeURIComponent(args.concept_id), body);
      return text('Updated concept #' + args.concept_id);
    }
  );

  registerDual(server,
    'studio_link_concept',
    'Link a concept to a project so it is shared across that project.',
    {
      concept_id: z.string().describe('Concept ID to link'),
      project: z.string().describe('Project ID to link the concept to')
    },
    async (args) => {
      await apiPost('/concepts/' + encodeURIComponent(args.concept_id) + '/link', { project: args.project });
      return text('Linked concept #' + args.concept_id + ' to project ' + args.project);
    }
  );

  // ===== CHANNELS =====

  registerDual(server,
    'studio_list_channels',
    'List chat channels on the network.',
    {},
    async () => {
      var channels = await apiGet('/channels');
      if (!channels.length) return text('No channels found.');
      var lines = ['=== Channels (' + channels.length + ') ==='];
      for (var ch of channels) {
        lines.push('#' + ch.id + ' ' + ch.name + ' [' + ch.type + ']' +
          (ch.description ? ' — ' + ch.description : ''));
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_create_channel',
    'Create a new chat channel.',
    {
      name: z.string().describe('Channel name (e.g. #project-updates)'),
      type: z.enum(['general', 'announcement']).optional().describe('Channel type (default: general)'),
      description: z.string().optional().describe('Channel description')
    },
    async (args) => {
      var st = getState();
      var body = {
        name: args.name,
        type: args.type || 'general',
        created_by: st.agentId || '__admin__'
      };
      if (args.description) body.description = args.description;
      var result = await apiPost('/channels', body);
      return text('Created channel #' + result.id + ': ' + args.name);
    }
  );

  registerDual(server,
    'studio_read_channel',
    'Read messages from a specific channel.',
    {
      channel_id: z.number().describe('Channel ID to read'),
      limit: z.number().optional().describe('Max messages to return (default 30)')
    },
    async (args) => {
      var params = [];
      if (args.limit) params.push('limit=' + args.limit);
      var qs = params.length ? '?' + params.join('&') : '';
      var messages = await apiGet('/channels/' + args.channel_id + '/messages' + qs);
      if (!messages.length) return text('No messages in this channel.');
      var lines = messages.map(formatMessage);
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_send_to_channel',
    'Send a message to a specific channel.',
    {
      channel_id: z.number().describe('Channel ID to send to'),
      content: z.string().describe('Message content')
    },
    async (args) => {
      var st = getState();
      var body = {
        content: args.content,
        from_agent: st.agentId || '__admin__',
        channel_id: args.channel_id
      };
      var result = await apiPost('/messages', body);
      return text('Message sent to channel #' + args.channel_id + ' (msg id: ' + result.id + ')');
    }
  );

  // ===== APPROVAL GATES =====

  registerDual(server,
    'studio_request_approval',
    'Request approval for a gated action (deploy, outreach_send, git_push, plan_create, money_action, delete, external_comm). Returns approval ID to poll.',
    {
      action_type: z.enum(['deploy', 'outreach_send', 'git_push', 'plan_create', 'money_action', 'delete', 'external_comm']).describe('Type of gated action'),
      title: z.string().describe('Short description of what you want to do'),
      payload: z.string().optional().describe('JSON string with action details (e.g. deploy target, branch, file to delete)'),
      project: z.string().optional().describe('Project context (default: mycelium)')
    },
    async (args) => {
      var st = getState();
      var requester = st.agentId || '__admin__';
      var result = await apiPost('/approvals', {
        action_type: args.action_type,
        requested_by: requester,
        title: args.title,
        payload: args.payload ? safeParseJSON(args.payload) : {},
        project: args.project || 'mycelium'
      });
      return text('Approval requested (id: ' + result.id + ')\nAction: ' + args.action_type + '\nTitle: ' + args.title + '\nStatus: pending — waiting for human approval in dashboard.\n\nPoll with studio_check_approval to check status.');
    }
  );

  registerDual(server,
    'studio_check_approval',
    'Check the status of an approval request. Returns pending, approved, denied, or executed.',
    {
      approval_id: z.number().describe('Approval ID to check')
    },
    async (args) => {
      var approval = await apiGet('/approvals/' + args.approval_id);
      var lines = [
        'Approval #' + approval.id + ' [' + approval.status + ']',
        'Action: ' + approval.action_type,
        'Title: ' + approval.title
      ];
      if (approval.status === 'approved') {
        lines.push('Approved by: ' + (approval.decided_by || 'unknown') + ' at ' + (approval.decided_at || ''));
        if (approval.reason) lines.push('Notes: ' + approval.reason);
        lines.push('', 'You may now execute the action. Call studio_mark_executed when done.');
      } else if (approval.status === 'denied') {
        lines.push('Denied by: ' + (approval.decided_by || 'unknown'));
        if (approval.reason) lines.push('Reason: ' + approval.reason);
        lines.push('', 'Do NOT proceed with this action.');
      } else if (approval.status === 'pending') {
        lines.push('', 'Still waiting for human approval. Check back later.');
      } else if (approval.status === 'executed') {
        lines.push('Already executed at: ' + (approval.executed_at || ''));
      }
      if (approval.payload && typeof approval.payload === 'object' && Object.keys(approval.payload).length) {
        lines.push('', 'Payload: ' + JSON.stringify(approval.payload, null, 2));
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_mark_executed',
    'Mark an approved action as executed. Call this after you have successfully performed the approved action.',
    {
      approval_id: z.number().describe('Approval ID to mark as executed')
    },
    async (args) => {
      await apiPut('/approvals/' + args.approval_id + '/executed', {});
      return text('Approval #' + args.approval_id + ' marked as executed.');
    }
  );

  registerDual(server,
    'studio_list_approvals',
    'List approval requests. Defaults to pending. Use to see what needs approval or check history.',
    {
      status: z.enum(['pending', 'approved', 'denied', 'executed']).optional().describe('Filter by status (default: pending)'),
      action_type: z.string().optional().describe('Filter by action type'),
      project: z.string().optional().describe('Filter by project')
    },
    async (args) => {
      var params = [];
      if (args.status) params.push('status=' + encodeURIComponent(args.status));
      else params.push('status=pending');
      if (args.action_type) params.push('action_type=' + encodeURIComponent(args.action_type));
      if (args.project) params.push('project=' + encodeURIComponent(args.project));
      var qs = params.length ? '?' + params.join('&') : '';
      var approvals = await apiGet('/approvals' + qs);
      if (!approvals.length) return text('No approvals found.');
      var lines = ['=== Approvals (' + approvals.length + ') ==='];
      for (var a of approvals) {
        lines.push('#' + a.id + ' [' + a.status + '] ' + a.action_type + ': ' + a.title +
          (a.requested_by ? ' (by ' + a.requested_by + ')' : '') +
          (a.project ? ' — ' + a.project : ''));
      }
      return text(lines.join('\n'));
    }
  );

  // ===== WORK ROUTING =====

  registerDual(server, 'studio_request_work',
    'Request work assignment from Claude Admin. Types: task_request, asset_request, work_request.',
    {
      type: { type: 'string', description: 'Request type: task_request, asset_request, work_request' },
      description: { type: 'string', description: 'What work is needed' },
      target: { type: 'string', description: 'Target agent (for cross-agent requests)' },
      priority: { type: 'string', description: 'Priority: low, normal, high, urgent' }
    },
    async function (params) {
      var res = await apiPost('/work/request', {
        type: params.type,
        target: params.target || '',
        description: params.description || '',
        priority: params.priority || 'normal'
      });
      return { content: [{ type: 'text', text: 'Work request filed. Message #' + res.message_id + ' routed to ' + res.routed_to + '.\nClaude Admin will review and assign work.' }] };
    }
  );

  registerDual(server, 'studio_file_directive',
    'Issue a blocking directive to an agent. Agent must respond before getting new work.',
    {
      to: { type: 'string', description: 'Target agent ID' },
      content: { type: 'string', description: 'Directive content' },
      project_id: { type: 'string', description: 'Project context' }
    },
    async function (params) {
      var st = getState();
      var res = await apiPost('/messages', {
        from: st.agentId || '__admin__',
        to: params.to,
        msg_type: 'directive',
        content: params.content,
        project_id: params.project_id || ''
      });
      return { content: [{ type: 'text', text: 'Directive sent to ' + params.to + '. Message #' + res.id + '.\nAgent MUST respond before receiving new work assignments.' }] };
    }
  );

  // ===== ASSETS =====

  registerDual(server, 'studio_upload_asset',
    'Mark an asset as ready and set its file path. For actual file upload, use dashboard or curl POST /assets/:id/upload.',
    {
      asset_id: { type: 'number', description: 'Asset ID to update' },
      path: { type: 'string', description: 'File path or URL where asset is available' },
      status: { type: 'string', description: 'New status (default: ready)' }
    },
    async function (params) {
      var res = await apiPut('/assets/' + params.asset_id, {
        status: params.status || 'ready',
        path: params.path || ''
      });
      return { content: [{ type: 'text', text: 'Asset #' + params.asset_id + ' updated. Status: ' + (params.status || 'ready') + '. Path: ' + (params.path || '(none)') }] };
    }
  );

  registerDual(server, 'studio_download_asset',
    'Get download info for a ready asset.',
    {
      asset_id: { type: 'number', description: 'Asset ID to check' }
    },
    async function (params) {
      var res = await apiGet('/assets/' + params.asset_id);
      if (res.status !== 'ready') {
        return { content: [{ type: 'text', text: 'Asset #' + params.asset_id + ' is not ready. Status: ' + res.status }] };
      }
      var url = res.download_url || res.path || '(no file attached)';
      return { content: [{ type: 'text', text: 'Asset #' + params.asset_id + ' (' + res.name + ') is ready.\nDownload: ' + url + '\nType: ' + res.type + '\nProject: ' + res.project_id }] };
    }
  );

  // ===== RAW API =====

  registerDual(server,
    'studio_api',
    'Raw API call to any Mycelium endpoint. Use for operations not covered by other tools.',
    {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
      path: z.string().describe('API path (e.g. /tasks, /agents/greatness-claude)'),
      body: z.string().optional().describe('JSON body string for POST/PUT')
    },
    async (args) => {
      var parsed = args.body ? safeParseJSON(args.body) : undefined;
      var fn = { GET: apiGet, POST: apiPost, PUT: apiPut, DELETE: apiDelete }[args.method];
      var result = await fn(args.path, parsed);
      return text(result);
    }
  );

  // ===== PLUGIN TOOLS (auto-discovered, see registerPluginTools) =====
  // Outreach, video-pipeline, and steam-assets tools are registered dynamically on boot.

  // ===== SAVEPOINTS =====

  registerDual(server,
    'studio_leave_notes',
    'Leave notes on an agent\'s latest savepoint. The agent will see these notes on their next boot. Use for handoff instructions, context, or "hey I fixed X, don\'t redo it".',
    {
      agent_id: z.string().describe('Agent ID to leave notes for'),
      notes: z.string().describe('Notes text — the agent will see this on next boot')
    },
    async (args) => {
      var result = await apiPut('/agents/' + args.agent_id + '/savepoint/notes', { notes: args.notes });
      return text('Notes saved for ' + args.agent_id + ' (savepoint #' + result.savepoint_id + ').\nThey will see this on next boot.');
    }
  );

  registerDual(server,
    'studio_view_savepoint',
    'View an agent\'s latest savepoint — see what they were working on, their session state, and any notes.',
    {
      agent_id: z.string().describe('Agent ID to view savepoint for')
    },
    async (args) => {
      var sp = await apiGet('/agents/' + args.agent_id + '/savepoint');
      if (!sp.has_savepoint && !sp.id) return text('No savepoint found for ' + args.agent_id);
      var lines = [
        '=== Savepoint for ' + args.agent_id + ' ===',
        'Last heartbeat: ' + (sp.heartbeat_at || 'unknown'),
        'Session: ' + (sp.session_id || 'none'),
        'Working on: ' + (sp.working_on || 'nothing')
      ];
      if (sp.notes) lines.push('Notes: ' + sp.notes);
      if (sp.state_snapshot && sp.state_snapshot !== '{}') {
        try { lines.push('State: ' + JSON.stringify(JSON.parse(sp.state_snapshot), null, 2)); }
        catch { lines.push('State: ' + sp.state_snapshot); }
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_savepoint_diff',
    'Get what changed since an agent\'s last savepoint — new messages, task changes, context updates, etc.',
    {
      agent_id: z.string().describe('Agent ID to check diff for')
    },
    async (args) => {
      var diff = await apiGet('/agents/' + args.agent_id + '/savepoint/diff');
      if (!diff.has_savepoint) return text('No savepoint found for ' + args.agent_id + ' — first session.');
      var lines = [
        '=== Changes since savepoint (' + diff.savepoint_at + ') ===',
        'Was working on: ' + (diff.was_working_on || 'nothing')
      ];
      if (diff.notes) lines.push('NOTES FROM ADMIN: ' + diff.notes);
      var s = diff.summary;
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
      return text(lines.join('\n'));
    }
  );

  // ===== DRONES =====

  registerDual(server,
    'studio_list_drone_jobs',
    'List drone jobs. Defaults to all non-cancelled jobs. Filter by status.',
    {
      status: z.string().optional().describe('Filter by status: pending, claimed, done, failed, cancelled'),
      limit: z.number().optional().describe('Max results (default 20)')
    },
    async (args) => {
      var params = [];
      if (args.status) params.push('status=' + encodeURIComponent(args.status));
      if (args.limit) params.push('limit=' + args.limit);
      else params.push('limit=20');
      var jobs = await apiGet('/drones/jobs' + (params.length ? '?' + params.join('&') : ''));
      if (!jobs.length) return text('No drone jobs found.');
      var lines = ['=== Drone Jobs (' + jobs.length + ') ==='];
      for (var j of jobs) {
        var line = '#' + j.id + ' [' + j.status + '] ' + j.title;
        if (j.drone_id) line += ' (worker: ' + j.drone_id + ')';
        line += ' [p' + j.priority + ']';
        if (j.started_at) line += ' started ' + timeAgo(j.started_at);
        if (j.completed_at) line += ' completed ' + timeAgo(j.completed_at);
        if (j.error) line += '\n  ERROR: ' + j.error.substring(0, 200);
        lines.push(line);
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_get_drone_job',
    'Get full details for a specific drone job including command, input/result data, and error info.',
    {
      job_id: z.number().describe('Drone job ID')
    },
    async (args) => {
      var job = await apiGet('/drones/jobs/' + args.job_id);
      var lines = [
        '=== Drone Job #' + job.id + ' ===',
        'Title: ' + job.title,
        'Status: ' + job.status,
        'Priority: ' + job.priority,
        'Requester: ' + job.requester,
        'Worker: ' + (job.drone_id || 'unassigned'),
        'Command: ' + job.command
      ];
      if (job.input_data && job.input_data !== '{}') {
        try { lines.push('Input: ' + JSON.stringify(JSON.parse(job.input_data), null, 2)); }
        catch { lines.push('Input: ' + job.input_data); }
      }
      if (job.started_at) lines.push('Started: ' + job.started_at + ' (' + timeAgo(job.started_at) + ')');
      if (job.completed_at) lines.push('Completed: ' + job.completed_at + ' (' + timeAgo(job.completed_at) + ')');
      if (job.error) lines.push('Error:\n' + job.error);
      if (job.result_data && job.result_data !== '{}') {
        try {
          var rd = JSON.parse(job.result_data);
          if (rd.stdout) lines.push('Stdout:\n' + rd.stdout.substring(0, 1000));
          if (rd.stderr) lines.push('Stderr:\n' + rd.stderr.substring(0, 500));
        } catch { lines.push('Result: ' + job.result_data.substring(0, 500)); }
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_queue_drone_job',
    'Queue a new drone job for GPU/CPU workers to pick up.',
    {
      title: z.string().describe('Job title'),
      command: z.string().optional().describe('Shell command to execute on the drone (optional if job_type is set)'),
      requires: z.array(z.string()).optional().describe('Required capabilities, e.g. ["gpu"]'),
      priority: z.number().optional().describe('Priority (1=highest, default 5)'),
      input_data: z.string().optional().describe('JSON string of metadata for the job'),
      job_type: z.string().optional().describe('Job template ID (e.g. "kc_art_gen"). Auto-fills requires and renders command at claim time.')
    },
    async (args) => {
      var body = { title: args.title };
      if (args.command) body.command = args.command;
      if (args.requires) body.requires = args.requires;
      if (args.priority) body.priority = args.priority;
      if (args.input_data) body.input_data = args.input_data;
      if (args.job_type) body.job_type = args.job_type;
      var result = await apiPost('/drones/jobs', body);
      var info = 'Queued drone job #' + result.id + ': ' + args.title;
      if (args.job_type) info += '\nTemplate: ' + args.job_type;
      info += '\nPriority: ' + (args.priority || 5) + ' | Requires: ' + JSON.stringify(args.requires || ['cpu']);
      return text(info);
    }
  );

  registerDual(server,
    'studio_cancel_drone_job',
    'Cancel a pending drone job.',
    {
      job_id: z.number().describe('Job ID to cancel')
    },
    async (args) => {
      await apiPut('/drones/jobs/' + args.job_id, { status: 'cancelled' });
      return text('Cancelled drone job #' + args.job_id);
    }
  );

  registerDual(server,
    'studio_list_drones',
    'List registered drone workers and their status.',
    {},
    async () => {
      var drones = await apiGet('/drones');
      if (!drones.length) return text('No drone workers registered.');
      var lines = ['=== Drone Workers (' + drones.length + ') ==='];
      for (var d of drones) {
        var statusIcon = d.status === 'online' ? '[ON]' : '[OFF]';
        var caps = [];
        try { caps = JSON.parse(d.capabilities); } catch {}
        var line = statusIcon + ' ' + d.name + ' (' + d.id + ')';
        if (caps.length) line += ' [' + caps.join(', ') + ']';
        if (d.working_on) line += '\n  Working on: ' + d.working_on;
        line += '\n  Last seen: ' + timeAgo(d.last_heartbeat);
        lines.push(line);
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_list_artifacts',
    'List uploaded drone artifacts (scripts, models, result zips).',
    {},
    async () => {
      var artifacts = await apiGet('/drones/artifacts');
      if (!artifacts.length) return text('No artifacts uploaded.');
      var lines = ['=== Drone Artifacts (' + artifacts.length + ') ==='];
      for (var a of artifacts) {
        var size = a.size > 1048576 ? (a.size / 1048576).toFixed(1) + ' MB' : Math.round(a.size / 1024) + ' KB';
        lines.push(a.name + ' (' + size + ') — uploaded ' + timeAgo(a.uploaded));
      }
      return text(lines.join('\n'));
    }
  );

  // ===== JOB TEMPLATES =====

  registerDual(server,
    'studio_list_job_templates',
    'List job templates for smart drone job routing. Templates define what each job type needs (deps, GPU, artifacts).',
    {},
    async () => {
      var templates = await apiGet('/drones/templates');
      if (!templates.length) return text('No job templates found.');
      var lines = ['=== Job Templates (' + templates.length + ') ==='];
      for (var t of templates) {
        var reqs = t.requires;
        try { if (typeof reqs === 'string') reqs = JSON.parse(reqs); } catch (e) { reqs = []; }
        lines.push(t.id + ' — ' + t.name +
          (t.project_id ? ' [' + t.project_id + ']' : '') +
          ' | requires: ' + JSON.stringify(reqs) +
          (t.min_vram_gb > 0 ? ' | VRAM: ' + t.min_vram_gb + 'GB+' : '') +
          ' | disk: ' + t.min_disk_gb + 'GB+');
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_check_drone_compatibility',
    'Check which job templates a drone can handle based on its diagnostics (GPU, VRAM, disk, deps).',
    {
      drone_id: z.string().describe('Drone ID to check compatibility for')
    },
    async (args) => {
      var result = await apiGet('/drones/' + encodeURIComponent(args.drone_id) + '/compatibility');
      if (result.error) return text('Error: ' + result.error);
      var lines = ['=== Compatibility for ' + result.drone_id + ' ==='];
      if (result.compatible && result.compatible.length) {
        lines.push('');
        lines.push('Compatible:');
        for (var c of result.compatible) {
          lines.push('  [OK] ' + c.template + ' (' + c.name + ')' + (c.notes ? ' — ' + c.notes : ''));
        }
      }
      if (result.incompatible && result.incompatible.length) {
        lines.push('');
        lines.push('Incompatible:');
        for (var ic of result.incompatible) {
          lines.push('  [X] ' + ic.template + ' (' + ic.name + ') — ' + ic.reasons.join(', '));
        }
      }
      if ((!result.compatible || !result.compatible.length) && (!result.incompatible || !result.incompatible.length)) {
        lines.push('No templates found to check against.');
      }
      return text(lines.join('\n'));
    }
  );

// (registerTools continues — GitHub, sleep/wake tools below, closed after studio_wake)

function formatOverview(data) {
  var lines = [];

  // Agents
  if (data.agents && data.agents.length > 0) {
    lines.push('=== Agents ===');
    for (var a of data.agents) {
      // Support both slim format (id, status, working_on, heartbeat) and full format
      if (a.heartbeat) {
        lines.push('[' + (a.status === 'online' ? 'ON' : 'OFF') + '] ' + a.id + (a.working_on ? ': ' + a.working_on : '') + ' (' + a.heartbeat + ')');
      } else {
        lines.push(formatAgent(a));
      }
    }
  }

  // Counts (slim format)
  if (data.counts) {
    var c = data.counts;
    lines.push('');
    lines.push('=== Counts ===');
    lines.push('Tasks: ' + (c.tasks_open || 0) + ' open, ' + (c.tasks_in_progress || 0) + ' in progress');
    lines.push('Bugs: ' + (c.bugs_open || 0) + ' open | Plans: ' + (c.plans_active || 0) + ' active');
    lines.push('Requests: ' + (c.requests_pending || 0) + ' pending | Approvals: ' + (c.approvals_pending || 0) + ' pending');
    lines.push('Drones: ' + (c.drones_online || 0) + ' online, ' + (c.drone_jobs_pending || 0) + ' jobs pending');
  }

  // Attention (slim format)
  if (data.attention && data.attention.length > 0) {
    lines.push('');
    lines.push('=== Needs Attention ===');
    for (var item of data.attention) {
      lines.push('[' + item.type + '] #' + item.id + ': ' + item.title + ' → ' + item.action + ' (' + item.age + ')');
    }
  }

  // Recent activity (slim format)
  if (data.recent_activity && data.recent_activity.length > 0) {
    lines.push('');
    lines.push('=== Recent ===');
    for (var act of data.recent_activity) {
      lines.push(act);
    }
  }

  // Legacy full format fallback — if data has `tasks` object, use old format
  if (data.tasks && !data.counts) {
    var tasks = data.tasks || {};
    var open = tasks.open || [];
    var inProg = tasks.in_progress || [];
    var review = tasks.review || [];
    var done = tasks.done || [];
    lines.push('');
    lines.push('=== Tasks: ' + open.length + ' open, ' + inProg.length + ' in-progress, ' +
      review.length + ' review, ' + done.length + ' recently done ===');
    for (var t of [].concat(open, inProg, review)) lines.push(formatTask(t));

    var plans = data.plans || [];
    if (plans.length) {
      lines.push('');
      lines.push('=== Plans (' + plans.length + ') ===');
      for (var p of plans) lines.push('Plan #' + p.id + ' [' + p.status + '] ' + p.title);
    }

    var msgs = data.messages || [];
    var pendingReqs = msgs.filter(function (m) { return m.msg_type === 'request' && m.status !== 'completed' && m.status !== 'resolved'; });
    if (pendingReqs.length) {
      lines.push('');
      lines.push('=== Pending Requests (' + pendingReqs.length + ') ===');
      for (var r of pendingReqs) lines.push(formatMessage(r));
    }

    var bugs = data.bugs || [];
    var openBugs = bugs.filter(function (b) { return b.status === 'open' || b.status === 'in_progress'; });
    if (openBugs.length) {
      lines.push('');
      lines.push('=== Open Bugs (' + openBugs.length + ') ===');
      for (var b of openBugs) lines.push(formatBug(b));
    }
  }

  return lines.join('\n');
}

function formatContact(c) {
  return '#' + c.id + ' [' + c.status + '] ' + c.name +
    (c.outlet ? ' (' + c.outlet + ')' : '') +
    (c.tier ? ' ' + c.tier : '') +
    (c.email ? ' <' + c.email + '>' : '') +
    ' — ' + c.type;
}

// ===== GITHUB =====

  registerDual(server,
    'studio_list_prs',
    'List pull requests for a GitHub repo.',
    {
      owner: z.string().describe('GitHub owner or org (e.g. SoftBacon-Software)'),
      repo: z.string().describe('Repository name (e.g. mycelium)'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)')
    },
    async (args) => {
      var qs = '?state=' + (args.state || 'open');
      var result = await apiGet('/github/prs/' + args.owner + '/' + args.repo + qs);
      if (!result.prs || !result.prs.length) return text('No ' + (args.state || 'open') + ' PRs in ' + args.owner + '/' + args.repo);
      var lines = ['=== PRs: ' + args.owner + '/' + args.repo + ' (' + result.count + ') ==='];
      for (var pr of result.prs) {
        lines.push('#' + pr.number + (pr.draft ? ' [DRAFT]' : '') + ' ' + pr.title + ' (' + pr.author + ' | ' + pr.branch + ')');
        lines.push('  ' + pr.url);
      }
      return text(lines.join('\n'));
    }
  );

  registerDual(server,
    'studio_merge_pr',
    'Merge a pull request on GitHub. Requires GITHUB_TOKEN on the Mycelium server.',
    {
      owner: z.string().describe('GitHub owner or org (e.g. SoftBacon-Software)'),
      repo: z.string().describe('Repository name (e.g. mycelium)'),
      number: z.number().describe('PR number to merge'),
      merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: squash)'),
      commit_title: z.string().optional().describe('Commit title (squash/merge only)'),
      commit_message: z.string().optional().describe('Commit message body')
    },
    async (args) => {
      var body = { merge_method: args.merge_method || 'squash' };
      if (args.commit_title) body.commit_title = args.commit_title;
      if (args.commit_message) body.commit_message = args.commit_message;
      var result = await apiPost('/github/prs/' + args.owner + '/' + args.repo + '/' + args.number + '/merge', body);
      return text('Merged PR #' + result.number + ' in ' + args.owner + '/' + args.repo + ' (sha: ' + (result.sha || '?').slice(0, 8) + ')');
    }
  );

  registerDual(server,
    'studio_create_pr',
    'Create a pull request on GitHub.',
    {
      owner: z.string().describe('GitHub owner or org'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('PR title'),
      head: z.string().describe('Head branch (your changes)'),
      base: z.string().describe('Base branch (merge target, e.g. main)'),
      body: z.string().optional().describe('PR description'),
      draft: z.boolean().optional().describe('Create as draft PR')
    },
    async (args) => {
      var result = await apiPost('/github/prs/' + args.owner + '/' + args.repo, {
        title: args.title, head: args.head, base: args.base,
        body: args.body || '', draft: !!args.draft
      });
      return text('Created PR #' + result.number + ': ' + result.title + '\n' + result.url);
    }
  );
}

// ===== PLUGIN AUTO-DISCOVERY =====

// Convert a plugin tool schema field to a Zod type
function fieldToZod(field) {
  var base;
  if (field.enum) {
    base = z.enum(field.enum);
  } else if (field.type === 'number' || field.type === 'integer') {
    base = z.number();
  } else if (field.type === 'boolean') {
    base = z.boolean();
  } else if (field.type === 'array') {
    var itemZod = field.items ? fieldToZod(field.items) : z.any();
    base = z.array(itemZod);
  } else if (field.type === 'object') {
    if (field.properties) {
      base = jsonSchemaObjectToZod(field);
    } else {
      base = z.record(z.string(), z.any());
    }
  } else {
    base = z.string();
  }
  if (field.description) base = base.describe(field.description);
  return base;
}

// Convert a JSON Schema object with properties to a Zod object
function jsonSchemaObjectToZod(schema) {
  var shape = {};
  var props = schema.properties || {};
  var required = schema.required || [];
  for (var [key, field] of Object.entries(props)) {
    var zodField = fieldToZod(field);
    if (!required.includes(key)) zodField = zodField.optional();
    shape[key] = zodField;
  }
  return z.object(shape);
}

// Convert a plugin tool schema (flat or nested JSON Schema) to a Zod shape object
function pluginSchemaToZod(schema) {
  if (!schema || Object.keys(schema).length === 0) return {};

  // Nested JSON Schema format (has "type": "object" at top level)
  if (schema.type === 'object' && schema.properties) {
    var shape = {};
    var required = schema.required || [];
    for (var [key, field] of Object.entries(schema.properties)) {
      var zodField = fieldToZod(field);
      if (!required.includes(key)) zodField = zodField.optional();
      shape[key] = zodField;
    }
    return shape;
  }

  // Flat key-value format (outreach-style: { key: { type, description, required, enum } })
  var flat = {};
  for (var [key, field] of Object.entries(schema)) {
    var zodField = fieldToZod(field);
    if (!field.required) zodField = zodField.optional();
    flat[key] = zodField;
  }
  return flat;
}

// Build the API path, substituting {param} and :param placeholders from args
function buildPath(pathTemplate, args) {
  return pathTemplate.replace(/\{(\w+)\}|:(\w+)/g, function (_, a, b) {
    var key = a || b;
    return encodeURIComponent(args[key] || '');
  });
}

// Build a handler function for a plugin tool based on its endpoint config
function buildPluginHandler(endpoint) {
  var method = (endpoint.method || 'GET').toUpperCase();
  var pathTemplate = endpoint.path;
  var queryMap = endpoint.queryMap || {};
  var bodyMap = endpoint.bodyMap || {};

  return async function (args) {
    var path = buildPath(pathTemplate, args);

    if (method === 'GET') {
      var params = [];
      for (var [argKey, queryKey] of Object.entries(queryMap)) {
        if (args[argKey] !== undefined && args[argKey] !== null) {
          params.push(queryKey + '=' + encodeURIComponent(args[argKey]));
        }
      }
      var url = path + (params.length ? '?' + params.join('&') : '');
      var result = await apiGet(url);
      return text(result);
    }

    // POST / PUT / DELETE — build request body
    var body = {};
    if (Object.keys(bodyMap).length > 0) {
      for (var [argKey, bodyKey] of Object.entries(bodyMap)) {
        if (args[argKey] !== undefined) body[bodyKey] = args[argKey];
      }
    } else {
      // No bodyMap — pass all args except path params as body
      var pathParams = new Set();
      pathTemplate.replace(/\{(\w+)\}|:(\w+)/g, function (_, a, b) { pathParams.add(a || b); });
      for (var [key, val] of Object.entries(args)) {
        if (!pathParams.has(key) && val !== undefined) body[key] = val;
      }
    }

    var fn = { POST: apiPost, PUT: apiPut, DELETE: apiDelete }[method];
    if (!fn) throw new Error('Unsupported HTTP method: ' + method);
    var result = await fn(path, body);
    return text(result);
  };
}

// Fetch plugin MCP tools from the server and register them dynamically
export async function registerPluginTools(server) {
  try {
    var tools = await apiGet('/plugins/mcp-tools');
    if (!Array.isArray(tools) || tools.length === 0) {
      process.stderr.write('Plugin discovery: no tools returned\n');
      return 0;
    }
    // Suppress per-tool notifications during bulk registration to avoid
    // flooding the MCP client (which can cause Claude Code to drop the connection).
    var origSendToolListChanged = server.sendToolListChanged.bind(server);
    server.sendToolListChanged = function() {};
    var count = 0;
    for (var tool of tools) {
      try {
        var schema = pluginSchemaToZod(tool.schema);
        var handler = buildPluginHandler(tool.endpoint);
        registerDual(server, tool.name, tool.description, schema, handler);
        count++;
      } catch (err) {
        process.stderr.write('Plugin tool registration failed for ' + tool.name + ': ' + err.message + '\n');
      }
    }
    // Restore and send a single notification for all registered tools
    server.sendToolListChanged = origSendToolListChanged;
    if (count > 0) {
      server.sendToolListChanged();
    }
    process.stderr.write('Plugin discovery: registered ' + count + ' tools from ' + tools.length + ' definitions\n');
    return count;
  } catch (err) {
    process.stderr.write('Plugin discovery failed: ' + err.message + '\n');
    return 0;
  }
}
