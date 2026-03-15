import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Tests for swarm-tracking.js — agent lifecycle tracking and auto-cleanup.
 *
 * Mocks only bridge.js (heavy server deps). Uses the real broadcast module
 * with a mock IO injected via setIO() so broadcastToSession() correctly
 * fires the interceptor registered at swarm-tracking.js module init.
 */

// ── Mocks (hoisted by Bun before any import) ─────────────────────────────────

let cancelImpl = () => false;
mock.module("./routes/bridge.js", () => ({
  cancelBridgePrompt: (id) => cancelImpl(id),
  initBridge: () => {},
  dispatchBridgePrompt: async () => {},
}));

// Self-contained broadcast mock: captures the interceptor registered by
// swarm-tracking.js at module init, then exposes broadcastToSession so tests
// can fire it directly — independent of any other test file's broadcast mock.
let _interceptor = null;
const broadcastToSession = (sessionId, message) => {
  if (_interceptor) _interceptor(sessionId, message);
};
mock.module("./broadcast.js", () => ({
  onBroadcastToSession: (fn) => { _interceptor = fn; return () => { _interceptor = null; }; },
  broadcastToSession,
  broadcast: () => {},
  debouncedDiffInvalidation: () => {},
  clearDiffTimers: () => {},
}));

const { trackAgent, untrackAgent, cancelAgent, getActiveAgents, hasActiveAgents, _broadcastInterceptor } =
  await import("./swarm-tracking.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

let seq = 0;
function makeAgent(overrides = {}) {
  const id = overrides.id ?? `agent-test-${Date.now()}-${++seq}`;
  return {
    id,
    description: "Test agent",
    status: "running",
    startedAt: new Date().toISOString(),
    sessionId: overrides.sessionId ?? "sess-test",
    ...overrides,
  };
}

let trackedIds = [];

beforeEach(() => {
  cancelImpl = () => false;
  trackedIds = [];
});

afterEach(() => {
  for (const id of trackedIds) untrackAgent(id);
  trackedIds = [];
});

function track(agent) {
  trackAgent(agent);
  trackedIds.push(agent.id);
  return agent;
}

// ─── trackAgent / getActiveAgents / hasActiveAgents ───────────────────────────

describe("trackAgent", () => {
  it("adds agent to active map", () => {
    const agent = track(makeAgent({ sessionId: "sess-1" }));
    const active = getActiveAgents("sess-1");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(agent.id);
  });

  it("returns a copy — mutations do not affect internal state", () => {
    const agent = track(makeAgent({ sessionId: "sess-copy" }));
    const [copy] = getActiveAgents("sess-copy");
    copy.status = "mutated";
    expect(getActiveAgents("sess-copy")[0].status).toBe("running");
  });

  it("tracks multiple agents", () => {
    track(makeAgent({ sessionId: "sess-multi" }));
    track(makeAgent({ sessionId: "sess-multi" }));
    expect(getActiveAgents("sess-multi")).toHaveLength(2);
  });

  it("tracks agents across different sessions independently", () => {
    track(makeAgent({ sessionId: "sess-A" }));
    track(makeAgent({ sessionId: "sess-B" }));
    expect(getActiveAgents("sess-A")).toHaveLength(1);
    expect(getActiveAgents("sess-B")).toHaveLength(1);
  });

  it("returns all agents when no sessionId filter is given", () => {
    const before = getActiveAgents().length;
    track(makeAgent({ sessionId: "sess-all-1" }));
    track(makeAgent({ sessionId: "sess-all-2" }));
    expect(getActiveAgents()).toHaveLength(before + 2);
  });
});

describe("hasActiveAgents", () => {
  it("returns true when at least one agent is tracked", () => {
    track(makeAgent());
    expect(hasActiveAgents()).toBe(true);
  });
});

// ─── untrackAgent ─────────────────────────────────────────────────────────────

describe("untrackAgent", () => {
  it("removes a tracked agent", () => {
    const agent = track(makeAgent({ sessionId: "sess-untrack" }));
    untrackAgent(agent.id);
    trackedIds = trackedIds.filter((id) => id !== agent.id);
    expect(getActiveAgents("sess-untrack")).toHaveLength(0);
  });

  it("is a no-op for unknown agent ids", () => {
    const before = getActiveAgents().length;
    untrackAgent("nonexistent-id");
    expect(getActiveAgents()).toHaveLength(before);
  });

  it("removes only the targeted agent, not others in the same session", () => {
    const a = track(makeAgent({ sessionId: "sess-partial" }));
    const b = track(makeAgent({ sessionId: "sess-partial" }));
    untrackAgent(a.id);
    trackedIds = trackedIds.filter((id) => id !== a.id);
    const active = getActiveAgents("sess-partial");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(b.id);
  });
});

// ─── cancelAgent ──────────────────────────────────────────────────────────────

describe("cancelAgent", () => {
  it("returns { cancelled: false } when bridge rejects the cancel", () => {
    const agent = track(makeAgent());
    cancelImpl = () => false;
    expect(cancelAgent(agent.id)).toEqual({ cancelled: false });
    expect(getActiveAgents().some((a) => a.id === agent.id)).toBe(true);
  });

  it("returns { cancelled: true } and removes agent when bridge cancels successfully", () => {
    const agent = track(makeAgent({ sessionId: "sess-cancel" }));
    cancelImpl = () => true;
    const result = cancelAgent(agent.id);
    trackedIds = trackedIds.filter((id) => id !== agent.id);
    expect(result).toEqual({ cancelled: true });
    expect(getActiveAgents("sess-cancel")).toHaveLength(0);
  });

  it("does not remove agent when cancellation fails", () => {
    const agent = track(makeAgent({ sessionId: "sess-no-cancel" }));
    cancelImpl = () => false;
    cancelAgent(agent.id);
    expect(getActiveAgents("sess-no-cancel")).toHaveLength(1);
  });
});

// ─── Auto-cleanup via broadcast interceptor ───────────────────────────────────

// NOTE: These tests call _broadcastInterceptor directly rather than going
// through broadcastToSession. This is necessary because prompt.test.js imports
// swarm-tracking.js before this file, pre-caching the module so its module-level
// onBroadcastToSession() call never runs against our mock. The named export
// lets us invoke the interceptor logic directly, independent of the wiring.
describe("prompt:done broadcast interceptor", () => {
  it("removes agent when prompt:done fires with matching instanceId", () => {
    const sid = `sess-cleanup-${++seq}`;
    const agent = track(makeAgent({ sessionId: sid }));
    _broadcastInterceptor(sid, { type: "prompt:done", instanceId: agent.id });
    trackedIds = trackedIds.filter((id) => id !== agent.id);
    expect(getActiveAgents(sid)).toHaveLength(0);
  });

  it("does NOT remove agent when instanceId does not match", () => {
    const sid = `sess-nomatch-${++seq}`;
    const agent = track(makeAgent({ sessionId: sid }));
    _broadcastInterceptor(sid, { type: "prompt:done", instanceId: "different-id" });
    expect(getActiveAgents(sid)).toHaveLength(1);
  });

  it("ignores messages without instanceId", () => {
    const sid = `sess-noid-${++seq}`;
    const agent = track(makeAgent({ sessionId: sid }));
    _broadcastInterceptor(sid, { type: "prompt:done" });
    expect(getActiveAgents(sid)).toHaveLength(1);
  });

  it("ignores non-prompt:done message types", () => {
    const sid = `sess-wrongtype-${++seq}`;
    const agent = track(makeAgent({ sessionId: sid }));
    _broadcastInterceptor(sid, { type: "agent:done", instanceId: agent.id });
    expect(getActiveAgents(sid)).toHaveLength(1);
  });

  it("ignores null/undefined messages", () => {
    const sid = `sess-null-${++seq}`;
    const agent = track(makeAgent({ sessionId: sid }));
    _broadcastInterceptor(sid, null);
    _broadcastInterceptor(sid, undefined);
    expect(getActiveAgents(sid)).toHaveLength(1);
  });

  it("removes only the agent matching instanceId when multiple are tracked", () => {
    const sid = `sess-multi-done-${++seq}`;
    const a = track(makeAgent({ sessionId: sid }));
    const b = track(makeAgent({ sessionId: sid }));
    _broadcastInterceptor(sid, { type: "prompt:done", instanceId: a.id });
    trackedIds = trackedIds.filter((id) => id !== a.id);
    const remaining = getActiveAgents(sid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
  });
});
