// OctoPrint provider — communicates via REST API.
// Works with any OctoPrint-compatible printer (Ender, Prusa, etc).
//
// Ref: https://docs.octoprint.org/en/master/api/

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { PrinterProvider } from './base.js';

export class OctoPrintProvider extends PrinterProvider {
  constructor(config) {
    super(config);
    this.apiKey = config.apiKey?.startsWith('env:')
      ? process.env[config.apiKey.slice(4)]
      : config.apiKey;
    this.baseUrl = `http://${this.address}`;
  }

  async _fetch(path, opts = {}) {
    const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OctoPrint ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return {};
    return res.json();
  }

  async connect() {
    const data = await this._fetch('/api/version');
    console.log(`[octoprint] Connected: OctoPrint ${data.server} (API ${data.api})`);
  }

  async getStatus() {
    const [printer, job] = await Promise.all([
      this._fetch('/api/printer').catch(() => null),
      this._fetch('/api/job').catch(() => null),
    ]);

    let state = 'offline';
    if (printer?.state?.flags) {
      const f = printer.state.flags;
      if (f.printing || f.pausing) state = 'printing';
      else if (f.error) state = 'error';
      else if (f.ready || f.operational) state = 'idle';
    }

    return {
      state,
      progress: job?.progress?.completion ?? 0,
      layer: { current: null, total: null }, // OctoPrint doesn't track layers natively
      timeLeft: job?.progress?.printTimeLeft ?? 0,
      temps: {
        nozzle: printer?.temperature?.tool0?.actual ?? null,
        bed: printer?.temperature?.bed?.actual ?? null,
      },
      error: state === 'error' ? printer?.state?.text : null,
    };
  }

  async uploadAndPrint(gcodePath, filename) {
    const name = filename || basename(gcodePath);
    const fileData = await readFile(gcodePath);

    const formData = new FormData();
    formData.append('file', new Blob([fileData]), name);
    formData.append('select', 'true');
    formData.append('print', 'true');

    const res = await globalThis.fetch(`${this.baseUrl}/api/files/local`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.apiKey },
      body: formData,
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return { ok: true };
  }

  async cancel() {
    await this._fetch('/api/job', { method: 'POST', body: JSON.stringify({ command: 'cancel' }) });
  }

  async getSnapshot() {
    try {
      const res = await globalThis.fetch(`${this.baseUrl}/webcam/?action=snapshot`, {
        headers: { 'X-Api-Key': this.apiKey },
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }
}
