// Boot wrapper — catches top-level ESM import errors that occur before
// any process.on('uncaughtException') handler can be registered.
try {
  await import('./index.js');
} catch (e) {
  process.stdout.write('[FATAL] Boot failed: ' + (e?.stack || e?.message || String(e)) + '\n');
  process.stderr.write('[FATAL] Boot failed: ' + (e?.stack || e?.message || String(e)) + '\n');
  process.exit(1);
}
