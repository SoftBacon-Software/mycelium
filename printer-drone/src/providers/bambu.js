// Bambu Lab printer provider — communicates via local MQTT + FTPS.
// Works with A1, A1 Mini, P1P, P1S, X1, X1C.
//
// Connection: MQTT on port 8883 (TLS), username "bblp", password = LAN access code.
// Topics: device/{serial}/report (subscribe), device/{serial}/request (publish).
// File upload: FTPS on port 990.
//
// Ref: https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md

import mqtt from 'mqtt';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { PrinterProvider } from './base.js';

export class BambuProvider extends PrinterProvider {
  constructor(config) {
    super(config);
    this.serial = config.serial?.startsWith('env:')
      ? process.env[config.serial.slice(4)]
      : config.serial;
    this.accessCode = config.accessCode?.startsWith('env:')
      ? process.env[config.accessCode.slice(4)]
      : config.accessCode;
    this.client = null;
    this.status = { state: 'offline', progress: 0, layer: {}, timeLeft: 0, temps: {}, error: null };
    this.seqId = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = `mqtts://${this.address}:8883`;
      this.client = mqtt.connect(url, {
        username: 'bblp',
        password: this.accessCode,
        rejectUnauthorized: false, // Self-signed cert on printer
        connectTimeout: 10000,
      });

      const topic = `device/${this.serial}/report`;

      this.client.on('connect', () => {
        console.log(`[bambu] Connected to ${this.address}`);
        this.client.subscribe(topic, (err) => {
          if (err) return reject(new Error(`Subscribe failed: ${err.message}`));
          // Push initial status request
          this._send({ pushing: { command: 'pushall', sequence_id: String(this.seqId++) } });
          resolve();
        });
      });

      this.client.on('message', (_topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          this._handleReport(msg);
        } catch { /* ignore malformed */ }
      });

      this.client.on('error', (err) => {
        console.error(`[bambu] MQTT error: ${err.message}`);
        this.status.state = 'error';
        this.status.error = err.message;
      });

      setTimeout(() => reject(new Error('MQTT connect timeout')), 15000);
    });
  }

  _handleReport(msg) {
    const p = msg.print || {};
    // Map gcode_state to our standard states
    if (p.gcode_state) {
      const stateMap = {
        'IDLE': 'idle',
        'RUNNING': 'printing',
        'PAUSE': 'printing',
        'FINISH': 'idle',
        'FAILED': 'error',
        'PREPARE': 'printing',
        'SLICING': 'printing',
      };
      this.status.state = stateMap[p.gcode_state] || 'idle';
    }
    if (p.mc_percent !== undefined) this.status.progress = p.mc_percent;
    if (p.layer_num !== undefined || p.total_layer_num !== undefined) {
      this.status.layer = {
        current: p.layer_num ?? this.status.layer.current,
        total: p.total_layer_num ?? this.status.layer.total,
      };
    }
    if (p.mc_remaining_time !== undefined) this.status.timeLeft = p.mc_remaining_time * 60; // min → sec
    if (p.nozzle_temper !== undefined || p.bed_temper !== undefined) {
      this.status.temps = {
        nozzle: p.nozzle_temper ?? this.status.temps.nozzle,
        bed: p.bed_temper ?? this.status.temps.bed,
      };
    }
    if (p.print_error && p.print_error !== 0) {
      this.status.error = `Print error code: ${p.print_error}`;
      this.status.state = 'error';
    }
  }

  _send(payload) {
    if (!this.client) throw new Error('Not connected');
    const topic = `device/${this.serial}/request`;
    this.client.publish(topic, JSON.stringify(payload));
  }

  async getStatus() {
    return { ...this.status };
  }

  async uploadAndPrint(gcodePath, filename) {
    // Upload via FTPS to printer SD card
    const remotePath = `/cache/${filename || basename(gcodePath)}`;
    await this._ftpUpload(gcodePath, remotePath);

    // Send print command
    this._send({
      print: {
        command: 'project_file',
        sequence_id: String(this.seqId++),
        param: `Metadata/plate_1.gcode`,
        subtask_name: filename || basename(gcodePath),
        url: `ftp://${remotePath}`,
        file: remotePath,
        flow_cali: 0,
        layer_inspect: 0,
        use_ams: false,
        timelapse: false,
        bed_leveling: true,
        vibration_cali: false,
      },
    });

    return { ok: true };
  }

  async _ftpUpload(localPath, remotePath) {
    // Use basic-ftp for FTPS upload
    let Client;
    try {
      ({ Client } = await import('basic-ftp'));
    } catch {
      throw new Error('basic-ftp not installed. Run: npm install basic-ftp');
    }

    const client = new Client();
    try {
      await client.access({
        host: this.address,
        port: 990,
        user: 'bblp',
        password: this.accessCode,
        secure: true,
        secureOptions: { rejectUnauthorized: false },
      });
      await client.uploadFrom(localPath, remotePath);
    } finally {
      client.close();
    }
  }

  async cancel() {
    this._send({
      print: {
        command: 'stop',
        sequence_id: String(this.seqId++),
      },
    });
  }

  async pause() {
    this._send({
      print: {
        command: 'pause',
        sequence_id: String(this.seqId++),
      },
    });
  }

  async resume() {
    this._send({
      print: {
        command: 'resume',
        sequence_id: String(this.seqId++),
      },
    });
  }

  async getSnapshot() {
    // Bambu cameras stream via RTSP, not HTTP snapshot.
    // Would need ffmpeg to grab a frame. Return null for now.
    return null;
  }

  async disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
