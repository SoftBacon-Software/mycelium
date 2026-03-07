#!/usr/bin/env node
// printer-drone — Mycelium drone worker for 3D printers.
//
// Poll loop: claim job → download STL → slice → upload gcode → monitor → complete/fail.
// Provider pattern: swap Bambu/OctoPrint/Moonraker via config.
//
// Usage:
//   node index.js              # Run with config.json
//   node index.js --mock       # Run with mock printer (no hardware)
//   node index.js --config X   # Custom config path

import { readFile, mkdir, rm } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';
import { MyceliumAPI } from './src/api.js';
import { Slicer } from './src/slicer.js';
import { JobMonitor } from './src/monitor.js';

// --- Config ---

const args = process.argv.slice(2);
const useMock = args.includes('--mock');
const configIdx = args.indexOf('--config');
const configPath = configIdx >= 0 ? args[configIdx + 1] : 'config.json';

async function loadConfig() {
  if (useMock) {
    return {
      mycelium: {
        apiUrl: process.env.MYCELIUM_URL || 'https://mycelium.fyi/api/mycelium',
        agentKey: process.env.PRINTER_DRONE_KEY || 'mock-key',
        droneId: 'printer-drone',
      },
      printer: { provider: 'mock', mockDurationMs: 30000 },
      slicer: { path: 'prusa-slicer', profile: 'generic' },
      pollIntervalMs: 10000,
      jobTypes: ['3d_print'],
      workDir: './work',
    };
  }

  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}

// --- Provider Factory ---

async function createProvider(config) {
  const type = config.printer?.provider || 'mock';
  switch (type) {
    case 'bambu': {
      const { BambuProvider } = await import('./src/providers/bambu.js');
      return new BambuProvider(config.printer);
    }
    case 'octoprint': {
      const { OctoPrintProvider } = await import('./src/providers/octoprint.js');
      return new OctoPrintProvider(config.printer);
    }
    case 'moonraker': {
      const { MoonrakerProvider } = await import('./src/providers/moonraker.js');
      return new MoonrakerProvider(config.printer);
    }
    case 'mock': {
      const { MockProvider } = await import('./src/providers/mock.js');
      return new MockProvider(config.printer);
    }
    default:
      throw new Error(`Unknown printer provider: ${type}`);
  }
}

// --- Job Execution ---

async function executeJob(job, { api, provider, slicer, workDir }) {
  const input = typeof job.input_data === 'string' ? JSON.parse(job.input_data) : (job.input_data || {});
  const jobDir = join(workDir, `job-${job.id}`);
  await mkdir(jobDir, { recursive: true });

  try {
    // 1. Check printer is idle
    const printerStatus = await provider.getStatus();
    if (printerStatus.state === 'printing') {
      throw new Error('Printer is busy with another print');
    }

    // 2. Download STL/gcode
    let filePath;
    if (input.artifact_url) {
      const ext = extname(input.artifact_url) || '.stl';
      filePath = join(jobDir, `input${ext}`);
      console.log(`[job ${job.id}] Downloading ${input.artifact_url}`);
      await api.downloadFile(input.artifact_url, filePath);
    } else if (input.file_url) {
      const ext = extname(input.file_url) || '.stl';
      filePath = join(jobDir, `input${ext}`);
      await api.downloadFile(input.file_url, filePath);
    } else {
      throw new Error('No artifact_url or file_url in job input_data');
    }

    // 3. Slice if needed
    let gcodePath = filePath;
    if (slicer.needsSlicing(filePath)) {
      console.log(`[job ${job.id}] Slicing...`);
      await api.heartbeat(`Slicing "${job.title}"...`).catch(() => {});
      gcodePath = await slicer.slice(filePath, jobDir, {
        infill: input.infill,
        supports: input.supports,
        quality: input.quality,
      });
      console.log(`[job ${job.id}] Sliced → ${basename(gcodePath)}`);
    }

    // 4. Send to printer
    const printFilename = `mycelium-${job.id}-${basename(gcodePath)}`;
    console.log(`[job ${job.id}] Sending to printer...`);
    await provider.uploadAndPrint(gcodePath, printFilename);

    // 5. Monitor until done
    console.log(`[job ${job.id}] Printing started, monitoring...`);
    const monitor = new JobMonitor(provider, api);
    const result = await monitor.monitor(job.id, job.title);

    if (!result.success) {
      throw new Error(result.error);
    }

    // 6. Capture snapshot if available
    let snapshotInfo = null;
    const snapshot = await provider.getSnapshot();
    if (snapshot) {
      const snapPath = join(jobDir, 'result.jpg');
      const { writeFile } = await import('fs/promises');
      await writeFile(snapPath, snapshot);
      await api.uploadArtifact(job.id, snapPath, 'result.jpg').catch(() => {});
      snapshotInfo = 'result.jpg uploaded';
    }

    // 7. Complete
    await api.completeJob(job.id, {
      message: `Print completed successfully`,
      snapshot: snapshotInfo,
      layers: result.status?.layer,
    });
    console.log(`[job ${job.id}] ✓ Completed`);

  } finally {
    // Cleanup work directory
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Main Loop ---

async function main() {
  console.log('printer-drone v1.0.0');
  const config = await loadConfig();
  console.log(`Provider: ${config.printer?.provider || 'mock'}`);
  console.log(`Mycelium: ${config.mycelium.apiUrl}`);

  const api = new MyceliumAPI(config.mycelium);
  const slicer = new Slicer(config.slicer || {});
  const provider = await createProvider(config);

  const workDir = config.workDir || './work';
  await mkdir(workDir, { recursive: true });

  // Connect to printer
  console.log('Connecting to printer...');
  await provider.connect();
  console.log('Printer connected.');

  // Initial heartbeat with diagnostics (required for job claiming)
  await api.heartbeat('Printer drone online, waiting for jobs', {
    os: process.platform === 'win32' ? 'windows' : process.platform,
    platform: process.platform,
    capabilities: config.capabilities || ['3d_printer'],
    printer_provider: config.printer?.provider || 'mock',
    node_version: process.version,
  }).catch((e) => {
    console.warn(`[heartbeat] ${e.message}`);
  });

  const pollMs = config.pollIntervalMs || 30000;
  let running = true;

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    running = false;
    await provider.disconnect().catch(() => {});
    await api.heartbeat('Printer drone offline').catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`Polling every ${pollMs / 1000}s for ${config.jobTypes?.join(', ') || '3d_print'} jobs\n`);

  while (running) {
    try {
      // Server-side claim — returns best matching job or null
      const result = await api.claimJob(config.capabilities || ['3d_printer']);
      const job = result.job;

      if (job) {
        console.log(`[poll] Claimed job #${job.id}: "${job.title}"`);

        // Execute
        try {
          await executeJob(job, { api, provider, slicer, workDir });
        } catch (err) {
          console.error(`[job ${job.id}] Failed: ${err.message}`);
          await api.failJob(job.id, err.message).catch(() => {});
          await api.heartbeat(`Job #${job.id} failed: ${err.message}`).catch(() => {});
        }

        // Back to idle
        await api.heartbeat('Printer drone idle, waiting for jobs').catch(() => {});
      }
    } catch (err) {
      console.error(`[poll] Error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(1);
});
