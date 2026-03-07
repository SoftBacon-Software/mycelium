// Job monitor — polls printer status and formats heartbeat strings.
// Detects completion and failure.

export class JobMonitor {
  constructor(provider, api) {
    this.provider = provider;
    this.api = api;
    this.polling = false;
    this.pollTimer = null;
  }

  // Monitor a print job until completion or failure.
  // Returns: { success: true, status } or { success: false, error }
  async monitor(jobId, jobTitle, pollMs = 5000) {
    this.polling = true;

    while (this.polling) {
      try {
        const status = await this.provider.getStatus();
        const heartbeat = this._formatHeartbeat(jobTitle, status);
        await this.api.heartbeat(heartbeat, {
          printer_state: status.state,
          progress: status.progress,
          temps: status.temps,
        }).catch(() => {}); // Non-blocking

        if (status.state === 'error') {
          return { success: false, error: status.error || 'Printer error' };
        }

        if (status.state === 'idle' && status.progress >= 99) {
          return { success: true, status };
        }

        // If printer went idle but progress is low, it likely failed silently
        if (status.state === 'idle' && status.progress > 0 && status.progress < 50) {
          return { success: false, error: `Print stopped unexpectedly at ${status.progress}%` };
        }
      } catch (err) {
        console.error(`[monitor] Poll error: ${err.message}`);
      }

      await sleep(pollMs);
    }

    return { success: false, error: 'Monitoring cancelled' };
  }

  stop() {
    this.polling = false;
  }

  _formatHeartbeat(title, status) {
    if (status.state === 'idle') return `Printer idle`;
    if (status.state === 'error') return `Printer error: ${status.error}`;

    const parts = [`Printing "${title}"`];

    if (status.layer?.current && status.layer?.total) {
      parts.push(`layer ${status.layer.current}/${status.layer.total}`);
    }

    if (status.progress > 0) {
      parts.push(`${Math.round(status.progress)}%`);
    }

    if (status.timeLeft > 0) {
      parts.push(formatTime(status.timeLeft));
    }

    return parts.join(' — ');
  }
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m left`;
  return `${m}m left`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
