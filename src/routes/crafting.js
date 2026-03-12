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

export default async function craftingRoutes(fastify) {
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
