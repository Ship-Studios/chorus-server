import { describe, expect, it, beforeEach } from "bun:test";
import { wsClients, broadcast } from "./broadcast.js";

/**
 * Tests for the WebSocket broadcast utility.
 * Uses plain objects mimicking the WebSocket interface (readyState + send).
 */

function mockSocket(readyState = 1) {
  return {
    readyState,
    sent: [],
    send(data) {
      this.sent.push(data);
    },
  };
}

function mockSocketThatThrows(readyState = 1) {
  return {
    readyState,
    send() {
      throw new Error("connection reset");
    },
  };
}

describe("broadcast", () => {
  beforeEach(() => {
    wsClients.clear();
  });

  it("sends JSON to all open clients", () => {
    const a = mockSocket();
    const b = mockSocket();
    wsClients.add(a);
    wsClients.add(b);

    broadcast({ type: "test", value: 42 });

    const expected = JSON.stringify({ type: "test", value: 42 });
    expect(a.sent).toEqual([expected]);
    expect(b.sent).toEqual([expected]);
  });

  it("skips clients with readyState !== 1 (OPEN)", () => {
    const open = mockSocket(1);
    const connecting = mockSocket(0);
    const closing = mockSocket(2);
    const closed = mockSocket(3);
    wsClients.add(open);
    wsClients.add(connecting);
    wsClients.add(closing);
    wsClients.add(closed);

    broadcast({ type: "ping" });

    expect(open.sent).toHaveLength(1);
    expect(connecting.sent).toHaveLength(0);
    expect(closing.sent).toHaveLength(0);
    expect(closed.sent).toHaveLength(0);
  });

  it("removes clients that throw on send", () => {
    const good = mockSocket();
    const bad = mockSocketThatThrows();
    wsClients.add(good);
    wsClients.add(bad);

    broadcast({ type: "test" });

    expect(good.sent).toHaveLength(1);
    expect(wsClients.has(bad)).toBe(false);
    expect(wsClients.has(good)).toBe(true);
  });

  it("does nothing when no clients are connected", () => {
    // Should not throw
    broadcast({ type: "empty" });
    expect(wsClients.size).toBe(0);
  });

  it("sends multiple broadcasts independently", () => {
    const client = mockSocket();
    wsClients.add(client);

    broadcast({ type: "first" });
    broadcast({ type: "second" });

    expect(client.sent).toHaveLength(2);
    expect(JSON.parse(client.sent[0]).type).toBe("first");
    expect(JSON.parse(client.sent[1]).type).toBe("second");
  });
});
