// Mycelium API client — check work, heartbeat, update status

export class MyceliumAPI {
  constructor(apiUrl, adminKey) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.adminKey = adminKey;
  }

  async request(method, path, body) {
    const url = `${this.apiUrl}${path}`;
    const opts = {
      method,
      headers: {
        'X-Admin-Key': this.adminKey,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mycelium API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async getWork(agentId) {
    return this.request('GET', `/work/${agentId}`);
  }

  async heartbeat(agentId, status, workingOn) {
    return this.request('POST', '/agents/heartbeat', {
      agent_id: agentId,
      status,
      working_on: workingOn || '',
    });
  }

  async getAgent(agentId) {
    const agents = await this.request('GET', '/agents');
    return agents.find(a => a.id === agentId);
  }

  async sendEvent(agentId, message) {
    return this.request('POST', '/messages', {
      from_agent: '__system__',
      to_agent: agentId,
      content: message,
      msg_type: 'info',
    });
  }

  // Write a handoff savepoint for the agent — captured at session end so the next boot
  // sees what was accomplished and can pick up where we left off.
  async saveHandoffSnapshot(agentId, notes) {
    try {
      return await this.request('POST', `/agents/${agentId}/savepoint`, { notes });
    } catch (e) {
      // Non-critical — savepoints are best-effort
      return null;
    }
  }

  // Dynamic spawn queue — returns pending spawn requests for this runner to execute
  async getSpawnQueue() {
    try {
      return await this.request('GET', '/admin/runner/spawns?status=pending');
    } catch (e) {
      return [];
    }
  }

  async claimSpawn(id, runnerId) {
    return this.request('PUT', `/admin/runner/spawns/${id}/claim`, { runner_id: runnerId });
  }

  async doneSpawn(id, result, status) {
    return this.request('PUT', `/admin/runner/spawns/${id}/done`, { result, status: status || 'done' });
  }

  // Returns { autonomous: bool, directive: string, sleepingOperators: [], availableOperators: [] }
  async getNetworkMode() {
    try {
      const [operators, sleep] = await Promise.all([
        this.request('GET', '/operators'),
        this.request('GET', '/admin/sleep'),
      ]);
      const active = (operators || []).filter(o => o.status === 'active');
      const available = active.filter(o => o.availability === 'available');
      const sleeping = active.filter(o => o.availability === 'sleeping' || o.availability === 'away');
      const autonomous = available.length === 0;
      return {
        autonomous,
        directive: sleep && sleep.active ? (sleep.directive || '') : '',
        sleepingOperators: sleeping.map(o => o.display_name || o.id),
        availableOperators: available.map(o => o.display_name || o.id),
      };
    } catch (e) {
      // Non-critical — fail open (assume humans present)
      return { autonomous: false, directive: '', sleepingOperators: [], availableOperators: [] };
    }
  }
}
