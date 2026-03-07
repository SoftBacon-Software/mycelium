// Mock printer provider — simulates a printer for development and testing.
// No real hardware needed. Simulates print progress over time.

import { PrinterProvider } from './base.js';

export class MockProvider extends PrinterProvider {
  constructor(config) {
    super(config);
    this.state = 'idle';
    this.progress = 0;
    this.totalLayers = 0;
    this.currentLayer = 0;
    this.printTimer = null;
    this.printName = '';
    this.startTime = 0;
    this.printDuration = config.mockDurationMs || 30000; // 30s default "print"
  }

  async connect() {
    console.log('[mock] Connected to virtual printer');
  }

  async getStatus() {
    return {
      state: this.state,
      progress: Math.round(this.progress),
      layer: { current: this.currentLayer, total: this.totalLayers },
      timeLeft: this.state === 'printing'
        ? Math.round((this.printDuration - (Date.now() - this.startTime)) / 1000)
        : 0,
      temps: { nozzle: this.state === 'printing' ? 210 : 25, bed: this.state === 'printing' ? 60 : 25 },
      error: null,
    };
  }

  async uploadAndPrint(gcodePath, filename) {
    if (this.state === 'printing') throw new Error('Printer is busy');

    this.printName = filename || gcodePath;
    this.totalLayers = 100 + Math.floor(Math.random() * 200);
    this.currentLayer = 0;
    this.progress = 0;
    this.state = 'printing';
    this.startTime = Date.now();

    // Simulate progress
    const interval = this.printDuration / this.totalLayers;
    this.printTimer = setInterval(() => {
      this.currentLayer++;
      this.progress = (this.currentLayer / this.totalLayers) * 100;
      if (this.currentLayer >= this.totalLayers) {
        clearInterval(this.printTimer);
        this.printTimer = null;
        this.state = 'idle';
        this.progress = 100;
        console.log(`[mock] Print "${this.printName}" completed`);
      }
    }, interval);

    console.log(`[mock] Started printing "${this.printName}" (${this.totalLayers} layers, ${this.printDuration / 1000}s)`);
    return { ok: true };
  }

  async cancel() {
    if (this.printTimer) {
      clearInterval(this.printTimer);
      this.printTimer = null;
    }
    this.state = 'idle';
    this.progress = 0;
    console.log(`[mock] Print cancelled`);
  }

  async disconnect() {
    if (this.printTimer) clearInterval(this.printTimer);
  }
}
