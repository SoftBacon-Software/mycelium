// =============== MYCELIUM — lazy WebSocket ping heartbeat ===============
// Task 186 §2 (AUDIT-lab-clockwork-2026-09-12): the voice (10s) and file-drone
// (15s) ping timers used to run unconditionally from boot and were never
// .unref()'d — two live timers for surfaces with zero clients. The heartbeat
// now starts lazily on the first client connection (ensure()) and is unref'd
// so it never holds the daemon open; with no clients the tick is a no-op.

export function createHeartbeat(opts) {
  var timer = null;

  function tick() {
    var clients = opts.clients() || [];
    clients.forEach(function (ws) {
      if (!ws.isAlive) {
        if (opts.onDead) opts.onDead(ws);
        try { ws.terminate(); } catch (e) { /* already gone */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* socket closing — next tick cleans up */ }
    });
  }

  // Idempotent: every connection handler can call this; only the first wins.
  function ensure() {
    if (timer) return timer;
    timer = setInterval(tick, opts.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isRunning() { return timer !== null; }

  return { ensure: ensure, stop: stop, tick: tick, isRunning: isRunning };
}
