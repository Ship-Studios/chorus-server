/**
 * Flint routes — Mobey MCP proxy + AI executive assistant.
 *
 * Endpoints:
 *   GET  /api/flint/status    — check if MOBEY_API_KEY is configured
 *   GET  /api/flint/ai-status — check if ANTHROPIC_API_KEY is configured
 *   GET  /api/flint/todos     — fetch todos from Mobey via MCP Streamable HTTP
 *   GET  /api/flint/boards    — fetch boards from Mobey
 *   POST /api/flint/chat      — streaming AI consultant with full Mobey tool access
 *
 * The /api/flint/chat endpoint uses Server-Sent Events (SSE) for streaming.
 * It runs an agentic loop: LLM can call any of the 19 Mobey tools, get results,
 * and continue generating until it reaches a final response. Chunks arrive as:
 *   { type: "chunk",       text }
 *   { type: "tool_call",  toolName, toolInput, toolId }
 *   { type: "tool_result",toolId, toolName, result?, error? }
 *   { type: "done" }
 *   { type: "error",      error }
 *
 * @module routes/flint
 */

import Anthropic from "@anthropic-ai/sdk";
import { PassThrough } from "node:stream";
import { getAnthropicFetchOptions } from "../vpn.js";

// ---------------------------------------------------------------------------
// Anthropic client — lazy init, VPN-aware, exported resetClient for /api/vpn/reconfigure
// ---------------------------------------------------------------------------

const FLINT_MODEL = process.env.FLINT_CONSULTANT_MODEL ?? "claude-sonnet-4-6";
const MAX_AGENTIC_TURNS = 12;

let client = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({
      maxRetries: 2,
      timeout: 120_000,
      ...getAnthropicFetchOptions(),
    });
  }
  return client;
}

export function resetClient() {
  client = null;
}

// ---------------------------------------------------------------------------
// Mobey MCP connection
// ---------------------------------------------------------------------------

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
  await initRes.text(); // consume body to free connection

  if (!sessionId) throw new Error("Mobey MCP: no session ID in initialize response");

  const sessionHeaders = { ...headers, "Mcp-Session-Id": sessionId };

  // ── 2. Acknowledge initialization ─────────────────────────────────────────
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

  // Parse response — may be SSE or plain JSON / NDJSON
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

  const text = result.content?.[0]?.text;
  if (text == null) throw new Error("Mobey MCP: empty tool result content");

  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// AI consultant — system prompt + tool definitions
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `You are Flint, an executive assistant and productivity coach embedded in a software developer's daily workflow dashboard. You have direct access to their Mobey task management system via tools.

Today is ${date}.

**The Eisenhower Matrix (how the task board is organized):**
- Q1 — Urgent + Important: Do First. Crises, hard deadlines, critical blockers.
- Q2 — Not Urgent + Important: Schedule. Deep work, planning, skill-building. This quadrant creates the most long-term value.
- Q3 — Urgent + Not Important: Delegate. Interruptions, other people's priorities.
- Q4 — Not Urgent + Not Important: Eliminate. Distractions, busywork.

**Your role:**
- Give concise, actionable guidance on what to focus on right now
- Proactively identify overdue items, Q1 pile-up, an empty Q2, or inbox clutter
- Help create, complete, reprioritize, and clean up tasks when asked
- Use notes for context when relevant
- Be direct — the user is a busy developer. Lead with what matters. Use bullet points over paragraphs.

**When the user asks "what should I work on?" or greets you:**
1. Immediately fetch their active todos (don't ask first, just do it)
2. Start with Q1 + overdue items
3. Mention any notable Q2 items worth protecting time for
4. Flag inbox items that need sorting
5. End with one concrete "start here" recommendation

**Tone:** Direct, brief, knowledgeable. No motivational filler. Think senior engineering manager giving a 2-minute standup briefing, not a life coach.`;
}

