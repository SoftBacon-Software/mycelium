// Mycelium API client for drone workers.
// Handles: poll jobs, claim, complete/fail, heartbeat, artifact download.

import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export class MyceliumAPI {
  constructor(config) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    // Resolve env: references
    this.agentKey = config.agentKey.startsWith('env:')
      ? process.env[config.agentKey.slice(4)]
      : config.agentKey;
    if (!this.agentKey) {
      throw new Error(`Agent key not set. Expected env var: ${config.agentKey.slice(4)}`);
    }
    this.droneId = config.droneId || 'printer-drone';
  }

  async fetch(path, opts = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': this.agentKey,
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${opts.method || 'GET'} ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  // Claim next available job matching our capabilities.
  // Server picks the best match — no need to poll separately.
  // Returns: { job } or { job: null }
  async claimJob(capabilities = ['3d_printer']) {
    return this.fetch('/drones/claim', {
      method: 'POST',
      body: { capabilities },
    });
  }

  // Mark job as done with optional result data
  async completeJob(jobId, resultData = {}) {
    return this.fetch(`/drones/jobs/${jobId}`, {
      method: 'PUT',
      body: { status: 'done', result_data: typeof resultData === 'string' ? resultData : JSON.stringify(resultData) },
    });
  }

  // Mark job as failed
  async failJob(jobId, error) {
    return this.fetch(`/drones/jobs/${jobId}`, {
      method: 'PUT',
      body: { status: 'failed', error: typeof error === 'string' ? error : error.message },
    });
  }

  // Send heartbeat with status
  async heartbeat(workingOn, diagnostics = {}) {
    return this.fetch('/agents/heartbeat', {
      method: 'POST',
      body: {
        agent_id: this.droneId,
        working_on: workingOn,
        system_diagnostics: diagnostics,
        // state_snapshot.system_info is what the server persists for drone job routing
        state_snapshot: Object.keys(diagnostics).length > 0 ? { system_info: diagnostics } : undefined,
      },
    });
  }

  // Download a file (STL artifact) to local path
  async downloadFile(url, destPath) {
    const res = await globalThis.fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${url} → ${res.status}`);
    const fileStream = createWriteStream(destPath);
    await pipeline(res.body, fileStream);
    return destPath;
  }

  // Upload result artifact (e.g. webcam snapshot)
  async uploadArtifact(jobId, filePath, filename) {
    const { readFile } = await import('fs/promises');
    const data = await readFile(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([data]), filename);
    const url = `${this.baseUrl}/drones/jobs/${jobId}/artifact`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'X-Agent-Key': this.agentKey },
      body: formData,
    });
    if (!res.ok) {
      // Non-critical — print still succeeded
      console.warn(`[api] Artifact upload failed: ${res.status}`);
    }
  }
}
