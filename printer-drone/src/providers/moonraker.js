// Moonraker provider — communicates via REST API.
// Works with Klipper-based printers (Voron, Ender + Klipper, etc).
//
// Ref: https://moonraker.readthedocs.io/en/latest/web_api/

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { PrinterProvider } from './base.js';

export class MoonrakerProvider extends PrinterProvider {
  constructor(config) {
    super(config);
    this.baseUrl = `http://${this.address}`;
    this.apiKey = config.apiKey?.startsWith('env:')
      ? process.env[config.apiKey.slice(4)]
      : config.apiKey;
  }

  async _fetch(path, opts = {}) {
    const headers = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    if (opts.json) headers['Content-Type'] = 'application/json';

    const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: { ...headers, ...opts.headers },
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Moonraker ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  async connect() {
    const info = await this._fetch('/server/info');
    console.log(`[moonraker] Connected: Moonraker ${info.result?.software_version || 'unknown'}`);
  }

  async getStatus() {
    const data = await this._fetch(
      '/printer/objects/query?print_stats&display_status&extruder&heater_bed'
    );
    const r = data.result?.status || {};
    const ps = r.print_stats || {};
    const ds = r.display_status || {};
    const ext = r.extruder || {};
    const bed = r.heater_bed || {};

    const stateMap = {
      'standby': 'idle',
      'printing': 'printing',
      'paused': 'printing',
      'complete': 'idle',
      'cancelled': 'idle',
      'error': 'error',
    };

    const totalDuration = ps.print_duration || 0;
    const progress = ds.progress || 0;
    const timeLeft = progress > 0 ? (totalDuration / progress) * (1 - progress) : 0;

    return {
      state: stateMap[ps.state] || 'offline',
      progress: Math.round(progress * 100),
      layer: {
        current: ps.info?.current_layer ?? null,
        total: ps.info?.total_layer ?? null,
      },
      timeLeft: Math.round(timeLeft),
      temps: {
        nozzle: ext.temperature ?? null,
        bed: bed.temperature ?? null,
      },
      error: ps.state === 'error' ? (ps.message || 'Unknown error') : null,
    };
  }

  async uploadAndPrint(gcodePath, filename) {
    const name = filename || basename(gcodePath);
    const fileData = await readFile(gcodePath);

    const formData = new FormData();
    formData.append('file', new Blob([fileData]), name);

    // Upload
    const headers = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    const uploadRes = await globalThis.fetch(`${this.baseUrl}/server/files/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

    // Start print
    await this._fetch(`/printer/print/start?filename=${encodeURIComponent(name)}`, {
      method: 'POST',
    });

    return { ok: true };
  }

  async cancel() {
    await this._fetch('/printer/print/cancel', { method: 'POST' });
  }

  async getSnapshot() {
    try {
      // Most Klipper setups use crowsnest/mjpg-streamer on port 8080
      const res = await globalThis.fetch(`${this.baseUrl.replace(':7125', ':8080')}/?action=snapshot`);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }
}
