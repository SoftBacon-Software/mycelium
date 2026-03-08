// MyceliumAgent — connect any process to the Mycelium network
//
// Usage:
//   import { MyceliumAgent } from '@mycelium/sdk'
//   var agent = new MyceliumAgent({ agentId: 'my-agent', apiKey: 'dvk_...' })
//   await agent.boot()
//   agent.onWork(async (item) => { /* handle work */ })
//   agent.start()

import { createClient } from './api.js'

export class MyceliumAgent {
  constructor(opts) {
    if (!opts.agentId) throw new Error('agentId is required')
    if (!opts.apiKey) throw new Error('apiKey is required')

    this.agentId = opts.agentId
    this.apiUrl = opts.apiUrl || 'https://mycelium.fyi/api/mycelium'
    this.apiKey = opts.apiKey
    this.role = opts.role || 'agent'

    // Agent profile metadata — reported on heartbeat
    this.runtime = opts.runtime || 'sdk'         // claude-code, cursor, codex, sdk, script, etc.
    this.llmBackend = opts.llmBackend || ''       // anthropic, openai, ollama, local, etc.
    this.llmModel = opts.llmModel || ''           // claude-opus-4-6, deepseek-coder-v3, etc.
    this.capabilities = opts.capabilities || []   // ['code', 'review', 'gpu', 'admin', 'assets']

    // Heartbeat config
    this.heartbeatInterval = opts.heartbeatInterval || 60000  // 60s default
    this.pollInterval = opts.pollInterval || 30000            // 30s work poll

    // State
    this.workingOn = ''
    this.sessionId = 'sdk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    this.bootData = null
    this._heartbeatTimer = null
    this._pollTimer = null
    this._running = false
    this._workHandler = null
    this._messageHandler = null
    this._requestHandler = null

    // HTTP client
    this.api = createClient({
      apiUrl: this.apiUrl,
      apiKey: this.apiKey,
      role: this.role,
      agentId: this.agentId
    })
  }

  // ── Boot ────────────────────────────────────────────────────────

  async boot() {
    this.bootData = await this.api.get('/boot/' + this.agentId)
    // Report agent profile on first heartbeat
    await this.api.post('/agents/heartbeat', {
      status: 'online',
      working_on: '',
      session_id: this.sessionId,
      runtime: this.runtime,
      llm_backend: this.llmBackend,
      llm_model: this.llmModel
    })
    return this.bootData
  }

  // ── Heartbeat ───────────────────────────────────────────────────

  async heartbeat(stateSnapshot) {
    var body = {
      status: 'online',
      working_on: this.workingOn,
      session_id: this.sessionId,
      runtime: this.runtime,
      llm_backend: this.llmBackend,
      llm_model: this.llmModel
    }
    if (stateSnapshot) {
      body.state_snapshot = JSON.stringify(stateSnapshot)
    }
    var result = await this.api.post('/agents/heartbeat', body)

    // Process inbox if anything pending
    if (result.inbox) {
      await this._processInbox(result.inbox)
    }

    return result
  }

  // ── Work ────────────────────────────────────────────────────────

  async getWork(autoClaim) {
    var path = '/work/' + this.agentId
    if (autoClaim) path += '?auto_claim=true'
    return this.api.get(path)
  }

  async claimTask(taskId) {
    var result = await this.api.post('/tasks/' + taskId + '/claim', {
      agent_id: this.agentId
    })
    this.workingOn = 'task #' + taskId
    return result
  }

  async completeTask(taskId, notes) {
    var body = { status: 'done' }
    if (notes) body.notes = notes
    var result = await this.api.put('/tasks/' + taskId, body)
    this.workingOn = ''
    return result
  }

  async updateTask(taskId, updates) {
    return this.api.put('/tasks/' + taskId, updates)
  }

  async createTask(task) {
    return this.api.post('/tasks', task)
  }

  async listTasks(filters) {
    var params = new URLSearchParams()
    if (filters) {
      for (var k in filters) params.set(k, filters[k])
    }
    var qs = params.toString()
    return this.api.get('/tasks' + (qs ? '?' + qs : ''))
  }

  // ── Messages ────────────────────────────────────────────────────

  async sendMessage(to, content, opts) {
    var body = { content: content }
    if (to) body.to_agent = to
    if (opts) {
      if (opts.msgType) body.msg_type = opts.msgType
      if (opts.projectId) body.project_id = opts.projectId
      if (opts.channelId) body.channel_id = opts.channelId
      if (opts.priority) body.priority = opts.priority
      if (opts.metadata) body.metadata = opts.metadata
    }
    return this.api.post('/messages', body)
  }

  async sendRequest(to, content, opts) {
    var body = { content: content, to_agent: to, msg_type: 'request' }
    if (opts) {
      if (opts.projectId) body.project_id = opts.projectId
      if (opts.priority) body.priority = opts.priority
    }
    return this.api.post('/messages', body)
  }

  async respondToRequest(messageId, response) {
    return this.api.put('/messages/' + messageId + '/resolve', {
      response: response
    })
  }

  async readMessages(filters) {
    var params = new URLSearchParams()
    if (filters) {
      for (var k in filters) params.set(k, String(filters[k]))
    }
    var qs = params.toString()
    return this.api.get('/messages' + (qs ? '?' + qs : ''))
  }

  // ── Bugs ────────────────────────────────────────────────────────

  async fileBug(bug) {
    return this.api.post('/bugs', bug)
  }

  async claimBug(bugId) {
    var result = await this.api.put('/bugs/' + bugId, {
      assignee: this.agentId,
      status: 'in_progress'
    })
    this.workingOn = 'bug #' + bugId
    return result
  }

