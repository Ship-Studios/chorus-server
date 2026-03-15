import * as s from "../db.js";

export async function getAllCraftRecipes() {
  return s.getAllCraftRecipes.all();
}

export async function getCraftRecipe(id) {
  return s.getCraftRecipe.get({ $id: id }) ?? null;
}

export async function insertCraftRecipe({ name, description, synthesizedPrompt, ingredientIds, icon, color, tags, modelPreference }) {
  return s.insertCraftRecipe.get({
    $name: name,
    $description: description ?? null,
    $synthesizedPrompt: synthesizedPrompt ?? null,
    $ingredientIds: ingredientIds ?? "[]",
    $icon: icon ?? "#fbbf24",
    $color: color ?? "#fbbf24",
    $tags: tags ?? "[]",
    $modelPreference: modelPreference ?? null,
  });
}

export async function updateCraftRecipe(id, { name, description, synthesizedPrompt, ingredientIds, icon, color, tags, modelPreference }) {
  return s.updateCraftRecipeStmt.get({
    $id: id,
    $name: name,
    $description: description ?? null,
    $synthesizedPrompt: synthesizedPrompt ?? null,
    $ingredientIds: ingredientIds ?? "[]",
    $icon: icon ?? "#fbbf24",
    $color: color ?? "#fbbf24",
    $tags: tags ?? "[]",
    $modelPreference: modelPreference ?? null,
  });
}

export async function deleteCraftRecipe(id) {
  return s.deleteCraftRecipeStmt.run({ $id: id });
}
