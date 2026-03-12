/** @type {Set<import("ws").WebSocket>} */
export const wsClients = new Set();

const MAX_BUFFER = 1 * 1024 * 1024;

export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      if (client.bufferedAmount > MAX_BUFFER) {
        wsClients.delete(client);
        client.terminate();
        continue;
      }
      try {
        client.send(data);
      } catch {
        wsClients.delete(client);
      }
    }
  }
}