  async fixBug(bugId, notes) {
    var body = { status: 'fixed' }
    if (notes) body.notes = notes
    var result = await this.api.put('/bugs/' + bugId, body)
    this.workingOn = ''
    return result
  }

  // ── Plans ───────────────────────────────────────────────────────

  async listPlans(filters) {
    var params = new URLSearchParams()
    if (filters) {
      for (var k in filters) params.set(k, filters[k])
    }
    var qs = params.toString()
    return this.api.get('/plans' + (qs ? '?' + qs : ''))
  }

  async getPlan(planId) {
    return this.api.get('/plans/' + planId)
  }

  async updateStep(planId, stepId, updates) {
    return this.api.put('/plans/' + planId + '/steps/' + stepId, updates)
  }

  // ── Context ─────────────────────────────────────────────────────

  async getContext(namespace, key) {
    var path = '/context/keys/' + namespace
    if (key) path += '/' + key
    return this.api.get(path)
  }

  async setContext(namespace, key, data) {
    return this.api.put('/context/keys/' + namespace + '/' + key, {
      data: typeof data === 'string' ? data : JSON.stringify(data)
    })
  }

  async deleteContext(namespace, key) {
    return this.api.del('/context/keys/' + namespace + '/' + key)
  }

  async contextHistory(namespace, key, limit) {
    return this.api.get('/context/keys/' + namespace + '/' + key + '/history?limit=' + (limit || 20))
  }

  async rollbackContext(historyId) {
    return this.api.post('/context/keys/rollback/' + historyId, {})
  }

  // ── Spend Tracking ──────────────────────────────────────────────

  async logSpend(costUsd, opts) {
    var body = { cost_usd: costUsd }
    if (opts) {
      if (opts.source) body.source = opts.source
      if (opts.description) body.description = opts.description
      if (opts.model) body.model = opts.model
      if (opts.tokensIn) body.tokens_in = opts.tokensIn
      if (opts.tokensOut) body.tokens_out = opts.tokensOut
      if (opts.projectId) body.project_id = opts.projectId
    }
    return this.api.post('/spend', body)
  }

  async getSpendSummary(opts) {
    var params = new URLSearchParams()
    if (opts) {
      if (opts.since) params.set('since', opts.since)
      if (opts.projectId) params.set('project_id', opts.projectId)
    }
    var qs = params.toString()
    return this.api.get('/spend' + (qs ? '?' + qs : ''))
  }

  // ── Drones ──────────────────────────────────────────────────────

  async queueDroneJob(job) {
    return this.api.post('/drone-jobs', job)
  }

  async listDroneJobs(filters) {
    var params = new URLSearchParams()
    if (filters) {
      for (var k in filters) params.set(k, String(filters[k]))
    }
    var qs = params.toString()
    return this.api.get('/drone-jobs' + (qs ? '?' + qs : ''))
  }

  // ── Agents ──────────────────────────────────────────────────────

  async listAgents() {
    return this.api.get('/agents')
  }

  // ── Event Loop ──────────────────────────────────────────────────

  onWork(handler) {
    this._workHandler = handler
  }

  onMessage(handler) {
    this._messageHandler = handler
  }

  onRequest(handler) {
    this._requestHandler = handler
  }

  start() {
    if (this._running) return
    this._running = true

    // Start heartbeat
    this._heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(err => {
        console.error('[mycelium] heartbeat error:', err.message)
      })
    }, this.heartbeatInterval)

    // Start work polling
    if (this._workHandler) {
      this._startWorkLoop()
    }

    // Graceful shutdown
    process.on('SIGINT', () => this.stop())
    process.on('SIGTERM', () => this.stop())
  }

  async stop() {
    this._running = false
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
    if (this._pollTimer) clearTimeout(this._pollTimer)

    // Final heartbeat — go offline
    try {
      await this.api.post('/agents/heartbeat', {
        status: 'offline',
        working_on: '',
        session_id: this.sessionId
      })
    } catch {}
  }

  async _startWorkLoop() {
    while (this._running) {
      try {
        // Only poll for work when not already working
        if (!this.workingOn) {
          var work = await this.getWork(true)  // auto_claim
          if (work.claimed) {
            this.workingOn = work.claimed.title || ('work #' + work.claimed.id)
            try {
              await this._workHandler(work.claimed)
            } catch (err) {
              console.error('[mycelium] work handler error:', err.message)
            }
            this.workingOn = ''
          }
        }
      } catch (err) {
        console.error('[mycelium] work poll error:', err.message)
      }

      // Wait before next poll
      await new Promise(resolve => {
        this._pollTimer = setTimeout(resolve, this.pollInterval)
      })
    }
  }

  async _processInbox(inbox) {
    // Handle directives and requests first (blocking)
    if (inbox.directives && this._requestHandler) {
      for (var d of inbox.directives) {
        try {
          await this._requestHandler(d, 'directive')
        } catch (err) {
          console.error('[mycelium] directive handler error:', err.message)
        }
      }
    }

    if (inbox.requests && this._requestHandler) {
      for (var r of inbox.requests) {
        try {
          await this._requestHandler(r, 'request')
        } catch (err) {
          console.error('[mycelium] request handler error:', err.message)
        }
      }
    }

    if (inbox.messages && this._messageHandler) {
      for (var m of inbox.messages) {
        try {
          await this._messageHandler(m)
        } catch (err) {
          console.error('[mycelium] message handler error:', err.message)
        }
      }
    }
  }
}