/** Anthropic tool definitions for all 19 Mobey MCP tools. */
const MOBEY_TOOLS = [
  // ── Todos ───────────────────────────────────────────────────────────────
  {
    name: "list_todos",
    description: "List todos from the user's task board. Use this to get an overview of what's on their plate. Filter by quadrant, completion status, or board.",
    input_schema: {
      type: "object",
      properties: {
        quadrant: { type: "integer", enum: [1, 2, 3, 4], description: "Filter by quadrant (1=Do First, 2=Schedule, 3=Delegate, 4=Eliminate)." },
        completed: { type: "boolean", description: "true = completed only, false = active only. Omit for all." },
        boardKey: { type: "string", description: "Board key to filter by (e.g. 'action-priority'). Omit for default board." },
      },
    },
  },
  {
    name: "get_todo",
    description: "Get detailed information about a specific todo by ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "create_todo",
    description: "Create a new todo item. Optionally assign it to a quadrant immediately.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "The todo title/description." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        quadrant: { type: "integer", enum: [1, 2, 3, 4], description: "Quadrant to place the todo in." },
        boardKey: { type: "string", description: "Board to add to. Defaults to action-priority." },
      },
      required: ["description"],
    },
  },
  {
    name: "update_todo",
    description: "Update a todo's description, tags, or completion status.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo ID." },
        description: { type: "string", description: "Updated description." },
        tags: { type: "array", items: { type: "string" }, description: "Updated tags." },
        completed: { type: "boolean", description: "Updated completion status." },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_todo",
    description: "Permanently delete a todo. Use this when the user wants to remove a task entirely.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo ID to delete." },
      },
      required: ["id"],
    },
  },
  {
    name: "prioritize_todo",
    description: "Move a todo to a specific Eisenhower Matrix quadrant. Use this to help the user reprioritize tasks.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo ID." },
        quadrant: { type: "integer", enum: [1, 2, 3, 4], description: "Target quadrant: 1=Do First, 2=Schedule, 3=Delegate, 4=Eliminate." },
        boardKey: { type: "string", description: "The board to update the priority on." },
      },
      required: ["id", "quadrant"],
    },
  },
  {
    name: "complete_todo",
    description: "Mark a todo as completed. Use this when the user says they finished something.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The todo ID to mark complete." },
      },
      required: ["id"],
    },
  },
  // ── Boards ───────────────────────────────────────────────────────────────
  {
    name: "list_boards",
    description: "List all available task boards (built-in and custom). Use this to know which boards exist.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_board",
    description: "Get detailed info about a specific board including its quadrant definitions.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The board key (e.g. 'action-priority', 'risk-value')." },
      },
      required: ["key"],
    },
  },
  // ── Tags ─────────────────────────────────────────────────────────────────
  {
    name: "list_tag_colors",
    description: "Get all tag-to-color mappings for the user's task board.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_tag_color",
    description: "Set or remove a display color for a tag.",
    input_schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "The tag name." },
        color: { type: "string", description: "Hex color (e.g. '#ff0000') or empty string to remove." },
      },
      required: ["tag", "color"],
    },
  },
  // ── Statuses ─────────────────────────────────────────────────────────────
  {
    name: "list_statuses",
    description: "List all available todo statuses (system and custom).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_status",
    description: "Get detailed info about a specific status by ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The status ID." },
      },
      required: ["id"],
    },
  },
  // ── Notes ─────────────────────────────────────────────────────────────────
  {
    name: "list_notes",
    description: "List all notes, optionally filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "archived", "all"], description: "Filter by note status. Defaults to active." },
      },
    },
  },
  {
    name: "get_note",
    description: "Get the full content of a note by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note name." },
      },
      required: ["name"],
    },
  },
  {
    name: "create_note",
    description: "Create a new note.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note name." },
        content: { type: "string", description: "Optional note content (markdown supported)." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      },
      required: ["name"],
    },
  },
  {
    name: "update_note",
    description: "Update a note's content or tags.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note name." },
        content: { type: "string", description: "Updated content." },
        tags: { type: "array", items: { type: "string" }, description: "Updated tags." },
      },
      required: ["name"],
    },
  },
  {
    name: "archive_note",
    description: "Archive a note (moves it out of active view).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note name to archive." },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_note",
    description: "Permanently delete a note.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note name to delete." },
      },
      required: ["name"],
    },
  },
];

// ---------------------------------------------------------------------------
// Agentic loop — runs LLM turns + Mobey tool calls until end_turn
// ---------------------------------------------------------------------------

/**
 * Run the executive assistant agentic loop, streaming events to the client.
 *
 * The loop:
 *   1. Call Anthropic with current messages + tools
 *   2. Stream text chunks → { type: "chunk", text }
 *   3. On tool_use stop: execute all tools, emit tool_call/tool_result events
 *   4. Append assistant response + tool results to messages, repeat
 *   5. On end_turn: emit { type: "done" }
 *
 * @param {Anthropic} anthropic  Anthropic SDK instance
 * @param {Function}  send       SSE send function: send(eventData)
 * @param {Array}     history    Prior conversation turns [{role, content}]
 * @param {string}    message    Current user message
 */
