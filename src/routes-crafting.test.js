import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import Fastify from "fastify";
import { Database } from "bun:sqlite";

const SKIP = !process.env.SUPABASE_DB_URL;

/**
 * Integration tests for crafting route handlers.
 * Uses an in-memory SQLite database that mirrors the craft_agents and
 * craft_recipes tables from db.js.
 */

describe.skipIf(SKIP)("crafting routes", () => {

let app;
let db;
let stmts;

function initDb() {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE craft_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      prompt_snippet TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'default',
      color TEXT NOT NULL DEFAULT '#4ade80',
      tags TEXT DEFAULT '[]',
      model_preference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE craft_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      synthesized_prompt TEXT,
      ingredient_ids TEXT NOT NULL DEFAULT '[]',
      icon TEXT NOT NULL DEFAULT '#fbbf24',
      color TEXT NOT NULL DEFAULT '#fbbf24',
      tags TEXT DEFAULT '[]',
      model_preference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return {
    getAllCraftAgents: db.prepare(`SELECT * FROM craft_agents ORDER BY name`),
    getCraftAgent: db.prepare(`SELECT * FROM craft_agents WHERE id = $id`),
    insertCraftAgent: db.prepare(`
      INSERT INTO craft_agents (name, description, prompt_snippet, icon, color, tags, model_preference)
      VALUES ($name, $description, $promptSnippet, $icon, $color, $tags, $modelPreference)
      RETURNING *
    `),
    updateCraftAgentStmt: db.prepare(`
      UPDATE craft_agents SET
        name = $name, description = $description, prompt_snippet = $promptSnippet,
        icon = $icon, color = $color, tags = $tags, model_preference = $modelPreference,
        updated_at = datetime('now')
      WHERE id = $id
      RETURNING *
    `),
    deleteCraftAgentStmt: db.prepare(`DELETE FROM craft_agents WHERE id = $id`),

    getAllCraftRecipes: db.prepare(`SELECT * FROM craft_recipes ORDER BY updated_at DESC`),
    getCraftRecipe: db.prepare(`SELECT * FROM craft_recipes WHERE id = $id`),
    insertCraftRecipe: db.prepare(`
      INSERT INTO craft_recipes (name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference)
      VALUES ($name, $description, $synthesizedPrompt, $ingredientIds, $icon, $color, $tags, $modelPreference)
      RETURNING *
    `),
    updateCraftRecipeStmt: db.prepare(`
      UPDATE craft_recipes SET
        name = $name, description = $description, synthesized_prompt = $synthesizedPrompt,
        ingredient_ids = $ingredientIds, icon = $icon, color = $color, tags = $tags,
        model_preference = $modelPreference, updated_at = datetime('now')
      WHERE id = $id
      RETURNING *
    `),
    deleteCraftRecipeStmt: db.prepare(`DELETE FROM craft_recipes WHERE id = $id`),
  };
}

function registerRoutes(fastify, s) {
  // Mirror the routes from src/routes/crafting.js but using local stmts

  fastify.get("/api/craft/agents", async () => s.getAllCraftAgents.all());

  fastify.post("/api/craft/agents", async (req, reply) => {
    const { name, description, prompt_snippet, icon, color, tags, model_preference } = req.body;
    if (!name || !prompt_snippet) {
      return reply.code(400).send({ error: "name and prompt_snippet are required" });
    }
    const row = s.insertCraftAgent.get({
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
    const existing = s.getCraftAgent.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Agent not found" });

    const { name, description, prompt_snippet, icon, color, tags, model_preference } = req.body;
    if (!name || !prompt_snippet) {
      return reply.code(400).send({ error: "name and prompt_snippet are required" });
    }
    const row = s.updateCraftAgentStmt.get({
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
    const existing = s.getCraftAgent.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Agent not found" });
    s.deleteCraftAgentStmt.run({ $id: id });
    return { ok: true };
  });

  fastify.get("/api/craft/recipes", async () => s.getAllCraftRecipes.all());

  fastify.post("/api/craft/recipes", async (req, reply) => {
    const { name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference } = req.body;
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const row = s.insertCraftRecipe.get({
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
    const existing = s.getCraftRecipe.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Recipe not found" });

    const { name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference } = req.body;
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const row = s.updateCraftRecipeStmt.get({
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
    const existing = s.getCraftRecipe.get({ $id: id });
    if (!existing) return reply.code(404).send({ error: "Recipe not found" });
    s.deleteCraftRecipeStmt.run({ $id: id });
    return { ok: true };
  });
}

beforeAll(async () => {
  stmts = initDb();
  app = Fastify();

  // Accept empty JSON bodies (mirrors server's custom parser)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (!body || body.length === 0) { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (err) { done(err, undefined); }
  });

  registerRoutes(app, stmts);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

// ─── Craft Agents CRUD ────────────────────────────────────────────────────────

describe("GET /api/craft/agents", () => {
  it("returns empty array initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/craft/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("POST /api/craft/agents", () => {
  it("creates an agent with required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "Researcher", prompt_snippet: "You are a research specialist." },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Researcher");
    expect(body.prompt_snippet).toBe("You are a research specialist.");
    expect(body.icon).toBe("default");
    expect(body.color).toBe("#4ade80");
    expect(body.tags).toBe("[]");
    expect(body.id).toBeGreaterThan(0);
  });

  it("creates an agent with all optional fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: {
        name: "Coder",
        description: "Expert programmer",
        prompt_snippet: "You are a coding expert.",
        icon: "coder",
        color: "#60a5fa",
        tags: ["code", "typescript"],
        model_preference: "claude-sonnet-4-6",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.description).toBe("Expert programmer");
    expect(body.icon).toBe("coder");
    expect(body.color).toBe("#60a5fa");
    expect(body.tags).toBe('["code","typescript"]');
    expect(body.model_preference).toBe("claude-sonnet-4-6");
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { prompt_snippet: "snippet" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name and prompt_snippet are required");
  });

  it("returns 400 when prompt_snippet is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/craft/agents (after creation)", () => {
  it("returns created agents sorted by name", async () => {
    const res = await app.inject({ method: "GET", url: "/api/craft/agents" });
    expect(res.statusCode).toBe(200);
    const agents = res.json();
    expect(agents.length).toBeGreaterThanOrEqual(2);
    // Should be alphabetical: Coder before Researcher
    const names = agents.map((a) => a.name);
    expect(names.indexOf("Coder")).toBeLessThan(names.indexOf("Researcher"));
  });
});

describe("PUT /api/craft/agents/:id", () => {
  it("updates an existing agent", async () => {
    // Create first
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "Old Name", prompt_snippet: "Old prompt" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/agents/${id}`,
      payload: { name: "New Name", prompt_snippet: "New prompt", description: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("New Name");
    expect(body.prompt_snippet).toBe("New prompt");
    expect(body.description).toBe("Updated");
  });

  it("preserves existing icon/color when not provided", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "Styled", prompt_snippet: "p", icon: "architect", color: "#ff0000" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/agents/${id}`,
      payload: { name: "Styled", prompt_snippet: "updated" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.icon).toBe("architect");
    expect(body.color).toBe("#ff0000");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/craft/agents/99999",
      payload: { name: "X", prompt_snippet: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when required fields are missing", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "V", prompt_snippet: "v" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/agents/${id}`,
      payload: { name: "V" }, // missing prompt_snippet
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/craft/agents/:id", () => {
  it("deletes an existing agent", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "ToDelete", prompt_snippet: "bye" },
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/craft/agents/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // Verify it's gone
    const row = stmts.getCraftAgent.get({ $id: id });
    expect(row).toBeNull();
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/craft/agents/99999" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Craft Recipes CRUD ───────────────────────────────────────────────────────

describe("GET /api/craft/recipes", () => {
  it("returns empty array initially (after no recipes created)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/craft/recipes" });
    expect(res.statusCode).toBe(200);
    // May or may not be empty depending on test order, but should be 200
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe("POST /api/craft/recipes", () => {
  it("creates a recipe with required fields only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { name: "Code Review Combo" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Code Review Combo");
    expect(body.synthesized_prompt).toBeNull();
    expect(body.ingredient_ids).toBe("[]");
    expect(body.id).toBeGreaterThan(0);
  });

  it("creates a recipe with all fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: {
        name: "Full Stack Agent",
        description: "Frontend + backend combo",
        synthesized_prompt: "You are a full-stack developer...",
        ingredient_ids: [1, 2, 3],
        icon: "architect",
        color: "#fbbf24",
        tags: ["fullstack", "web"],
        model_preference: "claude-opus-4-6",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.description).toBe("Frontend + backend combo");
    expect(body.synthesized_prompt).toBe("You are a full-stack developer...");
    expect(body.ingredient_ids).toBe("[1,2,3]");
    expect(body.tags).toBe('["fullstack","web"]');
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { synthesized_prompt: "test" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name is required");
  });

  it("returns 400 when body is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /api/craft/recipes/:id", () => {
  it("updates an existing recipe", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { name: "Old Recipe", synthesized_prompt: "Old prompt" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/recipes/${id}`,
      payload: { name: "New Recipe", synthesized_prompt: "New prompt", ingredient_ids: [10, 20] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("New Recipe");
    expect(body.synthesized_prompt).toBe("New prompt");
    expect(body.ingredient_ids).toBe("[10,20]");
  });

  it("preserves existing synthesized_prompt when not provided", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { name: "Keeper", synthesized_prompt: "Important prompt" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/recipes/${id}`,
      payload: { name: "Keeper Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().synthesized_prompt).toBe("Important prompt");
  });

  it("preserves existing icon/color when not provided", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { name: "Styled", icon: "explorer", color: "#ff00ff" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/recipes/${id}`,
      payload: { name: "Styled Updated" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.icon).toBe("explorer");
    expect(body.color).toBe("#ff00ff");
  });

  it("returns 404 for non-existent recipe", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/craft/recipes/99999",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when name is missing", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { name: "V" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/craft/recipes/${id}`,
      payload: { description: "no name" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/craft/recipes/:id", () => {
  it("deletes an existing recipe", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: { name: "ToDelete" },
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/craft/recipes/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // Verify it's gone
    const row = stmts.getCraftRecipe.get({ $id: id });
    expect(row).toBeNull();
  });

  it("returns 404 for non-existent recipe", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/craft/recipes/99999" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── End-to-end workflow ──────────────────────────────────────────────────────

describe("crafting workflow", () => {
  it("creates agents, crafts a recipe, and updates it", async () => {
    // 1. Create two agents
    const a1 = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "Writer", prompt_snippet: "You write clearly." },
    });
    const a2 = await app.inject({
      method: "POST",
      url: "/api/craft/agents",
      payload: { name: "Reviewer", prompt_snippet: "You review code thoroughly." },
    });

    const agent1 = a1.json();
    const agent2 = a2.json();

    // 2. Create a recipe combining them
    const r1 = await app.inject({
      method: "POST",
      url: "/api/craft/recipes",
      payload: {
        name: "Writer + Reviewer",
        synthesized_prompt: "You write clearly and review code thoroughly.",
        ingredient_ids: [agent1.id, agent2.id],
      },
    });
    expect(r1.statusCode).toBe(201);
    const recipe = r1.json();
    expect(JSON.parse(recipe.ingredient_ids)).toEqual([agent1.id, agent2.id]);

    // 3. Update the recipe
    const r2 = await app.inject({
      method: "PUT",
      url: `/api/craft/recipes/${recipe.id}`,
      payload: {
        name: "Writer + Reviewer v2",
        synthesized_prompt: "Improved prompt.",
        ingredient_ids: [agent1.id, agent2.id],
      },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().name).toBe("Writer + Reviewer v2");

    // 4. Verify both agents and recipe are listed
    const agents = await app.inject({ method: "GET", url: "/api/craft/agents" });
    const agentNames = agents.json().map((a) => a.name);
    expect(agentNames).toContain("Writer");
    expect(agentNames).toContain("Reviewer");

    const recipes = await app.inject({ method: "GET", url: "/api/craft/recipes" });
    const recipeNames = recipes.json().map((r) => r.name);
    expect(recipeNames).toContain("Writer + Reviewer v2");
  });

}); // crafting workflow
}); // describe.skipIf(SKIP)
