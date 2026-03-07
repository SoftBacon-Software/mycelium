// PrusaSlicer CLI wrapper — slices STL to gcode.
// Skips slicing for pre-sliced files (.gcode, .3mf).

import { spawn } from 'child_process';
import { access } from 'fs/promises';
import { extname, join, basename } from 'path';

const SLICEABLE = new Set(['.stl', '.obj', '.amf']);
const PASSTHROUGH = new Set(['.gcode', '.gco', '.3mf']);

export class Slicer {
  constructor(config) {
    this.slicerPath = config.path || 'prusa-slicer';
    this.profileDir = config.profileDir || join(process.cwd(), 'profiles');
    this.profile = config.profile || 'generic';
  }

  // Returns true if the file needs slicing
  needsSlicing(filePath) {
    const ext = extname(filePath).toLowerCase();
    if (PASSTHROUGH.has(ext)) return false;
    if (SLICEABLE.has(ext)) return true;
    throw new Error(`Unsupported file type: ${ext}`);
  }

  // Slice an STL file to gcode. Returns path to output gcode.
  async slice(inputPath, outputDir, opts = {}) {
    if (!this.needsSlicing(inputPath)) return inputPath;

    await access(inputPath); // Verify file exists

    const outputName = basename(inputPath).replace(/\.[^.]+$/, '.gcode');
    const outputPath = join(outputDir, outputName);

    const args = ['--export-gcode'];

    // Load printer profile if it exists
    const printerIni = join(this.profileDir, `${this.profile}-printer.ini`);
    if (await access(printerIni).then(() => true).catch(() => false)) {
      args.push('--load', printerIni);
    }

    // Load print settings profile
    const printIni = join(this.profileDir, `${this.profile}-print.ini`);
    if (await access(printIni).then(() => true).catch(() => false)) {
      args.push('--load', printIni);
    }

    // Override with job-specific params
    if (opts.infill !== undefined) args.push('--fill-density', `${opts.infill}%`);
    if (opts.supports === 'auto') args.push('--support-material');
    if (opts.quality === 'draft') args.push('--layer-height', '0.3');
    else if (opts.quality === 'fine') args.push('--layer-height', '0.1');
    // 'standard' uses profile default

    args.push('-o', outputPath, inputPath);

    console.log(`[slicer] ${this.slicerPath} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.slicerPath, args);
      let stderr = '';

      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(outputPath);
        else reject(new Error(`Slicer exited with code ${code}: ${stderr.slice(0, 500)}`));
      });
      proc.on('error', (err) => {
        reject(new Error(`Failed to run slicer: ${err.message}. Is PrusaSlicer installed?`));
      });
    });
  }
}
