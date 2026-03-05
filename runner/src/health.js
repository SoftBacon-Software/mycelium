// Health HTTP server — Railway healthcheck + status endpoint

import { createServer } from 'http';
import * as logger from './logger.js';

export function startHealthServer(orchestrator, port) {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const status = orchestrator.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } else if (req.url === '/ready') {
      res.writeHead(orchestrator.running ? 200 : 503);
      res.end(orchestrator.running ? 'ok' : 'shutting down');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  server.listen(port, () => {
    logger.info(null, `Health server listening on :${port}`);
  });

  return server;
}
