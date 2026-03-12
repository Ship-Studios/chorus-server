/** @type {Set<import("ws").WebSocket>} */
export const wsClients = new Set();

export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      try {
        client.send(data);
      } catch {
        wsClients.delete(client);
      }
    }
  }
}
