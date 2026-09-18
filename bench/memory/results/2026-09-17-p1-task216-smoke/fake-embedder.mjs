// task 210 flag-path smoke — loopback ollama-shaped FAKE embedder.
// The same pattern as the 206 route smoke: every text embeds to the same
// 2-dim vector, so the full index path runs (sm_embeddings rows + scheduler
// write-back + vector cache) with no model and no oMLX/3090 involvement.
//   node fake-embedder.mjs --port 3998
import http from 'node:http';

const argIdx = process.argv.indexOf('--port');
const port = argIdx !== -1 ? parseInt(process.argv[argIdx + 1], 10) : 3998;

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: [[0.6, 0.8]] }));
    });
  })
  .listen(port, '127.0.0.1', () => console.error(`fake-embedder on 127.0.0.1:${port}`));
