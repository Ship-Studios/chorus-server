/**
 * bridge-exports.js — Direct re-exports of bridge relay functions.
 *
 * These functions dispatch operations to the local-agent daemon via the
 * Socket.IO bridge namespace and handle bridge connection state.
 *
 * @module bridge-exports
 */

export {
  dispatchPromptToBridge,
  cancelBridgePrompt,
  isBridgePromptActive,
  isBridgeConnected,
  dispatchSwarmToBridge,
  cancelBridgeSwarm,
} from "./routes/bridge.js";
