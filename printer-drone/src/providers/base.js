// Base provider interface. All printer providers must implement these methods.

export class PrinterProvider {
  constructor(config) {
    this.config = config;
    this.address = config.address;
  }

  // Verify printer is online and reachable
  async connect() { throw new Error('Not implemented'); }

  // Get current printer status
  // Returns: { state: 'idle'|'printing'|'error'|'offline', progress: 0-100,
  //            layer: { current, total }, timeLeft: seconds, temps: { bed, nozzle }, error: string|null }
  async getStatus() { throw new Error('Not implemented'); }

  // Send gcode file to printer and start printing
  // Returns: { ok: true } or throws
  async uploadAndPrint(gcodePath, filename) { throw new Error('Not implemented'); }

  // Abort current print
  async cancel() { throw new Error('Not implemented'); }

  // Get webcam snapshot as Buffer, or null if no camera
  async getSnapshot() { return null; }

  // Clean disconnect
  async disconnect() {}
}
