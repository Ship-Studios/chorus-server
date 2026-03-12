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

export default async function craftingRoutes(fastify) {
  // --- AI Status ---

  fastify.get("/api/craft/ai-status", async () => {
    return { available: !!process.env.ANTHROPIC_API_KEY };
  });

  // --- Synthesize ---

  fastify.post("/api/craft/synthesize", async (req, reply) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: "ANTHROPIC_API_KEY not configured on server" });
    }

    const { agents, model } = req.body ?? {};
    if (!Array.isArray(agents) || agents.length < 2) {
      return reply.code(400).send({ error: "At least 2 agents are required" });
    }

    const agentDescriptions = agents
      .map(
        (a) =>
          `### ${a.name}\nDescription: ${a.description ?? "N/A"}\nExpertise prompt:\n${a.prompt_snippet}`
      )
      .join("\n\n");

    const metaPrompt = `You are a prompt engineer specializing in creating powerful AI agent system prompts.

Given the following agent specializations, create a single cohesive system prompt that combines ALL their capabilities into one unified super-agent. The result should:

1. Integrate all areas of expertise seamlessly
2. Preserve the specific knowledge and instructions from each agent
3. Be well-structured with clear sections
4. Be ready to use as a system prompt for Claude

Agents to combine:

${agentDescriptions}

Output ONLY the synthesized system prompt text. No explanations, no preamble, no markdown code fences. Just the system prompt itself.`;

    try {
      const anthropic = new Anthropic();
      const msg = await anthropic.messages.create({
        model: model ?? SYNTHESIS_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: metaPrompt }],
      });

      const text = msg.content?.[0]?.text;
      if (!text) throw new Error("No content in API response");

      return { prompt: text, model: model ?? SYNTHESIS_MODEL, usage: msg.usage };
    } catch (e) {
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
