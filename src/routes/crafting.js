/**
 * Crafting routes — CRUD for craft agents and recipes, plus AI-powered
 * prompt synthesis.
 *
 * Endpoints:
 *   GET    /api/craft/agents        — List all craft agents
 *   POST   /api/craft/agents        — Create a craft agent (requires name + prompt_snippet)
 *   PUT    /api/craft/agents/:id    — Update a craft agent
 *   DELETE /api/craft/agents/:id    — Delete a craft agent
 *   GET    /api/craft/recipes       — List all recipes
 *   POST   /api/craft/recipes       — Create a recipe (requires name)
 *   PUT    /api/craft/recipes/:id   — Update a recipe
 *   DELETE /api/craft/recipes/:id   — Delete a recipe
 *   POST   /api/craft/synthesize    — AI-synthesize a unified prompt from 2+ agents
 *   GET    /api/craft/ai-status     — Check if ANTHROPIC_API_KEY is configured
 *
 * The synthesize endpoint combines multiple agent specializations into a single
 * cohesive system prompt using Claude (`claude-sonnet-4-6` by default). It requires
 * `ANTHROPIC_API_KEY` to be set on the server. The model parameter is validated
 * against `/^[a-zA-Z0-9._/-]+$/` to prevent CLI flag injection.
 *
 * The Anthropic client is lazily initialized with VPN-aware fetchOptions
 * (proxy + TLS) via `getAnthropicFetchOptions()`. The cached client is
 * invalidated on `/api/vpn/reconfigure` via the exported `resetClient()`.
 *
 * Agent prompt snippets are truncated to 4000 chars per agent in the synthesis
 * prompt to manage token costs.
 *
 * @module routes/crafting
 */

import { getAnthropicFetchOptions } from "../vpn.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  getAllCraftAgents,
  getCraftAgent,
  insertCraftAgent,
  updateCraftAgentStmt,
  deleteCraftAgentStmt,
  getAllCraftRecipes,
  getCraftRecipe,
  insertCraftRecipe,
  updateCraftRecipeStmt,
  deleteCraftRecipeStmt,
} from "../db.js";

const SYNTHESIS_MODEL = "claude-sonnet-4-6";

let client = null;

/**
 * Get the Anthropic client, lazily initializing it if needed.
 *
 * @returns {Anthropic|null} The Anthropic client, or null if API key is missing.
 */
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ maxRetries: 3, timeout: 60_000, ...getAnthropicFetchOptions() });
  return client;
}

/** Reset cached client so next call picks up new VPN/proxy config. */
export function resetClient() { client = null; }

