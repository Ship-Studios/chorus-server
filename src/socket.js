/**
 * Singleton holder for the Socket.IO Server instance.
 *
 * Set once in index.js after Fastify is ready. Imported by broadcast.js
 * and any module that needs to emit WebSocket messages.
 *
 * @type {import("socket.io").Server | null}
 */
let io = null;

/** @param {import("socket.io").Server} server */
export function setIO(server) { io = server; }

/** @returns {import("socket.io").Server | null} */
export function getIO() { return io; }
