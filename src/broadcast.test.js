import { describe, expect, it, beforeEach } from "bun:test";
import { setIO } from "./socket.js";
import { broadcast, broadcastToSession, debouncedDiffInvalidation, clearDiffTimers } from "./broadcast.js";

/**
 * Tests for the Socket.IO broadcast utilities.
 *
 * Uses setIO() to inject a mock Socket.IO server instance,
 * then asserts on captured emit calls.
 */

let emitted;
let roomEmitted;

function installMockIO() {
  emitted = [];
  roomEmitted = [];
  setIO({
    emit(event, data) {
      emitted.push({ event, data });
    },
    to(room) {
      return {
        emit(event, data) {
          roomEmitted.push({ room, event, data });
        },
      };
    },
  });
}

describe("broadcast", () => {
  beforeEach(() => {
    installMockIO();
    clearDiffTimers();
  });

  it("emits message to all clients via io.emit", () => {
    broadcast({ type: "test", value: 42 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      event: "message",
      data: { type: "test", value: 42 },
    });
  });

  it("does nothing when io is null", () => {
    setIO(null);
    // Should not throw
    broadcast({ type: "test" });
    expect(emitted).toHaveLength(0);
  });

  it("sends multiple broadcasts independently", () => {
    broadcast({ type: "first" });
    broadcast({ type: "second" });
    expect(emitted).toHaveLength(2);
    expect(emitted[0].data.type).toBe("first");
    expect(emitted[1].data.type).toBe("second");
  });
});

describe("broadcastToSession", () => {
  beforeEach(() => {
    installMockIO();
    clearDiffTimers();
  });

  it("emits to the correct session room", () => {
    broadcastToSession("sess-123", { type: "prompt:chunk", sessionId: "sess-123", chunk: {} });
    expect(roomEmitted).toHaveLength(1);
    expect(roomEmitted[0]).toEqual({
      room: "session:sess-123",
      event: "message",
      data: { type: "prompt:chunk", sessionId: "sess-123", chunk: {} },
    });
  });

  it("does not emit globally when targeting a session", () => {
    broadcastToSession("sess-456", { type: "diff:invalidated", sessionId: "sess-456" });
    expect(emitted).toHaveLength(0);
    expect(roomEmitted).toHaveLength(1);
  });

  it("targets different rooms for different sessions", () => {
    broadcastToSession("sess-A", { type: "prompt:chunk", sessionId: "sess-A" });
    broadcastToSession("sess-B", { type: "prompt:chunk", sessionId: "sess-B" });
    expect(roomEmitted).toHaveLength(2);
    expect(roomEmitted[0].room).toBe("session:sess-A");
    expect(roomEmitted[1].room).toBe("session:sess-B");
  });

  it("does nothing when io is null", () => {
    setIO(null);
    broadcastToSession("sess-X", { type: "test" });
    expect(roomEmitted).toHaveLength(0);
  });
});

describe("debouncedDiffInvalidation", () => {
  beforeEach(() => {
    installMockIO();
    clearDiffTimers();
  });

  it("broadcasts to session room after debounce", async () => {
    debouncedDiffInvalidation("sess-789");
    expect(roomEmitted).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 350));
    expect(roomEmitted).toHaveLength(1);
    expect(roomEmitted[0].room).toBe("session:sess-789");
    expect(roomEmitted[0].data.type).toBe("diff:invalidated");
  });

  it("coalesces multiple calls for the same session", async () => {
    debouncedDiffInvalidation("sess-coalesce");
    debouncedDiffInvalidation("sess-coalesce");
    debouncedDiffInvalidation("sess-coalesce");
    await new Promise((r) => setTimeout(r, 350));
    expect(roomEmitted).toHaveLength(1);
  });

  it("debounces independently per session", async () => {
    debouncedDiffInvalidation("sess-X");
    debouncedDiffInvalidation("sess-Y");
    await new Promise((r) => setTimeout(r, 350));
    expect(roomEmitted).toHaveLength(2);
    const rooms = roomEmitted.map((e) => e.room);
    expect(rooms).toContain("session:sess-X");
    expect(rooms).toContain("session:sess-Y");
  });

  it("clearDiffTimers cancels pending debounces", async () => {
    debouncedDiffInvalidation("sess-cleared");
    clearDiffTimers();
    await new Promise((r) => setTimeout(r, 350));
    expect(roomEmitted).toHaveLength(0);
  });
});
