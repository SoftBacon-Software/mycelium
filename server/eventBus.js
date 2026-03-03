// ─── Mycelium Live Event Bus ─────────────────────────────────────────────────
// In-process event emitter for SSE streaming. Routes call broadcast() to push
// events to all connected dashboard clients in real time.

var clients = new Set();

export function broadcast(event) {
  var data = 'data: ' + JSON.stringify(event) + '\n\n';
  for (var client of clients) {
    client.write(data);
  }
}

export function addClient(res) {
  clients.add(res);
  res.on('close', function () {
    clients.delete(res);
  });
}

export function clientCount() {
  return clients.size;
}
