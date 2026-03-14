/**
 * Flint routes — proxy to Mobey MCP for todo data.
 *
 * Endpoints:
 *   GET /api/flint/status — check if MOBEY_API_KEY is configured
 *   GET /api/flint/todos  — fetch todos from Mobey via MCP Streamable HTTP
 *
 * Calls the Mobey MCP server at https://mobey.up.railway.app/mcp using the
 * JSON-RPC 2.0 over HTTP (Streamable HTTP) protocol:
 *   1. POST /mcp with `initialize` → extract Mcp-Session-Id response header
 *   2. Fire `notifications/initialized` (spec-required acknowledgement)
 *   3. POST /mcp with `tools/call` for `list_todos` → parse JSON result
 *
 * @module routes/flint
 */

const MOBEY_MCP_URL = "https://mobey.up.railway.app/mcp";

/**
 * Call a Mobey MCP tool via the Streamable HTTP transport.
 *
 * Opens a fresh MCP session, calls the tool, and returns the parsed result.
 * Each request creates a new session — acceptable for low-frequency dashboard
 * polling. Long-lived session pooling can be added later if needed.
 *
 * @param {string} toolName - The MCP tool name (e.g. "list_todos").
 * @param {object} args - Tool arguments forwarded as-is to Mobey.
 * @returns {Promise<any>} Parsed JSON result from the tool response.
 * @throws {Error} On HTTP errors, missing session ID, or missing tool result.
 */
async function callMobeyTool(toolName, args) {
  const apiKey = process.env.MOBEY_API_KEY;
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer mobey_8f6fc0e00cb9c4686a222a30d8cac972c961d8f5f6a73de5d9de96c274c8a678`,
  };

  // ── 1. Initialize session ─────────────────────────────────────────────────
  const initRes = await fetch(MOBEY_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-dashboard", version: "1.0" },
      },
      id: 1,
    }),
  });

  if (!initRes.ok) {
    const body = await initRes.text();
    throw new Error(`Mobey MCP init failed (${initRes.status}): ${body}`);
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  // Consume the init response body to free the connection.
  await initRes.text();

  if (!sessionId) throw new Error("Mobey MCP: no session ID in initialize response");

  const sessionHeaders = { ...headers, "Mcp-Session-Id": sessionId };

  // ── 2. Acknowledge initialization — await the HTTP 200 to guarantee the
  //       server has processed the notification before the tool call arrives.
  //       JSON-RPC notifications have no id and expect no JSON reply, but the
  //       HTTP transport still returns 200; awaiting it prevents a race where
  //       tools/call arrives before the session is fully initialised.
  const notifRes = await fetch(MOBEY_MCP_URL, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await notifRes.text();

  // ── 3. Call the tool ──────────────────────────────────────────────────────
  const toolRes = await fetch(MOBEY_MCP_URL, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: 2,
    }),
  });

  if (!toolRes.ok) {
    const body = await toolRes.text();
    throw new Error(`Mobey MCP tool call failed (${toolRes.status}): ${body}`);
  }

  const contentType = toolRes.headers.get("content-type") ?? "";
  const body = await toolRes.text();

  // ── Parse response — may be SSE or plain JSON / NDJSON ───────────────────
  // SSE lines are prefixed "data: "; plain JSON is one or more lines of JSON.
  let result = null;
  for (const line of body.trim().split("\n")) {
    const stripped = line.startsWith("data: ") ? line.slice(6) : line;
    if (!stripped.trim()) continue;
    try {
      const msg = JSON.parse(stripped);
      if (msg.id === 2 && msg.result) {
        result = msg.result;
        break;
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  if (!result) {
    throw new Error(`Mobey MCP: no result in tool response (content-type: ${contentType})`);
  }

  // MCP tool results: { content: [{ type: "text", text: "<json>" }] }
  const text = result.content?.[0]?.text;
  if (text == null) throw new Error("Mobey MCP: empty tool result content");

  return JSON.parse(text);
}

/**
 * Fastify plugin registering the /api/flint/* routes.
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
export default async function flintRoutes(fastify) {
  /**
   * GET /api/flint/status
   *
   * Lightweight probe so the UI can decide whether to show or hide the Flint
   * page content without making a full data request. Returns `{ available: boolean }`.
   */
  fastify.get("/api/flint/status", async () => ({
    available: !!process.env.MOBEY_API_KEY,
  }));

  /**
   * GET /api/flint/todos
   *
   * Fetch todos from Mobey via MCP. Forwards optional query params to the
   * `list_todos` tool. Returns `{ todos: Todo[], available: true }`.
   *
   * Query params:
   *   - completed — "true" | "false" (default "false" = active only) | "all"
   *   - boardKey  — filter to a specific board
   *   - quadrant  — filter to quadrant 1–4
   *
   * Error responses:
   *   - 503 — MOBEY_API_KEY not configured
   *   - 502 — Mobey MCP call failed
   */
  fastify.get("/api/flint/todos", async (req, reply) => {
    if (!process.env.MOBEY_API_KEY) {
      return reply.code(503).send({
        error: "Flint unavailable: MOBEY_API_KEY not configured",
        available: false,
      });
    }

    const { completed = "false", boardKey, quadrant } = req.query;
    const args = {};

    if (completed !== "all") {
      args.completed = completed === "true";
    }
    if (boardKey) args.boardKey = boardKey;
    if (quadrant) args.quadrant = Number(quadrant);

    try {
      const todos = await callMobeyTool("list_todos", args);
      return { todos, available: true };
    } catch (err) {
      fastify.log.error(err, "Mobey MCP error");
      return reply.code(502).send({ error: `Mobey error: ${err.message}`, available: true });
    }
  });

  /**
   * GET /api/flint/boards
   *
   * Returns all available Mobey boards (built-in + custom).
   * Used by the UI board selector. Returns `{ boards: Board[], available: true }`.
   */
  fastify.get("/api/flint/boards", async (_req, reply) => {
    if (!process.env.MOBEY_API_KEY) {
      return reply.code(503).send({
        error: "Flint unavailable: MOBEY_API_KEY not configured",
        available: false,
      });
    }
    try {
      const boards = await callMobeyTool("list_boards", {});
      return { boards, available: true };
    } catch (err) {
      fastify.log.error(err, "Mobey MCP error");
      return reply.code(502).send({ error: `Mobey error: ${err.message}`, available: true });
    }
  });
}