/**
 * Fastify plugin for crafting routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export default async function craftingRoutes(fastify) {
  // --- AI Status ---

  fastify.get("/api/craft/ai-status", async () => {
    return { available: !!process.env.ANTHROPIC_API_KEY };
  });

  // --- Synthesize ---

  fastify.post("/api/craft/synthesize", async (req, reply) => {
    const anthropic = getClient();
    if (!anthropic) {
      return reply.code(503).send({ error: "ANTHROPIC_API_KEY not configured on server" });
    }

    const { agents, model } = req.body ?? {};
    if (!Array.isArray(agents) || agents.length < 2) {
      return reply.code(400).send({ error: "At least 2 agents are required" });
    }

    const resolvedModel = model ?? SYNTHESIS_MODEL;
    if (model && !/^[a-zA-Z0-9._/-]+$/.test(model)) {
      return reply.code(400).send({ error: "Invalid model name" });
    }

    const MAX_SNIPPET_CHARS = 4_000;
    const agentDescriptions = agents
      .map((a) => {
        const snippet = (a.prompt_snippet || "").length > MAX_SNIPPET_CHARS
          ? a.prompt_snippet.slice(0, MAX_SNIPPET_CHARS) + "\n[truncated]"
          : a.prompt_snippet;
        return `### ${a.name}\nDescription: ${a.description ?? "N/A"}\nExpertise prompt:\n${snippet}`;
      })
      .join("\n\n");

    const systemPrompt =
      "You are a prompt engineer specializing in creating powerful AI agent system prompts. " +
      "You integrate multiple agent specializations into cohesive, well-structured system prompts ready for Claude.";

    const userPrompt = `Given the following agent specializations, create a single cohesive system prompt that combines ALL their capabilities into one unified super-agent. The result should:

1. Integrate all areas of expertise seamlessly
2. Preserve the specific knowledge and instructions from each agent
3. Be well-structured with clear sections
4. Be ready to use as a system prompt for Claude

Agents to combine:

${agentDescriptions}

Output ONLY the synthesized system prompt text. No explanations, no preamble, no markdown code fences. Just the system prompt itself.`;

    try {
      const msg = await anthropic.messages.create({
        model: resolvedModel,
        max_tokens: 4096,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userPrompt }],
      });

      const text = msg.content?.[0]?.text;
      if (!text) throw new Error("No content in API response");

      const truncated = msg.stop_reason === "max_tokens";
      return { prompt: text, model: resolvedModel, usage: msg.usage, truncated };
    } catch (e) {
      if (e.status === 429) return reply.code(429).send({ error: "Rate limited — try again in a moment" });
      if (e.status === 529) return reply.code(503).send({ error: "AI service overloaded — try again later" });
      if (e.status === 401) return reply.code(502).send({ error: "Server API key is invalid — contact admin" });
      const status = e.status ?? 500;
      return reply.code(status).send({ error: e.message ?? "Synthesis failed" });
    }
  });
  // --- Craft Agents ---

  fastify.get("/api/craft/agents", async () => {
    return getAllCraftAgents.all();
  });

  fastify.post("/api/craft/agents", async (req, reply) => {
    const { name, description, prompt_snippet, icon, color, tags, model_preference } = req.body;
    if (!name || !prompt_snippet) {
      return reply.code(400).send({ error: "name and prompt_snippet are required" });
    }
    const row = insertCraftAgent.get({
      $name: name,
      $description: description ?? null,
      $promptSnippet: prompt_snippet,
      $icon: icon ?? "default",
      $color: color ?? "#4ade80",
      $tags: JSON.stringify(tags ?? []),
      $modelPreference: model_preference ?? null,
    });
    return reply.code(201).send(row);
  });

  fastify.put("/api/craft/agents/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getCraftAgent.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Agent not found" });

    const { name, description, prompt_snippet, icon, color, tags, model_preference } = req.body;
    if (!name || !prompt_snippet) {
      return reply.code(400).send({ error: "name and prompt_snippet are required" });
    }
    const row = updateCraftAgentStmt.get({
      $id: id,
      $name: name,
      $description: description ?? null,
      $promptSnippet: prompt_snippet,
      $icon: icon ?? existing.icon,
      $color: color ?? existing.color,
      $tags: JSON.stringify(tags ?? JSON.parse(existing.tags || "[]")),
      $modelPreference: model_preference ?? existing.model_preference,
    });
    return row;
  });

  fastify.delete("/api/craft/agents/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getCraftAgent.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Agent not found" });
    deleteCraftAgentStmt.run({ $id: id });
    return { ok: true };
  });

  // --- Craft Recipes ---

  fastify.get("/api/craft/recipes", async () => {
    return getAllCraftRecipes.all();
  });

  fastify.post("/api/craft/recipes", async (req, reply) => {
    const { name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference } = req.body;
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const row = insertCraftRecipe.get({
      $name: name,
      $description: description ?? null,
      $synthesizedPrompt: synthesized_prompt ?? null,
      $ingredientIds: JSON.stringify(ingredient_ids ?? []),
      $icon: icon ?? "default",
      $color: color ?? "#fbbf24",
      $tags: JSON.stringify(tags ?? []),
      $modelPreference: model_preference ?? null,
    });
    return reply.code(201).send(row);
  });

  fastify.put("/api/craft/recipes/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getCraftRecipe.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Recipe not found" });

    const { name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference } = req.body;
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const row = updateCraftRecipeStmt.get({
      $id: id,
      $name: name,
      $description: description ?? null,
      $synthesizedPrompt: synthesized_prompt ?? existing.synthesized_prompt,
      $ingredientIds: JSON.stringify(ingredient_ids ?? JSON.parse(existing.ingredient_ids || "[]")),
      $icon: icon ?? existing.icon,
      $color: color ?? existing.color,
      $tags: JSON.stringify(tags ?? JSON.parse(existing.tags || "[]")),
      $modelPreference: model_preference ?? existing.model_preference,
    });
    return row;
  });

  fastify.delete("/api/craft/recipes/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getCraftRecipe.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Recipe not found" });
    deleteCraftRecipeStmt.run({ $id: id });
    return { ok: true };
  });
}
