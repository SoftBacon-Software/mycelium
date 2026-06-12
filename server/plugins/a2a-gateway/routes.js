// A2A Gateway plugin routes
// Implements Google A2A protocol + management endpoints

import { Router } from 'express';
import crypto from 'crypto';
import createA2ADB from './db.js';

// SSRF protection: validate URLs before fetching
function validateExternalUrl(urlStr) {
  try {
    var parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    var host = parsed.hostname.toLowerCase();
    // Block private/internal IPs
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false;
    if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    // Block metadata endpoints
    if (host === 'metadata.google.internal' || host === '169.254.169.254') return false;
    return true;
  } catch (e) { return false; }
}

// A2A status mapping
var A2A_TO_MYCELIUM = {
  submitted: 'open',
  working: 'in_progress',
  completed: 'done',
  failed: 'open',
  canceled: 'open'
};

var MYCELIUM_TO_A2A = {
  open: 'submitted',
  in_progress: 'working',
  done: 'completed',
  review: 'working'
};

export default function (core) {
  var router = Router();
  var db = createA2ADB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError } = core;

  // ---- Agent Card ----
  // Served at /.well-known/agent.json (mounted by server/index.js via plugin system)
  // Also available via plugin route for convenience
  router.get('/agent-card', function (req, res) {
    var agents = core.db.prepare("SELECT id, name, capabilities, role FROM agents WHERE role != 'drone' AND status != 'offline'").all();
    var skills = agents.map(function (a) {
      var caps = [];
      try { caps = JSON.parse(a.capabilities || '[]'); } catch (e) {}
      return {
        id: a.id,
        name: a.name || a.id,
        description: 'Agent: ' + (a.name || a.id) + (caps.length > 0 ? ' (' + caps.join(', ') + ')' : '')
      };
    });

    var card = {
      name: 'Mycelium Platform',
      description: 'AI coordination platform — distributed development with multi-agent teams',
      url: 'https://mycelium.fyi',
      version: '1.0',
      capabilities: {
        streaming: true,
        pushNotifications: false
      },
      skills: [
        { id: 'task-management', name: 'Task Management', description: 'Create, assign, and track tasks across AI agents' },
        { id: 'agent-coordination', name: 'Agent Coordination', description: 'Route work to specialized agents based on capabilities' }
      ].concat(skills),
      authentication: {
        schemes: ['apiKey']
      }
    };

    res.json(card);
  });

  // ---- JSON-RPC 2.0 Handler ----
  router.post('/rpc', function (req, res) {
    // tasks/send injects real tasks + directives consumed by shell-executing
    // runners — require a valid agent/admin key (the apiKey scheme this
    // gateway's own Agent Card advertises). checkAgentOrAdmin sends the 401.
    var caller = checkAgentOrAdmin(req, res);
    if (!caller) return;

    var body = req.body;
    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return res.json({
        jsonrpc: '2.0',
        id: body ? body.id : null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    var method = body.method;
    var params = body.params || {};
    var rpcId = body.id;

    if (method === 'tasks/send') {
      return handleTaskSend(req, res, params, rpcId);
    } else if (method === 'tasks/get') {
      return handleTaskGet(req, res, params, rpcId);
    } else if (method === 'tasks/cancel') {
      return handleTaskCancel(req, res, params, rpcId);
    } else {
      return res.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: 'Method not found: ' + method }
      });
    }
  });

  function handleTaskSend(req, res, params, rpcId) {
    var message = params.message || {};
    var inputText = '';
    if (message.parts) {
      inputText = message.parts.filter(function (p) { return p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
    } else if (typeof message === 'string') {
      inputText = message;
    }

    if (!inputText) {
      return res.json({
        jsonrpc: '2.0', id: rpcId,
        error: { code: -32602, message: 'No input text in message' }
      });
    }

    // Find best-matching agent based on capabilities
    var targetAgentId = null;
    var agents = core.db.prepare("SELECT id, name, capabilities FROM agents WHERE role != 'drone' AND status IN ('online', 'idle') ORDER BY last_heartbeat DESC").all();
    if (agents.length > 0) targetAgentId = agents[0].id; // Default to most recently active

    var callerUrl = req.headers['x-a2a-caller-url'] || req.ip || 'unknown';
    var taskId = db.createInboundTask(callerUrl, targetAgentId, inputText);

    // Create a Mycelium task + directive
    if (targetAgentId) {
      try {
        var myceliumTask = core.db.prepare(
          "INSERT INTO tasks (title, description, project_id, requester, status) VALUES (?, ?, ?, ?, 'open') RETURNING id"
        ).get('A2A: ' + inputText.substring(0, 100), inputText, 'mycelium', 'a2a:' + callerUrl);
        if (myceliumTask) {
          db.updateInboundTask(taskId, { target_agent_id: targetAgentId });
          core.db.prepare(
            "INSERT INTO messages (from_agent, to_agent, content, msg_type, metadata) VALUES (?, ?, ?, 'directive', ?)"
          ).run('__system__', targetAgentId, 'A2A TASK: ' + inputText, JSON.stringify({ a2a_task_id: taskId, mycelium_task_id: myceliumTask.id }));
          core.emitEvent('a2a_task_received', '__system__', 'mycelium', 'A2A task from ' + callerUrl + ' assigned to ' + targetAgentId, { task_id: taskId });
        }
      } catch (e) {
        console.error('[a2a-gateway] Error creating task:', e.message);
      }
    }

    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        id: taskId,
        status: { state: 'submitted' },
        artifacts: []
      }
    });
  }

  function handleTaskGet(req, res, params, rpcId) {
    var taskId = params.id;
    if (!taskId) {
      return res.json({ jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Task ID required' } });
    }
    var task = db.getInboundTask(taskId);
    if (!task) {
      return res.json({ jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Task not found' } });
    }
    var a2aStatus = MYCELIUM_TO_A2A[task.status] || task.status;
    var artifacts = [];
    if (task.result) {
      artifacts.push({
        parts: [{ type: 'text', text: typeof task.result === 'string' ? task.result : JSON.stringify(task.result) }]
      });
    }
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: { id: taskId, status: { state: a2aStatus }, artifacts: artifacts }
    });
  }

  function handleTaskCancel(req, res, params, rpcId) {
    var taskId = params.id;
    if (!taskId) {
      return res.json({ jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Task ID required' } });
    }
    db.updateInboundTask(taskId, { status: 'canceled' });
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: { id: taskId, status: { state: 'canceled' } }
    });
  }

  // ---- Management Endpoints ----

  // POST /a2a/discover — discover an external A2A agent by URL
  router.post('/discover', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var url = req.body.url;
    if (!url) return apiError(res, 400, 'url is required');
    if (!validateExternalUrl(url)) return apiError(res, 400, 'Invalid or blocked URL — must be public http(s)');

    // Normalize URL
    var agentCardUrl = url.replace(/\/$/, '') + '/.well-known/agent.json';

    try {
      var response = await fetch(agentCardUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        return apiError(res, 502, 'Failed to fetch Agent Card: HTTP ' + response.status);
      }
      var card = await response.json();
      var id = db.addExternalAgent(url.replace(/\/$/, ''), card);
      core.emitEvent('a2a_agent_discovered', who, null, who + ' discovered A2A agent: ' + (card.name || url), { agent_url: url, agent_id: id });
      res.json({ ok: true, id: id, agent: db.getExternalAgent(id) });
    } catch (e) {
      return apiError(res, 502, 'Failed to discover agent: ' + e.message);
    }
  });

  // GET /a2a/agents — list known external agents
  router.get('/agents', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listExternalAgents(req.query.status));
  });

  // DELETE /a2a/agents/:id — remove external agent
  router.delete('/agents/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    db.removeExternalAgent(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // POST /a2a/send — send task to external agent
  router.post('/send', async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var { agent_id, message } = req.body;
    if (!agent_id || !message) return apiError(res, 400, 'agent_id and message are required');

    var agent = db.getExternalAgent(parseInt(agent_id));
    if (!agent) return apiError(res, 404, 'External agent not found');
    if (!validateExternalUrl(agent.agent_url)) return apiError(res, 400, 'Agent URL is blocked — private/internal addresses not allowed');

    var taskId = db.createOutboundTask(agent.id, who, 'tasks/send', message);

    try {
      var a2aUrl = agent.agent_url + '/a2a';
      var rpcBody = {
        jsonrpc: '2.0',
        id: taskId,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: message }]
          }
        }
      };

      var response = await fetch(a2aUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcBody),
        signal: AbortSignal.timeout(30000)
      });
      var result = await response.json();

      if (result.error) {
        db.updateOutboundTask(taskId, { status: 'failed', result: result.error });
        return apiError(res, 502, 'A2A error: ' + (result.error.message || JSON.stringify(result.error)));
      }

      var a2aResult = result.result || {};
      db.updateOutboundTask(taskId, {
        status: a2aResult.status ? (A2A_TO_MYCELIUM[a2aResult.status.state] || a2aResult.status.state) : 'submitted',
        result: a2aResult
      });

      core.emitEvent('a2a_task_sent', who, null, who + ' sent A2A task to ' + agent.name, { task_id: taskId, agent_url: agent.agent_url });
      res.json({ ok: true, task_id: taskId, result: a2aResult });
    } catch (e) {
      db.updateOutboundTask(taskId, { status: 'failed', result: { error: e.message } });
      return apiError(res, 502, 'Failed to send A2A task: ' + e.message);
    }
  });

  // GET /a2a/tasks — list A2A task log
  router.get('/tasks', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var tasks = db.listOutboundTasks({ status: req.query.status, limit: parseInt(req.query.limit) || 50 });
    res.json(tasks);
  });

  // GET /a2a/tasks/:id — get task status/result
  router.get('/tasks/:id', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var task = db.getOutboundTask(req.params.id);
    if (!task) return apiError(res, 404, 'Task not found');
    res.json(task);
  });

  return router;
}