async function runConsultantLoop(anthropic, send, history, message) {
  const messages = [
    ...history,
    { role: "user", content: message },
  ];

  const systemPrompt = buildSystemPrompt();

  for (let turn = 0; turn < MAX_AGENTIC_TURNS; turn++) {
    const stream = anthropic.messages.stream({
      model: FLINT_MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: MOBEY_TOOLS,
      messages,
    });

    // Stream text deltas to the client as they arrive
    stream.on("text", (text) => {
      send({ type: "chunk", text });
    });

    const finalMessage = await stream.finalMessage();

    if (finalMessage.stop_reason !== "tool_use") {
      send({ type: "done" });
      return;
    }

    // Execute all tool calls (sequentially to avoid MCP session conflicts)
    const toolUseBlocks = finalMessage.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      send({ type: "tool_call", toolName: toolUse.name, toolInput: toolUse.input, toolId: toolUse.id });

      try {
        const result = await callMobeyTool(toolUse.name, toolUse.input);
        send({ type: "tool_result", toolId: toolUse.id, toolName: toolUse.name, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        send({ type: "tool_result", toolId: toolUse.id, toolName: toolUse.name, error: err.message });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error calling ${toolUse.name}: ${err.message}`,
          is_error: true,
        });
      }
    }

    // Append this turn's messages and continue
    messages.push({ role: "assistant", content: finalMessage.content });
    messages.push({ role: "user", content: toolResults });
  }

  send({ type: "error", error: "Maximum tool use turns reached" });
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

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
   * page content without making a full data request.
   */
  fastify.get("/api/flint/status", async () => ({
    available: !!process.env.MOBEY_API_KEY,
  }));

  /**
   * GET /api/flint/ai-status
   *
   * Probe whether the AI consultant (Anthropic) is available.
   */
  fastify.get("/api/flint/ai-status", async () => ({
    available: !!(process.env.ANTHROPIC_API_KEY && process.env.MOBEY_API_KEY),
  }));

  /**
   * GET /api/flint/todos
   *
   * Fetch todos from Mobey via MCP.
   */
  fastify.get("/api/flint/todos", async (req, reply) => {
    if (!process.env.MOBEY_API_KEY) {
      return reply.code(503).send({ error: "Flint unavailable: MOBEY_API_KEY not configured", available: false });
    }

    const { completed = "false", boardKey, quadrant } = req.query;
    const args = {};

    if (completed !== "all") args.completed = completed === "true";
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
   */
  fastify.get("/api/flint/boards", async (_req, reply) => {
    if (!process.env.MOBEY_API_KEY) {
      return reply.code(503).send({ error: "Flint unavailable: MOBEY_API_KEY not configured", available: false });
    }
    try {
      const boards = await callMobeyTool("list_boards", {});
      return { boards, available: true };
    } catch (err) {
      fastify.log.error(err, "Mobey MCP error");
      return reply.code(502).send({ error: `Mobey error: ${err.message}`, available: true });
    }
  });

  /**
   * POST /api/flint/chat
   *
   * AI executive assistant with full Mobey tool access. Streams responses via
   * Server-Sent Events (SSE). The agentic loop runs entirely server-side.
   *
   * Body: { message: string, history?: Array<{role, content}> }
   *
   * SSE events (each `data: <json>\n\n`):
   *   { type: "chunk",       text: string }              — streaming text delta
   *   { type: "tool_call",  toolName, toolInput, toolId } — tool being called
   *   { type: "tool_result",toolId, toolName, result?, error? } — tool result
   *   { type: "done" }                                    — stream complete
   *   { type: "error",      error: string }               — fatal error
   */
  // Disable compression for SSE — @fastify/compress buffering delays chunk delivery.
  fastify.post("/api/flint/chat", { config: { compress: false } }, async (req, reply) => {
    const anthropic = getClient();

    if (!process.env.MOBEY_API_KEY) {
      return reply.code(503).send({ error: "MOBEY_API_KEY not configured" });
    }
    if (!anthropic) {
      return reply.code(503).send({ error: "ANTHROPIC_API_KEY not configured" });
    }

    const { message, history = [] } = req.body ?? {};
    if (!message || typeof message !== "string") {
      return reply.code(400).send({ error: "message (string) required" });
    }

    // Use a PassThrough stream as the SSE body — Fastify pipes it to the response.
    // This lets us write SSE events from the async agentic loop while the HTTP
    // response has already been handed back to Fastify for piping.
    const sseStream = new PassThrough();

    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");

    reply.send(sseStream);

    const send = (data) => {
      if (!sseStream.writableEnded) {
        sseStream.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    runConsultantLoop(anthropic, send, history, message)
      .catch((err) => {
        const status = err.status;
        if (status === 429) send({ type: "error", error: "Rate limited — try again shortly" });
        else if (status === 529) send({ type: "error", error: "AI service overloaded — try again" });
        else if (status === 401) send({ type: "error", error: "Anthropic API key error" });
        else send({ type: "error", error: err.message ?? "AI error" });
      })
      .finally(() => {
        if (!sseStream.writableEnded) sseStream.end();
      });
  });
}
